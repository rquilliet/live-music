import datetime as dt
import unittest
from unittest import mock

from livemusic.sources import venues_html as V

PAGE = """<h2>Au programme</h2><p>Pour cette rentrée, voici le programme 👇</p>
<p>🧠 MERCREDI 2 SEPTEMBRE — 20H00</p><p>LE BLINDTEST DU GEEK</p><p>🎮 Films, séries, jeux vidéo, musique…</p>
<p>🎬 MERCREDI 16 SEPTEMBRE — LEVEL UP EST DE RETOUR !</p><p>Une plongée dans les métiers du VFX</p>
<p>🎸 DIMANCHE 20 SEPTEMBRE — 17H00</p><p>LA JAM SESSION</p><p>Sortez les instruments !</p>
<p>🎸 DIMANCHE 20 SEPTEMBRE — 17H00</p><p>LA JAM SESSION</p><p>Sortez les instruments !</p>"""
VENUE = {"name": "Dernier Bar avant la Fin du Monde", "slug": "dernier-bar", "url": "https://dernierbar.com/pages/paris"}


class DernierBarTest(unittest.TestCase):
    def test_monthly_post(self):
        with mock.patch.object(V, "get", lambda url: PAGE):
            got = V.dernierbar(VENUE, {"today": dt.date(2026, 9, 1)})
        self.assertEqual([(e.date, e.time, e.title, e.is_music) for e in got], [
            ("2026-09-02", "20:00", "Le Blindtest Du Geek", False),   # "musique" in the blurb is not a concert
            ("2026-09-16", None, "Level Up Est De Retour", False),    # title on the date line
            ("2026-09-20", "17:00", "La Jam Session", True),          # pasted twice, kept once
        ])
        self.assertEqual(got[0].description, "Films, séries, jeux vidéo, musique…")

    def test_date_line_variants(self):
        page = """<p>🎸 DIMANCHE 20 SEPTEMBRE — 17H00 — LA JAM SESSION</p><p>Sortez les instruments !</p>
        <p>🎸 SAMEDI 26 SEPTEMBRE — À PARTIR DE 17H</p><p>CONCERT ÉTÉ</p><p>Trois groupes</p>
        <p>⚔️ JEUDI 1ER OCTOBRE — LEVEL UP ⚔️</p><p>Blabla</p>"""
        with mock.patch.object(V, "get", lambda url: page):
            got = V.dernierbar(VENUE, {"today": dt.date(2026, 9, 1)})
        self.assertEqual([(e.date, e.time, e.title, e.description, e.is_music) for e in got], [
            ("2026-09-20", "17:00", "La Jam Session", "Sortez les instruments !", True),
            ("2026-09-26", "17:00", "Concert Été", "Trois groupes", True),
            ("2026-10-01", None, "Level Up ⚔️", "Blabla", False),
        ])

    def test_old_post_does_not_roll_to_next_year(self):
        with mock.patch.object(V, "get", lambda url: PAGE):   # September's post still online in November
            got = V.dernierbar(VENUE, {"today": dt.date(2026, 11, 5)})
        self.assertEqual(got, [])


class ManualTest(unittest.TestCase):
    def test_committed_file_is_valid(self):
        from livemusic.sources import manual
        got = manual.scrape({"name": "La Pointe Lafayette", "slug": "la-pointe-lafayette"}, {})
        self.assertTrue(got and all(e.source == "manual" and e.date[:2] == "20" for e in got))


class GeoMatchTest(unittest.TestCase):
    def test_bar_next_to_a_theatre_does_not_take_its_events(self):
        from livemusic import pipeline
        from livemusic.model import Event
        venues = pipeline.load_venues()
        e = Event(title="Orchestre Français des Jeunes", date="2026-10-10", venue="Théâtre du Châtelet",
                  venue_slug="theatre-du-chatelet", source="opendata", lat=48.8578, lon=2.3469)
        pipeline.canonical_venue(e, venues)
        self.assertEqual(e.venue, "Théâtre du Châtelet")


if __name__ == "__main__":
    unittest.main()
