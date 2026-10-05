# pace — design

Status: v1 built, dogfooding from 2026-10-03. Personal testing first; its own public repo once it has proven itself.

## What it is

A Claude Code mod (≥ 2.1.287): an in-process plugin that shows how heavy a session is at the moment
it changes, warns before the prompt cache goes cold, and parks a session so the next one can pick it
up. Generic: it reads only what Claude Code hands it (`turn.step` usage, `$.session.*`) and takes its
settings through `userConfig`. No knowledge of any work tracker, repo or employer.

## Why

The cost of a session is roughly *context size × turns*: every turn re-reads the whole context.
Long sessions get expensive without any signal, and returning to a big session after the prompt
cache expired re-writes the whole context at write price (1.25–2× input instead of 0.1×).
Claude Code has point-in-time views (`/context`, `/usage`, `/cost`) but no live nudge.

## Principles

- **Zero standing context cost.** Toasts, the band and panes are user-only. Nothing is injected
  into the model's context.
- **Deterministic.** No model calls, except the optional topic check.
- **Tokens, not time.** Session length is measured as context and turns; wall-clock time is not a
  cost signal.
- **Nudge, never act.** No auto-`/clear`, no auto-compact, no blocking.
- **Generic.** Thresholds and the hint text come from `userConfig`; the mod knows no workflow.

## When the cache is cold


The next turn re-writes the whole context at write price (2× input on the 1-hour cache, against 0.1×
for a read). A fresh session restarts from the baseline and every later turn re-reads less, so:
cold and small → continue; cold and large with state recorded → fresh session; cold and large
without state → one turn to record it, then clear. The real goal is never to hit it: clear before
a break longer than the TTL.

## Surfaces

One standing surface and four on demand. Status line (`$.ui.status`, text only: the engine draws ANSI escapes as U+FFFD, so a dot carries the colour, 🟢 under `warn`, 🟡 under `high`, 🔴 above): `ctx 182K · 45 turns · cache 41m`, refreshed
after each request and on the 15 s tick; `⚠` from `warn`, `⏳ cache 3m` under `expiring_minutes`, `❄ cache cold · 310K
re-write` once cold and past `cold_warn`; the hint after `↻` from `high` or when cold and big; cleared on `/clear`.
Toast: one per crossing. Band row (`AbovePrompt`): the one state that needs an action, with its buttons. Pane:
`/pace-now`, park, resume. Prompt box: resume. Nothing drawn enters the model's context.

## Signals

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
creep (a trend across sessions, out of scope), limits and cost (account, not session: the pane).

Each toast fires once per crossing and again only after the value drops back. The band shows one pace row,
priority `cold` > `expiring` > `heavy`, hidden while a turn runs, and always renders `next(e)` beneath it so
other mods' rows stack. The suggestion at the end of a message is `hint` from config (`fresh session` by
default), so workflow wording ("save state, then /clear") lives in the user's config, not in pace.

## Work check

The one model call, and a cycle rather than a per-prompt test. At `topic_at` (100K) Haiku reads the last 10
prompts and writes one line: the baseline, shown after `on:` on the status line and toasted once. Every
`topic_every` (100K of context growth) it reads the last 10 prompts again, with the baseline and the previous
reading, and answers `{now, same_task, why}`. Every reading is kept for the session (`/pace-now` lists them:
started, then, now). A reading that is not the same task toasts the history (started · N ago · now) and marks
the status line with `⇄`; the next reading comes at the next interval, nothing is held or blocked. A failed or
unparsable reply backs off 20K before the next try. `/clear` empties the readings. Interval, not per prompt:
slow drift over several prompts is invisible to a sliding window and visible against a fixed baseline, and the
cost is bounded by the context, not by how often you type.

## Park and resume

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

## Settings asked at install (`userConfig`)

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
| `status_line` | `colour` | `plain` drops the dot; `off` hides the line |
| `topic_check` | `on` | `off` stops the Haiku calls |
| `topic_at` | 100 000 | context at which the baseline reading is taken |
| `topic_every` | 100 000 | context growth between readings |

Every setting has a default, so installing with Enter through the dialog works; `/plugin configure` and
`/config` change them later, applied after `/reload-plugins` or in the next session.

## Commands

`/pace-now` (pane: context, window %, turns, cache countdown, last request read/write, re-writes, limits,
cost, active signals), `/pace-park`, `/pace-resume`, `/pace-dismiss` (hide the alert row), `/pace-close` (close the
panes), `/pace-help` (commands, keys, how to turn things off). All run without a model turn. The mod
bundles a small skill, `pace:help`, that answers questions about its alerts and settings.

Keys (Claude Code's own): every pace pane opens with focus, so Esc closes it at once. Ctrl+X then Tab moves focus
from the prompt into the band and the open panes; Tab and the arrows move between buttons, Enter presses, a button's
hotkey presses it, Ctrl+X then X closes a pane, Ctrl+X then an arrow resizes it, Esc returns to the prompt.
Commands are the dependable path; the buttons are for when the band or pane holds focus.

`$.state` resets on `/clear`, `/resume` and `/branch` without a new `session.start`, so resume points are scanned
again from `classic.SessionStart` with those sources.

## Extension contract

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


## Not in scope

Automatic actions, dollar figures, trends across sessions, any integration with a specific
tracker (extensions do that through the contract above).
