import copy
import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pace  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "status_input.json")
ANSI = re.compile(r"\033\[[0-9;]*m")
NOW = 1_791_000_000


def plain(s):
    return ANSI.sub("", s)


def usage(read, write=0, inp=1, out=10):
    return {"input_tokens": inp, "cache_read_input_tokens": read,
            "cache_creation_input_tokens": write, "output_tokens": out}


def assistant(mid, u, ts="2026-10-01T10:00:00Z", model="claude-opus-5-5"):
    return json.dumps({"type": "assistant", "timestamp": ts, "requestId": "r" + mid,
                       "message": {"id": mid, "model": model, "usage": u}})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, "state")
        self.projects = os.path.join(self.tmp, "projects")
        os.makedirs(os.path.join(self.projects, "p"))
        patches = [mock.patch.object(pace, "STATE", self.state),
                   mock.patch.object(pace, "PROJECTS", self.projects),
                   mock.patch.object(pace, "CONFIG", os.path.join(self.tmp, "none.toml"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.cfg = pace.load_config()

    def transcript(self, lines, sid="s1"):
        path = os.path.join(self.projects, "p", f"{sid}.jsonl")
        with open(path, "a") as f:
            f.write("\n".join(lines) + "\n")
        return path

    def status_input(self, transcript, **over):
        with open(FIXTURE) as f:
            d = json.load(f)
        d["transcript_path"] = transcript
        for key, val in over.items():
            d[key] = val
        return d


class TestTranscript(Base):
    def test_streamed_lines_count_once(self):
        path = self.transcript([assistant("a", usage(100)), assistant("a", usage(100)),
                                assistant("b", usage(200))])
        fp = pace.footprint(path)
        self.assertEqual(fp["turns"], 2)
        self.assertEqual(fp["cache_read"], 300)

    def test_peak_start_and_synthetic_ignored(self):
        path = self.transcript([assistant("a", usage(50_000, 6_000)),
                                assistant("b", usage(300_000)),
                                assistant("c", usage(0), model="<synthetic>"),
                                assistant("d", usage(120_000))])
        fp = pace.footprint(path)
        self.assertEqual(fp["turns"], 3)
        self.assertEqual(fp["start_ctx"], 56_001)
        self.assertEqual(fp["peak_ctx"], 300_001)

    def test_subagent_spend_counts_not_turns(self):
        path = self.transcript([assistant("a", usage(100))])
        sub = os.path.join(self.projects, "p", "s1", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-x.jsonl"), "w") as f:
            f.write(assistant("z", usage(1000)) + "\n")
        fp = pace.footprint(path)
        self.assertEqual(fp["turns"], 1)
        self.assertEqual(fp["cache_read"], 1100)

    def test_bad_lines_skipped(self):
        path = self.transcript(["not json", "{}", assistant("a", usage(10))])
        self.assertEqual(pace.footprint(path)["turns"], 1)

    def test_missing_transcript(self):
        self.assertIsNone(pace.footprint("/nope.jsonl"))


class TestIncremental(Base):
    def test_reads_only_new_lines(self):
        path = self.transcript([assistant("a", usage(100)), assistant("a", usage(100))])
        self.assertEqual(pace._tail_state("s1", path)["turns"], 1)
        self.transcript([assistant("b", usage(500))])
        st = pace._tail_state("s1", path)
        self.assertEqual(st["turns"], 2)
        self.assertEqual(st["last_ctx"], 501)

    def test_partial_last_line_waits(self):
        path = self.transcript([assistant("a", usage(100))])
        with open(path, "a") as f:
            f.write(assistant("b", usage(200))[:30])
        self.assertEqual(pace._tail_state("s1", path)["turns"], 1)

    def test_truncated_file_restarts(self):
        path = self.transcript([assistant("a", usage(1)), assistant("b", usage(1))])
        pace._tail_state("s1", path)
        with open(path, "w") as f:
            f.write(assistant("c", usage(7)) + "\n")
        st = pace._tail_state("s1", path)
        self.assertEqual((st["turns"], st["last_ctx"]), (1, 8))


class TestStatusLine(Base):
    def line(self, ctx=None, cache=None, **over):
        d = self.status_input(self.transcript([assistant("a", usage(1))]), **over)
        if ctx is not None:
            d["context_window"]["current_usage"] = usage(ctx, inp=0)
        if cache is not None:
            d["prompt_cache"].update(cache)
        return pace.status_line(d, self.cfg, now=NOW)

    def test_fixture_warm(self):
        out = self.line(cache={"warm": True, "expires_at": NOW + 2520})
        self.assertEqual(plain(out), "ctx 146K · 1 turns · cache 42m")
        self.assertIn(pace.GREEN, out)

    def test_colour_levels_and_hint(self):
        self.assertIn(pace.GREEN, self.line(ctx=100_000))
        mid = self.line(ctx=200_000)
        self.assertIn(pace.YELLOW, mid)
        self.assertNotIn("fresh session", mid)
        high = self.line(ctx=300_000)
        self.assertIn(pace.RED, high)
        self.assertIn("↻ fresh session", plain(high))

    def test_expiring_turns_yellow(self):
        out = self.line(ctx=10, cache={"warm": True, "expires_at": NOW + 200})
        self.assertIn(f"{pace.YELLOW}cache 3m", out)

    def test_cold_large_uses_recache(self):
        out = plain(self.line(ctx=150_000, cache={"warm": False, "recache_tokens_if_cold": 310_000}))
        self.assertIn("cache cold · 310K re-write · fresh start is cheaper", out)

    def test_cold_small_is_quiet(self):
        out = plain(self.line(ctx=20_000, cache={"warm": False, "recache_tokens_if_cold": 20_000}))
        self.assertIn("cache cold", out)
        self.assertNotIn("re-write", out)

    def test_no_cache_block_falls_back_to_transcript(self):
        path = self.transcript([assistant("a", usage(120_000), ts="2026-10-01T10:00:00Z")])
        d = {"session_id": "x", "transcript_path": path}
        later = pace._parse_ts("2026-10-01T12:00:00Z")
        out = plain(pace.status_line(d, self.cfg, now=later))
        self.assertIn("ctx 120K", out)
        self.assertIn("120K re-write", out)

    def test_status_never_raises(self):
        buf = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO("{broken")), redirect_stdout(buf):
            pace.cmd_status(None)
        self.assertTrue(buf.getvalue().startswith("pace: "))

    def test_config_overrides(self):
        with open(os.path.join(self.tmp, "c.toml"), "w") as f:
            f.write('high = 100\nhint = "save state, then /clear"\n')
        with mock.patch.object(pace, "CONFIG", os.path.join(self.tmp, "c.toml")):
            self.cfg = pace.load_config()
        self.assertIn("↻ save state, then /clear", plain(self.line(ctx=500)))


class TestNow(Base):
    def test_fixture_details(self):
        d = self.status_input(self.transcript([assistant("a", usage(1))]))
        out = pace.now_report(d, self.cfg, now=NOW)
        for want in ("Opus 5.5", "146K of 1.0M (15%)", "warm · ttl 1h", "re-write if cold 143K",
                     "94% of 35 requests · 1 misses (re-wrote 115K) · last: ttl_expired_1h",
                     "limit five hour  4%", "limit seven day  3%", "$4.09"):
            self.assertIn(want, out)

    def test_sparse_input(self):
        out = pace.now_report({"session_id": "x"}, self.cfg, now=NOW)
        self.assertIn("context", out)


class TestRecordAndReport(Base):
    def run_cmd(self, fn, stdin="", args=None):
        buf = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO(stdin)), redirect_stdout(buf):
            fn(args)
        return buf.getvalue()

    def test_record_appends_and_clears_status(self):
        path = self.transcript([assistant(str(i), usage(1000 * i)) for i in range(1, 5)])
        pace._tail_state("s1", path)
        self.run_cmd(pace.cmd_record, json.dumps({"session_id": "s1", "transcript_path": path,
                                                  "reason": "clear", "cwd": "/w"}))
        with open(os.path.join(self.state, "sessions.jsonl")) as f:
            rec = json.loads(f.read())
        self.assertEqual((rec["turns"], rec["end_reason"], rec["peak_ctx"]), (4, "clear", 4001))
        self.assertFalse(os.path.exists(os.path.join(self.state, "status", "s1.json")))

    def test_record_empty_session_writes_nothing(self):
        self.run_cmd(pace.cmd_record, json.dumps({"session_id": "s0", "transcript_path": "/nope"}))
        self.assertFalse(os.path.exists(os.path.join(self.state, "sessions.jsonl")))

    def test_report_and_baseline(self):
        for sid, day, peak in (("a", "01", 300_000), ("b", "01", 50_000), ("c", "08", 80_000)):
            self.transcript([assistant(sid + str(i), usage(peak if i == 2 else 40_000),
                                       ts=f"2026-09-{day}T08:0{i}:00Z") for i in range(3)], sid=sid)
        args = mock.Mock(since="2026-09-01", by="day", top=2, min_turns=3)
        out = self.run_cmd(pace.cmd_report, args=args)
        self.assertRegex(out, r"2026-09-01\s+2\s+3\s+175K\s+1\s+40K")
        self.assertIn("top 2 sessions", out)
        out = self.run_cmd(pace.cmd_baseline, args=mock.Mock(n=10))
        self.assertIn("2026-09-08    1 sessions  start ctx median 40K", out)

    def test_recorded_session_not_backfilled_twice(self):
        path = self.transcript([assistant(str(i), usage(10)) for i in range(3)])
        self.run_cmd(pace.cmd_record, json.dumps({"session_id": "s1", "transcript_path": path}))
        self.assertEqual(len(pace.all_sessions()), 1)


if __name__ == "__main__":
    unittest.main()
