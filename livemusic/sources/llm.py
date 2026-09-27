"""Generic extractor: fetch the venue's programme page(s), turn them into text, and let Claude
pull out the concerts.  Used for venues without a hand-written parser.  Needs ANTHROPIC_API_KEY.
"""
import datetime as dt
import hashlib
import json
import os
import re
import time
from typing import List

from .. import usage
from ..fetch import get, FetchError
from ..genres import llm_available, normalize_subgenres, TAGS
from ..model import Event
from ..util import html_to_text

CHUNK_CHARS = 30000     # one Claude call per chunk of page text (at most)
MAX_CHARS = 120000      # programme text per venue: plenty
CACHE_DAYS = 14         # a chunk seen unchanged is re-extracted at least this often (sold-out flags, year guesses)
BATCH_WAIT = 50 * 60    # seconds the run waits for a Message Batch before leaving it for the next run
PROMPT_VERSION = 2      # bump when SYSTEM / SCHEMA change: every chunk is extracted again

SYSTEM = (
    "You extract upcoming live-music events from the text of a concert venue's website.\n"
    "Today is {today}; dates without a year are the next occurrence from today.\n"
    "Return one entry per concert date (a multi-date run gives several entries). Skip past events, "
    "navigation, and anything that is not an event. Mark comedy, theatre, talks, exhibitions and "
    "similar as is_music=false. Keep titles as printed (headliner + support acts). "
    "Genres must come from: {tags} (1-3 per event, or empty if unknown). "
    "Add 0-3 'subgenres': fine-grained styles as short lowercase free text (stoner rock, shoegaze, "
    "drone, neo-soul, boom bap, bossa nova, free jazz, baroque, rap français...), using the page's own "
    "descriptors and your knowledge of the artists; never repeat a coarse genre, leave it empty if unsure. "
    "Absolute URLs only; leave url empty if unsure. The text may be one part of a longer page."
)
_OPT = {"anyOf": [{"type": "string"}, {"type": "null"}]}
_LIST = {"type": "array", "items": {"type": "string"}}
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["events"],
    "properties": {"events": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["title", "date"],
        "properties": {"title": {"type": "string"}, "date": {"type": "string"}, "time": _OPT, "url": _OPT,
                       "price": _OPT, "genres": _LIST, "subgenres": _LIST, "artists": _LIST,
                       "is_music": {"type": "boolean"}, "sold_out": {"type": "boolean"}}}}},
}


def _model():
    return os.environ.get("LIVEMUSIC_MODEL", "claude-opus-5")


def _params(venue, n, total, chunk, today):
    return {"model": _model(), "max_tokens": 16000,
            "system": SYSTEM.format(today=today.isoformat(), tags=", ".join(TAGS)),
            "messages": [{"role": "user", "content": f"Venue: {venue['name']} (part {n}/{total})\n\n{chunk}"}],
            "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}}}


def _key(venue, chunk):
    """Cache key of one chunk: its text, not the day. The system prompt's date only matters for year-less
    dates, which _fix_year corrects, and past events are dropped by the pipeline."""
    return hashlib.sha1(f"{PROMPT_VERSION}|{_model()}|{venue['slug']}|{chunk}".encode("utf-8")).hexdigest()


def _plan(venue, ctx):
    """[(key, chunk)] for the venue's programme text; FetchError when no page answered. Kept in ctx so
    scrape() sends the very text prefetch() batched (a --fresh run would download it again)."""
    plans = ctx.setdefault("llm_plans", {})
    if venue["slug"] not in plans:
        plans[venue["slug"]] = _read_plan(venue, ctx)
    return plans[venue["slug"]]


def _read_plan(venue, ctx):
    urls = venue.get("urls") or [venue["url"]]
    texts = []
    for u in urls:
        try:
            texts.append(f"### {u}\n" + html_to_text(get(u)))
        except FetchError as e:
            ctx["log"](f"  {venue['name']}: fetch failed: {e}")
            ctx["problem"] = str(e)
    if not texts:
        raise FetchError(ctx.get("problem") or f"no page could be fetched for {venue['name']}")
    text = "\n\n".join(texts)
    if len(text) < 200:
        ctx["problem"] = f"the page holds {len(text)} characters of text (JavaScript-rendered page or bot wall?)"
        return []
    chunks = _chunks(text[:MAX_CHARS], CHUNK_CHARS)
    return [(_key(venue, c), c) for c in chunks]


def _fresh(hit, today) -> bool:
    try:
        return (today - dt.date.fromisoformat(hit["at"])).days <= CACHE_DAYS
    except (KeyError, TypeError, ValueError):
        return False


def _parse(text):
    """Events of one answer, or None when the JSON does not hold (truncated answer)."""
    try:
        data = json.loads(text)
    except ValueError:
        return None
    out = []
    for x in data.get("events", []) if isinstance(data, dict) else []:
        if isinstance(x, dict) and isinstance(x.get("title"), str) and isinstance(x.get("date"), str):
            out.append(x)
    return out


def _answer_text(msg):
    return "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text")


