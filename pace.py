#!/usr/bin/env python3
"""pace: how heavy is this Claude Code session, and how do sessions trend.

Reads only what Claude Code provides: status-line JSON, hook JSON, transcripts.
No model calls, nothing injected into the model's context.
"""
import argparse
import glob
import json
import os
import statistics
import sys
import time
import tomllib
from datetime import datetime, timezone

STATE = os.path.expanduser(os.environ.get("PACE_STATE", "~/.local/state/pace"))
CONFIG = os.path.expanduser(os.environ.get("PACE_CONFIG", "~/.config/pace/config.toml"))
PROJECTS = os.path.expanduser(os.environ.get("PACE_PROJECTS", "~/.claude/projects"))

DEFAULTS = {
    "warn": 150_000,
    "high": 250_000,
    "cold_warn": 100_000,
    "cache_ttl": 3600,
    "expiring": 300,
    "hint": "fresh session",
}

GREEN, YELLOW, RED, DIM, RESET = "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[0m"


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG, "rb") as f:
            cfg.update(tomllib.load(f))
    except FileNotFoundError:
        pass
    return cfg


def k(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1000:
        return f"{n / 1000:.0f}K"
    return str(n)


def context_of(usage):
    return (usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
            + usage.get("cache_creation_input_tokens", 0))


def assistant_usages(lines):
    """Yield (timestamp, model, usage) once per API response.

    Streaming writes several transcript lines per response, all carrying the
    same message id and usage, so only the first one counts.
    """
    seen = set()
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("type") != "assistant":
            continue
        m = r.get("message")
        if not isinstance(m, dict) or not m.get("usage") or m.get("model") == "<synthetic>":
            continue
        key = (m.get("id"), r.get("requestId"))
        if key in seen:
            continue
        seen.add(key)
        yield r.get("timestamp", ""), m.get("model", "?"), m["usage"]


def footprint(transcript):
    """Summarise one session from its transcript plus its subagent transcripts."""
    fp = {"turns": 0, "peak_ctx": 0, "start_ctx": 0, "last_ctx": 0, "cache_read": 0,
          "cache_write": 0, "output": 0, "start": "", "end": "", "models": {}}
    try:
        with open(transcript, errors="ignore") as f:
            for ts, model, u in assistant_usages(f):
                ctx = context_of(u)
                if not fp["turns"]:
                    fp["start"], fp["start_ctx"] = ts, ctx
                fp["turns"] += 1
                fp["end"], fp["last_ctx"] = ts, ctx
                fp["peak_ctx"] = max(fp["peak_ctx"], ctx)
                fp["models"][model] = fp["models"].get(model, 0) + 1
                _add_spend(fp, u)
    except FileNotFoundError:
        return None
    sub = os.path.join(transcript[:-len(".jsonl")], "subagents")
    for path in glob.glob(os.path.join(sub, "**", "*.jsonl"), recursive=True):
        with open(path, errors="ignore") as f:
            for _, _, u in assistant_usages(f):
                _add_spend(fp, u)
    return fp


def _add_spend(fp, u):
    fp["cache_read"] += u.get("cache_read_input_tokens", 0)
    fp["cache_write"] += u.get("cache_creation_input_tokens", 0)
    fp["output"] += u.get("output_tokens", 0)


# ---------- status ----------

def _tail_state(sid, transcript):
    """Turns and current context, reading only transcript lines added since last call."""
    path = os.path.join(STATE, "status", f"{sid}.json")
    st = {"offset": 0, "turns": 0, "last_ctx": 0, "last_ts": "", "seen": []}
    try:
        with open(path) as f:
            st.update(json.load(f))
    except (FileNotFoundError, ValueError):
        pass
    try:
        size = os.path.getsize(transcript)
    except OSError:
        return st
    if size < st["offset"]:
        st.update(offset=0, turns=0, seen=[])
    with open(transcript, "rb") as f:
        f.seek(st["offset"])
        chunk = f.read()
    end = chunk.rfind(b"\n") + 1
    seen = set(st["seen"])
    for line in chunk[:end].decode(errors="ignore").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        m = r.get("message")
        if r.get("type") != "assistant" or not isinstance(m, dict) or not m.get("usage"):
            continue
        if m.get("model") == "<synthetic>" or m.get("id") in seen:
            continue
        seen.add(m.get("id"))
        st["turns"] += 1
        st["last_ctx"] = context_of(m["usage"])
        st["last_ts"] = r.get("timestamp", "")
    st["offset"] += end
    st["seen"] = list(seen)[-50:]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(st, f)
    return st


def _parse_ts(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def status_line(data, cfg, now=None):
    now = now or time.time()
    sid = data.get("session_id", "unknown")
    st = _tail_state(sid, data.get("transcript_path", ""))

    cw = data.get("context_window") or {}
    cur = cw.get("current_usage")
    ctx = context_of(cur) if isinstance(cur, dict) else st["last_ctx"]

    pc = data.get("prompt_cache") or {}
    expires = pc.get("expires_at")
    if not expires:
        last = _parse_ts(st["last_ts"])
        expires = last + cfg["cache_ttl"] if last else None
    warm = pc.get("warm") if "warm" in pc else (expires is not None and expires > now)

    colour = GREEN if ctx < cfg["warn"] else YELLOW if ctx < cfg["high"] else RED
    parts = [f"{colour}ctx {k(ctx)}{RESET}", f"{st['turns']} turns"]
    if ctx and not warm:
        recache = pc.get("recache_tokens_if_cold") or ctx
        if recache >= cfg["cold_warn"]:
            parts.append(f"{RED}cache cold · {k(recache)} re-write · fresh start is cheaper{RESET}")
        else:
            parts.append(f"{DIM}cache cold{RESET}")
    elif expires:
        left = max(0, expires - now)
        tone = YELLOW if left <= cfg["expiring"] else DIM
        parts.append(f"{tone}cache {int(left // 60)}m{RESET}")
    if ctx >= cfg["high"] and cfg.get("hint"):
        parts.append(f"{RED}↻ {cfg['hint']}{RESET}")
    return " · ".join(parts)


def cmd_status(_args):
    raw = sys.stdin.read()
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(os.path.join(STATE, "last-status-input.json"), "w") as f:
            f.write(raw)
        print(status_line(json.loads(raw), load_config()))
    except Exception as e:  # the status line must never break the UI
        print(f"pace: {type(e).__name__}")


def _clock(epoch, now):
    if not epoch:
        return "?"
    left = int(epoch - now)
    if left <= 0:
        return "passed"
    h, m = divmod(left // 60, 60)
    return f"in {h}h{m:02d}m" if h else f"in {m}m"


def now_report(data, cfg, now=None):
    """Everything about the current session, from the last status-line input."""
    now = now or time.time()
    st = _tail_state(data.get("session_id", "unknown"), data.get("transcript_path", ""))
    cw = data.get("context_window") or {}
    cur = cw.get("current_usage")
    ctx = context_of(cur) if isinstance(cur, dict) else st["last_ctx"]
    pc = data.get("prompt_cache") or {}
    cost = data.get("cost") or {}
    model = (data.get("model") or {}).get("display_name", "?")
    rows = [
        ("session", f"{data.get('session_name') or ''} {data.get('session_id', '?')[:8]}".strip()),
        ("model", model),
        ("context", f"{k(ctx)} of {k(cw.get('context_window_size') or 0)} "
                    f"({cw.get('used_percentage', '?')}%) · {st['turns']} turns"),
    ]
    if pc:
        state = "warm" if pc.get("warm") else "COLD"
        rows.append(("cache", f"{state} · ttl {pc.get('ttl', '?')} · expires "
                              f"{_clock(pc.get('expires_at'), now)} · re-write if cold "
                              f"{k(pc.get('recache_tokens_if_cold') or ctx)}"))
        hit = pc.get("hit_ratio")
        hit = f"{hit * 100:.0f}%" if isinstance(hit, (int, float)) else "?"
        miss = f"{pc.get('misses', 0)} misses"
        if pc.get("miss_recache_tokens"):
            miss += f" (re-wrote {k(pc['miss_recache_tokens'])})"
        cause = pc.get("last_miss_cause")
        if isinstance(cause, dict):
            cause = ", ".join(cause.get("causes") or [])
        if cause:
            miss += f" · last: {cause}"
        rows.append(("cache hits", f"{hit} of {pc.get('requests', '?')} requests · {miss}"))
    for name, rl in (data.get("rate_limits") or {}).items():
        rows.append((f"limit {name.replace('_', ' ')}",
                     f"{rl.get('used_percentage', '?')}% · resets {_clock(rl.get('resets_at'), now)}"))
    if cost:
        rows.append(("api-equiv cost", f"${cost.get('total_cost_usd', 0):.2f} · "
                                       f"{cost.get('total_duration_ms', 0) // 60000} min"))
    width = max(len(r[0]) for r in rows)
    return "\n".join(f"{a:<{width}}  {b}" for a, b in rows)


def cmd_now(_args):
    try:
        with open(os.path.join(STATE, "last-status-input.json")) as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError):
        print("no status-line input yet: is `pace status` wired as the statusLine command?")
        return
    print(now_report(data, load_config()))


# ---------- record ----------

def cmd_record(_args):
    data = json.loads(sys.stdin.read() or "{}")
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, "last-hook-input.json"), "w") as f:
        json.dump(data, f)
    fp = footprint(data.get("transcript_path", ""))
    if not fp or not fp["turns"]:
        return
    fp.update(session_id=data.get("session_id"), cwd=data.get("cwd"),
              end_reason=data.get("reason"))
    fp.pop("last_ctx")
    with open(os.path.join(STATE, "sessions.jsonl"), "a") as f:
        f.write(json.dumps(fp) + "\n")
    try:
        os.remove(os.path.join(STATE, "status", f"{data.get('session_id')}.json"))
    except OSError:
        pass


