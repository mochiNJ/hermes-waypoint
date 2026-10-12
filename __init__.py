"""Waypoint — Python half.

1. Registers two auxiliary tasks, ``waypoint_ideas`` and ``waypoint_ideas_2``: the
   two strong models offered by Waypoint's Power up menu. Pick their models like any
   other auxiliary model (Hermes Settings, or
   ``hermes config set auxiliary.waypoint_ideas.model <model>``). Unset, they resolve
   like any auxiliary task ("auto").

2. Power-up call log. Observes Hermes's ``pre_auxiliary_call`` / ``post_auxiliary_call``
   events for those two tasks only and writes one line per call to the Hermes log
   (``logs/agent.log``, logger ``plugins.waypoint``) plus one JSON record to
   ``<HERMES_HOME>/plugin-data/waypoint/power-calls.jsonl`` (rolls over at ~1 MB): model, reasoning effort
   (configured and as actually sent), response time, token counts, finish reason and
   status. No prompt or reply text is logged. Observer-only: it never changes a call.


No tools, no network access of its own.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

logger = logging.getLogger("plugins.waypoint")

# Token-count fallback status, recorded with every power-up call. The public build has no
# fallback, so it keeps this default.
_fallback: dict[str, str] = {"state": "not included in this build"}
LOG_MAX_BYTES = 1_000_000  # power-calls.jsonl rolls over to power-calls.1.jsonl past ~1 MB (~1,500 calls)
_warned: set[str] = set()


def _warn_once(key: str, message: str, *args: Any) -> None:
    """One WARNING per process per key, so a broken internal can't flood the log."""
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(message, *args)

POWER_TASKS = frozenset({"waypoint_ideas", "waypoint_ideas_2"})
_REASONING_KEYS = ("reasoning", "reasoning_effort", "thinking", "output_config")
_pending: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _find_reasoning(node: Any, depth: int = 0) -> dict[str, Any]:
    """Reasoning-related request fields, wherever the transport put them (top level or extra_body)."""
    found: dict[str, Any] = {}
    if depth > 3 or not isinstance(node, dict):
        return found
    for key, value in node.items():
        if key in _REASONING_KEYS and value not in (None, "", {}):
            found[key] = value
        elif isinstance(value, dict):
            for k, v in _find_reasoning(value, depth + 1).items():
                found.setdefault(k, v)
    return found


def sent_effort(found: dict[str, Any]) -> str:
    """One readable effort label from the request fields that were actually sent."""
    for key in ("output_config", "reasoning"):
        v = found.get(key)
        if isinstance(v, dict) and v.get("effort"):
            return "off" if v.get("enabled") is False else str(v["effort"])
    if isinstance(found.get("reasoning_effort"), str):
        return found["reasoning_effort"]
    thinking = found.get("thinking")
    if isinstance(thinking, dict):
        if thinking.get("budget_tokens"):
            return f"budget:{thinking['budget_tokens']}"
        if thinking.get("type"):
            return str(thinking["type"])
    return "none"


def configured_effort(task: str) -> str:
    try:
        from agent.auxiliary_task_config import _get_auxiliary_task_config

        return str(_get_auxiliary_task_config(task).get("reasoning_effort") or "default")
    except Exception:  # noqa: BLE001 - logging must never break a call
        return "unknown"


def _as_int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def format_line(rec: dict[str, Any]) -> str:
    u = rec.get("usage") or {}
    out = f"out={_as_int(u.get('output_tokens'))}"
    if (rec.get("provider") or "").lower() == "anthropic":
        out += " (incl. thinking)"  # Anthropic bills thinking inside output_tokens
    elif _as_int(u.get("reasoning_tokens")):
        out += f" reasoning={_as_int(u.get('reasoning_tokens'))}"
    cache = ""
    if _as_int(u.get("cache_read_tokens")) or _as_int(u.get("cache_write_tokens")):
        cache = f" cache_read={_as_int(u.get('cache_read_tokens'))} cache_write={_as_int(u.get('cache_write_tokens'))}"
    if rec.get("tokens") == "unknown" or not u:
        tokens = "unknown"
    else:
        tokens = f"in={_as_int(u.get('input_tokens'))} {out}{cache} total={_as_int(u.get('total_tokens'))}"
    return (
        f"Waypoint power-up call: task={rec['task']} model={rec.get('response_model') or rec.get('model') or '?'} "
        f"effort={rec.get('effort_sent', 'none')} (configured={rec.get('effort_configured', '?')}) "
        f"time={float(rec.get('seconds') or 0):.2f}s tokens {tokens} "
        f"finish={rec.get('finish_reason') or '-'} status={rec.get('status', '?')}"
    )