def prefetch(venues, ctx, client=None):
    """Extract every changed chunk of every LLM venue in one Message Batch (half price) before the venues
    are scraped one by one; scrape() then finds them in the cache. A batch still running after BATCH_WAIT
    is kept in the cache file and collected by the next run; its venues fail today (and keep yesterday's
    events, REM-46) rather than being paid for twice."""
    if not venues or not llm_available():
        return
    import anthropic
    client = client or anthropic.Anthropic()
    log, today = ctx["log"], ctx["today"]
    cache = _cache_load()
    if cache.get("_pending") and not _wait_and_collect(client, cache, ctx):
        return   # yesterday's batch is still running: wait for it rather than paying twice
    reqs, owner = [], {}
    for v in venues:
        try:
            plan = _plan(v, ctx)
        except FetchError:
            continue    # scrape() reports it
        for n, (key, chunk) in enumerate(plan, 1):
            hit = cache.get(key)
            if (hit and _fresh(hit, today)) or key in owner:
                continue
            owner[key] = v["name"]
            reqs.append({"custom_id": key, "params": _params(v, n, len(plan), chunk, today)})
    if not reqs:
        log(f"  LLM venues: every page part unchanged or already queued, nothing to extract")
        return
    log(f"  LLM venues: {len(reqs)} changed page parts from {len(set(owner.values()))} venues -> one Message Batch")
    try:
        batch = client.messages.batches.create(requests=reqs)
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log(f"  LLM venues: batch refused ({getattr(e, 'status_code', '')} {getattr(e, 'message', e)}), falling back to direct calls")
        return
    cache["_pending"] = {"id": batch.id, "keys": [r["custom_id"] for r in reqs], "at": today.isoformat()}
    _cache_save(cache)
    _wait_and_collect(client, cache, ctx)


def _wait_and_collect(client, cache, ctx) -> bool:
    """Wait up to BATCH_WAIT for the pending batch, then write its results into the chunk cache.
    False (and ctx["llm_pending"] set) when it is still running."""
    import anthropic
    pending, log, today = cache["_pending"], ctx["log"], ctx["today"]
    started = time.time()
    try:
        batch = client.messages.batches.retrieve(pending["id"])
        while batch.processing_status != "ended" and time.time() - started < BATCH_WAIT:
            time.sleep(ctx.get("poll_seconds", 30))
            batch = client.messages.batches.retrieve(pending["id"])
        results = list(client.messages.batches.results(pending["id"])) if batch.processing_status == "ended" else None
    except anthropic.NotFoundError:   # another key / workspace, or deleted: forget it, extract again
        log(f"  LLM venues: batch {pending['id']} not found, dropped")
        del cache["_pending"]
        _cache_save(cache)
        return True
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:   # try again next run, don't pay twice
        log(f"  LLM venues: batch {pending['id']} unreachable ({e}), collected next run")
        results = None
    if results is None:
        if time.time() - started >= BATCH_WAIT:
            log(f"  LLM venues: batch {pending['id']} still running after {BATCH_WAIT // 60} min, collected next run")
        ctx["llm_pending"] = set(pending["keys"])
        return False
    ok = bad = 0
    for r in results:
        if r.result.type != "succeeded":
            bad += 1   # errored / expired: asked again (directly) when its venue is scraped
            continue
        msg = r.result.message
        usage.add("venues", msg.model, msg.usage, batch=True)
        events = _parse(_answer_text(msg)) if msg.stop_reason != "max_tokens" else None
        if events is None:
            bad += 1
            continue
        cache[r.custom_id] = {"at": pending.get("at", today.isoformat()), "events": events}
        ok += 1
    del cache["_pending"]
    _cache_save(cache)
    log(f"  LLM venues: batch {pending['id']} collected, {ok} parts extracted" + (f", {bad} failed" if bad else "")
        + f" ({int(time.time() - started)} s)")
    return True


