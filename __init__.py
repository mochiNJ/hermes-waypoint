"""Waypoint — Python half.

Registers two auxiliary tasks, ``waypoint_ideas`` and ``waypoint_ideas_2``: the
two strong models offered by Waypoint's Power up menu. Pick their models like any
other auxiliary model (Hermes Settings, or
``hermes config set auxiliary.waypoint_ideas.model <model>``). Unset, they resolve
like any auxiliary task ("auto", the cheap model).

No tools, no hooks, no network access of its own. The desktop half
(desktop/plugin.js) calls this task through Hermes's ``llm.oneshot`` only when
the user has turned AI suggestions on.
"""


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
