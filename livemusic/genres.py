"""Genre taxonomy, normalisation of venue-provided tags, keyword rules, LLM tagging."""
import json
import os
import re
from typing import List, Optional

from .util import strip_accents

# Canonical tags shown in the UI (order = display order)
TAGS = [
    "rock", "indie", "pop", "metal", "punk", "electro", "hip-hop", "soul-rnb", "funk",
    "jazz", "blues", "folk", "chanson", "world", "latin", "afro", "reggae", "classical",
    "experimental",
]

# Patterns are matched on accent-stripped lowercase text.  Two rule sets:
#  * SITE_RULES: applied to genre text published by the venue ("Rap, Hip-Hop", "#indie #alt",
#    "bedroom punk / emo pop").  Short descriptors, so looser matching is fine.
#  * TEXT_RULES: applied to the concert title (and, as a weaker second pass, the description).
#    Only unambiguous words: a title is prose, so "house", "world", "groove", "impro" are banned here.
SITE_RULES = [
    (r"\bmetal|death|black metal|doom|thrash|hardcore|metalcore|grind|sludge|stoner", "metal"),
    (r"\bpunk|\boi\b|crust|emo\b", "punk"),
    (r"post[- ]?punk|shoegaze|garage|psych|noise pop|dream pop|indie|lo-?fi|math rock|krautrock|alternati|bedroom", "indie"),
    (r"\brock|grunge", "rock"),
    (r"techno|house|electro|electronic|electronique|electronica|synth|ambient|drum ?(and|&|n) ?bass|dnb|dubstep|bass music|rave|dj|hyperpop|idm|trance|edm|breakbeat|acid|club", "electro"),
    (r"hip[- ]?hop|\brap\b|\btrap\b|\bdrill\b|grime|boom bap", "hip-hop"),
    (r"\bsoul|r ?['&n]? ?b\b|rnb|motown|gospel", "soul-rnb"),
    (r"\bfunk|groove|disco\b|boogie", "funk"),
    (r"\bjazz|bebop|be-bop|swing\b|\bjam\b|big band", "jazz"),
    (r"\bblues\b", "blues"),
    (r"\bfolk|americana|bluegrass|country|singer[- ]?songwriter|acoustique|acoustic", "folk"),
    (r"chanson|variete|francaise|french pop|cabaret", "chanson"),
    (r"\bafro|highlife|amapiano|coupe[- ]decale|zouk|kizomba|soukous", "afro"),
    (r"\blatin|cumbia|salsa|bossa|samba|reggaeton|tango|flamenco|bachata|forro|mariachi|cubain|bresil", "latin"),
    (r"reggae|\bdub\b|\bska\b|ragga|dancehall|rocksteady", "reggae"),
    (r"world|musiques? du monde|traditionnel|oriental|balkan|celtique|tzigane|gnawa|\brai\b|arabe|klezmer|fado|manouche|africain|maloya|kabyle|turc|persan|indienne", "world"),
    (r"classique|classical|symphon|orchestr|philharmon|\bopera\b|baroque|recital|quatuor|chambre|chamber|choeur|chorale|lyrique|musique ancienne", "classical"),
    (r"experiment|\bnoise\b|drone|impro|avant[- ]garde|free jazz|contemporain|sound art", "experimental"),
    (r"\bpop\b|k-?pop|j-?pop|synthpop|electropop|dance pop", "pop"),
]

