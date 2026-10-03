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