def scrape(venue, ctx):
    if not llm_available():
        ctx["log"](f"  {venue['name']}: skipped (LLM extraction needs ANTHROPIC_API_KEY)")
        ctx["problem"] = "skipped, LLM extraction needs ANTHROPIC_API_KEY"
        return []
    import anthropic

    plan = _plan(venue, ctx)
    if not plan:
        return []
    today = ctx["today"]
    cache = _cache_load()
    waiting = ctx.get("llm_pending", set())
    if any(key in waiting for key, _ in plan):
        raise FetchError("extraction still running in the Message Batch")
    client = None
    events, seen, reused, changed = [], set(), 0, False
    for n, (key, chunk) in enumerate(plan, 1):
        hit = cache.get(key)
        if hit and _fresh(hit, today):
            got, reused = hit["events"], reused + 1
        else:   # not in the batch (no key, batch refused) or its request failed: one direct call
            client = client or anthropic.Anthropic()
            try:
                resp = client.messages.create(**_params(venue, n, len(plan), chunk, today))
            except anthropic.APIStatusError as e:
                ctx["log"](f"  {venue['name']}: API error {e.status_code}: {e.message}")
                ctx["problem"] = f"Claude API error {e.status_code}: {_api_message(e.message)}"[:300]
                break
            except anthropic.APIConnectionError as e:
                ctx["log"](f"  {venue['name']}: connection error: {e}")
                ctx["problem"] = f"Claude API connection error: {e}"[:300]
                break
            usage.add("venues", resp.model, resp.usage)
            got = _parse(_answer_text(resp)) if resp.stop_reason != "max_tokens" else None
            if got is None:
                ctx["log"](f"  {venue['name']}: unparseable or truncated answer for part {n}")
                ctx["problem"] = f"unparseable or truncated answer from Claude for part {n}"
                continue
            cache[key] = {"at": today.isoformat(), "events": got}
            changed = True
        for x in got:
            if not x["title"] or len(x["date"]) != 10 or (x["title"], x["date"]) in seen:
                continue
            seen.add((x["title"], x["date"]))
            events.append(x)
    if changed:
        _cache_save(cache)
    if reused:
        ctx["log"](f"  {venue['name']}: {reused}/{len(plan)} page parts unchanged, reused")
    return [_to_event(x, venue, ctx) for x in events]


def _api_message(text: str) -> str:
    """'Error code: 400 - {'type': 'error', 'error': {..., 'message': 'Your credit balance is too low…'}}'
    -> the sentence a human wants to read on the status page."""
    m = re.search(r"""['"]message['"]: (['"])(.+?)\1[,}]""", text or "")
    return m.group(2) if m else (text or "")


def _fix_year(date: str, today: dt.date, horizon_days: int) -> str:
    """Programme pages print '11 septembre' without a year and the model sometimes picks last year's;
    a date in the past whose next anniversary falls inside the scraping window is that mistake
    (La Marbrerie: 38 extracted concerts, 1 kept, before this)."""
    try:
        d = dt.date.fromisoformat(date)
    except ValueError:
        return date
    if d < today:
        try:
            nxt = d.replace(year=d.year + 1)
        except ValueError:  # 29 February
            return date
        if today <= nxt <= today + dt.timedelta(days=horizon_days):
            return nxt.isoformat()
    return date


def _to_event(x: dict, venue, ctx) -> Event:
    genres = [g for g in x.get("genres", []) if g in TAGS][:3]
    date = _fix_year(x["date"], ctx["today"], ctx["horizon_days"])
    return Event(
        subgenres=normalize_subgenres(x.get("subgenres", [])),
        title=x["title"], date=date, time=x.get("time") or None, venue=venue["name"], venue_slug=venue["slug"],
        source="llm", url=x.get("url") or venue["url"], price=x.get("price"), genres=genres,
        genre_source="llm" if genres else None, is_music=x.get("is_music", True), sold_out=x.get("sold_out", False),
        description=", ".join(x["artists"]) if x.get("artists") else None,
    )


CACHE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "llm_cache.json")


def _cache_load():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            cache = json.load(f)
        # entries of the old format (one per venue slug, keyed by the whole page) are dropped
        return {k: v for k, v in cache.items() if k == "_pending" or (isinstance(v, dict) and "at" in v)}
    return {}


def _cache_save(cache):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    today = dt.date.today()
    keep = {k: v for k, v in cache.items()   # an entry past CACHE_DAYS is never reused: drop it
            if k == "_pending" or (today - dt.date.fromisoformat(v["at"])).days <= CACHE_DAYS}
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(keep, f, ensure_ascii=False, indent=0, sort_keys=True)


def _chunks(text: str, size: int) -> List[str]:
    """Split on line boundaries so an event is not cut in half, at content-defined points: past half the size,
    a chunk ends after a line whose hash says so. A concert added or dropped at the top of the page then
    changes that chunk only, not every chunk after it (fixed-size cuts would shift them all)."""
    out, cur = [], []
    n = 0
    for line in text.split("\n"):
        if n + len(line) > size and cur:
            out.append("\n".join(cur))
            cur, n = [], 0
        cur.append(line)
        n += len(line) + 1
        if n >= size // 2 and int(hashlib.sha1(line.encode("utf-8")).hexdigest()[:4], 16) % 16 == 0:
            out.append("\n".join(cur))
            cur, n = [], 0
    if cur:
        out.append("\n".join(cur))
    return out