TEXT_RULES = [
    (r"\b(metal|black metal|death metal|doom|thrash|metalcore|grindcore|sludge)\b", "metal"),
    (r"\b(punk|hardcore)\b", "punk"),
    (r"\b(post-?punk|shoegaze|garage rock|psych(edelic|e)?|indie|krautrock)\b", "indie"),
    (r"\b(rock|grunge|rock'?n'?roll|rock and roll)\b", "rock"),
    (r"\b(techno|electro|electronic|electronique|dj set|rave|drum ?(and|&|n) ?bass|dubstep|hyperpop|trance|clubbing|dj)\b", "electro"),
    (r"\b(hip-?hop|rap|trap|drill|grime)\b", "hip-hop"),
    (r"\b(soul|r'?n'?b|rnb|r&b|gospel|motown)\b", "soul-rnb"),
    (r"\b(funk|disco|boogie)\b", "funk"),
    (r"\b(jazz|bebop|be-bop|jam session|jam|big band|quartet|quintet|sextet|trio|hommage a (dizzy|clifford|coltrane|miles|monk|bill evans|chet baker))\b", "jazz"),
    (r"\bblues\b", "blues"),
    (r"\b(folk|americana|bluegrass|singer-?songwriter)\b", "folk"),
    (r"\b(chanson francaise|chanson|variete)\b", "chanson"),
    (r"\b(afrobeat|afrobeats|amapiano|highlife|coupe-decale|zouk|kizomba)\b", "afro"),
    (r"\b(cumbia|salsa|bossa nova|bossa|samba|reggaeton|tango|flamenco|bachata|forro|piazzolla|cubain|cubaine|bresilien|bresilienne|latino)\b", "latin"),
    (r"\b(reggae|ska|ragga|dancehall|rocksteady)\b", "reggae"),
    (r"\b(musiques? du monde|musique traditionnelle|oriental|orientale|balkan|balkanique|celtique|tzigane|gnawa|klezmer|fado|manouche|maloya|kabyle|persan|persane|qawwali)\b", "world"),
    (r"\b(classique|symphonie|symphonique|orchestre (de|national|philharmonique|symphonique|du|des|de chambre)|philharmonie|opera|baroque|recital|quatuor|musique de chambre|choeur|chorale|requiem|oratorio|cantate|sonate|lieder|mahler|beethoven|mozart|bach|chopin|schubert|brahms|debussy|ravel|vivaldi|haydn|haendel|handel|rachmaninov|tchaikovski|schumann|liszt|puccini|verdi|wagner)\b", "classical"),
    (r"\b(experimental|experimentale|noise|drone|avant-garde|free jazz|musique contemporaine|musiques? improvisees?)\b", "experimental"),
    (r"\b(pop|k-?pop|j-?pop|synthpop|electropop)\b", "pop"),
]

NON_MUSIC = re.compile(
    r"\b(humour|humor|one man show|one woman show|stand-?up|sketch|theatre|theater|piece de theatre|"
    r"conference|debat|projection|cinema|film|expo|exposition|vernissage|atelier|workshop|marche|brocante|"
    r"vide-?grenier|brunch|food|yoga|sport|bingo|quiz|karaoke|lecture|litterature|dedicace|"
    r"visite|balade|spectacle vivant|danse contemporaine|cirque|magie|hypnose|drag|cabaret burlesque|"
    r"jeux|gaming|comedie|comedy|podcast|radio|talk|masterclass|salon|forum|vente de vinyles|record fair|"
    r"speed dating|loto|fete foraine|kermesse|enfants|jeune public|jeunesse|lancement du livre|livre|book launch|"
    r"rencontre|signature|repas|diner|degustation|marche de noel|braderie)\b"
)
MUSIC_HINT = re.compile(r"\b(concerts?|live|musique|music|musical|dj|club|festival|jam|tribute|release party|showcase|tournee|tour|orchestre|quartet|trio)\b")


def _norm(s: str) -> str:
    return strip_accents((s or "").lower()).replace("’", "'").replace("'", "'")


def _match(rules, text: str, max_tags: int = 3) -> List[str]:
    t = _norm(text)
    found = []
    for pattern, tag in rules:
        if tag not in found and re.search(pattern, t):
            found.append(tag)
    return found[:max_tags]


def tags_from_site(text: str) -> List[str]:
    return _match(SITE_RULES, text)


def tags_from_text(title: str, description: str = "") -> List[str]:
    """Title decides; the description only adds tags that the title left undetermined,
    and only when it is short and clearly about music."""
    tags = _match(TEXT_RULES, title)
    if tags or not description:
        return tags
    return _match(TEXT_RULES, description, max_tags=2)


def looks_non_music(text: str, venue_name: str = "") -> bool:
    t = _norm(text)
    if venue_name:  # "… au Théâtre de la Concorde" must not flag the concert as theatre
        t = t.replace(_norm(venue_name), " ")
    return bool(NON_MUSIC.search(t)) and not MUSIC_HINT.search(t)


