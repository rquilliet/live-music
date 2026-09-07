# Live in Paris

Concerts around Paris, scraped from the venues' own websites and the city's open data, tagged by
genre, browsable by *this week / next week / next 30 days / newly announced*.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # optional: Claude tags genres + extracts venues without a parser
.venv/bin/python scrape.py               # -> web/events.json  (add --no-llm to skip Claude)
.venv/bin/python serve.py                # http://localhost:8765
```

## How it works

| Step | Where | Notes |
|---|---|---|
| Sources | `venues.json` + `livemusic/sources/` | One entry per venue with a `strategy`. |
| `opendata` | Paris "Que faire à Paris ?" API | Every concert declared to the city, free, no key. Hundreds of small venues. |
| `tribe` | WordPress Events Calendar REST | Supersonic, Sunset/Sunside. |
| hand parsers | `sources/venues_html.py` | Bataclan, Cigale/Boule Noire, Trianon, Élysée Montmartre, Maroquinerie, Petit Bain, Point Éphémère, Café de la Danse, Hasard Ludique, New Morning. |
| `llm` | `sources/llm.py` | Any other venue: the programme page is turned into text and Claude extracts the concerts. Needs the API key. |
| Merge | `pipeline.merge` | Same venue + same date + similar title → one event (venue site wins over open data). |
| Genres | `livemusic/genres.py` | 1. tags published by the venue, 2. keyword rules on title/description, 3. venue default, 4. Claude for whatever is still weak (cached in `data/genre_cache.json`). |
| New | `data/seen.json` | First-seen date per event; "Nouveautés" = first seen in the last 7 days. The very first run is a baseline and shows nothing as new. |
| UI | `web/` | Static page reading `events.json`. Tabs, genre chips, venue filter, search, "près de moi" (browser geolocation + venue coordinates), detail sheet with artist blurb (Wikipedia), player and similar artists (Deezer, no key). |

Pages are cached 6 h in `data/cache/` (`--fresh` to bypass). Run `scrape.py` daily (cron / launchd) so
"newly announced" means something.

## Adding a venue

Add an entry to `venues.json`. If the site publishes the Events Calendar REST API use `"strategy": "tribe"`;
otherwise start with `"strategy": "llm"` and the programme URL, and write a parser in `venues_html.py`
if you want it to work without the API key. `genres` on a venue is the default tag when nothing better is known.

## Model

Claude calls use `claude-opus-5` by default; set `LIVEMUSIC_MODEL` to change it.
