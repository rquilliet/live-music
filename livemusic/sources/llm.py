"""Generic extractor: fetch the venue's programme page(s), turn them into text, and let Claude
pull out the concerts.  Used for venues without a hand-written parser.  Needs ANTHROPIC_API_KEY.
"""
import json
import os
from typing import List, Optional

from ..fetch import get, FetchError
from ..genres import llm_available, TAGS
from ..model import Event
from ..util import html_to_text

MAX_CHARS = 60000


def scrape(venue, ctx):
    if not llm_available():
        ctx["log"](f"  {venue['name']}: skipped (LLM extraction needs ANTHROPIC_API_KEY)")
        return []
    import anthropic
    from pydantic import BaseModel

    class Extracted(BaseModel):
        title: str
        date: str                    # YYYY-MM-DD
        time: Optional[str] = None   # HH:MM
        url: Optional[str] = None
        price: Optional[str] = None
        genres: List[str] = []
        artists: List[str] = []
        is_music: bool = True
        sold_out: bool = False

    class ExtractedList(BaseModel):
        events: List[Extracted]

    urls = venue.get("urls") or [venue["url"]]
    texts = []
    for u in urls:
        try:
            texts.append(f"### {u}\n" + html_to_text(get(u)))
        except FetchError as e:
            ctx["log"](f"  {venue['name']}: fetch failed: {e}")
    text = "\n\n".join(texts)[:MAX_CHARS]
    if len(text) < 200:
        return []

    client = anthropic.Anthropic()
    model = os.environ.get("LIVEMUSIC_MODEL", "claude-opus-5")
    system = (
        "You extract upcoming live-music events from the text of a concert venue's website.\n"
        f"Today is {ctx['today'].isoformat()}; dates without a year are the next occurrence from today.\n"
        "Return one entry per concert date (a multi-date run gives several entries). Skip past events, "
        "navigation, and anything that is not an event. Mark comedy, theatre, talks, exhibitions and "
        "similar as is_music=false. Keep titles as printed (headliner + support acts). "
        f"Genres must come from: {', '.join(TAGS)} (1-3 per event, or empty if unknown). "
        "Absolute URLs only; leave url empty if unsure."
    )
    try:
        resp = client.messages.parse(
            model=model,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": f"Venue: {venue['name']}\n\n{text}"}],
            output_format=ExtractedList,
        )
    except anthropic.APIStatusError as e:
        ctx["log"](f"  {venue['name']}: API error {e.status_code}: {e.message}")
        return []
    except anthropic.APIConnectionError as e:
        ctx["log"](f"  {venue['name']}: connection error: {e}")
        return []
    result = resp.parsed_output
    if result is None:
        return []
    events = []
    for x in result.events:
        if not x.title or len(x.date) != 10:
            continue
        genres = [g for g in x.genres if g in TAGS][:3]
        events.append(Event(
            title=x.title, date=x.date, time=x.time or None, venue=venue["name"], venue_slug=venue["slug"],
            source="llm", url=x.url or venue["url"], price=x.price, genres=genres,
            genre_source="llm" if genres else None, is_music=x.is_music, sold_out=x.sold_out,
            description=", ".join(x.artists) if x.artists else None,
        ))
    return events