# ---------- report / baseline ----------

def all_sessions():
    """Recorded sessions, plus backfill from transcripts not yet recorded."""
    out = {}
    try:
        with open(os.path.join(STATE, "sessions.jsonl")) as f:
            for line in f:
                s = json.loads(line)
                out[s["session_id"]] = s
    except FileNotFoundError:
        pass
    for path in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")):
        sid = os.path.basename(path)[:-len(".jsonl")]
        if sid in out:
            continue
        fp = footprint(path)
        if fp and fp["turns"]:
            fp.update(session_id=sid, cwd=os.path.basename(os.path.dirname(path)))
            out[sid] = fp
    return list(out.values())


def _period(s, by):
    d = datetime.fromisoformat(s["start"][:10])
    if by == "week":
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}"
    return s["start"][:10]


def cmd_report(args):
    cfg = load_config()
    sessions = [s for s in all_sessions() if s["start"][:10] >= (args.since or "")
                and s["turns"] >= args.min_turns]
    if not sessions:
        print("no sessions")
        return
    groups = {}
    for s in sessions:
        groups.setdefault(_period(s, args.by), []).append(s)
    print(f"{args.by:<11}{'sessions':>9}{'turns':>7}{'peak':>7}{f'>{k(cfg['high'])}':>7}"
          f"{'start':>7}{'read/day':>10}")
    for p in sorted(groups):
        g = groups[p]
        days = len({s["start"][:10] for s in g})
        print(f"{p:<11}{len(g):>9}{statistics.median(s['turns'] for s in g):>7.0f}"
              f"{k(statistics.median(s['peak_ctx'] for s in g)):>7}"
              f"{sum(s['peak_ctx'] >= cfg['high'] for s in g):>7}"
              f"{k(statistics.median(s['start_ctx'] for s in g)):>7}"
              f"{k(sum(s['cache_read'] for s in g) // days):>10}")
    total = sum(s["cache_read"] for s in sessions)
    top = sorted(sessions, key=lambda s: -s["cache_read"])[:args.top]
    share = sum(s["cache_read"] for s in top) / total * 100 if total else 0
    print(f"\ntop {len(top)} sessions = {share:.0f}% of cache reads")
    for s in top:
        print(f"  {s['start'][:16].replace('T', ' ')}  {s['turns']:>4} turns  "
              f"peak {k(s['peak_ctx']):>5}  read {k(s['cache_read']):>6}  {s['session_id'][:8]}")


