import datetime as dt
import unittest

from livemusic.sources.llm import expand_url


class ExpandUrlTest(unittest.TestCase):
    def test_plain_url_is_untouched(self):
        self.assertEqual(expand_url("https://a.test/agenda?x={y}", dt.date(2026, 9, 27)), "https://a.test/agenda?x={y}")

    def test_month_offsets_roll_over_the_year(self):
        today = dt.date(2026, 11, 15)
        self.assertEqual(expand_url("https://a.test/agenda?mois={month}", today), "https://a.test/agenda?mois=11")
        self.assertEqual(expand_url("https://a.test/agenda?mois={month+1}", today), "https://a.test/agenda?mois=12")
        self.assertEqual(expand_url("https://a.test/agenda?mois={month+2}&annee={year+2}", today),
                         "https://a.test/agenda?mois=1&annee=2027")
        self.assertEqual(expand_url("https://a.test/{year+3}-{mm+3}", today), "https://a.test/2027-02")
        self.assertEqual(expand_url("https://a.test/{year-11}-{mm-11}", today), "https://a.test/2025-12")


if __name__ == "__main__":
    unittest.main()
