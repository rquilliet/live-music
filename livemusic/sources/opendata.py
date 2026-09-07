"""Paris open data 'Que faire à Paris ?' - every concert declared to the city.

Free JSON API, no key: https://opendata.paris.fr/explore/dataset/que-faire-a-paris-/
"""
import datetime as dt
import urllib.parse

from ..fetch import get_json
from ..model import Event
from ..util import clean_text, slugify

BASE = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records"
PAGE = 100
MAX_OCCURRENCES = 40


def scrape(venue, ctx):
    today, horizon = ctx["today"], ctx["horizon_days"]
    where = "qfap_tags like 'Concert' AND date_end>=now()"
    rows, offset, total = [], 0, None
    while total is None or offset < min(total, 3000):
        url = f"{BASE}?{urllib.parse.urlencode({'where': where, 'limit': PAGE, 'offset': offset, 'order_by': 'date_start'})}"
        data = get_json(url)
        total = data.get("total_count", 0)
        page = data.get("results", [])
        if not page:
            break
        rows.extend(page)
        offset += PAGE
    _unify_venue_names(rows)
    events = []
    for r in rows:
        events.extend(_expand(r, today, horizon))
    return events


def _unify_venue_names(rows):
    """'38Riv' and '38Riv Jazz Club' at the same street address are one venue: use the most common name."""
    by_addr = {}
    for r in rows:
        key = (clean_text(r.get("address_street") or "").lower(), r.get("address_zipcode"))
        name = clean_text(r.get("address_name") or "")
        if key[0] and name:
            by_addr.setdefault(key, {}).setdefault(name, 0)
            by_addr[key][name] += 1
    for r in rows:
        key = (clean_text(r.get("address_street") or "").lower(), r.get("address_zipcode"))
        names = by_addr.get(key)
        if names and len(names) > 1:
            r["address_name"] = max(names.items(), key=lambda kv: kv[1])[0]


def _expand(r, today, horizon):
    name = clean_text(r.get("address_name") or "")
    if not name:
        return []
    tags = [t for t in (r.get("qfap_tags") or "").split(";") if t]
    if "Enfants" in tags and "Concert" not in tags:
        return []
    latlon = r.get("lat_lon") or {}
    address = ", ".join(x for x in [r.get("address_street"), r.get("address_zipcode"), r.get("address_city")] if x)
    price_type = (r.get("price_type") or "").lower()
    price = clean_text(r.get("price_detail") or "") or (price_type or None)
    desc = clean_text(r.get("lead_text") or r.get("description") or "")
    raw_genre = ", ".join(t for t in tags if t not in ("Concert",)) or None
    out = []
    occ = (r.get("occurrences") or "").split(";")
    dates = []
    for o in occ:
        start = o.split("_")[0]
        if len(start) >= 16:
            dates.append((start[:10], start[11:16]))
    if not dates and r.get("date_start"):
        dates.append((r["date_start"][:10], r["date_start"][11:16]))
    seen = set()
    for d, t in dates:
        if d in seen:
            continue
        seen.add(d)
        try:
            day = dt.date.fromisoformat(d)
        except ValueError:
            continue
        if day < today or day > today + dt.timedelta(days=horizon):
            continue
        out.append(Event(
            title=r.get("title") or "",
            date=d,
            time=t if t != "00:00" else None,
            venue=name,
            venue_slug=slugify(name),
            source="opendata",
            url=r.get("url"),
            ticket_url=r.get("access_link"),
            price=price[:60] if price else None,
            free=price_type == "gratuit",
            raw_genre=raw_genre,
            description=desc,
            image=r.get("cover_url"),
            address=address or None,
            lat=latlon.get("lat"),
            lon=latlon.get("lon"),
        ))
        if len(out) >= MAX_OCCURRENCES:
            break
    return out
