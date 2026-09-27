"""python -m unittest discover tests"""
import unittest

from livemusic import genres as G
from livemusic.model import Event


class RuleTests(unittest.TestCase):
    def test_post_punk_is_not_punk(self):
        self.assertEqual(G.tags_from_site("Darkwave, Post-punk"), ["indie"])
        self.assertEqual(G.tags_from_site("post punk"), ["indie"])
        self.assertEqual(G.tags_from_site("Darkwave"), ["indie"])
        self.assertEqual(G.tags_from_site("Cold wave / Goth"), ["indie"])
        self.assertEqual(G.tags_from_site("Concert, Rock, Punk"), ["punk", "rock"])
        self.assertEqual(G.tags_from_site("bedroom punk / emo pop"), ["punk", "indie", "pop"])
        self.assertEqual(G.tags_from_site("Post-punk, Punk"), ["punk", "indie"])
        self.assertEqual(G.tags_from_site("Synth wave"), ["electro"])
        self.assertEqual(G.tags_from_site("Post–punk"), ["indie"])          # en dash
        self.assertEqual(G.tags_from_site("post- punk"), ["indie"])
        self.assertEqual(G.tags_from_site("Gothenburg melodic death metal"), ["metal"])
        self.assertEqual(G.tags_from_site("Gothic metal"), ["metal"])
        self.assertEqual(G.tags_from_site("New Wave of British Heavy Metal"), ["metal"])
        self.assertEqual(G.tags_from_site("Visigoth"), [])
        self.assertEqual(G.tags_from_site("Rock gothique"), ["indie", "rock"])

    def test_titles(self):
        self.assertEqual(G.tags_from_text("Soirée post-punk"), ["indie"])
        self.assertEqual(G.tags_from_text("Nuit punk hardcore"), ["punk"])
        self.assertEqual(G.tags_from_text("Post-hardcore night"), ["punk"])


class SubgenreTests(unittest.TestCase):
    def test_venue_descriptors_become_labels(self):
        self.assertEqual(G.subgenres_from_site("Metal, Punk, Heavy Metal, Hard Rock et assimilés"), ["heavy metal", "hard rock"])
        self.assertEqual(G.subgenres_from_site("Afropop, Afrobeats, Zouk"), ["afropop", "afrobeats", "zouk"])
        self.assertEqual(G.subgenres_from_site("indie, alt, indiepop, electronicrock"), ["indie pop", "electronic rock"])
        self.assertEqual(G.subgenres_from_site("Rock alternatif"), ["alternative rock"])
        self.assertEqual(G.subgenres_from_site("Variété / Chanson / Pop française"), ["pop française"])

    def test_coarse_tags_and_noise_are_dropped(self):
        for raw in ("Rap, Hip-Hop", "pop, indie, alt", "Musiques électroniques", "Chanson française", "R'n'B",
                    "Coming Soon", "Festival", "Spectacle musical", "Danse, Nuit", "CONCERT & FESTIVAL",
                    "Pianissimo Vol XXI, Coming Soon", "Makhtaverskan", "marché, braderie, vinyle", None, ""):
            self.assertEqual(G.subgenres_from_site(raw), [], raw)
        self.assertEqual(G.subgenres_from_site("Hyperpop et Club"), ["hyperpop"])
        self.assertEqual(G.subgenres_from_site("Rock and Roll, Tribute Beatles, Soirée électro"), ["rock and roll"])
        self.assertEqual(G.normalize_subgenres(["soul-rnb", "soul/r&b", "Hip Hop", "dj set", "neo-soul"]), ["neo-soul"])
        self.assertEqual(G.subgenres_from_site("Variété internationale (pop, soul, nouvelles esthétiques, RnB)"), [])

    def test_normalize_unifies_spellings_and_caps(self):
        got = G.normalize_subgenres(["Post Punk", "post-punk", "Shoegaze", "rock", "Psych Rock", "drum and bass", "dnb",
                                     "Rap Français", 42, "x" * 40, "free jazz"])
        self.assertEqual(got, ["post-punk", "shoegaze", "psychedelic rock", "drum & bass"])  # MAX_SUBGENRES = 4

    def test_merge_keeps_venue_labels_first(self):
        self.assertEqual(G.merge_subgenres(["heavy metal"], ["Heavy Metal", "stoner rock"]), ["heavy metal", "stoner rock"])

    def test_llm_answer_never_overwrites_site_genres(self):
        ev = Event(title="X", date="2026-09-10", venue="V", venue_slug="v", source="cigale", genres=["hip-hop"], genre_source="site")
        G._apply_hit(ev, ["pop"], True, ["boom bap", "hip-hop"])
        self.assertEqual((ev.genres, ev.genre_source, ev.subgenres), (["hip-hop"], "site", ["boom bap"]))
        G._apply_hit(ev, [], False, [])
        self.assertTrue(ev.is_music)  # a venue-published concert is not demoted by Claude
        weak = Event(title="Y", date="2026-09-10", venue="V", venue_slug="v", source="opendata", genres=["jazz"], genre_source="venue")
        G._apply_hit(weak, ["soul-rnb"], True, ["neo-soul"])
        self.assertEqual((weak.genres, weak.genre_source, weak.subgenres), (["soul-rnb"], "llm", ["neo-soul"]))
        extracted = Event(title="Z", date="2026-09-10", venue="V", venue_slug="v", source="llm", genres=["jazz"], genre_source="llm")
        G._apply_hit(extracted, ["experimental"], True, ["free jazz"])
        self.assertEqual((extracted.genres, extracted.subgenres), (["jazz"], ["free jazz"]))  # page extraction saw more than the title

    def test_needs_llm(self):
        mk = lambda src, subs: Event(title="T", date="2026-09-10", venue="V", venue_slug="v", source="s", genres=["rock"], genre_source=src, subgenres=subs)
        self.assertTrue(G._needs_llm(mk("site", [])))
        self.assertFalse(G._needs_llm(mk("site", ["stoner rock"])))
        self.assertTrue(G._needs_llm(mk("venue", ["stoner rock"])))
        off = mk("venue", []); off.is_music = False
        self.assertFalse(G._needs_llm(off))


if __name__ == "__main__":
    unittest.main()
