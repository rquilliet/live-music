"""Short summary of the venue's event page, written by Claude, for concerts the venue gave no text for.

The detail sheet shows what the venue says about a show (who plays, what kind of show).  Most events
carry a scraped `description`; for the rest, this step fetches the event's own page (`Event.url`),
turns it into text and asks Claude for one or two French sentences.  Results are cached per event id
in data/summary_cache.json ("" = the page had nothing specific about the event), so the daily run
only pays for new concerts, and at most MAX_PER_RUN pages a day.
"""
import collections
import datetime as dt
import json
import os
import re
from typing import Dict, Iterable, List, Optional

from .fetch import get, FetchError
from .genres import llm_available, _cache_load, _cache_save
from .util import clean_text, html_to_text

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(ROOT, "data", "summary_cache.json")

MAX_LEN = 400            # same cap as Event.description
MAX_PER_RUN = 200        # pages fetched + summarised per run: the cron catches up over a few days
BATCH_SIZE = 5           # events (pages) per Claude call
PAGE_CHARS = 12000       # page text handed to Claude per event (the event copy sits near the top)
SHARED_URL_MAX = 3       # more events than this on one url = the venue's programme page, not an event page
FETCH_TIMEOUT = 15

SYSTEM = (
    "Tu reçois le texte de pages web de salles de concert parisiennes, une page par événement, avec le titre "
    "et la date de l'événement concerné.\n"
    "Pour chaque événement, écris en français 1 à 2 phrases courtes qui résument ce que la salle dit de ce "
    "concert : qui joue, quel genre de musique ou de soirée. Reprends les informations de la page, sans "
    "inventer.\n"
    "N'indique ni date, ni horaire, ni prix, ni billetterie, ni informations pratiques, ni formules "
    "publicitaires (« ne manquez pas », « événement exceptionnel »…).\n"
    "Réponds \"\" (chaîne vide) quand la page ne dit rien de précis sur cet événement : agenda général, "
    "liste de concerts, page d'accueil, page d'erreur, ou seulement le titre.\n"
    "Réponds uniquement en JSON, sans commentaire : {\"summaries\": [{\"id\": \"...\", \"summary\": \"...\"}]}, "
    "chaque id reçu exactement une fois."
)


def shared_urls(events, limit: int = SHARED_URL_MAX) -> set:
    """Urls carried by more than `limit` events: a page listing 30 concerts is not an event page."""
    counts = collections.Counter(e.url for e in events if e.url)
    return {u for u, n in counts.items() if n > limit}


def candidates(events, generic_urls: Iterable[str] = ()) -> list:
    """Music events without a description that point at a page of their own."""
    skip = shared_urls(events) | set(generic_urls)
    return [e for e in events if e.is_music and e.url and not e.description and e.url not in skip]


def cap(text: Optional[str], limit: int = MAX_LEN) -> str:
    """Clean, single-paragraph text of at most `limit` chars, cut on a word boundary."""
    t = clean_text(text or "").strip(" \"«»'")
    if len(t) <= limit:
        return t
    return re.sub(r"\s+\S*$", "", t[:limit - 1]).rstrip(" ,;:") + "…"


