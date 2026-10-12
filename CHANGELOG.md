# Changelog

## 2.5.0 — 2026-10-12
- **Power up call log.** Each Power up call (strong model 1 or 2) now writes one line to the Hermes
  log (`logs/agent.log`, logger `plugins.waypoint`), for example:
  `Waypoint power-up call: task=waypoint_ideas model=claude-opus-5-5 effort=high (configured=high)
  time=11.70s tokens in=3648 out=991 (incl. thinking) total=4639 finish=stop status=ok`.
  It also adds one JSON record to `<HERMES_HOME>/plugin-data/waypoint/power-calls.jsonl`, which rolls
  over at about 1 MB and keeps one previous file. Each line has the model, the reasoning effort (as
  configured and as sent), the response time, token counts, the finish reason and success or
  error. **Your messages and the ideas are never logged.** It uses Hermes's public
  `pre_auxiliary_call` / `post_auxiliary_call` hooks and only reads the call; it never changes it.
- **`tokens unknown` instead of a misleading 0.** Some Hermes versions don't pass token counts to
  plugins for every provider. Today that includes the Anthropic route of auxiliary tasks, where
  the counts arrive as 0. When there are no usable counts, Waypoint logs `tokens unknown`, adds a
  `tokens_reason` to the record (for example `Hermes reported 0 tokens`, `Hermes reported no
  usage`, `call failed`), and writes **one** WARNING per Hermes start explaining why. Model,
  effort and time are always logged. Real counts appear automatically once Hermes reports them.
- "My chat model" Power up calls go through the session's own model, outside the auxiliary tasks,
  so they aren't in this log.

## 2.4.0 — 2026-10-12
- **Power up model menu:** the arrow next to ⚡ Power up lets you pick **Strong model 1**, **Strong
  model 2** or **My chat model** with one click. Picking one runs Power up right away and remembers
  it as the default. The two strong models are auxiliary tasks `waypoint_ideas` and
  `waypoint_ideas_2`, so you can point them at e.g. Claude Opus 5.5 (with high reasoning) and
  Claude Sonnet 5.5, and rename them in Settings.
- More room for strong models that reason before answering.

## 2.3.0 — 2026-10-12
- **⚡ Power up** button (in the status card and on the "Next:" row): when you feel stuck, it asks
  your strong model for **3 sharper ways to continue**, using a longer slice of the chat. It runs
  only when you press it. The ideas replace the list until the chat moves on.
- The automatic background "big idea" is now **off by default**. Turn it on in Settings if you want it.
- Power-up model: the `waypoint_ideas` auxiliary model (e.g. Claude Sonnet 5.5) or **My chat
  model** (the open session's own model, e.g. Opus).
- Prompts keep JSON keys in English so Arabic replies always parse.

## 2.2.0 — 2026-10-12
- **Mark complete** button in the status card: turns the bar green and **stops suggestions** for
  that session (cached ideas are cleared, no more model calls). Choose Working to bring them back.
- **One big idea from a strong model.** Every suggestion set now includes one "big idea" written
  by a strong model (badge with the model name), refreshed at most every 10 minutes and only after
  4+ new messages, next to the cheap-model and quick ideas. The model is the auxiliary task
  `waypoint_ideas` (pick e.g. Claude Sonnet 5.5 in Hermes), or optionally the session's own model.
- **Priority colours:** green = important, yellow = less important, red = optional, on every idea
  in the card and on the "Next:" chips. Ideas are ordered by priority.

## 2.1.0 — 2026-10-12
- **Suggested next steps.** Every session gets 3 ideas for what to do next, shown in the status
  card and as one-click chips above the message box ("Next: …").
  - **Quick** ideas are instant and free: they come from offers the assistant just made
    ("Want me to…", "I can also…") plus sensible defaults for the session's status.
  - **AI** ideas (opt-in) are written by your auxiliary model, the same cheap model that writes
    session titles, from the last messages of the open session. They refresh automatically after
    a reply, at most once every 90 seconds and only after new messages.
  - **Ask** puts the suggestion's ready-made message in the chat box (you press send);
    **Make it my next step** saves it as the Working note.
- Status Board shows each Working session's top idea.
- Setting: AI suggestions Off / Tracked sessions / All sessions.

## 2.0.0 — 2026-10-12
- Status card (right-click / Shift+click): pick any state, 1–4 keys, Enter/Esc.
- Working → "next step" note; Done → outcome + Start fresh session + Archive.
- Waiting → who/what + reminder (tomorrow / 3 days / 1 week) at a chosen hour;
  in-app toast + native notification; pulsing bar when due; snooze to tomorrow.
- Resume banner above the composer ("Where you stopped …", Insert).
- Fresh start with handoff draft (`@session:` link + outcome + next step).
- Status Board page: columns, follow-ups due, stale detection, archive all done.
- Triage of recent untracked sessions.
- Status-bar counter, morning summary, ⌘K commands.
- Settings: click behaviour, reminder hour, hide grey bars, stale days, banner,
  digest, custom state names, backup/restore.
- English + Arabic (RTL); card placement beside the sidebar on either side.
- Data compatible with 1.x (statuses + waiting notes carry over).

## 1.x — 2026-10-12
- Sidebar status bar with grey / yellow / purple / green, waiting note + reminder.
