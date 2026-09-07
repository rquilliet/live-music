"""WordPress 'The Events Calendar' REST API (wp-json/tribe/events/v1)."""
import urllib.parse

from ..fetch import get_json
from ..model import Event
from ..util import clean_text, parse_price


NOISE = {"concert", "promotion", "agenda", "sowprog"}


def scrape(venue, ctx):
    base = venue["url"].rstrip("/")
    start = ctx["today"].isoformat()
    raw, page = [], 1
    while page <= 10:
        q = urllib.parse.urlencode({"per_page": 50, "start_date": start, "page": page})
        data = get_json(f"{base}/wp-json/tribe/events/v1/events?{q}", timeout=venue.get("timeout", 90))
        raw.extend(data.get("events", []))
        if page >= int(data.get("total_pages") or 1):
            break
        page += 1

    # A category stuck on nearly every event ("Pop / Rock / Folk" at Supersonic) says nothing about
    # one concert: treat it as noise and let the keyword rules / venue default / LLM decide.
    freq = {}
    for e in raw:
        for c in e.get("categories", []):
            freq[c.get("name", "")] = freq.get(c.get("name", ""), 0) + 1
    generic = {n for n, k in freq.items() if raw and k / len(raw) > 0.8}
    venue_name = venue["name"].lower()

    events = []
    for e in raw:
        title = clean_text(e.get("title") or "")
        cats = [c.get("name", "") for c in e.get("categories", []) if c.get("name", "") not in generic]
        tags = [t.get("name", "") for t in e.get("tags", [])]
        # tags are often artist names or the venue's own name: keep only genre-looking ones
        words = []
        for x in cats + tags:
            xl = x.lower()
            if not x or xl in NOISE or venue_name in xl or xl in title.lower():
                continue
            words.append(x)
        raw_genre = ", ".join(dict.fromkeys(words)) or None
        price, free = parse_price(e.get("cost") or "")
        if True:
            start_date = (e.get("start_date") or "")[:16]
            events.append(Event(
                title=title,
                date=start_date[:10],
                time=start_date[11:16] or None,
                venue=venue["name"],
                venue_slug=venue["slug"],
                source="tribe",
                url=e.get("url"),
                price=price,
                free=free,
                raw_genre=raw_genre,
                description=clean_text(e.get("excerpt") or e.get("description") or ""),
                image=(e.get("image") or {}).get("url") if isinstance(e.get("image"), dict) else None,
            ))
    return events
