"""Run every source, merge duplicates, tag genres, track first-seen dates, write web/events.json."""
import datetime as dt
import json
import os
import re
import traceback

from . import genres as G
from .fetch import FetchError
from .sources import STRATEGIES
from .util import norm_title, slugify

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web")
SEEN_PATH = os.path.join(DATA, "seen.json")
GENRE_CACHE = os.path.join(DATA, "genre_cache.json")
OUT_PATH = os.path.join(WEB, "events.json")
HORIZON_DAYS = 120
NEW_WINDOW_DAYS = 7


def load_venues(path=None):
    with open(path or os.path.join(ROOT, "venues.json"), "r", encoding="utf-8") as f:
        venues = json.load(f)
    for v in venues:
        v.setdefault("slug", slugify(v["name"]))
    return venues


def run(only=None, use_llm=True, log=print):
    today = dt.date.today()
    ctx = {"today": today, "horizon_days": HORIZON_DAYS, "log": log}
    venues = load_venues()
    by_slug = {v["slug"]: v for v in venues}
    events, report = [], []

    for v in venues:
        if only and v["slug"] not in only and v["strategy"] not in only:
            continue
        if v["strategy"] == "none":  # metadata-only entry (address, coordinates)
            continue
        fn = STRATEGIES.get(v["strategy"])
        if not fn:
            log(f"  {v['name']}: unknown strategy {v['strategy']}")
            continue
        if v["strategy"] == "llm" and not use_llm:
            continue
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
        log(f"  {v['name']}: {len(kept)} events" + (f" ({len(got) - len(kept)} outside window/invalid)" if len(got) != len(kept) else ""))
        report.append({"venue": v["name"], "ok": True, "count": len(kept)})
        for e in kept:
            _fill_venue_meta(e, by_slug.get(e.venue_slug) or v)
        events.extend(kept)

    events = merge(events, log)

    # genres: site tags -> rules -> venue default, then LLM for the weak ones
    for e in events:
        vconf = by_slug.get(e.venue_slug, {})
        G.apply_rules(e, vconf.get("genres"))
        if e.is_music and G.looks_non_music(f"{e.raw_genre or ''} {e.title}"):
            e.is_music = False
    if use_llm and G.llm_available():
        try:
            G.llm_tag(events, GENRE_CACHE, log=log)
        except Exception as e:
            log(f"  LLM tagging failed: {e}")
    elif use_llm:
        log("  LLM tagging skipped: set ANTHROPIC_API_KEY to enable")

    first_seen = track_seen(events, today)
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
    log(f"wrote {len(events)} events -> {os.path.relpath(OUT_PATH, ROOT)}")
    return out


def _fill_venue_meta(e, v):
    if not v:
        return
    e.address = e.address or v.get("address")
    e.lat = e.lat if e.lat is not None else v.get("lat")
    e.lon = e.lon if e.lon is not None else v.get("lon")


def _title_tokens(t):
    return set(w for w in norm_title(t).split() if len(w) > 2)


def merge(events, log=print):
    """Collapse the same concert reported by several sources (venue site + open data)."""
    priority = {"opendata": 0, "llm": 1}  # lower = weaker; hand parsers / tribe win
    events.sort(key=lambda e: -priority.get(e.source, 5))
    buckets = {}
    for e in events:
        buckets.setdefault((e.venue_slug, e.date), []).append(e)
    merged, dropped = [], 0
    for (_, _), group in buckets.items():
        kept = []
        for e in group:
            toks = _title_tokens(e.title)
            dup = None
            for k in kept:
                kt = _title_tokens(k.title)
                if not toks or not kt:
                    continue
                overlap = len(toks & kt) / min(len(toks), len(kt))
                if overlap >= 0.6 or norm_title(e.title) in norm_title(k.title) or norm_title(k.title) in norm_title(e.title):
                    dup = k
                    break
            if dup:
                dropped += 1
                dup.raw_genre = dup.raw_genre or e.raw_genre
                dup.genres = dup.genres or e.genres
                dup.genre_source = dup.genre_source or e.genre_source
                dup.description = dup.description or e.description
                dup.image = dup.image or e.image
                dup.time = dup.time or e.time
                dup.price = dup.price or e.price
                dup.free = dup.free or e.free
                dup.ticket_url = dup.ticket_url or e.ticket_url
                dup.url = dup.url or e.url
                dup.lat = dup.lat if dup.lat is not None else e.lat
                dup.lon = dup.lon if dup.lon is not None else e.lon
                dup.address = dup.address or e.address
            else:
                kept.append(e)
        merged.extend(kept)
    if dropped:
        log(f"  merged {dropped} duplicates")
    return merged


def track_seen(events, today):
    """Remember when each event id was first seen so the UI can show 'newly announced'."""
    seen = {}
    if os.path.exists(SEEN_PATH):
        with open(SEEN_PATH, "r", encoding="utf-8") as f:
            seen = json.load(f)
    baseline = not seen  # first ever run: nothing is "new"
    stamp = today.isoformat()
    for e in events:
        if e.id not in seen:
            seen[e.id] = "baseline" if baseline else stamp
    # prune ids of events that are gone for good
    ids = {e.id for e in events}
    seen = {k: v for k, v in seen.items() if k in ids}
    os.makedirs(DATA, exist_ok=True)
    with open(SEEN_PATH, "w", encoding="utf-8") as f:
        json.dump(seen, f, indent=0)
    return seen
