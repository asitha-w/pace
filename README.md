# pace

pace shows how heavy a Claude Code session is while you work, warns you before the prompt cache
goes cold, and shows how your sessions trend over weeks.

## Why

Every turn re-reads the whole context, so a session costs roughly **context × turns**. A long
session gets expensive without any signal. Coming back after the prompt cache has expired is
worse: the next turn re-writes the whole context at write price (1.25–2× input) instead of read
price (0.1×). Claude Code has point-in-time views (`/context`, `/usage`, `/cost`), but it gives no
live nudge and no history. pace adds both.

## Principles

- **No context cost.** pace shows everything to you through the status line, toasts and a band row.
  It never injects anything into the model's context.
- **Nudge, never act.** pace never runs `/clear` or compacts for you, and it blocks nothing. It
  says what happened and what it costs. The suggestion text is yours to set, for example "save
  state, then /clear".
- **Tokens, not time.** pace measures a session by its context size and turn count, not by
  minutes.
- **Generic.** pace reads only what Claude Code provides. It knows nothing about your tracker, your
  repos or your workflow.
- **Deterministic.** pace calls no model, with one optional exception: the topic check (see
  below), which you can turn off.

## Two parts

| Part | What it is | Use it for |
|---|---|---|
| **CLI** (`pace.py`) | Python 3.11+, standard library only | status line, session history, trends |
| **Mod** (`mod/`) | a Claude Code mod, Claude Code ≥ 2.1.287 | live alerts in the session, park and resume |

The two parts work independently. The mod never calls the CLI.

## CLI

| Command | Run by | Does |
|---|---|---|
| `pace status` | the `statusLine` setting | prints one coloured line: context, turns, cache countdown, hint |
| `pace now` | you | shows the current session: context window %, cache, misses, rate limits, cost |
| `pace record` | the `SessionEnd` hook | appends the session's footprint to `~/.local/state/pace/sessions.jsonl` |
| `pace report [--since D] [--top N]` | you | per-period table, biggest sessions, trend |
| `pace baseline` | you | starting context of recent sessions, to catch setup creep |

Status line examples:

```
ctx 182K · 45 turns · cache 41m
ctx 312K · 120 turns · cache 52m · ↻ fresh session
ctx 310K · 120 turns · cache cold · 310K re-write · fresh start is cheaper
```

The line is green below `warn`, yellow below `high` and red above it. The cache countdown turns
yellow in the last 5 minutes. That is the moment to save state and clear before a break.

### Install

```sh
git clone https://github.com/asitha-w/pace.git
ln -s "$PWD/pace/pace.py" ~/.local/bin/pace
ln -s "$PWD/pace/skill/pace" ~/.claude/skills/pace   # optional: ask Claude in plain words
```

Add this to `settings.json` (user or project):

```json
{
  "statusLine": { "type": "command", "command": "pace status", "refreshInterval": 60 },
  "hooks": {
    "SessionEnd": [ { "hooks": [ { "type": "command", "command": "pace record" } ] } ]
  }
}
```

### Config

All settings are optional. Put them in `~/.config/pace/config.toml`:

```toml
warn = 150_000        # yellow
high = 250_000        # red, and the hint appears
cold_warn = 100_000   # the cold-cache warning shows only above this
expiring = 300        # seconds before expiry when the countdown turns yellow
cache_ttl = 3600      # fallback when Claude Code does not report the cache lifetime
hint = "fresh session"
```

## Mod

The mod runs inside Claude Code. It alerts you at the moment something happens, and it can park a
session so the next session picks up where this one stopped.

### Signals

| Signal | Means | Shown as |
|---|---|---|
| `heavy` | the context is big, and every turn re-reads it | a toast at `warn`, a band row while above `high` |
| `jump` | one step (a big file or log) added ≥ `big_result` tokens | a toast |
| `expiring` | the cache goes cold in a few minutes while you are idle | a toast, then a countdown row |
| `cold` | the cache went cold, so the next prompt re-writes the whole context | a band row until the next turn or `/clear` |
| `rewrite` | the cache was rebuilt mid-session, for example after a model switch | a toast naming the cause |
| `topic` | you started a new task in a big session | a toast, two reminders, then a band row |

Each toast fires once per crossing. Only one pace row shows in the band at a time, in this
priority: cold > expiring > topic > heavy.

**Topic check.** This is pace's only model call. Once the context is past `warn`, pace sends your
last few prompts and the new one to Haiku. The call costs a few hundred tokens and adds nothing to
your session's context. Haiku answers whether the new prompt starts a different task. Set
`topic_check` to `off` to stop the call.

### Park and resume

`/pace-park` (or `[p]` on the band) writes a resume point: one small markdown file. It always holds
the facts: cwd, branch, context, turns, the signal, the last prompts and the files touched. It can
also hold a summary written by the model, which is cheap while the cache is warm.

After `/clear`, or in a new session, the band lists the resume points for this folder:

- `[r] resume` puts the note into the prompt box. The file is deleted once you send that prompt.
- `[d] discard` deletes the note.

Nothing reaches the model until you send.

### Commands

| Command | Does |
|---|---|
| `/pace-now` | opens a pane with context, window %, turns, cache countdown, re-writes, limits, cost and active signals |
| `/pace-park` / `/pace-resume` | write a resume point / list resume points |
| `/pace-dismiss` / `/pace-close` | hide the alert row / close the panes |
| `/pace-help` | lists commands, keys, and how to turn things off |

None of these commands uses a model turn. The bundled `pace:help` skill answers questions about the
alerts in plain words.

### Settings

You set these at install. Change them later with `/plugin configure pace` or in `/config`. Every
setting has a default.

| Setting | Default |
|---|---|
| `park_dir` | `~/.local/state/pace/parked` |
| `summary` (`never` / `warm` / `always`) | `warm` |
| `resume_scope` (`folder` / `everywhere`) | `folder` |
| `warn` / `high` / `cold_warn` | 150 000 / 250 000 / 100 000 |
| `big_result` | 30 000 |
| `cache_ttl_minutes` / `expiring_minutes` | 60 / 5 |
| `hint` | `suggestion: start a new session` |
| `topic_check` (`off` / `when heavy`) | `when heavy` |

### Extending

The mod adds a `$.pace` noun with four events: `pace.signal`, `pace.targets`, `pace.park` and
`pace.now`. Another mod that lists `"dependencies": ["pace"]` can use them to log signals, reword
them, or add park targets such as an issue tracker. The contract is in
[`mod/types/index.d.ts`](mod/types/index.d.ts).

## Tests

```sh
python3 -m unittest tests.test_pace   # CLI
claude plugin test                    # mod, run from mod/
```

## Status

pace is being dogfooded. The mod lives on branch `mod-v1` and is not merged yet. The design and
the reasoning behind each threshold are in [DESIGN.md](DESIGN.md).
