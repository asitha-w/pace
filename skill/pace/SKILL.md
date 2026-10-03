---
name: pace
description: How heavy Claude Code sessions are — the current session (context, cache, misses, limits, cost) and the trend across sessions. Use when the user asks how big or costly this session is, whether the cache is cold, whether to start fresh, or how their sessions are trending.
---

# pace

`pace` is a CLI on the PATH. It reads Claude Code's own data and calls no model. Run the command,
print its output as-is, and add at most one line of interpretation.

| The user says | Run |
|---|---|
| "how heavy is this session" / "is the cache cold" / "my limits" | `pace now` |
| "how are my sessions" / "this week" / "since <date>" | `pace report [--since YYYY-MM-DD] [--by day]` |
| "biggest sessions" | `pace report --top 10` |
| "is my setup getting heavier" / "starting context" | `pace baseline` |

Reading the numbers: every turn re-reads the whole context, so cost is context × turns. When the
cache is cold, the next turn re-writes the whole context at write price; a fresh session from saved
state is cheaper when the context is large. The status line (`pace status`) and the session-end
record (`pace record`) are wired in settings and are not run by hand.
