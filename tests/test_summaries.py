"""python -m unittest discover tests"""
import json
import os
import tempfile
import unittest

from livemusic import summaries as S
from livemusic.fetch import FetchError
from livemusic.model import Event


def ev(title, url="https://www.venue.fr/e/x", date="2099-01-10", **kw):
    kw.setdefault("venue", "La Salle")
    kw.setdefault("venue_slug", "salle")
    kw.setdefault("source", "test")
    return Event(title=title, date=date, url=url, **kw)


class FakeBlock:
    type = "text"

    def __init__(self, text):
        self.text = text


class FakeResp:
    stop_reason = "end_turn"

    def __init__(self, text):
        self.content = [FakeBlock(text)]


class FakeMessages:
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def create(self, **kw):
        self.calls.append(kw)
        return FakeResp(self.answer if isinstance(self.answer, str) else json.dumps(self.answer))


class FakeClient:
    def __init__(self, answer):
        self.messages = FakeMessages(answer)


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "summary_cache.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_shared_urls_and_candidates(self):
        prog = "https://www.venue.fr/programme"
        listed = [ev(f"Concert {i}", url=prog) for i in range(4)]
        own = ev("Solo", url="https://www.venue.fr/e/solo")
        described = ev("Described", url="https://www.venue.fr/e/d", description="the venue wrote something")
        no_url = ev("Nowhere", url=None)
        other = ev("Comedy", url="https://www.venue.fr/e/c", is_music=False)
        generic = ev("Front", url="https://www.venue.fr/")
        events = listed + [own, described, no_url, other, generic]
        self.assertEqual(S.shared_urls(events), {prog})
        self.assertEqual(S.candidates(events, generic_urls=["https://www.venue.fr/"]), [own])
        three = [ev(f"C{i}", url="https://www.venue.fr/e/3") for i in range(3)]   # 3 events on one url is still fine
        self.assertEqual(len(S.candidates(three)), 3)

    def test_cache_hit_and_negative_cache_need_no_llm(self):
        a, b, c = ev("A", url="https://v.fr/a"), ev("B", url="https://v.fr/b"), ev("C", url="https://v.fr/c")
        with open(self.cache, "w") as f:
            json.dump({a.id: {"summary": "Trio de jazz.", "date": a.date}, b.id: {"summary": "", "date": b.date}}, f)
        asked = []
        got = S.enrich([a, b, c], cache_path=self.cache, log=lambda *_: None, fetch_page=lambda u: "page " * 50,
                       ask_llm=lambda cl, m, batch: asked.append(batch) or {}, client=object())
        self.assertEqual(a.summary, "Trio de jazz.")
        self.assertIsNone(b.summary)                       # negative cache: not asked again
        self.assertEqual([x["id"] for x in asked[0]], [c.id])
        self.assertEqual(got["cached"], 1)

    def test_no_api_call_when_llm_off(self):
        a = ev("A", url="https://v.fr/a")
        calls = []
        S.enrich([a], llm=False, cache_path=self.cache, log=lambda *_: None,
                 fetch_page=lambda u: calls.append(u), ask_llm=lambda *x: calls.append(x), client=object())
        self.assertEqual(calls, [])
        self.assertIsNone(a.summary)
        self.assertFalse(os.path.exists(self.cache))

    def test_parse_answer(self):
        self.assertEqual(S.parse_answer('{"summaries": [{"id": "x", "summary": " Duo folk. "}, {"id": "y", "summary": ""}]}'),
                         {"x": "Duo folk.", "y": ""})
        fenced = '```json\n{"summaries": [{"id": "x", "summary": "Rap."}]}\n```'
        self.assertEqual(S.parse_answer(fenced), {"x": "Rap."})
        self.assertEqual(S.parse_answer('{"summaries": [{"id": "x", "summary": null}, {"id": 3}]}'), {"x": ""})
        for bad in ("", "no json here", '{"summaries": "nope"}', '{"summaries": [1, 2'):
            with self.assertRaises(ValueError, msg=bad):
                S.parse_answer(bad)

    def test_length_cap(self):
        long = "mot " * 200
        s = S.cap(long)
        self.assertLessEqual(len(s), S.MAX_LEN)
        self.assertTrue(s.endswith("…"))
        self.assertNotIn("  ", s)
        self.assertEqual(S.cap("« Court. »"), "Court.")
        self.assertEqual(S.cap(None), "")

    def test_end_to_end_with_fake_client_writes_cache(self):
        a, b = ev("A", url="https://v.fr/a"), ev("B", url="https://v.fr/b")
        client = FakeClient({"summaries": [{"id": a.id, "summary": "Quatuor à cordes, programme Haydn. " * 20},
                                           {"id": b.id, "summary": ""}]})
        got = S.enrich([a, b], cache_path=self.cache, log=lambda *_: None, fetch_page=lambda u: "texte de la page " * 20, client=client)
        self.assertEqual(len(client.messages.calls), 1)
        self.assertIn(a.id, client.messages.calls[0]["messages"][0]["content"])
        self.assertTrue(a.summary and len(a.summary) <= 400 and a.summary.endswith("…"))
        self.assertIsNone(b.summary)
        self.assertEqual((got["summarised"], got["empty"]), (1, 1))
        with open(self.cache) as f:
            cache = json.load(f)
        self.assertEqual(cache[b.id], {"summary": "", "date": b.date})
        self.assertEqual(cache[a.id]["summary"], a.summary)

    def test_failures_never_raise(self):
        a, b = ev("A", url="https://v.fr/a"), ev("B", url="https://v.fr/b")

        def fetch(u):
            if u.endswith("/a"):
                raise FetchError("HTTP 404")
            return "page " * 50

        def boom(*_):
            raise RuntimeError("network down")

        got = S.enrich([a, b], cache_path=self.cache, log=lambda *_: None, fetch_page=fetch, ask_llm=boom, client=object())
        self.assertEqual(got["skipped"], 1)
        self.assertIsNone(b.summary)
        # a fetch failure is not cached as "nothing useful": it is retried on the next run
        self.assertFalse(os.path.exists(self.cache))
        # an empty page shell is remembered
        S.enrich([b], cache_path=self.cache, log=lambda *_: None, fetch_page=lambda u: "  ", ask_llm=boom, client=object())
        with open(self.cache) as f:
            self.assertEqual(json.load(f)[b.id]["summary"], "")

    def test_per_run_limit_and_nearest_first(self):
        evs = [ev(f"E{i}", url=f"https://v.fr/{i}", date=f"2099-01-{20 - i:02d}") for i in range(5)]
        batches = []
        S.enrich(evs, cache_path=self.cache, limit=2, log=lambda *_: None, fetch_page=lambda u: "page " * 50,
                 ask_llm=lambda cl, m, batch: batches.append(batch) or {x["id"]: "ok" for x in batch}, client=object())
        asked = [x["date"] for b in batches for x in b]
        self.assertEqual(asked, ["2099-01-16", "2099-01-17"])


if __name__ == "__main__":
    unittest.main()
