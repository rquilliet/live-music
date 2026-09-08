"""Where can the artist be listened to?  Resolved at scrape time, per artist name, for the detail sheet.

The page is static, so it cannot ask Bandcamp (no API, no CORS) or Spotify (OAuth) itself.  This module
looks each act up once, caches the answer in data/player_cache.json (negative answers too, re-checked
after NEGATIVE_TTL_DAYS) and writes onto every music event::

    players: {"<artist name>": {"bandcamp": {"url": ..., "embed": ...}, "spotify": {"url": ..., "id": ...}}}

Providers that were not found are simply absent; a Bandcamp page with nothing embeddable has `url` only
(still worth a link).  The UI picks Bandcamp (embed) > Spotify > Deezer.

* Bandcamp: public autocomplete endpoint (falls back to the HTML search page), exact normalised name
  match, then the band page's ``bc-page-properties`` meta gives an album/track id for the EmbeddedPlayer.
* Spotify: only with SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (client-credentials flow); skipped otherwise.

No dependency beyond the standard library; network errors never propagate (logged, not cached).
"""
import base64
import datetime as dt
import html as htmllib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .fetch import UA
from .util import strip_accents

NEGATIVE_TTL_DAYS = 30      # an act unknown to Bandcamp/Spotify is asked again after a month
POSITIVE_TTL_DAYS = 365     # a found page is trusted for a year (ids do not move)
MAX_LOOKUPS = 300           # new artists resolved per run; the cache fills up over the daily runs
MAX_ARTISTS_PER_EVENT = 5   # headliner + 4 support acts
MAX_CONSECUTIVE_ERRORS = 5  # a blocked host must not cost hundreds of timeouts
BANDCAMP_PAUSE = 1.0        # seconds between Bandcamp requests
TIMEOUT = 15

BC_AUTOCOMPLETE = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic"
BC_SEARCH = "https://bandcamp.com/search?q={q}&item_type=b"
BC_EMBED = ("https://bandcamp.com/EmbeddedPlayer/{kind}={id}/size=large/bgcol=ffffff/linkcol=0687f5/"
            "tracklist=false/artwork=small/transparent=true/")
SP_TOKEN = "https://accounts.spotify.com/api/token"
SP_SEARCH = "https://api.spotify.com/v1/search?type=artist&limit=5&q={q}"


class PlayerError(Exception):
    pass


# ------------------------------------------------------------------ names

def norm_artist(name: str) -> str:
    """Accent/case/punctuation-insensitive key: 'The Black Angels' == 'black angels', 'A & B' == 'a and b'."""
    n = strip_accents((name or "").lower()).replace("&", " and ")
    n = re.sub(r"[^a-z0-9]+", " ", n).strip()
    n = re.sub(r"^(the|les|le|la) ", "", n)
    return re.sub(r"\s+", " ", n)


def same_artist(a: str, b: str) -> bool:
    na, nb = norm_artist(a), norm_artist(b)
    return bool(na) and na == nb


def _looks_like_artist(name: str) -> bool:
    n = norm_artist(name)
    return 1 < len(n) <= 80 and not re.fullmatch(r"\d+", n)


# ------------------------------------------------------------------ http

def http(url, data=None, headers=None, timeout=TIMEOUT):
    """GET (or POST when `data` is given) and return the body as text; PlayerError on anything else."""
    h = {"User-Agent": UA, "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
         "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"}
    h.update(headers or {})
    if isinstance(data, (dict, list)):
        data = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    elif isinstance(data, str):
        data = data.encode()
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as e:
        raise PlayerError(f"HTTP {e.code} for {url}") from None
    except Exception as e:  # DNS, TLS, timeouts, proxy refusals
        raise PlayerError(f"{type(e).__name__}: {e} for {url}") from None


# ------------------------------------------------------------------ bandcamp parsing

def _band_url(hit: dict):
    u = hit.get("item_url_path") or hit.get("url") or hit.get("item_url_root") or ""
    if not u:
        return None
    if u.startswith("//"):
        u = "https:" + u
    elif not re.match(r"^https?://", u):
        u = "https://" + u.lstrip("/")
    return u.split("?")[0].rstrip("/")


def parse_autocomplete(payload, name: str):
    """Band URL of the autocomplete hit whose name is exactly the artist, else None.

    Tolerates both {"auto": {"results": [...]}} and {"results": [...]}; only `type == "b"` items count.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    if not isinstance(payload, dict):
        return None
    results = (payload.get("auto") or {}).get("results") if isinstance(payload.get("auto"), dict) else None
    if results is None:
        results = payload.get("results") or []
    for hit in results:
        if isinstance(hit, dict) and hit.get("type") == "b" and same_artist(hit.get("name", ""), name):
            u = _band_url(hit)
            if u:
                return u
    return None


_RESULT = re.compile(r'class="searchresult(.*?)(?=class="searchresult|$)', re.S)
_HEADING = re.compile(r'class="heading"\s*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_ITEMTYPE = re.compile(r'class="itemtype"\s*>(.*?)<', re.S)


def parse_search_html(page: str, name: str):
    """Fallback for the HTML search page: the artist's URL when a result is an ARTIST with that exact name."""
    for block in _RESULT.findall(page or ""):
        kind = _ITEMTYPE.search(block)
        head = _HEADING.search(block)
        if not head or (kind and "artist" not in kind.group(1).strip().lower()):
            continue
        label = htmllib.unescape(re.sub(r"<[^>]+>", " ", head.group(2)))
        if same_artist(label, name):
            u = _band_url({"url": htmllib.unescape(head.group(1))})
            if u:
                return u
    return None