def parse_answer(text: str) -> Dict[str, str]:
    """{id: summary} out of Claude's JSON answer (a ```json fence or stray prose around it is tolerated).
    Raises ValueError when no usable JSON is there."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON object in answer")
    data = json.loads(m.group(0))
    items = data.get("summaries") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise ValueError("no 'summaries' list in answer")
    out = {}
    for it in items:
        if isinstance(it, dict) and isinstance(it.get("id"), str):
            s = it.get("summary")
            out[it["id"]] = cap(s) if isinstance(s, str) else ""
    return out


def page_text(url: str) -> str:
    return html_to_text(get(url, timeout=FETCH_TIMEOUT, retries=0))[:PAGE_CHARS]


def ask(client, model: str, batch: List[dict]) -> Dict[str, str]:
    """One Claude call for a batch of {"id", "title", "venue", "date", "page"} dicts."""
    parts = [f"### id: {b['id']}\nÉvénement : {b['title']} — {b['venue']} — {b['date']}\n\n{b['page']}" for b in batch]
    resp = client.messages.create(
        model=model,
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
    )
    if resp.stop_reason == "max_tokens":
        raise ValueError("answer truncated (max_tokens)")
    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
    return parse_answer(text)


def enrich(events, *, llm: bool = True, fresh: bool = False, cache_path: str = CACHE_PATH,
           generic_urls: Iterable[str] = (), limit: int = MAX_PER_RUN, log=print,
           fetch_page=page_text, ask_llm=ask, client=None) -> dict:
    """Fill `Event.summary` from the cache, then from Claude for up to `limit` uncached events.

    `llm=False` (the --no-llm flag) or a missing API key only applies cached summaries.  `fresh=True`
    ignores the cache and asks again.  Never raises for network or API trouble: the scrape goes on
    without summaries.  Returns the counts it logged.
    """
    cache = {} if fresh else _cache_load(cache_path)
    today = dt.date.today().isoformat()
    todo, hits = [], 0
    for e in candidates(events, generic_urls):
        hit = cache.get(e.id)
        if hit is not None and isinstance(hit, dict) and "summary" in hit:
            e.summary = cap(hit["summary"]) or None
            hits += bool(e.summary)
        else:
            todo.append(e)
    counts = {"cached": hits, "todo": len(todo), "asked": 0, "summarised": 0, "empty": 0, "skipped": 0}
    if not todo:
        log(f"  summaries: {hits} from cache, nothing new to summarise")
        return counts
    if not llm:
        log(f"  summaries: {hits} from cache, {len(todo)} left without (LLM off)")
        return counts
    if client is None and not llm_available():
        log(f"  summaries: {hits} from cache, {len(todo)} left without (set ANTHROPIC_API_KEY to enable)")
        return counts

    todo.sort(key=lambda e: e.date)        # the nearest concerts first: they are the ones people open
    todo = todo[:limit]
    model = os.environ.get("LIVEMUSIC_MODEL", "claude-opus-5")
    log(f"  summaries: {hits} from cache, asking {model} for {len(todo)} event pages"
        + (f" (of {counts['todo']}, the rest tomorrow)" if counts["todo"] > len(todo) else ""))
    if client is None:
        import anthropic
        client = anthropic.Anthropic()

    by_id = {e.id: e for e in todo}
    for i in range(0, len(todo), BATCH_SIZE):
        batch = []
        for e in todo[i:i + BATCH_SIZE]:
            try:
                page = fetch_page(e.url)
            except FetchError as ex:
                log(f"  summaries: fetch failed for {e.venue} / {e.title[:40]}: {ex}")
                counts["skipped"] += 1
                continue
            if len(page.strip()) < 80:  # an empty shell (JS-rendered page): nothing to summarise, remember it
                cache[e.id] = {"summary": "", "date": e.date}
                counts["empty"] += 1
                continue
            batch.append({"id": e.id, "title": e.title, "venue": e.venue, "date": e.date, "page": page})
        if not batch:
            _save(cache, cache_path, today)
            continue
        try:
            answers = ask_llm(client, model, batch)
        except (ValueError, TypeError) as ex:  # malformed / truncated JSON: try the next batch
            log(f"  summaries: unparseable answer for batch {i // BATCH_SIZE + 1}: {str(ex)[:120]}")
            continue
        except Exception as ex:  # API / network trouble (anthropic.APIStatusError...) must not fail the scrape
            log(f"  summaries: {type(ex).__name__}: {str(ex)[:160]}, giving up for this run")
            break
        for b in batch:
            if b["id"] not in answers:
                continue   # not answered this time: asked again tomorrow
            e = by_id[b["id"]]
            e.summary = answers[b["id"]] or None
            counts["asked"] += 1
            counts["summarised" if e.summary else "empty"] += 1
            cache[e.id] = {"summary": e.summary or "", "date": e.date}
        _save(cache, cache_path, today)
    log(f"  summaries: {counts['summarised']} written, {counts['empty']} pages without event text, "
        f"{counts['skipped']} fetch failures")
    return counts


def _save(cache: dict, path: str, today: str) -> None:
    """Write the cache after every batch (a run killed halfway keeps its answers), minus past events."""
    for k in [k for k, v in cache.items() if not isinstance(v, dict) or v.get("date", "9999") < today]:
        del cache[k]
    _cache_save(path, cache)
