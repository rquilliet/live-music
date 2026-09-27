import datetime as dt
import os
import tempfile
import unittest
from unittest import mock

from livemusic import pipeline
from livemusic.model import Event

TODAY = dt.date(2026, 9, 27)


def ev(title, date="2026-10-10", slug="le-trabendo", source="llm"):
    return Event(title=title, date=date, venue="Le Trabendo", venue_slug=slug, source=source)


class TrackSeenTest(unittest.TestCase):
    def track(self, events, ids, venues=("llm:le-trabendo",)):
        state = {"ids": ids, "venues": list(venues), "counts": {}, "last_ok": {}, "horizon": pipeline.HORIZON_DAYS}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.multiple(pipeline, SEEN_PATH=os.path.join(tmp, "seen.json"), DATA=tmp):
            return pipeline.track_seen(events, TODAY, state, [])

    def test_a_show_seen_before_keeps_its_date(self):
        e = ev("Band")
        got = self.track([e], {e.id: {"first_seen": "2026-09-01", "date": e.date}})
        self.assertEqual(got[e.id], "2026-09-01")

    def test_a_new_show_at_a_known_venue_is_new_today(self):
        e = ev("Band")
        self.assertEqual(self.track([e], {})[e.id], "2026-09-27")

    def test_a_venue_scraped_for_the_first_time_is_baseline(self):
        e = ev("Band")
        self.assertEqual(self.track([e], {}, venues=())[e.id], "baseline")

    def seen(self, e, first="2026-09-01", last="2026-09-26"):
        return {e.id: {"first_seen": first, "date": e.date, "venue": e.venue_slug, "last": last}}

    def test_a_renamed_show_inherits_the_old_date(self):
        old, new = ev("Early set"), ev("Early set with Foo")
        self.assertNotEqual(old.id, new.id)
        self.assertEqual(self.track([new], self.seen(old)), {new.id: "2026-09-01"})

    def test_a_second_show_the_same_night_is_still_new(self):
        a, b = ev("Early set"), ev("Late set")
        self.assertEqual(self.track([a, b], self.seen(a)), {a.id: "2026-09-01", b.id: "2026-09-27"})

    def test_two_renames_the_same_night_are_not_guessed(self):
        a, b, a2, b2 = ev("Early set"), ev("Late set"), ev("Early set with Foo"), ev("Late set with Bar")
        got = self.track([a2, b2], dict(self.seen(a), **self.seen(b, first="2026-09-25")))
        self.assertEqual((got[a2.id], got[b2.id]), ("2026-09-27", "2026-09-27"))

    def test_a_show_gone_for_long_is_not_matched(self):
        old, new = ev("Early set"), ev("Late set")
        self.assertEqual(self.track([new], self.seen(old, last="2026-09-10"))[new.id], "2026-09-27")

    def test_a_carried_over_show_keeps_its_date(self):
        # REM-46: a failed venue's events come back with the same id, so first_seen is untouched
        prev = {"today": "2026-09-26", "events": [dict(ev("Band").to_dict(), first_seen="2026-09-01")]}
        kept, _ = pipeline.carry_over({"name": "Le Trabendo", "slug": "le-trabendo", "strategy": "llm"}, prev, TODAY)
        got = self.track(kept, {kept[0].id: {"first_seen": "2026-09-01", "date": "2026-10-10"}})
        self.assertEqual(got, {kept[0].id: "2026-09-01"})


if __name__ == "__main__":
    unittest.main()
