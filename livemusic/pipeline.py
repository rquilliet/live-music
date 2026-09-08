"""Run every source, merge duplicates, tag genres, resolve players, track first-seen dates, write web/events.json."""
import datetime as dt
import json
import math
import os
import re
import time
import traceback

from . import genres as G
from . import players as P
from .fetch import FetchError
from .sources import STRATEGIES
from .util import norm_title, slugify, split_lineup, strip_accents

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web")
SEEN_PATH = os.path.join(DATA, "seen.json")
GENRE_CACHE = os.path.join(DATA, "genre_cache.json")
PLAYER_CACHE = os.path.join(DATA, "player_cache.json")
OUT_PATH = os.path.join(WEB, "events.json")
HORIZON_DAYS = 120
NEW_WINDOW_DAYS = 7
VENUE_MATCH_KM = 0.15


def today_paris() -> dt.date:
    """Calendar date in Paris whatever the machine's timezone (a UTC server at 00:30 is still 'today')."""
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo("Europe/Paris")).date()
    except Exception:  # no tz database available
        return dt.date.today()


def load_venues(path=None):
    with open(path or os.path.join(ROOT, "venues.json"), "r", encoding="utf-8") as f:
        venues = json.load(f)
    for v in venues:
        v.setdefault("slug", slugify(v["name"]))
    return venues


