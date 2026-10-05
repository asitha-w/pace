# Commands and keys

| Command | Does |
|---|---|
| `/pace-now` | opens a pane: context, window %, turns, cache countdown, last request read/write, re-writes, rate limits, cost, active signals, and the work readings (started, then, now) |
| `/pace-park` | writes a resume point; a small dialog picks the target and whether to add a summary |
| `/pace-resume` | lists the resume points for this folder |
| `/pace-dismiss` | hides the alert row until it clears |
| `/pace-close` | closes the pace panes |
| `/pace-help` | commands, keys, and how to turn things off |

None of these uses a model turn. The bundled `pace:help` skill answers questions about the alerts
in plain words.

## Keys

Claude Code's own. Every pace pane opens with focus, so `Esc` closes it at once.

- `Ctrl+X` then `Tab`: move focus from the prompt into the band row and the open panes
- `Tab` and the arrows: move between buttons; `Enter` or the digit presses
- `Ctrl+X` then `X`: close a pane; `Ctrl+X` then an arrow: resize it
- `Esc`: back to the prompt

Commands are the dependable path; the buttons are for when the row or pane holds focus.

## The band row

One row above the prompt, only while a state needs an action, in this priority: cold, expiring,
heavy. `[1 park]` opens the park dialog, `[2 dismiss]` hides the row until the state clears.

After `/clear`, or in a new session in this folder, the row lists the newest resume point:
`[3 resume]` puts it in the prompt box, `[4 discard]` deletes it, `[5 all]` lists every one.
