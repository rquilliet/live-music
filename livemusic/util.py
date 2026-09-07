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


# Separators between acts on a bill. "&" is deliberately absent: "Frankie & The Witch Fingers" is one band.
_LINEUP_SEP = re.compile(r"\s*(?:•|·\s|\+|\s/\s|\s\|\s|,|\s(?:x|vs\.?|feat\.?|ft\.?|w/|invite|avec)\s|\s[-–—]\s|:(?=\s))\s*", re.I)


# "Concert : Kokoroko" -> the act is after the colon, not before
_GENERIC_LEAD = re.compile(r"^(?:concerts?|caf[ée][ -]concert|ap[ée]ro[ -]concert|club|jazz club|soir[ée]e|live|showcase|"
                           r"jam(?: session)?|programmation|musique|spectacle|release party)$", re.I)
# parts that are status / time / stage directions, never an act
_LINEUP_NOISE = re.compile(r"^(?:complet|sold ?out|annul[ée]e?|report[ée]e?|nouvelle date|guests?|1[eè]re partie|"
                           r"premi[eè]re partie|first part|\d{1,2}\s*[h:]\s*\d{0,2})$", re.I)


def split_lineup(title: str):
    """'Jaguar Sun • Sean Nicholas Savage • Yes Please!' -> ('Jaguar Sun', ['Sean Nicholas Savage', 'Yes Please!'])."""
    parts = [p.strip(" -–—:•·") for p in _LINEUP_SEP.split(clean_text(title))]
    parts = [p for p in parts if len(p) > 1 and not _LINEUP_NOISE.match(p)]
    if len(parts) > 1 and _GENERIC_LEAD.match(parts[0]):
        parts = parts[1:]
    if not parts:
        return clean_text(title), []
    # a lowercase part after the separator is a description ("au 38Riv Jazz Club", "jam"), not an act
    return parts[0], [p for p in parts[1:] if not p[0].islower()][:6]


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
    for m in re.finditer(r"\b(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?", t):  # "du 12 au 15 septembre"
        d = int(m.group(1))
        mo = FR_MONTHS.get(m.group(2)) or EN_MONTHS.get(m.group(2))
        if not mo:
            continue
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