_PAGE_PROPS = re.compile(r'<meta\s+name=["\']bc-page-properties["\']\s+content=["\'](.*?)["\']\s*/?>', re.S | re.I)
_PAGE_PROPS_REV = re.compile(r'<meta\s+content=["\'](.*?)["\']\s+name=["\']bc-page-properties["\']\s*/?>', re.S | re.I)


def parse_page_properties(page: str):
    """(item_type, item_id) from the bc-page-properties meta: ('a', 123) for an album, ('t', 456) for a track."""
    m = _PAGE_PROPS.search(page or "") or _PAGE_PROPS_REV.search(page or "")
    if not m:
        return None
    try:
        props = json.loads(htmllib.unescape(m.group(1)))
    except ValueError:
        return None
    kind, item_id = props.get("item_type"), props.get("item_id")
    if kind in ("a", "t") and isinstance(item_id, int) and item_id > 0:
        return kind, item_id
    return None


_RELEASE = re.compile(r'href="((?:https?://[^"/]+)?/(?:album|track)/[A-Za-z0-9._~-]+)[^"]*"')


def first_release_link(page: str, base_url: str):
    """Absolute URL of the first album/track link on a band page (the discography's newest item)."""
    host = base_url.split("?")[0].rstrip("/")
    for m in _RELEASE.finditer(page or ""):
        href = htmllib.unescape(m.group(1))
        if href.startswith("/"):
            return host + href
        if href.split("/album/")[0].split("/track/")[0].rstrip("/") == host:  # same band only
            return href
    return None


def embed_url(kind: str, item_id: int) -> str:
    return BC_EMBED.format(kind="album" if kind == "a" else "track", id=int(item_id))


_BC_LINK = re.compile(r"https?://([a-z0-9-]+)\.bandcamp\.com\b", re.I)


def bandcamp_hints(events) -> dict:
    """norm artist -> band URL for acts whose event text already links their Bandcamp (venue pages often do):
    the subdomain must spell the artist's name, or the bill has a single act and the text a single link."""
    hints = {}
    for e in events:
        if not e.is_music:
            continue
        text = " ".join(filter(None, (e.description, e.url, e.ticket_url)))
        subs = {m.group(1).lower() for m in _BC_LINK.finditer(text)} - {"www", "daily", "bandcamp", "get"}
        names = artists_of(e)
        for n in names:
            key = norm_artist(n)
            for sub in subs:
                if sub.replace("-", "") == key.replace(" ", "") or (len(names) == 1 and len(subs) == 1):
                    hints.setdefault(key, f"https://{sub}.bandcamp.com")
    return hints


def resolve_bandcamp(name: str, fetch=http, sleep=time.sleep, url=None):
    """{"url", "embed"} for the band, {"url"} when the page has nothing embeddable, None when unknown.

    `url` skips the search when the venue page already linked the artist's Bandcamp.
    Raises PlayerError on network trouble so the caller does not cache a failure as "not on Bandcamp".
    """
    if not url:
        try:
            body = fetch(BC_AUTOCOMPLETE, data={"search_text": name, "search_filter": "b", "full_page": False, "fan_id": None})
            url = parse_autocomplete(body, name)
        except PlayerError:
            sleep(BANDCAMP_PAUSE)
            url = parse_search_html(fetch(BC_SEARCH.format(q=urllib.parse.quote(name))), name)
    if not url:
        return None
    sleep(BANDCAMP_PAUSE)
    page = fetch(url)
    props = parse_page_properties(page)
    if not props:
        release = first_release_link(page, url)
        if release:
            sleep(BANDCAMP_PAUSE)
            props = parse_page_properties(fetch(release))
    out = {"url": url}
    if props:
        out["embed"] = embed_url(*props)
    return out


# ------------------------------------------------------------------ spotify