def apply_rules(ev, venue_default: Optional[List[str]] = None):
    """Fill ev.genres from raw_genre, then title/description, then venue default."""
    if ev.genres:
        ev.genre_source = ev.genre_source or "site"
        return
    if ev.raw_genre:
        tags = tags_from_site(ev.raw_genre)
        if tags:
            ev.genres, ev.genre_source = tags, "site"
            return
    tags = tags_from_text(ev.title, ev.description or "")
    if tags:
        ev.genres, ev.genre_source = tags, "rules"
        return
    if venue_default:
        ev.genres, ev.genre_source = list(venue_default), "venue"


# --------------------------------------------------------------------------- sub-genres
# Fine-grained labels ("stoner rock", "shoegaze", "bossa nova") shown next to the coarse tags.  They are
# free text, so they are only lightly canonicalised: enough for the venue's "#indiepop" and Claude's
# "indie pop" to be one label, and for a label that merely repeats a coarse tag to be dropped.

MAX_SUBGENRES = 4
SUBGENRE_ALIASES = {
    "indiepop": "indie pop", "darkpop": "dark pop", "electronicrock": "electronic rock", "bossanova": "bossa nova",
    "synth pop": "synth-pop", "synthpop": "synth-pop", "post punk": "post-punk", "postpunk": "post-punk",
    "post rock": "post-rock", "postrock": "post-rock", "post hardcore": "post-hardcore", "post metal": "post-metal",
    "trip hop": "trip-hop", "triphop": "trip-hop", "neo soul": "neo-soul", "neosoul": "neo-soul", "nu jazz": "nu-jazz",
    "nu metal": "nu-metal", "lo fi": "lo-fi", "lofi": "lo-fi", "drum and bass": "drum & bass", "drum n bass": "drum & bass",
    "drum'n'bass": "drum & bass", "dnb": "drum & bass", "d'n'b": "drum & bass", "psyche rock": "psychedelic rock",
    "psych rock": "psychedelic rock", "psyche": "psychedelic", "psych": "psychedelic", "kpop": "k-pop", "jpop": "j-pop",
    "rock alternatif": "alternative rock", "alt rock": "alternative rock", "afro beat": "afrobeat",
    "chanson realiste": "chanson réaliste", "rap francais": "rap français", "pop francaise": "pop française",
    "musique contemporaine": "contemporain", "musiques improvisees": "impro", "musique improvisee": "impro",
}
# A "sub-genre" that only repeats a coarse tag, or names an event format rather than a style, is dropped.
COARSE_WORDS = {
    "club", "clubbing", "dj set", "djset", "dj", "tribute", "showcase", "release party", "jam session", "jam",
    "open mic", "karaoke", "soiree", "party", "gig",
    "rock", "indie", "pop", "metal", "punk", "electro", "electronic", "electronica", "electronique", "electronic music",
    "musiques electroniques", "musique electronique", "hip-hop", "hip hop", "hiphop", "rap", "soul", "rnb", "r&b",
    "r'n'b", "soul-rnb", "soul/r&b", "funk", "jazz", "blues", "folk", "chanson", "chanson francaise", "world", "world music",
    "musiques du monde", "musique du monde", "musiques traditionnelles", "musique traditionnelle", "traditionnel",
    "latin", "latino", "afro", "reggae", "classical", "classique", "musique classique", "experimental", "experimentale",
    "variete", "variete francaise", "variete internationale", "alt", "alternative", "alternatif", "concert", "concerts", "festival", "live", "musique", "music",
}
# Venue tags are also artist names, festival names and event types: keep only what looks like a style.
_STYLE_WORD = re.compile(
    r"pop|rock|punk|metal|core\b|wave\b|gaze\b|jazz|\bsoul|funk|folk|blues|hop\b|\brap\b|\btrap\b|house\b|techno|"
    r"electro|ambient|drone|noise|psych|garage|\bsurf|indie|\bemo\b|\bska\b|\bdub|reggae|cumbia|bossa|samba|salsa|"
    r"tango|afro|latin|chanson|variete|classique|baroque|opera|trance|disco|boogie|groove|grunge|stoner|doom|sludge|"
    r"thrash|\bdeath\b|grind|dream|synth|kraut|lo-?fi|acousti|americana|bluegrass|country|gospel|klezmer|fado|"
    r"flamenco|manouche|swing|bebop|experiment|impro|k-?pop|j-?pop|\bdnb\b|dubstep|breakbeat|\bacid\b|\bidm\b|"
    r"\bedm\b|\brave\b|ragga|dancehall|rocksteady|zouk|kizomba|amapiano|highlife|gnawa|balkan|celti|tzigane|oriental|"
    r"traditionnel|musette|yeye|industrial|goth|\bprog|batucada|forro|mariachi|reggaeton|bachata|kompa|\bsega\b|"
    r"fusion|\btrad|beat|musique|\brnb\b|r&b|r'n'b|\bdrill\b|\bgrime\b|\bneo|chill|downtempo|minimal|chamber|"
    r"choral|lieder|symphon|orchestr|qawwali|maloya|kabyle|persan|\bturc|indien|contemporain|\bworld|electroni|"
    r"hardcore|shoegaze|crust|\balt\b|alternati|\bbass\b|\bbreaks\b|\bjungle\b|footwork|\bbounce\b|ballroom"
)
_SPLIT = re.compile(r"\s*(?:,|/|;|\||•|\+|\bet\b|\band\b(?! (?:bass|roll)))\s*", re.I)
_FORMAT_PREFIX = re.compile(r"^(tribute|hommage|soiree|nuit|special|spéciale?)\b")   # "tribute beatles", "soirée électro"


