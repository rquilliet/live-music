import datetime as dt
import json
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


def page(offers=None, free=None, text="<p>Un groupe légendaire du rock psychédélique.</p>"):
    ld = {"@context": "https://schema.org", "@type": "Event", "name": "x"}
    if offers is not None:
        ld["offers"] = [{"@type": "Offer", "name": n, "price": p, "availability": "https://schema.org/" + a}
                        for n, p, a in offers]
    if free is not None:
        ld["isAccessibleForFree"] = free
    return ('<a href="https://dice.fm/venue/header-link">nav</a><script type="application/ld+json">' + json.dumps(ld)
            + '</script><div class="p-content p-texte-content"><div class="text-formatted field '
            'field--name-field-texte field--type-text-long">' + text + "</div></div>")


class BalChavauxTest(unittest.TestCase):
    def scrape(self, pages):
        calls = []

        def get(url, retries=2):
            if "/agenda/" in url:          # event pages: the ones a test does not give are down
                if url not in pages:
                    raise V.FetchError("HTTP 500 for " + url)
                return pages[url]
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
        self.assertEqual({(e.price, e.ticket_url) for e in got}, {(None, None)})   # event pages down: cards kept
        self.assertEqual(got[0].url, "https://balchavaux.fr/agenda/olllam")
        self.assertEqual(got[0].image, "https://balchavaux.fr/sites/balchavaux/files/olllam.png?itok=a")

    def test_single_page(self):
        got, calls = self.scrape({VENUE["url"]: PAGE2})
        self.assertEqual((len(got), len(calls)), (3, 1))


    def test_event_page(self):
        base = "https://balchavaux.fr/agenda/"
        dice = "https://dice.fm/event/rykx8q-mareux?lng=fr"
        got, _ = self.scrape({VENUE["url"]: PAGE1, VENUE["url"] + "?page=1": PAGE2, **{base + k: v for k, v in {
            "olllam": page([("Prévente", 32, "InStock"), ("Sur place", 35, "InStock"), ("Exonéré", 0, "InStock")], False),
            "alpha-wolf": page([("Prévente", 20, "InStock")], False),                       # cancelled on the card
            "liksn": page([("Tarif unique", 29.5, "InStock")], False),
            "sophro-danse-0": page([("Exonéré", 0, "InStock"), ("PRIX LIBRE", 0, "InStock")], False,
                                   "<p>Entrée libre / 10€ conseillé&nbsp;</p><p>Un atelier pour lâcher prise.</p>"),
            "mareux": page([("Prévente", 29.5, "SoldOut"), ("Sur place", 34, "SoldOut")], False,
                           f'<p>BILLETTERIE SUR DICE : <a href="{dice}">{dice}</a></p><p>&nbsp;</p>'
                           "<p><strong>Mareux sera de passage au Bal Chavaux.</strong></p>"),
            "silvestri": page(None, True),
        }.items()}})
        by = {e.url.rsplit("/", 1)[1]: e for e in got}
        self.assertEqual([(k, e.price, e.free, e.ticket_url) for k, e in by.items()], [
            ("olllam", "32–35 €", False, base + "olllam"),          # sold on the venue's own page
            ("sophro-danse-0", "Entrée libre / 10€ conseillé", True, base + "sophro-danse-0"),
            ("alpha-wolf", "20 €", False, None),
            ("liksn", "29.50 €", False, base + "liksn"),
            ("mareux", "29.50–34 €", False, dice),
            ("silvestri", None, True, None),
        ])
        self.assertEqual(by["sophro-danse-0"].description, "AVEC LA CIE X — Un atelier pour lâcher prise.")
        self.assertEqual(by["mareux"].description, "Mareux sera de passage au Bal Chavaux.")
        self.assertEqual(by["liksn"].description, "Persona Grata présente — Un groupe légendaire du rock psychédélique.")

    def details(self, html):
        with mock.patch.object(V, "get", lambda url, retries=2: html):
            return V._bc_details("https://balchavaux.fr/agenda/x")

    def test_event_page_odd_cases(self):
        ra = '<p>Résident <a href="https://ra.co/dj/someone">RA</a> depuis 2020, en live.</p>'
        d = self.details(page([("Prévente", 20, "SoldOut"), ("Exonéré", 0, "InStock")], False, ra))
        self.assertEqual((d["ticket_url"], d["sold_out"], d["price"]), ("https://balchavaux.fr/agenda/x", True, "20 €"))
        self.assertIn("Résident", d["description"])
        d = self.details(page([("Exonéré", 0, "InStock")], False, "<p>Free jazz trio from Berlin.</p>"))
        self.assertEqual((d.get("price"), d["free"]), (None, False))
        d = self.details(page([("Exonéré", 0, "InStock")], False,
                              '<div class="video"><iframe></iframe></div><p>Billets : <a href="https://shotgun.live/fr/events/x">ici</a></p>'))
        self.assertEqual(d["ticket_url"], "https://shotgun.live/fr/events/x")
        for offers in ('5', '{"@type": "Offer", "price": "20.00", "availability": "InStock"}', 'null'):
            d = self.details('<script type="application/ld+json">{"@type": "Event", "offers": %s}</script>' % offers)
            self.assertEqual(d.get("price"), "20 €" if "20" in offers else None)
        self.assertEqual(self.details("<html></html>"), {"free": False, "description": None})

    def test_event_pages_down_are_not_asked_forever(self):
        asked = []

        def get(url, retries=2):
            if "/agenda/" in url:
                asked.append(url)
                raise V.FetchError("HTTP 503")
            return PAGE1 + PAGE2
        with mock.patch.object(V, "get", get):
            got = V.balchavaux(VENUE, {"today": dt.date(2026, 9, 28)})
        self.assertEqual((len(got), len(asked)), (6, 3))

    def test_past_event_page_is_not_fetched(self):
        pages = {VENUE["url"]: PAGE2, "https://balchavaux.fr/agenda/silvestri": page([("Prévente", 40, "InStock")])}
        with mock.patch.object(V, "get", lambda url, retries=2: pages[url]):      # a KeyError if an October page is asked
            got = V.balchavaux(VENUE, {"today": dt.date(2026, 12, 1)})
        self.assertEqual([(e.date, e.price) for e in got],
                         [("2026-10-01", None), ("2026-10-31", None), ("2027-03-06", "40 €")])


if __name__ == "__main__":
    unittest.main()