def _write_jsonl(rec: dict[str, Any]) -> None:
    try:
        from hermes_constants import get_hermes_home

        folder = get_hermes_home() / "plugin-data" / "waypoint"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "power-calls.jsonl"
        if path.exists() and path.stat().st_size > LOG_MAX_BYTES:
            path.replace(folder / "power-calls.1.jsonl")  # keep one previous file, drop older
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
    except Exception:  # noqa: BLE001
        logger.debug("waypoint: could not append power-calls.jsonl", exc_info=True)


def on_pre_auxiliary_call(**kw: Any) -> None:
    if kw.get("aux_task") not in POWER_TASKS:
        return
    request = kw.get("request") if isinstance(kw.get("request"), dict) else {}
    body = request.get("body") or {}
    found = _find_reasoning(body)
    with _lock:
        _pending[str(kw.get("api_request_id") or "")] = {
            "effort_sent": sent_effort(found),
            "reasoning_fields": found,
            "max_tokens": kw.get("max_tokens") or (body.get("max_tokens") if isinstance(body, dict) else None),
        }
        while len(_pending) > 50:  # never grow without bound if a post event is lost
            _pending.pop(next(iter(_pending)))


def on_post_auxiliary_call(**kw: Any) -> None:
    task = kw.get("aux_task")
    if task not in POWER_TASKS:
        return
    with _lock:
        pre = _pending.pop(str(kw.get("api_request_id") or ""), {})
    usage = kw.get("usage") if isinstance(kw.get("usage"), dict) else {}
    known = any(_as_int(usage.get(k)) for k in ("input_tokens", "output_tokens", "total_tokens"))
    reason = ""
    if not known:
        reason = ("call failed" if kw.get("error") else
                  "Hermes reported no usage" if not usage else "Hermes reported 0 tokens")
    rec = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(kw.get("ended_at") or time.time())),
        "task": task,
        "model": kw.get("model"),
        "response_model": kw.get("response_model"),
        "provider": kw.get("provider"),
        "effort_configured": configured_effort(task),
        "effort_sent": pre.get("effort_sent", "unknown"),
        "reasoning_fields": pre.get("reasoning_fields", {}),
        "max_tokens": pre.get("max_tokens"),
        "seconds": round(float(kw.get("api_duration") or 0.0), 3),
        "tokens": "known" if known else "unknown",
        "tokens_reason": reason or None,
        "usage": {k: usage.get(k) for k in ("input_tokens", "output_tokens", "reasoning_tokens",
                                             "cache_read_tokens", "cache_write_tokens", "prompt_tokens",
                                             "total_tokens", "usage_source") if k in usage} if known else None,
        "usage_fallback": _fallback["state"],
        "finish_reason": kw.get("finish_reason"),
        "retry_count": kw.get("retry_count"),
        "status": "error" if kw.get("error") else "ok",
        "error_type": kw.get("error_type"),
    }
    logger.info(format_line(rec))
    if not known and not kw.get("error"):
        _warn_once("unknown", "Waypoint: Power up token counts are unknown (%s; usage fallback: %s). "
                   "Model, effort and time are still logged.", reason, _fallback["state"])
    _write_jsonl(rec)


def register(ctx) -> None:
    ctx.register_auxiliary_task(
        "waypoint_ideas",
        display_name="Waypoint power up (model 1)",
        description=(
            "Strong model 1 in Waypoint's Power up menu, also used for the optional "
            "automatic big idea. Pick a strong model here, e.g. Claude Opus."
        ),
    )
    ctx.register_auxiliary_task(
        "waypoint_ideas_2",
        display_name="Waypoint power up (model 2)",
        description="Strong model 2 in Waypoint's Power up menu, e.g. Claude Sonnet.",
    )
    ctx.register_hook("pre_auxiliary_call", on_pre_auxiliary_call)
    ctx.register_hook("post_auxiliary_call", on_post_auxiliary_call)