def _sub_key(label: str) -> str:
    """Comparison key: accent-free, lowercase, punctuation-free ("Post-Punk" == "post punk")."""
    return re.sub(r"[^a-z0-9&']+", " ", _norm(label)).strip()


_COARSE_KEYS = {_sub_key(w) for w in COARSE_WORDS} | {_sub_key(w).replace(" ", "") for w in COARSE_WORDS}


def _canon_subgenre(label: str) -> Optional[str]:
    label = clean_text_light(label)
    if not label:
        return None
    key = _sub_key(label)
    key = re.sub(r"\s+et assimiles$", "", key)
    label = SUBGENRE_ALIASES.get(key) or SUBGENRE_ALIASES.get(key.replace(" ", "")) or label.lower()
    key = _sub_key(label)
    if not key or len(key) < 3 or len(label) > 32 or key in _COARSE_KEYS or key.replace(" ", "") in _COARSE_KEYS:
        return None
    if _FORMAT_PREFIX.match(key):
        return None
    return label


def clean_text_light(s: str) -> str:
    s = re.sub(r"\(.*?\)", " ", s or "")           # "Variété internationale (pop, soul, RnB)"
    s = s.replace("#", " ").strip(" .-–—:*")
    return " ".join(s.split())


def normalize_subgenres(labels) -> List[str]:
    """Canonical spelling, no duplicates, no coarse-tag repeats, at most MAX_SUBGENRES."""
    out, seen = [], set()
    for raw in labels or []:
        if not isinstance(raw, str):
            continue
        label = _canon_subgenre(raw)
        if not label:
            continue
        key = _sub_key(label).replace(" ", "").replace("-", "")
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
        if len(out) >= MAX_SUBGENRES:
            break
    return out


def subgenres_from_site(raw_genre: Optional[str]) -> List[str]:
    """Fine-grained labels out of the genre text published by the venue.

    'Metal, Punk, Heavy Metal, Hard Rock et assimilés' -> ['heavy metal', 'hard rock'];
    'pop, indie, alt' -> []; 'Coming Soon' / 'Makhtaverskan' (an artist) -> [].
    """
    if not raw_genre:
        return []
    parts = [p for p in _SPLIT.split(clean_text_light(raw_genre)) if p]
    return normalize_subgenres([p for p in parts if _STYLE_WORD.search(_norm(p))])


def merge_subgenres(*lists) -> List[str]:
    """Earlier lists win (venue descriptors before Claude's)."""
    return normalize_subgenres([x for lst in lists for x in (lst or [])])


# --------------------------------------------------------------------------- LLM tagging

