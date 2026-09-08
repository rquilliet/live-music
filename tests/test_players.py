"""python -m unittest discover tests"""
import datetime as dt
import json
import os
import tempfile
import unittest

from livemusic import players as P
from livemusic.model import Event

BAND = "https://frankieandthewitchfingers.bandcamp.com"
AUTOCOMPLETE = json.dumps({"auto": {"results": [
    {"type": "a", "name": "Frankie and the Witch Fingers", "band_name": "Somebody Else", "item_url_path": "https://x.bandcamp.com/album/y"},
    {"type": "b", "name": "Frankie & The Witch Fingers", "item_url_path": BAND + "?from=search", "location": "Los Angeles"},
    {"type": "b", "name": "Frankie", "item_url_path": "https://frankie.bandcamp.com"},
]}})
SEARCH_HTML = """
<ul class="result-items">
<li class="searchresult data-search"><div class="result-info">
  <div class="itemtype">ALBUM</div>
  <div class="heading"><a href="https://other.bandcamp.com/album/thala?from=fanpub_fnb">Thala</a></div></div></li>
<li class="searchresult data-search"><div class="result-info">
  <div class="itemtype">
      ARTIST
  </div>
  <div class="heading">
      <a href="https://thala.bandcamp.com?from=search&amp;search_item_id=1">
          Thala
      </a>
  </div></div></li>
</ul>"""
BAND_PAGE = """<html><head><meta charset="utf-8">
<meta name="bc-page-properties" content="{&quot;item_type&quot;:&quot;a&quot;,&quot;item_id&quot;:2710421567}">
</head><body>ok</body></html>"""
DISCOGRAPHY = """<html><body><ol id="music-grid">
<li><a href="/album/data-doom?label=1">Data Doom</a></li><li><a href="/track/single">Single</a></li></ol></body></html>"""
TRACK_PAGE = """<meta content='{"item_type":"t","item_id":99}' name="bc-page-properties">"""
SPOTIFY = json.dumps({"artists": {"items": [
    {"id": "1", "name": "Thala Tribute", "external_urls": {"spotify": "https://open.spotify.com/artist/1"}},
    {"id": "4bWlB8v4eOgdzBIO5FSCGh", "name": "Thála", "external_urls": {"spotify": "https://open.spotify.com/artist/4bWlB8v4eOgdzBIO5FSCGh"}},
]}})
SP_THALA = {"id": "4bWlB8v4eOgdzBIO5FSCGh", "url": "https://open.spotify.com/artist/4bWlB8v4eOgdzBIO5FSCGh"}
TODAY = dt.date(2026, 9, 8)


