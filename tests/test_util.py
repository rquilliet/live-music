import unittest

from livemusic.util import split_lineup, strip_decor


class SplitLineupTest(unittest.TestCase):
    def test_plain_bill(self):
        self.assertEqual(split_lineup("Jaguar Sun • Sean Nicholas Savage • Yes Please!"), ("Jaguar Sun", ["Sean Nicholas Savage", "Yes Please!"]))

    def test_decorations_are_stripped(self):   # REM-36: the names must match Spotify's
        self.assertEqual(strip_decor("KYTES en concert (côté Records)"), "KYTES")
        self.assertEqual(strip_decor("Horse Lords (1er soir)"), "Horse Lords")
        self.assertEqual(strip_decor("#JazzDeDemain Arlet Feuillard"), "Arlet Feuillard")
        self.assertEqual(strip_decor("#LaJamDuLundi de FRANÇOIS CONSTANTIN"), "FRANÇOIS CONSTANTIN")
        self.assertEqual(strip_decor("#LaPetiteHeure by... RICARDO IZQUIERDO & SERGIO GRUZ"), "RICARDO IZQUIERDO & SERGIO GRUZ")
        self.assertEqual(strip_decor("Raynald Colom Quartet en concert au 38Riv Jazz Club"), "Raynald Colom Quartet")
        self.assertEqual(strip_decor("Pauline Mann au Sunset"), "Pauline Mann")
        self.assertEqual(split_lineup("KYTES en concert (côté Records)"), ("KYTES", []))

    def test_names_that_look_decorated_survive(self):
        self.assertEqual(strip_decor("Au Revoir Simone"), "Au Revoir Simone")
        self.assertEqual(strip_decor("Voyage au bout de la nuit"), "Voyage au bout de la nuit")   # lowercase after "au": kept
        self.assertEqual(strip_decor("(1er soir)"), "(1er soir)")   # nothing left once stripped: the name stays


if __name__ == "__main__":
    unittest.main()
