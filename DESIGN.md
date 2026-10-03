# pace — design

Status: v1 built and wired, dogfooding from 2026-10-03. Personal testing first; its own public repo once it has proven itself.

## What it is

A small CLI that shows how heavy a Claude Code session is while you work, and how sessions trend
over time. Generic: it reads only what Claude Code itself provides (status-line JSON, hook JSON,
transcripts). No knowledge of any work tracker, repo or employer.

## Why

The cost of a session is roughly *context size × turns*: every turn re-reads the whole context.
Long sessions get expensive without any signal, and returning to a big session after the prompt
cache expired re-writes the whole context at write price (1.25–2× input instead of 0.1×).
Claude Code has point-in-time views (`/context`, `/usage`, `/cost`) but no live nudge and no trend.

## Principles

- **Zero standing context cost.** Everything the user sees comes through the status line or
  user-only hook output. Nothing is injected into the model's context by default.
- **Deterministic.** No model calls. Reading JSON and counting tokens.
- **Tokens, not time.** Session length is measured as peak context and turns; wall-clock time is
  not a cost signal.
- **Nudge, never act.** No auto-`/clear`, no auto-compact, no blocking by default.
- **Generic.** Thresholds and the hint text come from config; the tool knows no workflow.
- **Stdlib only.** Python 3.11+, no dependencies.

## Surface

| Command | Called by | Does |
|---|---|---|
| `pace status` | `statusLine` setting | one coloured line: context, turns, cache state, hint |
| `pace now` | user / skill | details of the current session: cache, misses, limits, cost |
| `pace record` | `SessionEnd` hook | appends the session's footprint to the local log |
| `pace report [--since D] [--top N]` | user / skill | one screen: per day, biggest sessions, trend |
| `pace baseline` | user | starting-context size of recent sessions, to catch setup creep |

Plus a small skill (`pace`) so the user can ask in their own words ("how heavy are my sessions this
week") and Claude runs the right command. Its description is the only standing context cost.

## Status line (v1 core)

Input: the status-line JSON on stdin. Confirmed against a live capture (Claude Code 2.1.288,
sample in `tests/fixtures/status_input.json`). Fields used:

| Field | Use |
|---|---|
| `session_id`, `transcript_path` | turn count from the transcript |
| `context_window.current_usage` | current context = input + cache read + cache write |
| `context_window.{context_window_size, used_percentage}` | `pace now` |
| `prompt_cache.{warm, ttl, expires_at}` | cache countdown and cold state |
| `prompt_cache.recache_tokens_if_cold` | exact re-write size for the cold warning |
| `prompt_cache.{requests, hit_ratio, misses, miss_recache_tokens, last_miss_cause}` | `pace now`; `last_miss_cause` is an object `{"causes": [...]}` |
| `rate_limits.{five_hour, seven_day}.{used_percentage, resets_at}` | `pace now` only |
| `cost.{total_cost_usd, total_duration_ms}` | `pace now` only |

Also present, unused: `exceeds_200k_tokens`, `prompt_cache.miss_causes`, `expected_rebuilds`,
`effort`, `thinking`, `fast_mode`, `session_name`. Fields may be absent on older versions or early in
a session; every one has a fallback (context and cache expiry from the transcript).

Output, one line, ANSI colour:

```
ctx 182K · 45 turns · cache 41m
ctx 182K · 45 turns · cache 3m                      (countdown yellow below `expiring`)
ctx 312K · 120 turns · cache 52m · ↻ fresh session
ctx 310K · 120 turns · cache cold · 310K re-write · fresh start is cheaper
```

- Colour by context: green < `warn`, yellow < `high`, red above.
- Turns are counted from the transcript, cached per session by file offset so each call reads
  only new lines (measured 34 ms on a 150K session).
- The countdown turns yellow below `expiring` (5 min): the moment to record state and clear before
  a break.
- Past `high`, append `hint` from config.
- Cold cache above `cold_warn`: red re-write warning, sized from `recache_tokens_if_cold`. Below it,
  a quiet "cache cold": a small re-write is not worth a fresh start.
- Limits and cost stay out of the line; they are in `pace now`.

Must never fail loudly: on any error print `pace: <ErrorType>`. Every call saves its input to
`$STATE/last-status-input.json`, which is what `pace now` reads.

### When the cache is cold

The next turn re-writes the whole context at write price (2× input on the 1-hour cache, against 0.1×
for a read). A fresh session restarts from the baseline and every later turn re-reads less, so:
cold and small → continue; cold and large with state recorded → fresh session; cold and large
without state → one turn to record it, then clear. The real goal is never to hit it: clear before
a break longer than the TTL.

## Hooks

| Hook | v1? | Purpose |
|---|---|---|
| `SessionEnd` → `pace record` | yes | footprint log, so history survives transcript cleanup (`cleanupPeriodDays`, 30 days default) |
| `Stop` threshold nudge | later | only if the status line proves too easy to ignore, and only if user-only output is confirmed |
| `PostToolUse` big-result alert | later | "that result added 60K"; same condition |
| `SessionStart` baseline line | later | `context_tokens` is provided; same condition |

Hook output that reaches the model's context (`additionalContext`, plain stdout on
`SessionStart`/`UserPromptSubmit`) is never used. Whether `systemMessage` stays user-only is
unconfirmed; the spike settles it before any nudge hook is built.

