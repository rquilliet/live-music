"""Hand-written parsers for venue websites that publish their programme as HTML."""
import datetime as dt
import re
import urllib.parse

from ..fetch import get, FetchError
from ..model import Event
from ..util import clean_text, parse_fr_date, parse_time, parse_price, strip_accents, FR_MONTHS, infer_year


def _abs(base, href):
    return urllib.parse.urljoin(base, href) if href else None


def _blocks(html, start_pat, end_pat=None):
    """Split html into chunks starting at each match of start_pat (regex)."""
    idx = [m.start() for m in re.finditer(start_pat, html)]
    for i, s in enumerate(idx):
        e = idx[i + 1] if i + 1 < len(idx) else min(len(html), s + 20000)
        yield html[s:e]


def _first(pattern, s, flags=re.S, group=1):
    m = re.search(pattern, s, flags)
    return m.group(group) if m else None


# ------------------------------------------------------------------ La Cigale (+ La Boule Noire)

def cigale(venue, ctx):
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<li class="artiste-event__item"'):
        head = b[:400]
        typ = _first(r'data-type="([^"]*)"', head) or ""
        raw_genre = clean_text(_first(r'data-genre="([^"]*)"', head) or "")
        date = parse_fr_date(_first(r'data-date="(\d{8})"', head) or "")
        url = _first(r'<a href="([^"]+)" class="artiste-event__link"', b)
        title = clean_text(_first(r'<h3 class="artiste-event__title[^"]*">(.*?)</h3>', b) or "")
        time = parse_time(_first(r'arimo-semibold-14">(\d{1,2}:\d{2})<', b) or "")
        place = _first(r'alt="[^"]*? à (La Boule Noire|La Cigale)"', b) or venue["name"]
        img = _first(r'class="artiste-event__img"[^>]*src="([^"]+)"', b) or _first(r'src="([^"]+)"[^>]*class="artiste-event__img"', b)
        if not date or not title:
            continue
        is_music = typ in ("Concert", "Festival") or bool(re.search(r"pop|rock|jazz|rap|electro|soul", raw_genre.lower()))
        events.append(Event(
            title=title, date=date, time=time, venue=place,
            venue_slug="la-boule-noire" if "Boule" in place else venue["slug"],
            source="cigale", url=url, raw_genre=raw_genre or typ, image=img, is_music=is_music,
        ))
    return events


# ------------------------------------------------------------------ Bataclan

def bataclan(venue, ctx):
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<article class="o-event'):
        cat = clean_text(_first(r'<div class="text-xs uppercase[^"]*">(.*?)</div>', b) or "")
        title = clean_text(_first(r"<h3><span[^>]*>(.*?)</span>", b) or "")
        supports = [clean_text(x) for x in re.findall(r"<li>\s*\+?\s*(.*?)</li>", _first(r"<h3>.*?<ul[^>]*>(.*?)</ul>", b) or "")]
        date = parse_fr_date(_first(r'<div class="font-title uppercase[^"]*text-lg[^"]*">(.*?)</div>', b) or "")
        ticket = _first(r'href="(https://billetterie\.bataclan\.fr[^"]+)"', b)
        img = _first(r'<img src="([^"]+)"', b)
        sold_out = bool(re.search(r"complet|sold ?out", b, re.I)) and not ticket
        if not title or not date:
            continue
        full_title = title + (" + " + " + ".join(supports) if supports else "")
        events.append(Event(
            title=full_title, date=date, venue=venue["name"], venue_slug=venue["slug"], source="bataclan",
            url=venue["url"], ticket_url=ticket, raw_genre=cat or None, image=img, sold_out=sold_out,
            # only an explicit non-concert category (HUMOUR, SPECTACLE, SPORT) excludes an event
            is_music=not cat or "CONCERT" in cat.upper() or "FESTIVAL" in cat.upper(),
        ))
    return events


# ------------------------------------------------------------------ Le Trianon / Élysée Montmartre (same theme)

def trianon(venue, ctx):
    html = get(venue["url"])
    events, seen = [], set()
    for b in _blocks(html, r'<div class="bloc_extrait evenement'):
        url = _first(r'<a href="([^"]+)"[^>]*class="link"', b)
        title = clean_text(_first(r'<div class="titre">(.*?)</div>', b) or _first(r'title="([^"]*)"[^>]*class="link"', b) or "")
        date = parse_fr_date(_first(r'<div class="date">(.*?)</div>', b) or "")
        img = _first(r'<img[^>]+src="([^"]+)"', b)
        if not title or not date or (url, date) in seen:
            continue
        seen.add((url, date))
        events.append(Event(title=title, date=date, venue=venue["name"], venue_slug=venue["slug"], source="trianon",
                            url=url, image=img, sold_out="complet" in b.lower()))
    return events


# ------------------------------------------------------------------ La Maroquinerie

