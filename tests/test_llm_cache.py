import datetime as dt
import json
import os
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest import mock

from livemusic import usage
from livemusic.sources import llm as L

VENUE = {"name": "Le Trabendo", "slug": "le-trabendo", "url": "https://letrabendo.net/"}
PAGE = "\n".join(f"<p>Concert {i} — {10 + i % 18} octobre — 20h</p>" for i in range(40))
USAGE = NS(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0, cache_creation_input_tokens=0)


def answer(params):
    """The fake model: one event per 'Concert N' line of the chunk it was sent."""
    chunk = params["messages"][0]["content"]
    events = [{"title": ln.split(" — ")[0], "date": "2026-10-10"} for ln in chunk.split("\n") if ln.startswith("Concert")]
    return NS(content=[NS(type="text", text=json.dumps({"events": events}))], stop_reason="end_turn",
              model=params["model"], usage=USAGE)


class FakeBatches:
    def __init__(self, finish_after=0):
        self.created, self.polls, self.finish_after = [], 0, finish_after

    def create(self, requests):
        self.created.append(requests)
        return NS(id=f"b{len(self.created)}", processing_status="in_progress")

    def retrieve(self, bid):
        self.polls += 1
        return NS(id=bid, processing_status="ended" if self.polls > self.finish_after else "in_progress")

    def results(self, bid):
        for r in self.created[int(bid[1:]) - 1]:
            yield NS(custom_id=r["custom_id"], result=NS(type="succeeded", message=answer(r["params"])))


class FakeClient:
    def __init__(self, **kw):
        self.messages = NS(batches=FakeBatches(**kw), create=mock.Mock(side_effect=lambda **p: answer(p)))


class LlmCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.page = PAGE
        patches = [mock.patch.object(L, "CACHE_PATH", os.path.join(self.tmp.name, "llm_cache.json")),
                   mock.patch.object(L, "get", lambda url: self.page),
                   mock.patch.object(L, "llm_available", lambda: True),
                   mock.patch.object(L, "CHUNK_CHARS", 600)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        usage.reset()

    def ctx(self, day=27, **kw):
        today = dt.date(2026, 9, 27) + dt.timedelta(days=day - 27)
        return dict(today=today, horizon_days=120, log=lambda m: None, poll_seconds=0, **kw)

    def run_day(self, client, day=27):
        ctx = self.ctx(day)
        L.prefetch([VENUE], ctx, client=client)
        with mock.patch("anthropic.Anthropic", lambda: client):
            return L.scrape(VENUE, ctx)

    def test_batch_then_cache_next_day(self):
        c = FakeClient()
        got = self.run_day(c)
        self.assertEqual(len(got), 40)
        parts = len(c.messages.batches.created[0])
        self.assertGreater(parts, 2)
        c.messages.create.assert_not_called()               # everything went through the batch
        self.assertIn("batched calls", "\n".join(usage.summary()))

        c2 = FakeClient()
        self.page = PAGE.replace("Concert 0 ", "Concert zero ")   # tomorrow: one line changed at the top
        got = self.run_day(c2, day=28)
        self.assertEqual(len(got), 40)
        self.assertEqual(len(c2.messages.batches.created[0]), 1)   # only the changed part is paid for again

        c3 = FakeClient()
        self.assertEqual(len(self.run_day(c3, day=29)), 40)
        self.assertEqual(c3.messages.batches.created, [])          # nothing changed: no call at all

    def test_cache_expires(self):
        self.run_day(FakeClient())
        c = FakeClient()
        self.run_day(c, day=27 + L.CACHE_DAYS)       # within the window: reused
        self.assertEqual(c.messages.batches.created, [])
        c2 = FakeClient()
        self.run_day(c2, day=28 + L.CACHE_DAYS)      # one day later: extracted again
        self.assertEqual(len(c2.messages.batches.created), 1)

    def test_batch_still_running_fails_the_venue_and_is_collected_next_run(self):
        c = FakeClient(finish_after=10**9)
        ctx = self.ctx()
        with mock.patch.object(L, "BATCH_WAIT", 0):
            L.prefetch([VENUE], ctx, client=c)
        with self.assertRaises(L.FetchError):                    # REM-46 keeps yesterday's events
            L.scrape(VENUE, ctx)
        c.messages.create.assert_not_called()                    # not paid twice

        c.messages.batches.finish_after = 0                      # next day: the old batch has ended
        c.messages.batches.polls = 0
        ctx2 = self.ctx(28)
        L.prefetch([VENUE], ctx2, client=c)
        self.assertEqual(len(c.messages.batches.created), 1)     # collected, no new batch
        with mock.patch("anthropic.Anthropic", lambda: c):
            self.assertEqual(len(L.scrape(VENUE, ctx2)), 40)

    def test_lost_batch_is_dropped_and_polling_errors_do_not_pay_twice(self):
        import anthropic
        c = FakeClient(finish_after=10**9)
        with mock.patch.object(L, "BATCH_WAIT", 0):
            L.prefetch([VENUE], self.ctx(), client=c)
        resp = mock.Mock(status_code=500, headers={})
        c.messages.batches.retrieve = mock.Mock(side_effect=anthropic.InternalServerError("boom", response=resp, body=None))
        ctx = self.ctx(28)
        L.prefetch([VENUE], ctx, client=c)
        with self.assertRaises(L.FetchError):          # still pending: not asked again directly
            L.scrape(VENUE, ctx)
        c.messages.create.assert_not_called()

        resp = mock.Mock(status_code=404, headers={})
        c.messages.batches.retrieve = mock.Mock(side_effect=anthropic.NotFoundError("gone", response=resp, body=None))
        c.messages.batches.create = mock.Mock(return_value=NS(id="b9", processing_status="ended"))
        L.prefetch([VENUE], self.ctx(29), client=c)
        c.messages.batches.create.assert_called_once()  # forgotten, a new batch is sent

    def test_direct_fallback_when_batch_refused(self):
        import anthropic
        c = FakeClient()
        err = anthropic.APIConnectionError(request=mock.Mock())
        c.messages.batches.create = mock.Mock(side_effect=err)
        got = self.run_day(c)
        self.assertEqual(len(got), 40)
        self.assertGreater(c.messages.create.call_count, 2)

    def test_chunks_are_content_defined(self):
        text = "\n".join(f"line {i} " + "x" * 40 for i in range(400))
        a = L._chunks(text, 2000)
        b = L._chunks("new first line\n" + text, 2000)
        self.assertTrue(all(len(c) <= 2000 for c in a))
        self.assertGreaterEqual(len(set(a) & set(b)), len(a) - 2)   # an insertion only changes its own chunk

    def test_old_cache_format_is_dropped(self):
        with open(L.CACHE_PATH, "w") as f:
            json.dump({"le-trabendo": {"digest": "x", "today": "2026-09-25", "events": []}}, f)
        self.assertEqual(L._cache_load(), {})


if __name__ == "__main__":
    unittest.main()