The three "later" hooks are superseded by the mod below: its output is user-only by construction,
so the `systemMessage` question no longer gates them.

## Mod

A Claude Code mod (≥ 2.1.287) in `mod/`: an in-process plugin that shows pace's signals at the
moment they happen and parks a session so the next one can pick it up. Mod-native and self-contained:
it reads only what Claude Code hands it (`turn.step` usage, `$.session.*`), takes its settings through
`userConfig`, and neither calls nor reads the CLI. The CLI (status line, record, report) is unchanged.

### Signals

Cost is context × turns, and the prompt cache decides whether a turn re-reads the context cheaply or
re-writes it. Every signal is a change in one of those two things; pace says what happened and what it
costs, never what workflow to follow.

| Signal | Means | Detected from | Default display |
|---|---|---|---|
| `heavy` | every turn re-reads a lot of context | context ≥ `warn` (toast once), ≥ `high` (band) | toast at `warn`, band row while ≥ `high` |
| `jump` | one step added ≥ `big_result` tokens | prompt growth between two consecutive requests, attributed to the previous step's tools | toast |
| `expiring` | the cache window closes while idle | last request + `cache_ttl` − now ≤ `expiring` | toast on entry, band row counting down |
| `cold` | the window closed; the next prompt re-writes the context | idle past `cache_ttl` with context ≥ `cold_warn` | band row until the next turn or `/clear` |
| `rewrite` | the cache was rebuilt mid-session without a break | a request reads < 50 % of the previous prompt from cache although the gap was under `cache_ttl` | toast with the cause (model switch, or unknown) |
| `topic` | a new task started in a big session | see Topic check | toast, two reminders, then a band row |

Per-request usage comes from a `turn.step` hook (main loop only, subagents ignored); live context, limits
and cost from `$.session.usage()`. Not live signals: turns (an explanation, shown in the pane), baseline
creep (a trend: `pace report`, `pace baseline`), limits and cost (account, not session: the pane).

Each toast fires once per crossing and again only after the value drops back. The band shows one pace row,
priority `cold` > `expiring` > `heavy`, hidden while a turn runs, and always renders `next(e)` beneath it so
other mods' rows stack. The suggestion at the end of a message is `hint` from config (`fresh session` by
default), so workflow wording ("save state, then /clear") lives in the user's config, not in pace.

### Topic check

The one signal that needs meaning, not counts, so the one model call pace makes; on by default (`topic_check`),
off in `/plugin configure pace`.

- Trigger, all must hold, on every prompt the person types (`origin.kind` `composer`): `topic_check` is `when heavy`;
  context ≥ `warn`; the prompt is substantive (≥ 6 words, not a `/command`, not a resume note); at least 3 earlier
  substantive prompts; no topic warning open and not dismissed.
- Check: `$.model.complete` on Haiku with the last 5 prompts (300 chars each) and the new one (600), asking for
  `{same_task, why}`; a few hundred tokens, nothing enters the session's context, the prompt is never held.
- `same_task: false` → `topic` enter: a 10 s toast naming the change and `/pace-park`. Reminders as `topic` update
  toasts at the end of the 1st and 3rd turn after; then only the band row (priority cold > expiring > topic > heavy).
- Closes on park, `/clear`, or dismiss; dismiss also stops checks until the context drops below `warn` or `/clear`.
- Not `$.agent.spawn` (an agent loop for a yes/no) and not `$.model.fork` (re-reads the whole context each check).

### Park and resume

Park writes one small markdown file, a resume point, so a fresh session can pick up where this one stopped.

- Offered from the band (`[p] park` on `heavy`, `expiring`, `cold`) and `/pace-park`. A dialog pane picks the
  target and whether to add a summary.
- Content: facts, always (session, cwd, branch, context, turns, the signal, the last prompts, files touched;
  from the transcript, no model) and a summary on request (`$.model.fork`: one tool-less question over the
  cached transcript, cache-read priced while warm; the dialog defaults it off on a cold cache).
- Targets: `note` (a new file in `park_dir`, default) and `append` (to the last file parked to). Extension
  mods add targets (see contract).
- Resume: at session start the band lists the resume points for this folder (`resume_scope`), newest first:
  `[r] resume` puts the note's text into the prompt box, and the file is deleted when that prompt is sent
  (cleared instead of sent, it stays). `[d] discard` deletes it. Points older than 7 days collapse into one
  `[c] clear` line. Nothing reaches the model until the user sends.

### Settings asked at install (`userConfig`)

