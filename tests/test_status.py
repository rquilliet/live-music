import datetime as dt
import json
import os
import tempfile
import unittest

from livemusic import status

TODAY = dt.date(2026, 9, 27)
JAVA = {"name": "La Java", "slug": "la-java", "strategy": "llm", "url": "https://la-java.fr/"}
TRABENDO = {"name": "Le Trabendo", "slug": "le-trabendo", "strategy": "llm", "url": "https://www.letrabendo.net/"}
OPENDATA = {"name": "Paris open data", "slug": "opendata", "strategy": "opendata"}
STATE = {"counts": {"La Java": 13, "Le Trabendo": 54}, "last_ok": {"La Java": "2026-09-26", "Le Trabendo": "2026-09-24"}}


def build(scraped, report, previous=None, today=TODAY, **kw):
    return status.build(scraped, report, STATE, today, previous=previous, now="2026-09-27T04:40:00Z", url="", **kw)


class BuildTest(unittest.TestCase):
    def test_one_row_per_source_with_the_reason(self):
        got = build([JAVA, TRABENDO, OPENDATA], [
            {"venue": "La Java", "ok": True, "count": 12},
            {"venue": "Le Trabendo", "ok": False, "error": "HTTP 503", "carried": 40, "stale_since": "2026-09-24"},
            {"venue": "Paris open data", "ok": True, "count": 0},
        ], timings={"La Java": 2.5}, duration=61)
        java, trabendo, opendata = got["sources"]
        self.assertEqual((java["status"], java["count"], java["prev_count"], java["last_ok"], java["seconds"]),
                         ("ok", 12, 13, "2026-09-27", 2.5))
        self.assertEqual((trabendo["status"], trabendo["error"], trabendo["last_ok"], trabendo["carried"]),
                         ("failed", "HTTP 503", "2026-09-24", 40))
        self.assertEqual(trabendo["failing_since"], "2026-09-25")   # no earlier report: the day after the last success
        self.assertEqual(opendata["status"], "ok")                   # open data is never "low coverage"
        self.assertEqual(got["history"], [{"date": "2026-09-27", "run_url": "", "usd": 0,
                                           "sources": {"la-java": 12, "le-trabendo": "HTTP 503", "opendata": 0}}])
        self.assertEqual(got["duration_s"], 61)
        self.assertEqual([s["slug"] for s in status.failing(got)], ["le-trabendo"])

    def test_thin_programme_is_flagged(self):
        got = build([JAVA], [{"venue": "La Java", "ok": True, "count": 2}])
        self.assertEqual(got["sources"][0]["status"], "low")

    def test_a_venue_sets_its_own_bar_with_low(self):
        bar = dict(JAVA, low=1)   # a bar with one jam a month: one event is its whole programme
        self.assertEqual(build([bar], [{"venue": "La Java", "ok": True, "count": 1}])["sources"][0]["status"], "ok")
        self.assertEqual(build([bar], [{"venue": "La Java", "ok": True, "count": 0}])["sources"][0]["status"], "low")

    def test_failing_since_survives_the_following_days_and_resets_on_success(self):
        fail = [{"venue": "Le Trabendo", "ok": False, "error": "HTTP 503"}]
        day1 = build([TRABENDO], fail, today=dt.date(2026, 9, 25))
        day2 = build([TRABENDO], fail, previous=day1, today=dt.date(2026, 9, 26))
        self.assertEqual(day2["sources"][0]["failing_since"], "2026-09-25")
        self.assertEqual([h["date"] for h in day2["history"]], ["2026-09-26", "2026-09-25"])
        day3 = build([TRABENDO], [{"venue": "Le Trabendo", "ok": True, "count": 50}], previous=day2)
        self.assertNotIn("failing_since", day3["sources"][0])
        day4 = build([TRABENDO], fail, previous=day3, today=dt.date(2026, 9, 28))
        self.assertEqual(day4["sources"][0]["failing_since"], "2026-09-28")

    def test_history_is_capped(self):
        prev = {"history": [{"date": (TODAY - dt.timedelta(days=n)).isoformat(), "sources": {}} for n in range(1, 30)]}
        got = build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}], previous=prev)
        self.assertEqual(len(got["history"]), status.HISTORY_DAYS)
        self.assertEqual(got["history"][-1]["date"], "2026-09-14")

    def test_partial_run_keeps_the_other_sources(self):
        full = build([JAVA, TRABENDO], [{"venue": "La Java", "ok": True, "count": 12},
                                        {"venue": "Le Trabendo", "ok": False, "error": "HTTP 503"}])
        full["fixes"] = [{"date": "2026-09-27", "slug": "le-trabendo"}]
        got = build([TRABENDO], [{"venue": "Le Trabendo", "ok": True, "count": 50}], previous=full, partial=True,
                    duration=12, active={"la-java", "le-trabendo"})
        self.assertEqual([(s["slug"], s["status"]) for s in got["sources"]], [("la-java", "ok"), ("le-trabendo", "ok")])
        self.assertEqual((got["generated_at"], got["duration_s"]), (full["generated_at"], full["duration_s"]))
        self.assertEqual(got["history"][0]["sources"], {"la-java": 12, "le-trabendo": 50})
        self.assertEqual(len(got["history"]), 1)
        self.assertEqual(got["fixes"], full["fixes"])

    def test_removed_venue_is_dropped(self):
        full = build([JAVA, TRABENDO], [{"venue": "La Java", "ok": True, "count": 12},
                                        {"venue": "Le Trabendo", "ok": False, "error": "HTTP 503"}])
        got = build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}], previous=full, active={"la-java"})
        self.assertEqual([s["slug"] for s in got["sources"]], ["la-java"])

    def test_cost_of_the_day_adds_up(self):
        step = lambda what, usd: {"what": what, "model": "claude-opus-5", "batch": False, "calls": 1, "tokens_in": 10,
                                  "tokens_out": 5, "usd": usd}
        ok = [{"venue": "La Java", "ok": True, "count": 12}]
        morning = build([JAVA], ok, cost={"usd": 1.5, "steps": [step("venues", 1.0), step("genres", 0.5)]})
        self.assertEqual((morning["cost"]["usd"], morning["history"][0]["usd"]), (1.5, 1.5))
        patch = build([JAVA], ok, previous=morning, partial=True, cost={"usd": 0.25, "steps": [step("venues", 0.25)]})
        self.assertEqual((patch["cost"]["usd"], patch["history"][0]["usd"], len(patch["cost"]["steps"])), (1.75, 1.75, 3))
        agent = status.add_cost(patch, {"usd": 0.4, "steps": [{"what": "troubleshooting", "usd": 0.4}]}, TODAY)
        self.assertEqual((agent["cost"]["usd"], agent["history"][0]["usd"]), (2.15, 2.15))
        tomorrow = build([JAVA], ok, previous=agent, today=dt.date(2026, 9, 28), cost={"usd": 0, "steps": []})
        self.assertEqual((tomorrow["cost"]["usd"], [h["usd"] for h in tomorrow["history"]]), (0, [0, 2.15]))

    def test_timeline_keeps_every_day(self):
        old = [{"date": "2026-09-07", "sources": 56, "ok": 56}, {"date": "2026-09-26", "sources": 2, "ok": 2}]
        report = [{"venue": "La Java", "ok": True, "count": 12}, {"venue": "Le Trabendo", "ok": False, "error": "HTTP 503"}]
        yesterday = build([JAVA, TRABENDO], report, today=dt.date(2026, 9, 26))
        del yesterday["history"][0]["usd"]   # a day from before the cost was measured
        first = build([JAVA, TRABENDO], report, previous=yesterday, cost={"usd": 1.5, "steps": [{"what": "venues", "usd": 1.5}]})
        rows = status.track(first, old)
        self.assertEqual(rows, [old[0], old[1],   # a day already in the timeline is not rewritten
                                {"date": "2026-09-27", "sources": 2, "ok": 1, "usd": 1.5}])
        again = status.add_cost(first, {"steps": [{"what": "troubleshooting", "usd": 0.5}]}, TODAY)
        self.assertEqual(status.track(again, rows)[-1], {"date": "2026-09-27", "sources": 2, "ok": 1, "usd": 2.0})
        self.assertEqual(status.track(first, [])[0], {"date": "2026-09-26", "sources": 2, "ok": 1})   # not measured: no usd

    def test_timeline_of_a_run_on_a_subset_counts_every_source(self):
        report = [{"venue": "La Java", "ok": True, "count": 12}, {"venue": "Le Trabendo", "ok": True, "count": 40}]
        full = build([JAVA, TRABENDO], report, today=dt.date(2026, 9, 26))
        patch = build([JAVA], report[:1], previous=full, partial=True)
        self.assertEqual(status.track(patch, [{"date": "2026-09-27", "sources": 1, "ok": 1, "first": 1}])[-1],
                         {"date": "2026-09-27", "sources": 2, "ok": 2, "usd": 0, "first": 1})

    def test_timeline_takes_the_agent_cost_of_a_day_without_scrape(self):
        got = build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}])
        status.add_cost(got, {"steps": [{"what": "troubleshooting", "usd": 0.4}]}, "2026-09-28")
        self.assertEqual(status.track(got, [])[-1], {"date": "2026-09-28", "sources": 1, "ok": None, "usd": 0.4})

    def test_damaged_timeline_is_left_alone(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "status.json")
            with open(os.path.join(d, "timeline.json"), "w", encoding="utf-8") as f:
                f.write("<<<<<<< HEAD")
            status.write(build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}]), path)
            with open(os.path.join(d, "timeline.json"), encoding="utf-8") as f:
                self.assertEqual(f.read(), "<<<<<<< HEAD")

    def test_write_updates_the_timeline_next_to_the_report(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "status.json")
            status.write(build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}]), path)
            status.write(build([JAVA], [{"venue": "La Java", "ok": True, "count": 12}], today=dt.date(2026, 9, 28)), path)
            with open(os.path.join(d, "timeline.json"), encoding="utf-8") as f:
                self.assertEqual([r["date"] for r in json.load(f)], ["2026-09-27", "2026-09-28"])

    def test_run_url(self):
        self.assertIsNone(status.run_url({}))
        self.assertEqual(status.run_url({"GITHUB_RUN_ID": "42", "GITHUB_REPOSITORY": "rquilliet/live-music"}),
                         "https://github.com/rquilliet/live-music/actions/runs/42")


if __name__ == "__main__":
    unittest.main()
