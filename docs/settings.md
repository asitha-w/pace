# Settings

Set at install, changed later with `/plugin configure pace` or in `/config`. Every setting has a
default; a change applies after `/reload-plugins` or in the next session.

| Setting | Default | What it moves |
|---|---|---|
| `status_line` | `colour` | the line under the prompt: `colour` leads with a dot, `plain` has none, `off` hides the line |
| `warn` | 150 000 | context at which the dot turns yellow, `⚠` appears and the `heavy` toast fires |
| `high` | 250 000 | context at which the dot turns red, the hint appears and the `heavy` band row stays |
| `cold_warn` | 100 000 | context below which a cold cache gets no warning: a small re-write is cheap |
| `big_result` | 30 000 | tokens one step must add to the context to count as a `jump` |
| `cache_ttl_minutes` | 60 | the prompt-cache lifetime the countdown runs from: 60 on the 1-hour cache, 5 on the 5-minute one |
| `expiring_minutes` | 5 | minutes before the cache goes cold when the countdown starts |
| `toast_seconds` | 30 | how long a signal toast stays on screen |
| `hint` | `suggestion: start a new session` | the text after `↻` once the session is past `high` or cold and big |
| `topic_check` | `on` | the work check; `off` never calls a model |
| `topic_at` | 100 000 | context at which Haiku takes the baseline reading of the work |
| `topic_every` | 100 000 | context growth between one reading and the next |
| `park_dir` | `~/.local/state/pace/parked` | where resume points are written |
| `summary` | `warm` | add a model-written summary to a resume point: `never`, `warm` (only while the cache is warm, cheap), `always` |
| `resume_scope` | `folder` | list resume points parked in this folder, or `everywhere` |

## The status line, by level

```
🟢 ctx 62K · 12 turns · cache 52m                                            under warn
🟢 ctx 120K · 14 turns · cache 59m · on: pace mod status line                 with the work reading
🟡 ⚠ ctx 182K · 45 turns · cache 41m                                         past warn
🟡 ⚠ ctx 182K · 45 turns · ⏳ cache 3m · ↻ park before a break               countdown
🔴 ⚠ ctx 312K · 120 turns · cache 52m · ↻ suggestion: start a new session    past high
🔴 ⚠ ctx 310K · 120 turns · ❄ cache cold · 310K re-write · ↻ suggestion: …   cold and big
🔴 ⚠ ctx 322K · 60 turns · cache 41m · ↻ suggestion: … · ⇄ on: k8s alerts   the work changed
🟢 ctx 40K · 12 turns · cache cold                                           cold and small: carry on
```

Claude Code draws the line under the prompt with the mod's name in front, so on screen it reads
`pace: 🟢 ctx 62K · …`. The dot is the colour: the status line draws text only, no ANSI colour. It
is the only standing surface pace has: the same fields every time, so you can read it without
reading it. It disappears on `/clear`.
