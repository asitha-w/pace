# pace

**Know when a Claude Code session is getting expensive, and leave it cleanly.**

pace is a Claude Code mod. It keeps one coloured line under the prompt with the size of the session
and the life left in its prompt cache, speaks up when the session gets heavy or the cache is about
to go cold, and saves where you are so a fresh session picks up from there. It only nudges: it never
clears, compacts or blocks anything, and nothing it shows enters the model's context.

![pace: session → measure → status line and signals → park → next session](docs/overview.svg)

## Why

Every turn re-reads the whole context, so a session costs roughly **context × turns**. A long
session gets expensive without any signal. Coming back after the prompt cache has expired is
worse: the next turn re-writes the whole context at write price (1.25–2× input) instead of read
price (0.1×). Claude Code has point-in-time views (`/context`, `/usage`, `/cost`), but it gives you
no live nudge. pace adds one.

## What it does

1. **It measures.** After every request to the model it reads the usage block the engine hands
   back and keeps the context size, the time of the request and what the cache did. Subagent
   requests are ignored. A 15-second clock watches the cache lifetime between requests.
2. **It shows a standing line** under the prompt: context size, turn count, minutes of cache
   left, coloured by cost. Green under `warn`, yellow under `high`, red above. A countdown in
   the last `expiring_minutes` of cache life, a cold mark with the re-write size once the cache
   has died. The `hint` text appears past `high`, or when the cache is cold and the context big.
3. **It raises six signals**, each once per crossing:
   - `heavy`: context past `warn`, then a persistent row past `high`
   - `jump`: one step added `big_result` tokens or more, named by the tool that did it
   - `expiring`: the cache dies in under `expiring_minutes` while you are idle
   - `cold`: the cache died and the context is over `cold_warn`, so the next prompt re-writes it all
   - `rewrite`: the cache was rebuilt mid-session, for example after a model switch
   - `topic`: you started a different task in a session already past `warn`
4. **It shows them on the right surface.** A moment gets a toast that fades. A state that needs
   an action gets a row above the prompt with two buttons, `park` and `dismiss`. Only one row
   shows at a time, in this priority: cold, expiring, topic, heavy.
5. **It runs one small model call**, the topic check. Past `warn` it sends your last few prompts
   and the new one to Haiku and asks whether the task changed. A few hundred tokens, nothing
   added to your session. Off with one setting.
6. **It parks.** `/pace-park` or the button writes one small markdown file: folder, branch,
   context size, turns, the signal, your last prompts, the files touched, and a model-written
   summary while the cache is still warm, so it is cheap.
7. **It resumes.** After `/clear`, or in a new session in the same folder, a row lists the
   resume points. `resume` puts the note into your prompt box; you read it, you send it, the
   file is deleted. `discard` deletes it. Nothing reaches the model until you send.
8. **It answers on demand.** `/pace-now` opens a pane with context, window percent, turns, cache
   countdown, re-writes, rate limits, cost and active signals. `/pace-help` explains the rest.
   No command uses a model turn.
9. **It is configurable** at install or later: every threshold, the cache lifetime, the hint
   text, the summary on park, the status line, the topic check.
10. **It is extendable.** Another mod can listen to its signals, reword them, or add a park
    target such as a work tracker. Neither side depends on the other.

## The status line

```
ctx 62K · 12 turns · cache 52m                                               green
⚠ ctx 182K · 45 turns · cache 41m                                            yellow
⚠ ctx 182K · 45 turns · ⏳ cache 3m · ↻ park before a break                  countdown
⚠ ctx 312K · 120 turns · cache 52m · ↻ suggestion: start a new session       red
⚠ ctx 310K · 120 turns · ❄ cache cold · 310K re-write · ↻ suggestion: …      cold and big
ctx 40K · 12 turns · cache cold                                              cold and small: cheap, carry on
```

The context part is coloured by cost, the cache part by state. It is the only standing surface
pace has, and it is quiet by design: the same three fields every time, so you can read it without
reading it. `status_line` = `plain` drops the colour, `off` hides the line. The line disappears on
`/clear`.

## How pace talks to you

A mod is only useful if it reaches you where you already look. pace uses six of the surfaces
Claude Code gives a mod, each for one job, and nothing it draws enters the model's context.

