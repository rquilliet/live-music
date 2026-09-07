"""Small helpers: HTML -> text, French date parsing, ids."""
import datetime as dt
import hashlib
import html as htmllib
import re
import unicodedata

FR_MONTHS = {
    "janvier": 1, "janv": 1, "jan": 1,
    "fevrier": 2, "février": 2, "fevr": 2, "févr": 2, "fev": 2, "fév": 2,
    "mars": 3, "mar": 3,
    "avril": 4, "avr": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7, "juil": 7,
    "aout": 8, "août": 8,
    "septembre": 9, "sept": 9, "sep": 9,
    "octobre": 10, "oct": 10,
    "novembre": 11, "nov": 11,
    "decembre": 12, "décembre": 12, "dec": 12, "déc": 12,
}
EN_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def clean_text(s: str) -> str:
    """Unescape entities, drop tags, collapse whitespace."""
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = htmllib.unescape(s)
    s = s.replace("\xa0", " ")
    return re.sub(r"\s+", " ", s).strip()


def html_to_text(h: str) -> str:
    """Readable text of a whole page (scripts/styles/nav removed), newline per block."""
    h = re.sub(r"<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<!--.*?-->", " ", h, flags=re.S)
    h = re.sub(r"</(p|div|li|h[1-6]|tr|article|section|header|footer|br|span|a|td|th)>", "\n", h, flags=re.I)
    h = re.sub(r"<br\s*/?>", "\n", h, flags=re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    h = htmllib.unescape(h).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in h.split("\n")]
    out, prev = [], None
    for ln in lines:
        if ln and ln != prev:
            out.append(ln)
        prev = ln
    return "\n".join(out)


def norm_title(s: str) -> str:
    s = strip_accents(clean_text(s).lower())
    s = re.sub(r"\b(complet|sold out|annule|annulé|report[ée]|nouvelle date|guests?)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(s: str) -> str:
    s = strip_accents(s.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "x"


def event_id(venue_slug: str, date: str, title: str) -> str:
    key = f"{venue_slug}|{date}|{norm_title(title)}"
    return hashlib.sha1(key.encode()).hexdigest()[:12]


def infer_year(month: int, day: int, today: dt.date = None) -> int:
    """Pick the year so that (month, day) is not more than ~45 days in the past."""
    today = today or dt.date.today()
    for year in (today.year, today.year + 1):
        try:
            d = dt.date(year, month, day)
        except ValueError:
            continue
        if (d - today).days >= -45:
            return year
    return today.year + 1


def parse_fr_date(s: str, today: dt.date = None) -> str:
    """Parse French / numeric dates. Returns 'YYYY-MM-DD' or None.

    Handles: 'mardi 08 septembre 2026', '9 septembre', 'mar. 8 sept.', '18 sept. 2026',
    '09.09.2026', '09.09', '2026-09-09', '09/09/2026', '20260908'.
    """
    if not s:
        return None
    t = strip_accents(clean_text(s).lower())
    t = t.replace("1er", "1")
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"\b(\d{4})(\d{2})(\d{2})\b", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b", t)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    m = re.search(r"\b(\d{1,2})[./](\d{1,2})\b(?![./]\d)", t)
    if m:
        d, mo = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{infer_year(mo, d, today)}-{mo:02d}-{d:02d}"
    m = re.search(r"\b(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?", t)
    if m:
        d = int(m.group(1))
        mo = FR_MONTHS.get(m.group(2)) or EN_MONTHS.get(m.group(2))
        if mo:
            year = int(m.group(3)) if m.group(3) else infer_year(mo, d, today)
            try:
                dt.date(year, mo, d)
            except ValueError:
                return None
            return f"{year}-{mo:02d}-{d:02d}"
    return None


def parse_time(s: str) -> str:
    """'20h00', '20h', '19:30', '20H' -> 'HH:MM' or None."""
    if not s:
        return None
    m = re.search(r"\b(\d{1,2})\s*[h:H]\s*(\d{2})?\b", s)
    if not m:
        return None
    h = int(m.group(1))
    mi = int(m.group(2) or 0)
    if 0 <= h < 24 and 0 <= mi < 60:
        return f"{h:02d}:{mi:02d}"
    return None


def parse_price(s: str):
    """Return (price_text, is_free)."""
    t = clean_text(s or "")
    if not t:
        return None, False
    low = strip_accents(t.lower())
    free = bool(re.search(r"\b(gratuit|free|entree libre|prix libre)\b", low))
    return t[:60], free
