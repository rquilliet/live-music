import datetime as dt
import json
import os
import tempfile
import unittest
from unittest import mock

from livemusic import pipeline
from livemusic.model import Event
from livemusic.sources.llm import _fix_year
from livemusic.util import YEAR_GUESS_DAYS, parse_fr_date

TODAY = dt.date(2026, 9, 27)


def valid(date):
    return Event(title="Show", date=date, venue="Le Trabendo", venue_slug="le-trabendo", source="llm").is_valid(
        TODAY, pipeline.HORIZON_DAYS)


class HorizonTest(unittest.TestCase):
    def test_concerts_announced_a_year_ahead_are_kept(self):
        self.assertTrue(valid("2027-02-15"))   # the old 120-day window stopped late January
        self.assertTrue(valid("2027-09-30"))

    def test_past_and_absurd_dates_are_dropped(self):
        self.assertFalse(valid("2026-09-26"))
        self.assertFalse(valid("2030-01-01"))


class FixYearTest(unittest.TestCase):
    def fix(self, date):
        return _fix_year(date, TODAY, YEAR_GUESS_DAYS)

    def test_last_years_date_for_an_upcoming_show_moves_to_this_year(self):
        self.assertEqual(self.fix("2025-10-11"), "2026-10-11")
        self.assertEqual(self.fix("2026-03-14"), "2027-03-14")   # "14 mars" read as this March

    def test_recent_past_show_stays_in_the_past(self):
        # still on the programme page a week later: must not come back as next September's concert
        self.assertEqual(self.fix("2026-09-20"), "2026-09-20")
        self.assertEqual(self.fix("2026-07-01"), "2026-07-01")
        self.assertEqual(self.fix("2026-05-20"), "2026-05-20")   # "last season" block copied with its year


class InferYearTest(unittest.TestCase):
    """HTML scrapers read '20.06' or '10 mai' without a year; the old horizon hid wrong roll-overs."""

    def test_upcoming_year_less_dates(self):
        self.assertEqual(parse_fr_date("12 octobre", TODAY), "2026-10-12")
        self.assertEqual(parse_fr_date("14.03", TODAY), "2027-03-14")

    def test_months_old_show_is_not_next_years_concert(self):
        for s in ("20.06", "10 mai", "5 aout"):
            d = parse_fr_date(s, TODAY)
            self.assertLess(d, TODAY.isoformat(), s)
            self.assertFalse(valid(d), s)


class FirstSeenTest(unittest.TestCase):
    def run_seen(self, horizon):
        state = {"ids": {}, "venues": ["llm:le-trabendo"], "counts": {}, "last_ok": {}, "horizon": horizon}
        events = [Event(title=t, date=d, venue="Le Trabendo", venue_slug="le-trabendo", source="llm")
                  for t, d in (("Soon", "2026-11-01"), ("Far", "2027-06-01"))]
        with mock.patch.object(pipeline, "SEEN_PATH", os.path.join(tempfile.mkdtemp(), "seen.json")):
            seen = pipeline.track_seen(events, TODAY, state, [])
            with open(pipeline.SEEN_PATH) as f:
                saved = json.load(f)
        return {e.title: seen[e.id] for e in events}, saved

    def test_first_run_after_raising_the_horizon_does_not_flag_far_concerts_as_new(self):
        seen, saved = self.run_seen(pipeline.OLD_HORIZON_DAYS)
        self.assertEqual(seen, {"Soon": "2026-09-27", "Far": "baseline"})
        self.assertEqual(saved["horizon"], pipeline.HORIZON_DAYS)

    def test_later_runs_flag_far_announcements_as_new(self):
        seen, _ = self.run_seen(pipeline.HORIZON_DAYS)
        self.assertEqual(seen["Far"], "2026-09-27")


if __name__ == "__main__":
    unittest.main()
