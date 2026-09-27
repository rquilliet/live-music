"""Hand-kept programmes for venues with nothing scrapable (Facebook-only bars): manual_events.json at the repo root,
{venue slug: [{"title", "date", "time"?, "price"?, "url"?, "ticket_url"?, "genre"?}]}, filled on request."""
import json
import os

from ..model import Event

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "manual_events.json")


def scrape(venue, ctx, path=None):
    with open(path or PATH, "r", encoding="utf-8") as f:
        rows = json.load(f).get(venue["slug"], [])
    return [Event(title=r["title"], date=r["date"], time=r.get("time"), venue=venue["name"], venue_slug=venue["slug"],
                  source="manual", url=r.get("url"), ticket_url=r.get("ticket_url"), price=r.get("price"),
                  raw_genre=r.get("genre")) for r in rows]
