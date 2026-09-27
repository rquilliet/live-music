import datetime as dt
import json
import os
import tempfile
import unittest
from unittest import mock

from livemusic import pipeline
from livemusic.fetch import FetchError
from livemusic.model import Event

TODAY = dt.date(2026, 9, 27)
SITE = {"name": "Le Trabendo", "slug": "le-trabendo", "strategy": "llm"}
OPENDATA = {"name": "Paris open data", "slug": "opendata", "strategy": "opendata"}


def row(title, date, source="llm", slug="le-trabendo", **kw):
    return dict(Event(title=title, date=date, venue="Le Trabendo", venue_slug=slug, source=source, **kw).to_dict(),
                first_seen="2026-09-01")


class CarryOverTest(unittest.TestCase):
    def test_upcoming_events_of_the_failed_source_come_back_stale(self):
        prev = {"today": "2026-09-26", "events": [
            row("Past show", "2026-09-20"),
            row("Tonight", "2026-09-27"),
            row("Later", "2026-10-10"),
            row("Other venue", "2026-10-10", slug="la-java"),
            row("Open data copy", "2026-10-10", source="opendata"),
        ]}
        got, since = pipeline.carry_over(SITE, prev, TODAY)
        self.assertEqual([e.title for e in got], ["Tonight", "Later"])
        self.assertEqual(since, "2026-09-26")
        self.assertTrue(all(e.stale_since == "2026-09-26" for e in got))
        self.assertEqual(got[0].id, prev["events"][1]["id"])

    def test_open_data_is_matched_on_source_only(self):
        prev = {"today": "2026-09-26", "events": [row("A", "2026-10-01", source="opendata", slug="olympia"),
                                                 row("B", "2026-10-01", source="opendata", slug="la-java")]}
        got, _ = pipeline.carry_over(OPENDATA, prev, TODAY)
        self.assertEqual(len(got), 2)

    def test_stale_date_is_kept_across_runs_and_capped(self):
        prev = {"today": "2026-09-26", "events": [row("Later", "2026-10-10", stale_since="2026-09-20")]}
        got, since = pipeline.carry_over(SITE, prev, TODAY)
        self.assertEqual((len(got), since), (1, "2026-09-20"))
        prev["events"][0]["stale_since"] = "2026-09-12"   # 15 days of failures
        self.assertEqual(pipeline.carry_over(SITE, prev, TODAY), ([], "2026-09-12"))

    def test_last_success_date_wins_over_rows_cleared_by_merge(self):
        prev = {"today": "2026-09-26", "events": [row("Later", "2026-10-10")]}   # stale_since cleared by open data
        self.assertEqual(pipeline.carry_over(SITE, prev, TODAY, last_ok="2026-09-01"), ([], "2026-09-01"))
        got, since = pipeline.carry_over(SITE, prev, TODAY, last_ok="2026-09-20")
        self.assertEqual((got[0].stale_since, since), ("2026-09-20", "2026-09-20"))

    def test_no_previous_file(self):
        self.assertEqual(pipeline.carry_over(SITE, {}, TODAY), ([], None))

    def test_a_fresh_source_confirming_the_show_clears_stale(self):
        stale = Event(title="Later", date="2026-10-10", venue="Le Trabendo", venue_slug="le-trabendo", source="llm",
                      stale_since="2026-09-20")
        fresh = Event(title="Later", date="2026-10-10", venue="Le Trabendo", venue_slug="le-trabendo", source="opendata")
        merged = pipeline.merge([stale, fresh], log=lambda m: None)
        self.assertEqual(len(merged), 1)
        self.assertIsNone(merged[0].stale_since)


class RunTest(unittest.TestCase):
    """A whole run in a temp dir: the failing venue keeps yesterday's programme in events.json."""

    def test_failed_venue_keeps_its_events(self):
        venues = [dict(SITE, strategy="broken"), {"name": "La Java", "slug": "la-java", "strategy": "ok"}]

        def broken(v, ctx):
            raise FetchError("HTTP 503")

        def ok(v, ctx):
            return [Event(title="Jam", date="2026-10-02", venue="La Java", venue_slug="la-java", source="ok")]

        with tempfile.TemporaryDirectory() as tmp:
            out, seen = os.path.join(tmp, "events.json"), os.path.join(tmp, "seen.json")
            with open(out, "w") as f:
                json.dump({"today": "2026-09-26", "events": [row("Later", "2026-10-10", source="broken")]}, f)
            with mock.patch.multiple(pipeline, OUT_PATH=out, SEEN_PATH=seen, WEB=tmp, DATA=tmp,
                                     STRATEGIES={"broken": broken, "ok": ok}, today_paris=lambda: TODAY,
                                     load_venues=lambda: venues), \
                    mock.patch.object(pipeline.S, "enrich", lambda *a, **k: None):
                res = pipeline.run(use_llm=False, players=False, log=lambda m: None)
                with open(seen) as f:
                    self.assertEqual(json.load(f)["last_ok"], {"La Java": "2026-09-27"})
                with open(os.path.join(tmp, "status.json")) as f:
                    status = json.load(f)
        titles = {e["title"]: e["stale_since"] for e in res["events"]}
        self.assertEqual(titles, {"Jam": None, "Later": "2026-09-26"})
        self.assertEqual(res["report"][0], {"venue": "Le Trabendo", "ok": False, "error": "HTTP 503",
                                            "carried": 1, "stale_since": "2026-09-26"})
        self.assertEqual([(s["slug"], s["status"], s.get("error")) for s in status["sources"]],
                         [("le-trabendo", "failed", "HTTP 503"), ("la-java", "low", None)])


if __name__ == "__main__":
    unittest.main()