def cmd_baseline(args):
    sessions = sorted((s for s in all_sessions() if s["turns"] >= 3), key=lambda s: s["start"])
    days = {}
    for s in sessions[-args.n:]:
        days.setdefault(s["start"][:10], []).append(s["start_ctx"])
    for d, v in sorted(days.items()):
        print(f"{d}  {len(v):>3} sessions  start ctx median {k(statistics.median(v))}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="pace", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="verb", required=True)
    sub.add_parser("status", help="status line: reads the status-line JSON on stdin")
    sub.add_parser("now", help="details of the current session: cache, limits, cost")
    sub.add_parser("record", help="SessionEnd hook: append this session's footprint")
    r = sub.add_parser("report", help="sessions per period, biggest sessions")
    r.add_argument("--since", help="YYYY-MM-DD")
    r.add_argument("--by", choices=["day", "week"], default="week")
    r.add_argument("--top", type=int, default=5)
    r.add_argument("--min-turns", type=int, default=3)
    b = sub.add_parser("baseline", help="starting context of recent sessions")
    b.add_argument("-n", type=int, default=40, help="last N sessions")
    args = p.parse_args(argv)
    {"status": cmd_status, "now": cmd_now, "record": cmd_record, "report": cmd_report,
     "baseline": cmd_baseline}[args.verb](args)


if __name__ == "__main__":
    main()