def spotify_credentials():
    cid, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def spotify_token(cid: str, secret: str, fetch=http) -> str:
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    body = fetch(SP_TOKEN, data="grant_type=client_credentials",
                 headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"})
    token = json.loads(body).get("access_token")
    if not token:
        raise PlayerError("Spotify token response without access_token")
    return token


def parse_spotify(payload, name: str):
    """{"id", "url"} of the artist whose name matches exactly, else None."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    items = ((payload or {}).get("artists") or {}).get("items") or []
    for a in items:
        if isinstance(a, dict) and same_artist(a.get("name", ""), name) and a.get("id"):
            return {"id": a["id"], "url": (a.get("external_urls") or {}).get("spotify") or f"https://open.spotify.com/artist/{a['id']}"}
    return None


def resolve_spotify(name: str, token: str, fetch=http):
    body = fetch(SP_SEARCH.format(q=urllib.parse.quote(name)), headers={"Authorization": f"Bearer {token}"})
    return parse_spotify(body, name)


# ------------------------------------------------------------------ cache

PROVIDERS = ("bandcamp", "spotify")


def cache_load(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def cache_save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0, sort_keys=True)


def needs_lookup(entry, provider: str, today: dt.date) -> bool:
    """Never asked -> yes; negative older than NEGATIVE_TTL_DAYS -> yes; positive older than a year -> yes."""
    if not entry or provider not in entry:
        return True
    checked = (entry.get("checked") or {}).get(provider)
    try:
        age = (today - dt.date.fromisoformat(checked)).days
    except (TypeError, ValueError):
        return True
    return age >= (POSITIVE_TTL_DAYS if entry.get(provider) else NEGATIVE_TTL_DAYS)


def cache_put(entry: dict, provider: str, value, today: dt.date):
    entry[provider] = value
    entry.setdefault("checked", {})[provider] = today.isoformat()


def players_for(entry) -> dict:
    """The public shape written on events: only providers that were found."""
    return {p: entry[p] for p in PROVIDERS if entry and entry.get(p)}


# ------------------------------------------------------------------ pipeline entry point

def artists_of(event):
    names = [event.headliner] + list(event.support or []) if event.headliner else [event.title]
    out, seen = [], set()
    for n in names[:MAX_ARTISTS_PER_EVENT]:
        k = norm_artist(n or "")
        if n and k not in seen and _looks_like_artist(n):
            seen.add(k)
            out.append(n)
    return out


def resolve(events, cache_path, today=None, log=print, fetch=http, sleep=time.sleep, credentials=None,
            max_lookups=MAX_LOOKUPS):
    """Fill `players` on every music event.  Lookups go soonest-concert first, capped per run."""
    today = today or dt.date.today()
    cache = cache_load(cache_path)
    creds = credentials if credentials is not None else spotify_credentials()

    # artist -> earliest event date, so the cap favours acts that play soon
    pending = {}
    for e in sorted(events, key=lambda e: e.date):
        if e.is_music:
            for n in artists_of(e):
                pending.setdefault(norm_artist(n), n)
    todo = [(k, n) for k, n in pending.items()
            if needs_lookup(cache.get(k), "bandcamp", today) or (creds and needs_lookup(cache.get(k), "spotify", today))]
    if len(todo) > max_lookups:
        log(f"  players: {len(todo)} artists to look up, doing {max_lookups} this run")
        todo = todo[:max_lookups]
    elif todo:
        log(f"  players: looking up {len(todo)} artists" + ("" if creds else " (Spotify skipped: no SPOTIFY_CLIENT_ID/SECRET)"))

    hints = bandcamp_hints(events)
    token, bc_errors, sp_errors, found = None, 0, 0, {"bandcamp": 0, "spotify": 0}
    if creds and todo:
        try:
            token = spotify_token(*creds, fetch=fetch)
        except (PlayerError, ValueError) as e:
            log(f"  players: Spotify auth failed, skipping Spotify: {e}")
    dirty = False
    for i, (key, name) in enumerate(todo, 1):
        entry = cache.setdefault(key, {"name": name})
        if bc_errors < MAX_CONSECUTIVE_ERRORS and needs_lookup(entry, "bandcamp", today):
            try:
                cache_put(entry, "bandcamp", resolve_bandcamp(name, fetch=fetch, sleep=sleep, url=hints.get(key)), today)
                bc_errors, dirty = 0, True
                found["bandcamp"] += bool(entry["bandcamp"])
            except (PlayerError, ValueError) as ex:
                bc_errors += 1
                log(f"  players: bandcamp {name!r}: {ex}")
                if bc_errors >= MAX_CONSECUTIVE_ERRORS:
                    log("  players: Bandcamp unreachable, giving up on it for this run")
        if token and sp_errors < MAX_CONSECUTIVE_ERRORS and needs_lookup(entry, "spotify", today):
            try:
                cache_put(entry, "spotify", resolve_spotify(name, token, fetch=fetch), today)
                sp_errors, dirty = 0, True
                found["spotify"] += bool(entry["spotify"])
            except (PlayerError, ValueError) as ex:
                sp_errors += 1
                log(f"  players: spotify {name!r}: {ex}")
        if dirty and i % 25 == 0:
            cache_save(cache_path, cache)  # a run killed halfway keeps what it learnt
        if bc_errors >= MAX_CONSECUTIVE_ERRORS and (not token or sp_errors >= MAX_CONSECUTIVE_ERRORS):
            break
    if dirty:
        cache_save(cache_path, cache)
    if todo:
        log(f"  players: found {found['bandcamp']} on Bandcamp, {found['spotify']} on Spotify")

    for e in events:
        e.players = {}
        if not e.is_music:
            continue
        for n in artists_of(e):
            hit = players_for(cache.get(norm_artist(n)))
            if hit:
                e.players[n] = hit
    return cache
