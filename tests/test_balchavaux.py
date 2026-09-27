import datetime as dt
import unittest
from unittest import mock

from livemusic.sources import venues_html as V

VENUE = {"name": "Bal Chavaux", "slug": "bal-chavaux", "url": "https://balchavaux.fr/agenda"}


def card(slug, title, day, month, year, hour, cats=(), status=None, sub="", by=""):
    terms = '<span class=""><span class="mx-2">/</span></span>'.join(
        f'<span class="" data-first-level=true data-term-id="1" data-term-name="{c.lower()}"> {c} </span>' for c in cats)
    by = f'<h2 class="text-3xl mb-1 mt-2"> {by} </h2>' if by else ""
    sub = f'<div class="text-3xl leading-none mt-1 uppercase"> {sub}</div>' if sub else ""
    badge = f'<div class="mt-2"><span data-status-key="{status}" class="badge"> x </span></div>' if status else ""
    return f"""<div class="views-row" role="listitem" ><article class="group "> <a href="/agenda/{slug}" data-search
 class="block font-alt " aria-label="{title}"><figure><noscript> <img src="/sites/balchavaux/files/{slug}.png?itok=a" alt="" />
 </noscript></figure><div class="font-bold uppercase text-xl evt-date agenda--evt-date date-to-has-different-month"
 data-search="x" data-day-name="Jeudi" data-day="{day}" data-month="{month}" data-month-short="x" data-year="{year}" >
 <span class="evt-date-from-hour evt-date-hour"> • {hour} <i class="fal"></i> 23:30 </span></div>
 <div class="text-xl uppercase agenda--evt-categories" >{terms}</div>{badge}
 {by}<h2 class="uppercase"> <span class=" "> {title} </span></h2>{sub}</div></div> </a></article></div>"""


PAGE1 = (card("olllam", "THE OLLLAM", "01", "Octobre", "2026", "19:30", ["Jazz", "Rock"])
         + card("sophro-danse-0", "SOPHRO-DANSE", "11", "Octobre", "2026", "14:00", ["Atelier"], sub="AVEC LA CIE X")
         + card("alpha-wolf", "ALPHA WOLF", "11", "Octobre", "2026", "17:00", ["Rock", "Metalcore"], "canceled")
         + card("liksn", "LIKΣN + ANE GAIN", "14", "Octobre", "2026", "19:30", by="Persona Grata présente")
         + '<ul class="js-pager__items pager"><li class="pager__item"> <a class="button" href="?page=1" rel="next"> Afficher plus</a></li></ul>')
PAGE2 = (card("olllam", "THE OLLLAM", "01", "Octobre", "2026", "19:30", ["Jazz", "Rock"])      # the next page repeats the first
         + card("mareux", "MAREUX", "31", "Octobre", "2026", "19:30", ["Rock psychédélique", "Théâtre"], "full")
         + card("silvestri", "Daniele Silvestri", "06", "Mars", "2027", "20:00", ["Concert", "Danse"]))


class BalChavauxTest(unittest.TestCase):
    def scrape(self, pages):
        calls = []

        def get(url):
            calls.append(url)
            return pages[url]
        with mock.patch.object(V, "get", get):
            return V.balchavaux(VENUE, {"today": dt.date(2026, 9, 28)}), calls

    def test_cards_and_next_page(self):
        got, calls = self.scrape({VENUE["url"]: PAGE1, VENUE["url"] + "?page=1": PAGE2})
        self.assertEqual(calls, [VENUE["url"], VENUE["url"] + "?page=1"])
        self.assertEqual([(e.date, e.time, e.title, e.raw_genre, e.is_music, e.sold_out, e.cancelled) for e in got], [
            ("2026-10-01", "19:30", "THE OLLLAM", "Jazz, Rock", True, False, False),
            ("2026-10-11", "14:00", "SOPHRO-DANSE", "Atelier", False, False, False),
            ("2026-10-11", "17:00", "ALPHA WOLF", "Rock, Metalcore", True, False, True),
            ("2026-10-14", "19:30", "LIKΣN + ANE GAIN", None, True, False, False),
            ("2026-10-31", "19:30", "MAREUX", "Rock psychédélique", True, True, False),
            ("2027-03-06", "20:00", "Daniele Silvestri", "Concert", True, False, False),
        ])
        self.assertEqual([e.description for e in got[:4]], [None, "AVEC LA CIE X", None, "Persona Grata présente"])
        from livemusic import genres
        self.assertFalse(any(genres.looks_non_music(f"{e.raw_genre or ''} {e.title}", e.venue) for e in got if e.is_music))
        self.assertEqual(got[0].url, "https://balchavaux.fr/agenda/olllam")
        self.assertEqual(got[0].image, "https://balchavaux.fr/sites/balchavaux/files/olllam.png?itok=a")

    def test_single_page(self):
        got, calls = self.scrape({VENUE["url"]: PAGE2})
        self.assertEqual((len(got), len(calls)), (3, 1))


if __name__ == "__main__":
    unittest.main()