def llm_available() -> bool:
    if os.environ.get("LIVEMUSIC_NO_LLM"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def _cache_load(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _cache_save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0, sort_keys=True)


def _cache_key(ev) -> str:
    from .util import norm_title
    return f"{ev.venue_slug}|{norm_title(ev.title)}"


def _apply_hit(ev, genres, is_music, subgenres=()):
    """Merge an LLM answer into the event: keep the weaker tags when Claude returned none.  Events whose
    tags come from the venue ('site') or from the page extraction ('llm', which saw the whole page) are
    only asked for sub-genres: their genres and is_music are left alone."""
    genres = [g for g in genres if g in TAGS][:3]
    if ev.genre_source not in ("site", "llm"):
        if genres:
            ev.genres, ev.genre_source = genres, "llm"
        ev.is_music = ev.is_music and bool(is_music)
    ev.subgenres = merge_subgenres(ev.subgenres, subgenres)


def _needs_llm(ev) -> bool:
    """Weakly tagged music events, plus well-tagged ones that still lack a fine-grained label."""
    return ev.is_music and (ev.genre_source not in ("site", "llm") or not ev.subgenres)


def llm_tag(events, cache_path: str, batch_size: int = 40, log=print):
    """Ask Claude for genres and sub-genres of events whose tags came from weak sources, or that have no
    sub-genre yet.  Results are cached by venue+title so re-runs are free (entries written before
    sub-genres existed are refreshed once).  Needs ANTHROPIC_API_KEY.
    """
    import anthropic
    from pydantic import BaseModel, ValidationError

    class Tagged(BaseModel):
        id: str
        genres: List[str]
        subgenres: List[str] = []
        is_music: bool

    class TaggedList(BaseModel):
        events: List[Tagged]

    cache = _cache_load(cache_path)
    todo = []
    for ev in events:
        if not _needs_llm(ev):
            continue
        hit = cache.get(_cache_key(ev))
        if hit and "subgenres" in hit:
            _apply_hit(ev, hit.get("genres", []), hit.get("is_music", True), hit["subgenres"])
        else:
            todo.append(ev)
    if not todo:
        log("  LLM: nothing to tag (all cached)")
        return

    client = anthropic.Anthropic()
    model = os.environ.get("LIVEMUSIC_MODEL", "claude-opus-5")
    system = (
        "You tag live-music listings from Paris venues with genres.\n"
        f"Allowed genre tags (use 1 to 3 per event, most specific first): {', '.join(TAGS)}.\n"
        "Use your knowledge of the artists when the title names them. 'is_music' is false for "
        "comedy, theatre, talks, exhibitions, sport, workshops, kids' shows and other non-concert "
        "events.\n"
        "'subgenres': 0 to 3 fine-grained styles as short lowercase free text, most characteristic "
        "first (stoner rock, shoegaze, post-grindcore, drone, neo-soul, boom bap, bossa nova, free jazz, "
        "baroque, rap français...). Use the usual English name, or French for French-specific styles. "
        "Never repeat a coarse tag as a sub-genre; leave the list empty rather than guessing.\n"
        "Return every id you were given exactly once."
    )
    log(f"  LLM: tagging {len(todo)} events with {model} in batches of {batch_size}")
    for i in range(0, len(todo), batch_size):
        batch = todo[i:i + batch_size]
        lines = []
        for ev in batch:
            hint = " | ".join(x for x in [ev.raw_genre, ev.description] if x)
            lines.append(json.dumps({"id": ev.id, "title": ev.title, "venue": ev.venue,
                                     "hint": hint[:200]}, ensure_ascii=False))
        try:
            resp = client.messages.parse(
                model=model,
                max_tokens=8000,
                system=system,
                messages=[{"role": "user", "content": "Events:\n" + "\n".join(lines)}],
                output_format=TaggedList,
            )
            result = resp.parsed_output
        except anthropic.APIStatusError as e:
            log(f"  LLM: API error {e.status_code}: {e.message}")
            break
        except anthropic.APIConnectionError as e:
            log(f"  LLM: connection error: {e}")
            break
        except (ValidationError, ValueError) as e:  # truncated or malformed JSON
            log(f"  LLM: unparseable answer for batch {i // batch_size + 1}: {str(e)[:120]}")
            continue
        if result is None or resp.stop_reason == "max_tokens":
            log(f"  LLM: batch {i // batch_size + 1} truncated, skipped")
            continue
        by_id = {ev.id: ev for ev in batch}
        for t in result.events:
            ev = by_id.get(t.id)
            if not ev:
                continue
            _apply_hit(ev, t.genres, t.is_music, t.subgenres)
            cache[_cache_key(ev)] = {"genres": [g for g in t.genres if g in TAGS][:3], "is_music": bool(t.is_music),
                                     "subgenres": normalize_subgenres(t.subgenres)}
        _cache_save(cache_path, cache)
        log(f"  LLM: {min(i + batch_size, len(todo))}/{len(todo)} done")
