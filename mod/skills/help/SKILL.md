---
name: help
description: The pace mod's alerts, commands, keys and settings — what a pace toast or band row means, how to park and resume a session, and how to turn a signal or the Haiku topic check off. Use when the user asks about a pace toast, the alert row above the prompt, parking or resume points, or pace settings.
---

# pace mod

Answer from this page; run nothing. `/pace-help` prints the same list without a model turn.

## Signals

| Signal | Means | What to suggest |
|---|---|---|
| heavy | the context is big; every turn re-reads it | finish the task, then a new session |
| jump | one step (a big file or log) added a lot at once | read a smaller slice next time |
| expiring | the prompt cache goes cold in a few minutes while idle | park before a break |
| cold | the cache went cold; the next prompt re-writes the whole context | continue if small, park and start fresh if big |
| rewrite | the cache was rebuilt mid-session (e.g. a model switch) | avoid the cause |
| topic | a new task started in a big session (checked by Haiku) | park, then start a new session |

The topic toast repeats twice at turn ends, then stays as a quiet row until parked, dismissed or `/clear`.

## Commands and keys

`/pace-now` figures · `/pace-park` write a resume point · `/pace-resume` list them · `/pace-dismiss` hide the
alert row · `/pace-close` close the panes. Ctrl+X then Tab focuses the alert row and panes; Enter or the digit
presses a button; Esc goes back to the prompt; Ctrl+X then X closes a pane.

Park writes one small markdown file (facts, plus a summary when chosen). After `/clear` the row offers resume:
the note fills the prompt box and the file is deleted when that prompt is sent.

## Turning things off

`/plugin configure pace` (or the pace rows in `/config`): "New topic check" = off stops every Haiku call; the
thresholds, cache lifetime and suggestion text are there too. `/plugin disable pace` turns the whole mod off.
