# Changelog

## 2.2.0 — 2026-10-13
- **Mark complete** button in the status card: turns the bar green and **stops suggestions** for
  that session (cached ideas are cleared, no more model calls). Choose Working to bring them back.
- **One big idea from a strong model.** Every suggestion set now includes one "big idea" written
  by a strong model (badge with the model name), refreshed at most every 10 minutes and only after
  4+ new messages, next to the cheap-model and quick ideas. The model is the auxiliary task
  `waypoint_ideas` (pick e.g. Claude Sonnet 5.5 in Hermes), or optionally the session's own model.
- **Priority colours:** green = important, yellow = less important, red = optional, on every idea
  in the card and on the "Next:" chips. Ideas are ordered by priority.

## 2.1.0 — 2026-10-13
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