class FakeHttp:
    """Maps URL prefixes to bodies (or exceptions) and records the calls."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, data=None, headers=None, timeout=None):
        self.calls.append((url, data, headers))
        for prefix, body in self.routes.items():
            if url.startswith(prefix):
                if isinstance(body, Exception):
                    raise body
                return body
        raise P.PlayerError(f"no route for {url}")


def mk(title, headliner=None, support=(), is_music=True, date="2026-09-20", description=None, url=None):
    return Event(title=title, date=date, venue="V", venue_slug="v", source="s", headliner=headliner, support=list(support),
                 is_music=is_music, description=description, url=url)


class NameTests(unittest.TestCase):
    def test_same_artist_is_accent_case_article_insensitive(self):
        self.assertTrue(P.same_artist("The Black Angels", "black angels"))
        self.assertTrue(P.same_artist("Thála", "THALA"))
        self.assertTrue(P.same_artist("Frankie & The Witch Fingers", "Frankie and the Witch Fingers"))
        self.assertTrue(P.same_artist("Sean Nicholas-Savage", "sean nicholas savage"))
        self.assertFalse(P.same_artist("Frankie", "Frankie and the Witch Fingers"))
        self.assertFalse(P.same_artist("", ""))

    def test_artists_of(self):
        e = mk("T", "Ana", ["Bob", "ANA", "Cid", "Dee", "Eve", "Fay"])
        self.assertEqual(P.artists_of(e), ["Ana", "Bob", "Cid", "Dee"])  # de-duplicated, capped at 5 names on the bill
        self.assertEqual(P.artists_of(mk("T", "A", ["B"])), [])  # one-letter "names" are never looked up
        self.assertEqual(P.artists_of(mk("Solo title")), ["Solo title"])
        self.assertEqual(P.artists_of(mk("T", "1", ["x", "DJ set"])), ["DJ set"])


class BandcampParsingTests(unittest.TestCase):
    def test_autocomplete_exact_band_only(self):
        self.assertEqual(P.parse_autocomplete(AUTOCOMPLETE, "Frankie and the Witch Fingers"), BAND)
        self.assertEqual(P.parse_autocomplete(json.loads(AUTOCOMPLETE), "Frankie"), "https://frankie.bandcamp.com")
        self.assertIsNone(P.parse_autocomplete(AUTOCOMPLETE, "Witch Fingers"))
        self.assertIsNone(P.parse_autocomplete("<html>bot wall</html>", "Frankie"))
        self.assertEqual(P.parse_autocomplete({"results": [{"type": "b", "name": "X", "url": "x.bandcamp.com/"}]}, "X"), "https://x.bandcamp.com")

    def test_search_html_fallback(self):
        self.assertEqual(P.parse_search_html(SEARCH_HTML, "Thala"), "https://thala.bandcamp.com")
        self.assertIsNone(P.parse_search_html(SEARCH_HTML, "Other"))  # the album result is not an artist
        self.assertIsNone(P.parse_search_html("", "Thala"))

    def test_page_properties_and_release_links(self):
        self.assertEqual(P.parse_page_properties(BAND_PAGE), ("a", 2710421567))
        self.assertEqual(P.parse_page_properties(TRACK_PAGE), ("t", 99))
        self.assertIsNone(P.parse_page_properties(DISCOGRAPHY))
        self.assertIsNone(P.parse_page_properties('<meta name="bc-page-properties" content="{&quot;item_type&quot;:&quot;b&quot;,&quot;item_id&quot;:5}">'))
        self.assertEqual(P.first_release_link(DISCOGRAPHY, BAND), BAND + "/album/data-doom")
        self.assertEqual(P.first_release_link('<a href="https://elsewhere.bandcamp.com/album/z">z</a><a href="https://a.bandcamp.com/track/t">', "https://a.bandcamp.com/"),
                         "https://a.bandcamp.com/track/t")
        self.assertEqual(P.embed_url("a", 12), "https://bandcamp.com/EmbeddedPlayer/album=12/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/")
        self.assertTrue(P.embed_url("t", 99).startswith("https://bandcamp.com/EmbeddedPlayer/track=99/"))

    def test_resolve_bandcamp_via_autocomplete_then_band_page(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: AUTOCOMPLETE, BAND: BAND_PAGE})
        pauses = []
        got = P.resolve_bandcamp("Frankie and the Witch Fingers", fetch=http, sleep=pauses.append)
        self.assertEqual(got, {"url": BAND, "embed": P.embed_url("a", 2710421567)})
        self.assertEqual(http.calls[0][1]["search_text"], "Frankie and the Witch Fingers")
        self.assertEqual(http.calls[1][0], BAND)
        self.assertEqual(pauses, [P.BANDCAMP_PAUSE])

    def test_resolve_bandcamp_falls_back_to_html_search_and_discography(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: P.PlayerError("HTTP 403"), "https://bandcamp.com/search?": SEARCH_HTML,
                         "https://thala.bandcamp.com/album/": BAND_PAGE, "https://thala.bandcamp.com": DISCOGRAPHY})
        got = P.resolve_bandcamp("Thala", fetch=http, sleep=lambda s: None)
        self.assertEqual(got["url"], "https://thala.bandcamp.com")
        self.assertIn("album=2710421567", got["embed"])
        self.assertIsNone(P.resolve_bandcamp("Nobody", fetch=http, sleep=lambda s: None))
        # a band page with nothing embeddable still yields the URL for the links row
        http = FakeHttp({P.BC_AUTOCOMPLETE: AUTOCOMPLETE, BAND: "<html>coming soon</html>"})
        self.assertEqual(P.resolve_bandcamp("Frankie and the Witch Fingers", fetch=http, sleep=lambda s: None), {"url": BAND})

    def test_known_url_skips_the_search(self):
        http = FakeHttp({"https://thala.bandcamp.com": BAND_PAGE})
        got = P.resolve_bandcamp("Thala", fetch=http, sleep=lambda s: None, url="https://thala.bandcamp.com")
        self.assertEqual(got["url"], "https://thala.bandcamp.com")
        self.assertEqual([c[0] for c in http.calls], ["https://thala.bandcamp.com"])

    def test_network_errors_propagate(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: P.PlayerError("timeout"), "https://bandcamp.com/search?": P.PlayerError("timeout")})
        with self.assertRaises(P.PlayerError):
            P.resolve_bandcamp("Thala", fetch=http, sleep=lambda s: None)

    def test_hints_from_event_text(self):
        named = mk("Frankie and the Witch Fingers • Thala", "Frankie and the Witch Fingers", ["Thala"],
                   description="Psych from LA. https://frankieandthewitchfingers.bandcamp.com/album/data-doom")
        solo = mk("Thala", "Thala", url="https://venue.fr/x", description="écouter: http://thala-music.bandcamp.com")
        ambiguous = mk("A • B", "A", ["B"], description="https://somebody.bandcamp.com")
        off = mk("Thala", "Thala", is_music=False, description="https://nope.bandcamp.com")
        self.assertEqual(P.bandcamp_hints([named, solo, ambiguous, off]),
                         {"frankie and the witch fingers": BAND, "thala": "https://thala-music.bandcamp.com"})


class SpotifyTests(unittest.TestCase):
    def test_parse_exact_match(self):
        self.assertEqual(P.parse_spotify(SPOTIFY, "Thala"), SP_THALA)
        self.assertIsNone(P.parse_spotify(SPOTIFY, "Tribute"))
        self.assertIsNone(P.parse_spotify("{}", "Thala"))

    def test_token_and_search_requests(self):
        http = FakeHttp({P.SP_TOKEN: '{"access_token": "tok"}', "https://api.spotify.com/v1/search": SPOTIFY})
        self.assertEqual(P.spotify_token("id", "secret", fetch=http), "tok")
        self.assertEqual(http.calls[0][1], "grant_type=client_credentials")
        self.assertTrue(http.calls[0][2]["Authorization"].startswith("Basic "))
        self.assertEqual(P.resolve_spotify("Thála", "tok", fetch=http)["id"], "4bWlB8v4eOgdzBIO5FSCGh")
        self.assertEqual(http.calls[1][2]["Authorization"], "Bearer tok")
        self.assertIn("q=Th%C3%A1la", http.calls[1][0])


class CacheTests(unittest.TestCase):
    def test_negative_results_expire_after_30_days(self):
        entry = {"name": "X"}
        P.cache_put(entry, "bandcamp", None, TODAY)
        self.assertFalse(P.needs_lookup(entry, "bandcamp", TODAY))
        self.assertFalse(P.needs_lookup(entry, "bandcamp", TODAY + dt.timedelta(days=29)))
        self.assertTrue(P.needs_lookup(entry, "bandcamp", TODAY + dt.timedelta(days=30)))
        self.assertTrue(P.needs_lookup(entry, "spotify", TODAY))  # never asked (no credentials at the time)
        self.assertTrue(P.needs_lookup(None, "bandcamp", TODAY))
        self.assertTrue(P.needs_lookup({"bandcamp": None, "checked": {"bandcamp": "garbage"}}, "bandcamp", TODAY))

    def test_positive_results_are_kept_much_longer(self):
        entry = {"name": "X"}
        P.cache_put(entry, "bandcamp", {"url": BAND, "embed": "e"}, TODAY)
        self.assertFalse(P.needs_lookup(entry, "bandcamp", TODAY + dt.timedelta(days=200)))
        self.assertTrue(P.needs_lookup(entry, "bandcamp", TODAY + dt.timedelta(days=P.POSITIVE_TTL_DAYS)))
        self.assertEqual(P.players_for(entry), {"bandcamp": {"url": BAND, "embed": "e"}})
        self.assertEqual(P.players_for({"bandcamp": None, "spotify": None}), {})


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "player_cache.json")
        self.logs = []

    def tearDown(self):
        self.tmp.cleanup()

    def run_resolve(self, events, http, **kw):
        kw.setdefault("credentials", False)
        return P.resolve(events, self.path, today=kw.pop("today", TODAY), log=self.logs.append, fetch=http, sleep=lambda s: None, **kw)

    def test_players_written_per_artist_name_and_cached(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: AUTOCOMPLETE, BAND: BAND_PAGE, P.SP_TOKEN: '{"access_token": "t"}',
                         "https://api.spotify.com/v1/search": SPOTIFY})
        gig = mk("Frankie and the Witch Fingers • Thala", "Frankie and the Witch Fingers", ["Thala"])
        off = mk("Frankie and the Witch Fingers", "Frankie and the Witch Fingers", is_music=False)
        self.run_resolve([gig, off], http, credentials=("id", "secret"))
        self.assertEqual(gig.players, {
            "Frankie and the Witch Fingers": {"bandcamp": {"url": BAND, "embed": P.embed_url("a", 2710421567)}},
            "Thala": {"spotify": SP_THALA},
        })
        self.assertEqual(off.players, {})  # not a concert: not looked up
        self.assertEqual(json.loads(json.dumps(gig.to_dict()))["players"], gig.players)
        cache = P.cache_load(self.path)
        self.assertIsNone(cache["thala"]["bandcamp"])  # negative result stored...
        self.assertEqual(cache["thala"]["checked"], {"bandcamp": "2026-09-08", "spotify": "2026-09-08"})
        # ...so a second run makes no network call at all
        n = len(http.calls)
        again = mk("Thala", "Thala")
        self.run_resolve([again], http, credentials=("id", "secret"), today=TODAY + dt.timedelta(days=1))
        self.assertEqual(len(http.calls), n)
        self.assertEqual(again.players, {"Thala": {"spotify": SP_THALA}})

    def test_without_spotify_credentials_only_bandcamp_is_asked(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: AUTOCOMPLETE, BAND: BAND_PAGE})
        gig = mk("Frankie and the Witch Fingers", "Frankie and the Witch Fingers")
        self.run_resolve([gig], http)
        self.assertNotIn("spotify", P.cache_load(self.path)["frankie and the witch fingers"])
        self.assertFalse(any("spotify.com" in c[0] for c in http.calls))
        self.assertEqual(list(gig.players), ["Frankie and the Witch Fingers"])

    def test_bad_spotify_credentials_do_not_stop_bandcamp(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: AUTOCOMPLETE, BAND: BAND_PAGE, P.SP_TOKEN: P.PlayerError("HTTP 400")})
        gig = mk("Frankie and the Witch Fingers", "Frankie and the Witch Fingers")
        self.run_resolve([gig], http, credentials=("id", "wrong"))
        self.assertIn("bandcamp", gig.players["Frankie and the Witch Fingers"])
        self.assertTrue(any("Spotify auth failed" in m for m in self.logs))

    def test_network_failures_are_logged_not_cached_and_bounded(self):
        http = FakeHttp({})  # everything fails
        events = [mk(f"Band {i}", f"Band {i}") for i in range(20)]
        self.run_resolve(events, http)
        self.assertEqual(len(http.calls), 2 * P.MAX_CONSECUTIVE_ERRORS)  # autocomplete + html fallback, then it gives up
        self.assertFalse(os.path.exists(self.path))  # nothing learnt, nothing written: retried next run
        self.assertTrue(all(e.players == {} for e in events))
        self.assertTrue(any("giving up" in m for m in self.logs))

    def test_lookup_order_and_cap(self):
        http = FakeHttp({P.BC_AUTOCOMPLETE: "{}"})
        soon, later = mk("Zed", "Zed", date="2026-09-10"), mk("Alpha", "Alpha", date="2026-12-01")
        self.run_resolve([later, soon], http, max_lookups=1)
        self.assertEqual(http.calls[0][1]["search_text"], "Zed")
        self.assertEqual(list(P.cache_load(self.path)), ["zed"])

    def test_event_text_link_is_used_instead_of_the_search(self):
        http = FakeHttp({"https://thala.bandcamp.com": BAND_PAGE})
        gig = mk("Thala", "Thala", description="https://thala.bandcamp.com/album/x")
        self.run_resolve([gig], http)
        self.assertEqual(gig.players["Thala"]["bandcamp"]["url"], "https://thala.bandcamp.com")
        self.assertFalse(any(P.BC_AUTOCOMPLETE in c[0] for c in http.calls))


if __name__ == "__main__":
    unittest.main()
