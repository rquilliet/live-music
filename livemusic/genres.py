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

# Substring (accent-stripped, lowercase) -> canonical tag.  Checked against raw genre text first,
# then against title/description as a weaker fallback.  Order matters: more specific first.
RULES = [
    (r"\b(death|black|doom|thrash|heavy|hardcore|metalcore|grind|sludge)\b|metal", "metal"),
    (r"\bpunk|oi!|hardcore punk|crust", "punk"),
    (r"post[- ]?punk|shoegaze|garage|psych|noise pop|dream pop|indie|lo-?fi|emo\b|math rock|krautrock|alternati", "indie"),
    (r"\brock|grunge|stoner|blues rock", "rock"),
    (r"\b(techno|house|electro|electronic|electronique|electronica|synth\w*|ambient|drum ?(and|&|n) ?bass|dnb|dubstep|bass music|rave|dj set|dj|hyperpop|idm|trance|edm|breakbeat|acid|clubbing|club night|nuit club)\b", "electro"),
    (r"^club$|^club[ ,/]|[ ,/]club$", "electro"),  # 'club' alone as a venue-provided descriptor (Point Éphémère, Petit Bain)
    (r"hip[- ]?hop|\brap\b|\btrap\b|\bdrill\b|grime|boom bap", "hip-hop"),
    (r"\bsoul|r ?['&n]? ?b\b|rnb|neo[- ]?soul|motown|gospel", "soul-rnb"),
    (r"\bfunk|groove|disco\b|boogie", "funk"),
    (r"\bjazz|bebop|be-bop|swing\b|\bjam\b|\bjam session|quartet|quintet|\btrio\b|big band|hommage a (dizzy|clifford|coltrane|miles|monk)", "jazz"),
    (r"\bblues\b", "blues"),
    (r"\bfolk|americana|bluegrass|country|singer[- ]?songwriter|acoustique|acoustic", "folk"),
    (r"chanson|variete|varietes|francaise|french pop|cabaret", "chanson"),
    (r"\bafro|afrobeat|highlife|amapiano|coupe[- ]decale|zouk|kizomba|soukous", "afro"),
    (r"\blatin|cumbia|salsa|bossa|samba|reggaeton|tango|flamenco|bachata|forro|mariachi|son cubain|cubain|bresil", "latin"),
    (r"reggae|\bdub\b|\bska\b|ragga|dancehall|rocksteady", "reggae"),
    (r"world|musiques? du monde|traditionnel|oriental|balkan|celtique|tzigane|gnawa|rai\b|arabe|klezmer|fado|manouche|africain|maloya|kabyle|turc|persan|indienne", "world"),
    (r"classique|classical|symphon|orchestre (de|national|philharmonique|symphonique|du|des)|philharmon|\bopera\b|baroque|recital|quatuor|musique de chambre|chamber music|choeur|chorale|piano solo|\blied\b|sonate|cantate|requiem|oratorio|\bmesse\b|\borgue\b|pipe organ|mahler|beethoven|mozart|\bbach\b|chopin|schubert|brahms|debussy|\bravel\b|vivaldi|haydn|haendel|handel|conservatoire", "classical"),
    (r"experiment|\bnoise\b|drone|impro|avant[- ]garde|free jazz|musique contemporaine|sound art", "experimental"),
    (r"\bpop\b|k-?pop|j-?pop|synthpop|electropop|dance pop|pop rock", "pop"),
]

NON_MUSIC = re.compile(
    r"\b(humour|humor|one man show|one woman show|stand[- ]?up|sketch|theatre|theater|piece de theatre|"
    r"conference|debat|projection|cinema|film\b|expo|exposition|vernissage|atelier|workshop|marche\b|brocante|"
    r"vide[- ]?grenier|brunch|food|yoga|sport|bingo|quiz|karaoke|lecture|litterature|dedicace|"
    r"visite|balade|spectacle vivant|danse contemporaine|cirque|magie|hypnose|drag|cabaret burlesque|"
    r"jeux|gaming|comedie|comedy|podcast|radio|talk|masterclass|salon|forum|vente de vinyles|record fair|"
    r"speed dating|loto|fete foraine|kermesse|enfants|jeune public|jeunesse|lancement du livre|livre\b|book launch|"
    r"rencontre|signature|repas|diner|degustation|marche de noel|braderie)\b"
)
MUSIC_HINT = re.compile(r"\b(concert|live|musique|music|dj|club|festival|jam|tribute|release party|showcase|tournee|tour)\b")


def _norm(s: str) -> str:
    return strip_accents((s or "").lower()).replace("’", "'")


def tags_from_text(text: str, max_tags: int = 3) -> List[str]:
    t = _norm(text)
    found = []
    for pattern, tag in RULES:
        if tag not in found and re.search(pattern, t):
            found.append(tag)
    # "pop" matched from "pop rock" etc. is fine; keep the first few
    return found[:max_tags]


def looks_non_music(text: str) -> bool:
    t = _norm(text)
    return bool(NON_MUSIC.search(t)) and not MUSIC_HINT.search(t)


def apply_rules(ev, venue_default: Optional[List[str]] = None):
    """Fill ev.genres from raw_genre, then title/description, then venue default."""
    if ev.genres:
        ev.genre_source = ev.genre_source or "site"
        return
    if ev.raw_genre:
        tags = tags_from_text(ev.raw_genre)
        if tags:
            ev.genres, ev.genre_source = tags, "site"
            return
    tags = tags_from_text(f"{ev.title} {ev.description or ''}")
    if tags:
        ev.genres, ev.genre_source = tags, "rules"
        return
    if venue_default:
        ev.genres, ev.genre_source = list(venue_default), "venue"


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


def llm_tag(events, cache_path: str, batch_size: int = 40, log=print):
    """Ask Claude for genres of events whose tags came from weak sources.

    Only events with genre_source in (None, 'venue', 'rules') are sent; results are cached by
    venue+title so re-runs are free.  Needs ANTHROPIC_API_KEY.
    """
    import anthropic
    from pydantic import BaseModel

    class Tagged(BaseModel):
        id: str
        genres: List[str]
        is_music: bool

    class TaggedList(BaseModel):
        events: List[Tagged]

    cache = _cache_load(cache_path)
    todo = []
    for ev in events:
        if ev.genre_source == "site" or ev.genre_source == "llm":
            continue
        key = _cache_key(ev)
        if key in cache:
            hit = cache[key]
            ev.genres, ev.genre_source, ev.is_music = hit["genres"], "llm", hit.get("is_music", True)
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
        "events. Return every id you were given exactly once."
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
        if result is None:
            log("  LLM: empty response, stopping")
            break
        by_id = {ev.id: ev for ev in batch}
        for t in result.events:
            ev = by_id.get(t.id)
            if not ev:
                continue
            genres = [g for g in t.genres if g in TAGS][:3]
            if genres:
                ev.genres, ev.genre_source = genres, "llm"
            ev.is_music = ev.is_music and t.is_music
            cache[_cache_key(ev)] = {"genres": genres, "is_music": bool(t.is_music)}
        _cache_save(cache_path, cache)
        log(f"  LLM: {min(i + batch_size, len(todo))}/{len(todo)} done")