def run(only=None, use_llm=True, players=True, log=print):
    started = time.time()
    plain = log

    def log(msg):  # every line carries the elapsed time: the run takes minutes with the LLM on
        plain(f"[{int(time.time() - started) // 60:02d}:{int(time.time() - started) % 60:02d}] {msg}")

    today = today_paris()
    ctx = {"today": today, "horizon_days": HORIZON_DAYS, "log": log}
    venues = load_venues()
    by_slug = {v["slug"]: v for v in venues}
    state = load_state()
    events, report = [], []
    todo = [v for v in venues if v["strategy"] != "none" and not (v["strategy"] == "llm" and not use_llm)
            and (not only or v["slug"] in only or v["strategy"] in only)]
    log(f"{len(todo)} sources to scrape, today is {today}")

    for i, v in enumerate(todo, 1):
        fn = STRATEGIES.get(v["strategy"])
        if not fn:
            log(f"  {v['name']}: unknown strategy {v['strategy']}")
            continue
        log(f"  ({i}/{len(todo)}) {v['name']} [{v['strategy']}] ...")
        try:
            got = fn(v, ctx)
        except FetchError as e:
            log(f"  {v['name']}: FETCH FAILED {e}")
            report.append({"venue": v["name"], "ok": False, "error": str(e)})
            continue
        except Exception as e:  # a broken parser must not kill the run
            log(f"  {v['name']}: PARSER ERROR {e}")
            traceback.print_exc()
            report.append({"venue": v["name"], "ok": False, "error": repr(e)})
            continue
        kept = [e for e in got if e.is_valid(today, HORIZON_DAYS)]
        previous = state["counts"].get(v["name"], 0)
        if not kept and previous:
            # a 200 page with nothing in it is a broken parser or a bot wall, not an empty programme
            log(f"  {v['name']}: 0 events (had {previous}) -> treated as failure")
            report.append({"venue": v["name"], "ok": False, "error": f"0 events parsed (was {previous})"})
            continue
        log(f"  {v['name']}: {len(kept)} events" + (f" ({len(got) - len(kept)} outside window/invalid)" if len(got) != len(kept) else ""))
        report.append({"venue": v["name"], "ok": True, "count": len(kept)})
        for e in kept:
            canonical_venue(e, venues)
            _fill_venue_meta(e, by_slug.get(e.venue_slug) or v)
        events.extend(kept)

    events = merge(events, log)
    for e in events:
        if not e.headliner:
            e.headliner, e.support = split_lineup(e.title)

    # genres: site tags -> rules -> venue default, then LLM for the weak ones;
    # sub-genres: the venue's own descriptors first, Claude for the rest
    for e in events:
        vconf = by_slug.get(e.venue_slug, {})
        G.apply_rules(e, vconf.get("genres"))
        e.subgenres = G.merge_subgenres(G.subgenres_from_site(e.raw_genre), e.subgenres)
        if e.is_music and G.looks_non_music(f"{e.raw_genre or ''} {e.title}", e.venue):
            e.is_music = False
    if use_llm and G.llm_available():
        try:
            G.llm_tag(events, GENRE_CACHE, log=log)
        except Exception as e:
            log(f"  LLM tagging failed: {e}")
    elif use_llm:
        log("  LLM tagging skipped: set ANTHROPIC_API_KEY to enable")

    # players: Bandcamp page + embeddable release, Spotify artist id (optional key) for the detail sheet
    if players:
        try:
            P.resolve(events, PLAYER_CACHE, today=today, log=log)
        except Exception as e:  # never let a lookup problem lose the day's programme
            log(f"  players failed: {e}")
            traceback.print_exc()

    first_seen = track_seen(events, today, state, report)
    events.sort(key=lambda e: (e.date, e.time or "99:99", e.venue))
    out = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "new_window_days": NEW_WINDOW_DAYS,
        "tags": G.TAGS,
        "venues": sorted({e.venue for e in events}),
        "report": report,
        "events": [dict(e.to_dict(), first_seen=first_seen.get(e.id)) for e in events],
    }
    os.makedirs(WEB, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    fresh = sum(1 for e in events if first_seen.get(e.id) == today.isoformat())
    log(f"wrote {len(events)} events -> {os.path.relpath(OUT_PATH, ROOT)} ({fresh} newly announced today)")
    low = low_coverage(todo, report)
    if low:
        log(f"  low coverage (< {LOW_COVERAGE} events from the venue's own site, check the URL / parser): "
            + ", ".join(f"{name} ({n})" for name, n in low))
    return out


LOW_COVERAGE = 3


def low_coverage(scraped, report):
    """(venue name, count) for venue sites that answered but yielded almost nothing: a programme page
    rendered by JavaScript or a URL that moved looks like a thin programme, not like a failure."""
    strategy = {v["name"]: v["strategy"] for v in scraped}
    return [(r["venue"], r["count"]) for r in report
            if r["ok"] and r["count"] < LOW_COVERAGE and strategy.get(r["venue"]) != "opendata"]


# ------------------------------------------------------------------ venue identity

def _norm_venue(name: str) -> str:
    n = strip_accents(name.lower())
    n = n.replace("'", " ").replace("’", " ")
    for w in ("le ", "la ", "les ", "l ", "the "):
        if n.startswith(w):
            n = n[len(w):]
    return " ".join(n.replace("-", " ").split())


def _km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = 0.5 - math.cos((lat2 - lat1) * p) / 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2
    return 12742 * math.asin(math.sqrt(a))


def canonical_venue(e, venues):
    """Map an open-data venue ('Philharmonie de Paris', 'L'Olympia - Bruno Coquatrix') onto the
    configured venue with the same name or within 150 m, so cross-source merging can work."""
    if e.source != "opendata":
        return
    n = _norm_venue(e.venue)
    for v in venues:
        vn = _norm_venue(v["name"])
        if n == vn or n.startswith(vn + " ") or vn.startswith(n + " "):
            e.venue, e.venue_slug = v["name"], v["slug"]
            return
    if e.lat is not None and e.lon is not None:
        for v in venues:
            if v.get("lat") is not None and _km(e.lat, e.lon, v["lat"], v["lon"]) <= VENUE_MATCH_KM:
                e.venue, e.venue_slug = v["name"], v["slug"]
                return


def _fill_venue_meta(e, v):
    if v:
        e.address = e.address or v.get("address")
        e.lat = e.lat if e.lat is not None else v.get("lat")
        e.lon = e.lon if e.lon is not None else v.get("lon")
        e.area = e.area or v.get("area")
    e.area = e.area or area_from_address(e.address)


_POSTCODE = re.compile(r"\b(\d{5})\b[\s,]*([^\d,]*)")


def area_from_address(address):
    """'7 port de la Gare, 75013 Paris' -> '13e'; '21 rue Alexis Lepère, 93100 Montreuil' -> 'Montreuil'.

    Curated venues carry a nicer neighbourhood in venues.json ("Bastille"); this is the fallback
    for the hundreds of open-data venues.
    """
    if not address:
        return None
    matches = _POSTCODE.findall(address)   # the last 5-digit group is the postcode (a street number may come first)
    if not matches:
        return None
    postcode, town = matches[-1]
    if postcode.startswith("75"):
        n = 16 if postcode == "75116" else int(postcode[2:])
        if 1 <= n <= 20:
            return "1er" if n == 1 else f"{n}e"
        return None
    town = re.split(r"\s+[-–/(]|\s+(?:cedex|france)\b", town, flags=re.I)[0].strip(" .-")
    if town:
        return town.title() if town.isupper() else town[:40]
    return None


# ------------------------------------------------------------------ merge

def _title_tokens(t):
    return set(w for w in norm_title(t).split() if len(w) > 2)


def _headliner(title: str) -> str:
    """'Jaguar Sun • Thala' and 'Jaguar Sun • Sean Nicholas Savage • Yes Please!' share a headliner."""
    return norm_title(split_lineup(title)[0])


def _same_show(a, b) -> bool:
    ta, tb = _title_tokens(a.title), _title_tokens(b.title)
    na, nb = norm_title(a.title), norm_title(b.title)
    if na and na == nb:
        return True
    if not ta or not tb:
        return False
    shared = len(ta & tb)
    if shared / max(len(ta), len(tb)) >= 0.6 or (shared >= 2 and (na in nb or nb in na)):
        return True
    # same night, same start time, same headliner: the line-up text just differs between sources
    ha, hb = _headliner(a.title), _headliner(b.title)
    return bool(ha) and ha == hb and len(ha) > 3 and (a.time == b.time or not a.time or not b.time)


def merge(events, log=print):
    """Collapse the same concert reported by several sources (venue site + open data).

    Events from the same source never merge unless they are literally the same record: a venue with
    two rooms can host "Jam session" and "Jam session vocal" on the same night.
    """
    priority = {"opendata": 0, "llm": 1}  # lower = weaker; hand parsers / tribe win
    events.sort(key=lambda e: -priority.get(e.source, 5))
    buckets = {}
    for e in events:
        buckets.setdefault((e.venue_slug, e.date), []).append(e)
    merged, dropped = [], 0
    for group in buckets.values():
        kept = []
        for e in group:
            dup = None
            for k in kept:
                if k.source == e.source:
                    if k.id == e.id:
                        dup = k
                        break
                    continue
                if _same_show(e, k):
                    dup = k
                    break
            if dup:
                dropped += 1
                for attr in ("raw_genre", "genres", "genre_source", "subgenres", "description", "image", "time",
                             "price", "ticket_url", "url", "address"):
                    if not getattr(dup, attr):
                        setattr(dup, attr, getattr(e, attr))
                dup.free = dup.free or e.free
                if dup.lat is None:
                    dup.lat, dup.lon = e.lat, e.lon
            else:
                kept.append(e)
        merged.extend(kept)
    if dropped:
        log(f"  merged {dropped} duplicates")
    return merged


# ------------------------------------------------------------------ first-seen tracking

def load_state():
    """seen.json: {"ids": {id: {"first_seen": date|"baseline", "date": event date}},
    "venues": [slugs ever scraped], "counts": {venue name: events last time it succeeded}}."""
    state = {"ids": {}, "venues": [], "counts": {}}
    if os.path.exists(SEEN_PATH):
        with open(SEEN_PATH, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if "ids" in saved:
            ids = saved["ids"]
            # older format stored a bare date string per id
            state["ids"] = {k: (v if isinstance(v, dict) else {"first_seen": v, "date": "9999-12-31"}) for k, v in ids.items()}
            state["venues"] = saved.get("venues", [])
            state["counts"] = saved.get("counts", {})
        else:  # very first format: flat id -> date
            state["ids"] = {k: {"first_seen": v, "date": "9999-12-31"} for k, v in saved.items()}
    return state


def track_seen(events, today, state, report):
    """Remember when each event id was first seen so the UI can show 'newly announced'.

    * A venue scraped for the first time *by a given source* (new in venues.json, or an LLM venue
      that only had open-data events before) gets 'baseline': its whole programme is not "new".
    * Only events whose date is past are pruned, so a source failing one day does not make its
      programme look new the next day.
    """
    ids, known = state["ids"], set(state["venues"])
    stamp = today.isoformat()
    for e in events:
        key = f"{e.source}:{e.venue_slug}"
        if e.id not in ids:
            ids[e.id] = {"first_seen": stamp if key in known else "baseline", "date": e.date}
        else:
            ids[e.id]["date"] = e.date
    cutoff = today.isoformat()
    ids = {k: v for k, v in ids.items() if v.get("date", "9999") >= cutoff}
    counts = dict(state["counts"])
    for r in report:
        if r["ok"]:
            counts[r["venue"]] = r["count"]
    venues = sorted(known | {f"{e.source}:{e.venue_slug}" for e in events})
    os.makedirs(DATA, exist_ok=True)
    with open(SEEN_PATH, "w", encoding="utf-8") as f:
        json.dump({"ids": ids, "venues": venues, "counts": counts}, f, indent=0)
    return {k: v["first_seen"] for k, v in ids.items()}
