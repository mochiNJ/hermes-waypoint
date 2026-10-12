"""Waypoint — Python half.

Registers one auxiliary task, ``waypoint_ideas``, so the model behind Waypoint's
"big idea" suggestion can be picked like any other auxiliary model (Hermes
Settings, or ``hermes config set auxiliary.waypoint_ideas.model <model>``).
Unset, it resolves like any auxiliary task ("auto", the cheap model).

No tools, no hooks, no network access of its own. The desktop half
(desktop/plugin.js) calls this task through Hermes's ``llm.oneshot`` only when
the user has turned AI suggestions on.
"""


def register(ctx) -> None:
    ctx.register_auxiliary_task(
        "waypoint_ideas",
        display_name="Waypoint big ideas",
        description=(
            "Writes the one 'big idea' next-step suggestion in Waypoint (Hermes Desktop). "
            "Pick a strong model here, e.g. Claude Sonnet."
        ),
    )