| Surface | Where | pace uses it for | Lives |
|---|---|---|---|
| **Status line** | one line under the prompt | the standing figures, coloured by cost | always; refreshed after each request and every 15 s; `/clear` drops it |
| **Toast** | a short notice that fades | each crossing, once: `heavy`, `jump`, `rewrite`, `expiring`, `topic`; park and resume confirmations | a few seconds |
| **Band row** | a row above the prompt with buttons | the one signal that needs an action, with `park` and `dismiss`; the resume points for this folder with `resume`, `discard`, `all` | until it clears, or you dismiss it |
| **Pane** | a framed region beside the transcript | `/pace-now` figures; the park dialog (target, summary on/off); the resume list | until you close it (`Esc`, `Ctrl+X X`, or `/pace-close`) |
| **Prompt box** | the text you are about to send | resume puts the note there, so you read it before anything reaches the model | until you send or clear it |
| **Slash commands** | `/pace-…` | one word for each of the above, so nothing depends on a button being visible | — |

The rules behind the split:

- **The status line is the only standing surface.** Everything else appears when something
  happened and goes away.
- **A toast marks a moment; a band row marks a state.** Something that happened once (a big tool
  result, a cache re-write) gets a toast and nothing more. Something that stays true until you act
  (a cold cache, a new topic in a heavy session) gets a row that stays, with the action next to it.
- **Nothing standing is model-facing.** Every surface above is drawn for you. The topic check is
  the only model call, it goes to Haiku, and its answer comes back as a toast, not as context.
- **Every button has a command.** The band and the panes can be hidden by a narrow terminal;
  `/pace-park`, `/pace-resume`, `/pace-dismiss` and `/pace-close` do the same from the prompt.
- **Keys.** `Ctrl+X` then `Tab` focuses the band and panes, `Tab` and the arrows move, `Enter` or
  the digit presses, `Esc` returns to the prompt.

## Install

Requires Claude Code 2.1.287 or later.

Claude Code loads a plugin folder placed in `~/.claude/skills/` in every session:

```sh
git clone https://github.com/asitha-w/pace.git
ln -s "$PWD/pace" ~/.claude/skills/pace
```

pace loads in the next session as `pace@skills-dir`. To try it in a single session instead, run
`claude --plugin-dir ./pace`.

## Commands

| Command | Does |
|---|---|
| `/pace-now` | opens a pane with context, window %, turns, cache countdown, re-writes, limits, cost and active signals |
| `/pace-park` / `/pace-resume` | write a resume point / list resume points |
| `/pace-dismiss` / `/pace-close` | hide the alert row / close the panes |
| `/pace-help` | lists commands, keys, and how to turn things off |

None of these commands uses a model turn. The bundled `pace:help` skill answers questions about the
alerts in plain words.

## Settings

You set these at install. Change them later with `/plugin configure pace` or in `/config`. Every
setting has a default.

| Setting | Default |
|---|---|
| `status_line` (`colour` / `plain` / `off`) | `colour` |
| `warn` / `high` / `cold_warn` | 150 000 / 250 000 / 100 000 |
| `big_result` | 30 000 |
| `cache_ttl_minutes` / `expiring_minutes` | 60 / 5 |
| `hint` | `suggestion: start a new session` |
| `topic_check` (`off` / `when heavy`) | `when heavy` |
| `park_dir` | `~/.local/state/pace/parked` |
| `summary` (`never` / `warm` / `always`) | `warm` |
| `resume_scope` (`folder` / `everywhere`) | `folder` |

## Extending

pace adds a `$.pace` noun with four events: `pace.signal`, `pace.targets`, `pace.park` and
`pace.now`. Another mod that lists `"dependencies": ["pace"]` can use them to log signals, reword
them, or add park targets such as an issue tracker. The contract is in
[`types/index.d.ts`](types/index.d.ts).

## Related projects

[Cairn](https://github.com/asitha-w/cairn) (`crn`) keeps your work as a graph of plain markdown
nodes: what each piece of work is doing, what it waits on, and what was decided. The two projects
split the job:

- **pace** tells you when to leave a session.
- **Cairn** remembers where the work stands, so the next session starts small.

They connect through pace's extension contract. A small mod can answer `pace.targets` and
`pace.park` to park straight into a Cairn work node, for example as a `crn log` line. Neither
project depends on the other.

## Development

```sh
claude plugin validate .
claude plugin test .
```

The design and the reasoning behind each threshold are in [DESIGN.md](DESIGN.md).
