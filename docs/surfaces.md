# How pace talks to you

A mod is only useful if it reaches you where you already look. pace uses six of the surfaces
Claude Code gives a mod, each for one job, and nothing it draws enters the model's context.

| Surface | Where | pace uses it for | Lives |
|---|---|---|---|
| **Status line** | one line under the prompt | the standing figures with a dot coloured by cost, and the work reading after `on:` | always; refreshed after each request and every 15 s; `/clear` drops it |
| **Toast** | a short notice that fades | each crossing, once: `heavy`, `jump`, `rewrite`, `expiring`; the work baseline and each change of work; park and resume confirmations | a few seconds |
| **Band row** | a row above the prompt with buttons | the one signal that needs an action, with `park` and `dismiss`; the resume points for this folder | until it clears, or you dismiss it |
| **Pane** | a framed region beside the transcript | `/pace-now` figures and the work history; the park dialog; the resume list | until you close it |
| **Prompt box** | the text you are about to send | resume puts the note there, so you read it before anything reaches the model | until you send or clear it |
| **Slash commands** | `/pace-…` | one word for each of the above, so nothing depends on a button being visible | — |

The rules behind the split:

- **The status line is the only standing surface.** Everything else appears when something
  happened and goes away.
- **A toast marks a moment; a band row marks a state.** A big tool result or a cache re-write gets
  a toast and nothing more. A cold cache stays true until you act, so it gets a row that stays, with
  the action next to it.
- **The work check only toasts.** A change of work is information, not an emergency: one toast
  with the history, a `⇄` on the status line, and the next reading at the next interval. Nothing is
  held.
- **Nothing standing is model-facing.** Every surface above is drawn for you. The work check is
  the only model call, it goes to Haiku, and its answer comes back as a toast and a few words on
  the status line, not as context.
- **Every button has a command.** The band and the panes can be hidden by a narrow terminal;
  `/pace-park`, `/pace-resume`, `/pace-dismiss` and `/pace-close` do the same from the prompt.

## Signals

| Signal | Means | Shown as |
|---|---|---|
| `heavy` | the context is past `warn`, and every turn re-reads it | a toast at `warn`, a band row while above `high` |
| `jump` | one step (a big file or log) added `big_result` tokens or more | a toast naming the tool |
| `expiring` | the cache goes cold in `expiring_minutes` while you are idle | a toast, then a countdown row |
| `cold` | the cache went cold and the context is past `cold_warn`, so the next prompt re-writes it all | a band row until the next turn or `/clear` |
| `rewrite` | the cache was rebuilt mid-session, for example after a model switch | a toast naming the cause |
| `topic` | the work read at this interval is a different task from the baseline | a toast with started · then · now, and `⇄` on the status line |

Each toast fires once per crossing. Only one pace row shows in the band at a time: cold, then
expiring, then heavy.