| Key | Default | Choices |
|---|---|---|
| `park_dir` (directory) | `~/.local/state/pace/parked` | any folder |
| `summary` | `warm` | `never`, `warm`, `always` |
| `resume_scope` | `folder` | `folder`, `everywhere` |
| `warn` | 150 000 | context that toasts `heavy` once |
| `high` | 250 000 | context that keeps the `heavy` band row |
| `cold_warn` | 100 000 | context below which a cold cache is not worth a row |
| `big_result` | 30 000 | tokens one step must add to be a `jump` |
| `cache_ttl_minutes` | 60 | the prompt-cache lifetime (5 or 60) |
| `expiring_minutes` | 5 | when the countdown starts |
| `hint` | `suggestion: start a new session` | the suggestion after `heavy` and `cold` |
| `topic_check` | `when heavy` | `off` stops the Haiku call |

Every setting has a default, so installing with Enter through the dialog works; `/plugin configure` and
`/config` change them later.

### Commands

`/pace-now` (pane: context, window %, turns, cache countdown, last request read/write, re-writes, limits,
cost, active signals), `/pace-park`, `/pace-resume`, `/pace-dismiss` (hide the alert row), `/pace-close` (close the
panes), `/pace-help` (commands, keys, how to turn things off). All run without a model turn. `/pace` stays the CLI
skill; the mod bundles a small skill, `pace:help`, that answers questions about its alerts and settings.

Keys (Claude Code's own): every pace pane opens with focus, so Esc closes it at once. Ctrl+X then Tab moves focus
from the prompt into the band and the open panes; Tab and the arrows move between buttons, Enter presses, a button's
hotkey presses it, Ctrl+X then X closes a pane, Ctrl+X then an arrow resizes it, Esc returns to the prompt.
Commands are the dependable path; the buttons are for when the band or pane holds focus.

`$.state` resets on `/clear`, `/resume` and `/branch` without a new `session.start`, so resume points are scanned
again from `classic.SessionStart` with those sources.

### Extension contract

The mod adds the noun `$.pace` (contract `mod/types/index.d.ts`); each method call is an event another mod
hooks by listing `"dependencies": ["pace"]`:

| Event | Argument | Pace's own answer | An extension can |
|---|---|---|---|
| `pace.signal` | `PaceSignal` (`kind`, `phase` enter/update/clear, `metrics`, `text`, `hint`) | toast / band | observe (log to a tracker, a file), rewrite `text`/`hint`, answer to replace the display |
| `pace.targets` | — | `note`, `append` | add `{ id, label }` entries to the park dialog |
| `pace.park` | `{ target, reason, summary }` | writes the note for its targets | handle its own target ids (a tracker item, a GitHub issue) |
| `pace.now` | — | current metrics | read them (a pane of its own) |

Extensions are separate mods kept outside pace; anything that writes outside the machine is installed on
purpose.

## Footprint record

`~/.local/state/pace/sessions.jsonl`, one line per session end:

```json
{"session_id":"…","cwd":"…","start":"…","end":"…","turns":45,"peak_ctx":182340,
 "start_ctx":56120,"cache_read":7900000,"cache_write":410000,"output":120000,
 "models":{"claude-opus-5-5":45},"end_reason":"clear"}
```

`report` reads this log and, for sessions not yet recorded, the transcripts directly (backfill).
Subagent transcripts count toward their parent session.

## Config

`~/.config/pace/config.toml`, all optional:

```toml
warn = 150_000        # yellow
high = 250_000        # red + hint
cold_warn = 100_000   # show cold-cache warning above this
expiring = 300        # seconds; countdown turns yellow
cache_ttl = 3600      # fallback when prompt_cache is absent
hint = "fresh session"
```

## Report

```
pace report --since 2026-09-19
            sessions  turns(med)  peak(med)  >high  start(med)  cache-read/day
2026-09-19…    97         45        149K       9       56K           77M
top sessions: <date> <cwd> 631 turns, peak 905K, 349M read …
```

Tokens only. An optional price table may come later; no prices are built in.

## Plan

1. ~~Capture real input~~: done for the status line. Hook input is captured to
   `$STATE/last-hook-input.json` on the first `SessionEnd`; whether `systemMessage` reaches the model
   is still open (only matters for the later nudge hooks).
2. **v1:** `status`, `now`, `record`, `report`, `baseline`, config: built, 22 tests
   (`python3 -m unittest tests.test_pace`), the skill (`skill/pace/SKILL.md`, symlinked into
   `~/.claude/skills/pace`), entry point `~/.local/bin/pace` → `pace.py`.
3. **Dogfood (2 weeks):** wired into one workspace's `.claude/settings.local.json`; compare
   `report` before and after.
4. **Decide on nudge hooks** from what the dogfood shows.
5. **Publish:** own repo, README with the two settings snippets; plugin packaging only if others
   want it.

## Not in scope

Topic-switch detection (needs a model), automatic actions, dollar figures, any integration with a
specific tracker. Any link to other tools goes through `session_id`, from the other tool's side.