def maroquinerie(venue, ctx):
    base = "https://www.lamaroquinerie.fr"
    events, seen_urls = [], set()
    for offset in range(0, 400, 50):  # the agenda's infinite scroll pages with ?of=<offset>
        html = get(f"{base}/fr/agenda/results/?of={offset}")
        n, new = 0, 0
        for b in _blocks(html, r'<li class="event">'):
            n += 1
            url = _abs(base, _first(r'<a href="([^"]+)"', b))
            if url in seen_urls:
                continue
            seen_urls.add(url)
            new += 1
            title = clean_text(_first(r"<h2[^>]*>(.*?)</h2>", b) or "")
            date = parse_fr_date(_first(r'<h3 class="date">(.*?)</h3>', b) or "", ctx["today"])
            time = parse_time(_first(r'<div class="time">(.*?)</div>', b) or "")
            ticket = _first(r'<div class="booking[^"]*">\s*<a href="([^"]+)"', b)
            img = _abs(base, _first(r'<img src="([^"]+)"', b))
            if not title or not date:
                continue
            sold_out = "complet" in title.lower() or 'booking full' in b
            title = re.sub(r"\s*[-–]\s*complet\s*$", "", title, flags=re.I)
            events.append(Event(title=title, date=date, time=time, venue=venue["name"], venue_slug=venue["slug"],
                                source="maroquinerie", url=url, ticket_url=ticket, image=img, sold_out=sold_out))
        if n < 50 or new == 0:
            break
    return events


# ------------------------------------------------------------------ Petit Bain

def petitbain(venue, ctx):
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<div class="unevt '):
        classes = _first(r'<div class="unevt ([^"]*)"', b) or ""
        cats = re.findall(r"categorie-([a-z-]+)", classes)
        url = _first(r'<a href="([^"]+)"', b)
        date = parse_fr_date(_first(r'id="ladatevtmin">(.*?)</div>', b) or "", ctx["today"])
        title = clean_text(_first(r'id="nomsoiree">(.*?)</div>', b) or _first(r'class="titartprog">(.*?)</span>', b) or "")
        img = _first(r'id="contimgunevt"><img[^>]+src="([^"]+)"', b)
        if not title or not date:
            continue
        raw = ", ".join(c for c in cats if c not in ("agenda",))
        events.append(Event(title=title, date=date, venue=venue["name"], venue_slug=venue["slug"], source="petitbain",
                            url=url, image=img, raw_genre=raw or None, free="gratuit" in cats,
                            cancelled="billetterie-annule" in classes,
                            is_music=any(c in cats for c in ("concerts", "club")) or not cats))
    return events


# ------------------------------------------------------------------ Point Éphémère

def pointephemere(venue, ctx):
    base = "https://www.pointephemere.org"
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<a href="/event/'):
        url = _abs(base, _first(r'<a href="(/event/[^"]+)"', b))
        title = clean_text(_first(r'<span class="[^"]*truncate[^"]*">(.*?)</span>', b) or "")
        cols = re.findall(r'<div class="w-\[\d+%\][^"]*">(.*?)</div>', b, re.S)
        date_txt = clean_text(cols[1]) if len(cols) > 1 else ""
        time = parse_time(date_txt)
        date = parse_fr_date(_first(r"(\d{1,2}\.\d{1,2})", date_txt) or "", ctx["today"])
        genre = clean_text(_first(r'<div class="relative truncate[^"]*">(.*?)</div>', b) or "")
        img = _first(r'<img src="([^"]+)"', b)
        if not title or not date:
            continue
        events.append(Event(title=title, date=date, time=time, venue=venue["name"], venue_slug=venue["slug"],
                            source="pointephemere", url=url, raw_genre=genre or None, image=img))
    return events


# ------------------------------------------------------------------ Café de la Danse

def cafedeladanse(venue, ctx):
    html = get(venue["url"])
    events, seen = [], set()
    for b in _blocks(html, r'<div class="gt-title">'):
        url = _first(r'<div class="gt-title"><a href="([^"]+)"', b)
        title = clean_text(_first(r'<div class="gt-title"><a[^>]*>(.*?)</a>', b) or "")
        date = parse_fr_date(_first(r'<div class="gt-date">.*?<span>(.*?)</span>', b) or "")
        time = parse_time(_first(r'<div class="gt-time">.*?<span>(.*?)</span>', b) or "")
        genre = clean_text(_first(r'<div class="gt-location">.*?<li[^>]*><a[^>]*>(.*?)</a>', b) or "")
        price_txt = clean_text(_first(r'<div class="gt-price">(.*?)</div>', b) or "")
        price, free = parse_price(price_txt)
        if not title or not date or (title, date) in seen:
            continue
        seen.add((title, date))
        events.append(Event(title=title, date=date, time=time, venue=venue["name"], venue_slug=venue["slug"],
                            source="cafedeladanse", url=url, raw_genre=genre or None, price=price, free=free))
    return events


# ------------------------------------------------------------------ Le Hasard Ludique

