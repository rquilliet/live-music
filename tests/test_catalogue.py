import unittest

from livemusic import pipeline
from livemusic.model import Event

OPENDATA = {"name": "Paris open data", "slug": "opendata", "strategy": "opendata"}
JAVA = {"name": "La Java", "slug": "la-java", "strategy": "llm", "url": "https://la-java.fr/", "area": "Belleville"}
PLAN = {"name": "Le Plan", "slug": "le-plan", "strategy": "llm", "url": "https://www.leplan.com/", "area": "Ris-Orangis"}
CLEF = {"name": "La Clef", "slug": "la-clef", "strategy": "none"}


def ev(venue, genres=(), subgenres=(), is_music=True):
    return Event(title="x", date="2026-10-10", venue=venue, venue_slug="v", source="llm",
                 genres=list(genres), subgenres=list(subgenres), is_music=is_music)


class CatalogueTest(unittest.TestCase):
    def test_every_venue_of_venues_json_is_listed_even_with_nothing_on(self):
        got = pipeline.catalogue([ev("La Java"), ev("Le Petit Bain")], [OPENDATA, JAVA, PLAN, CLEF])
        self.assertEqual(got["venues"], ["La Clef", "La Java", "Le Petit Bain", "Le Plan"])   # not the open-data source
        self.assertEqual(got["areas"], {"La Java": "Belleville", "Le Plan": "Ris-Orangis"})

    def test_styles_come_from_the_programme_and_the_genre_cache_with_their_usual_genre(self):
        events = [ev("La Java", ["jazz"], ["hard bop"]), ev("La Java", ["rock", "metal"], ["stoner rock"]),
                  ev("La Java", ["metal"], ["stoner rock"]), ev("La Java", ["jazz"], ["quiz night"], is_music=False)]
        cache = {"k1": {"genres": ["electro"], "is_music": True, "subgenres": ["house", "techno"]},
                 "k2": {"genres": ["rock"], "is_music": True, "subgenres": ["stoner rock"]},
                 "k3": {"genres": ["jazz"], "is_music": False, "subgenres": ["comedy"]},
                 "k4": {"genres": [], "is_music": True, "subgenres": ["orphan"]}}
        got = pipeline.catalogue(events, [JAVA], cache)
        self.assertEqual(got["styles"], {"hard bop": "jazz", "house": "electro", "orphan": "",
                                         "stoner rock": "metal", "techno": "electro"})   # metal 2, rock 2: the name breaks the tie

    def test_low_coverage_honours_the_venue_bar(self):
        bar = dict(JAVA, low=1)
        report = [{"venue": "La Java", "ok": True, "count": 1}, {"venue": "Le Plan", "ok": True, "count": 1},
                  {"venue": "Paris open data", "ok": True, "count": 0}]
        self.assertEqual(pipeline.low_coverage([bar, PLAN, OPENDATA], report), [("Le Plan", 1)])


if __name__ == "__main__":
    unittest.main()