def hasardludique(venue, ctx):
    base = "https://www.lehasardludique.paris"
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<a class="event_card'):
        kind = _first(r'<a class="event_card ([a-z_-]*)"', b) or ""
        url = _abs(base, _first(r'href="([^"]+)"', b))
        tags = clean_text(_first(r"<div>\s*<span>(.*?)</span>", b) or "")
        title = clean_text(_first(r"<h3>(.*?)</h3>", b) or "")
        date = parse_fr_date(_first(r"<strong>(.*?)</strong>", b) or "")
        img = _first(r"background-image: url\('([^']+)'\)", b)
        if not title or not date:
            continue
        events.append(Event(title=title, date=date, venue=venue["name"], venue_slug=venue["slug"], source="hasardludique",
                            url=url, raw_genre=tags.replace("#", " ").strip() or None, image=img,
                            is_music=kind == "concert"))
    return events


# ------------------------------------------------------------------ Instants Chavirés (WordPress posts, one per concert)

def instantschavires(venue, ctx):
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'<article id="post-'):
        url = _first(r'<span class="dates_evenements"><a href="([^"]+)"', b)
        date = parse_fr_date(_first(r'<span class="dates_evenements"><a[^>]*>(.*?)</a>', b) or "")
        raw = _first(r'<h2 class="entry-title"><a[^>]*>(.*?)</a>', b) or ""
        raw = re.sub(r"<br\s*/?>\s*(?=[(&+])", " ", raw)   # line break inside a line-up: keep it one act
        title = clean_text(re.sub(r"<br\s*/?>", " + ", raw))  # line break between acts
        img = _first(r'<img[^>]+src="([^"]+)"', b)
        if not title or not date:
            continue
        events.append(Event(title=title, date=date, venue=venue["name"], venue_slug=venue["slug"],
                            source="instantschavires", url=url, image=img))
    return events


# ------------------------------------------------------------------ La Boule Noire (own site since 2026, Elementor cards)

def boulenoire(venue, ctx):
    """Cards 'TITLE / JEUDI 10 SEPTEMBRE 2026 – 19H30', 24 per page, /page/N/ for the rest."""
    events, seen = [], set()
    for page in range(1, 9):
        url = venue["url"] if page == 1 else f"{venue['url'].rstrip('/')}/page/{page}/"
        try:
            html = get(url)
        except FetchError:
            break
        blocks = list(_blocks(html, r'<article class="elementor-post '))
        titles = [_first(r'<h2 class="elementor-post__title">\s*<a[^>]*>(.*?)</a>', b) for b in blocks]
        if not blocks or set(titles) <= seen:  # the site repeats the last page forever
            break
        seen.update(titles)
        for b in blocks:
            url = _first(r'<h2 class="elementor-post__title">\s*<a[^>]*href="([^"]+)"', b)
            title = clean_text(_first(r'<h2 class="elementor-post__title">\s*<a[^>]*>(.*?)</a>', b) or "")
            when = clean_text(_first(r'<div class="elementor-post__excerpt">(.*?)</div>', b) or "")
            img = _first(r'<img[^>]+src="([^"]+)"', b)
            sold_out = "category-complet" in b[:800] or bool(re.search(r'elementor-post__badge">\s*Complet', b))
            if not title or not when:
                continue
            for date in _boulenoire_dates(when, ctx["today"]):
                events.append(Event(title=title, date=date, time=parse_time(when), venue=venue["name"],
                                    venue_slug=venue["slug"], source="boulenoire", url=url, image=img, sold_out=sold_out))
    return events


def _boulenoire_dates(when, today):
    """'JEUDI 10 SEPTEMBRE 2026 – 19H30' -> ['2026-09-10']; '15, 16 & 17 SEPTEMBRE 2026' -> three dates."""
    t = strip_accents(when.lower()).replace("1er", "1")
    for m in re.finditer(r"((?:\b\d{1,2}\s*(?:,|&|et)\s*)*\b\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?", t):
        if m.group(2) not in FR_MONTHS:  # "20h30 samedi 12 decembre": skip "30 samedi", keep "12 decembre"
            continue
        month = FR_MONTHS[m.group(2)]
        out = []
        for d in re.findall(r"\d{1,2}", m.group(1)):
            year = int(m.group(3)) if m.group(3) else infer_year(month, int(d), today)
            try:
                out.append(dt.date(year, month, int(d)).isoformat())
            except ValueError:
                continue
        return out
    return []


# ------------------------------------------------------------------ New Morning (JSON-LD, but not valid JSON)

def newmorning(venue, ctx):
    html = get(venue["url"])
    events = []
    for b in _blocks(html, r'"@type":"Event"'):
        title = clean_text(_first(r'"name":"(.*?)",\s*\n', b) or _first(r'"name":"([^"]*)"', b) or "")
        date = (_first(r'"startDate":"(\d{4}-\d{2}-\d{2})', b) or "")
        url = _first(r'"url":"([^"]+)"', b)
        price = _first(r'"price":\s*"([^"]+)"', b)
        desc = clean_text(_first(r'"description":"(.*?)",\s*\n', b) or "")
        img = _first(r'"image":"([^"]+)"', b)
        if not title or not date:
            continue
        events.append(Event(title=title, date=date, venue=venue["name"], venue_slug=venue["slug"], source="newmorning",
                            url=url, price=(price + " €") if price else None, description=desc, image=img))
    return events
