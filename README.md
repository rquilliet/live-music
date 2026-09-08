# Live in Paris

Concerts around Paris, scraped from the venues' own websites and the city's open data, tagged by
genre, browsable by *this week / next week / next 30 days / newly announced*.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                     # put your Anthropic API key in there (console.anthropic.com -> API Keys)
.venv/bin/python scrape.py               # -> web/events.json  (add --no-llm to skip Claude)
.venv/bin/python serve.py                # http://localhost:8765
```

Without a key the scraper still works with the venues that have a parser; Claude adds genre tagging
and the venues marked `"strategy": "llm"` in `venues.json`.

## Tooling

- `.mcp.json` declares Linear's MCP server so Claude Code can read and create backlog tickets from
  this project (approve the server and log in to Linear when prompted).
- `.claude/launch.json` lets Claude Code start the dev server for screenshots.

## How it works

| Step | Where | Notes |
|---|---|---|
| Sources | `venues.json` + `livemusic/sources/` | One entry per venue with a `strategy`. |
| `opendata` | Paris "Que faire à Paris ?" API | Every concert declared to the city, free, no key. Hundreds of small venues. |
| `tribe` | WordPress Events Calendar REST | Supersonic, Sunset/Sunside. |
| hand parsers | `sources/venues_html.py` | Bataclan, Cigale, Boule Noire, Trianon, Élysée Montmartre, Maroquinerie, Petit Bain, Point Éphémère, Café de la Danse, Hasard Ludique, New Morning, Instants Chavirés. |
| `llm` | `sources/llm.py` | Any other venue: the programme page is turned into text and Claude extracts the concerts. Needs the API key. |
| Merge | `pipeline.merge` | Same venue + same date + similar title → one event (venue site wins over open data). |
| Genres | `livemusic/genres.py` | 1. tags published by the venue, 2. keyword rules on title/description, 3. venue default, 4. Claude for whatever is still weak (cached in `data/genre_cache.json`). |
| Sub-genres | `livemusic/genres.py` | Free-text labels ("stoner rock", "bossa nova") shown next to the coarse tags and usable as a second-level filter ("Styles" row): the venue's own descriptors first (`subgenres_from_site`), then Claude's `subgenres` for every music event that has none. Clicking a label toggles that style filter. |
| Players | `livemusic/players.py` | For every act of a music event (headliner + support), the scraper looks for the artist's own Bandcamp page (public autocomplete, exact name match, then the page's `bc-page-properties` gives an album/track to embed) and, when `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` are set, the Spotify artist id. Written on the event as `players`; the detail sheet embeds Bandcamp > Spotify > Deezer. Cached per artist in `data/player_cache.json`, misses included (re-checked after 30 days); at most 300 new artists per run, soonest concerts first. `--no-players` skips it. |
| Summaries | `livemusic/summaries.py` | Text shown on the event sheet: the venue's own description when the scraper found one; otherwise Claude reads the event page (`url`) and writes 1–2 French sentences on who plays and what kind of show it is (`summary`, cached per event in `data/summary_cache.json`, at most 200 new pages per run; urls shared by more than 3 events are programme pages and are skipped). The UI falls back to the artist's Wikipedia summary only when both are empty, and shows nothing rather than a placeholder. |
| New | `data/seen.json` | First-seen date per event; "Nouveautés" = first seen in the last 7 days. The very first run is a baseline and shows nothing as new. |
| UI | `web/` | Static page reading `events.json`. Tabs, genre chips (with a contextual row of fine-grained style chips once a genre is picked), searchable multi-venue filter, search, "près de moi" (browser geolocation + venue coordinates), "Mes concerts" filter. Lean concert sheet ("Affiche"): a short hero whose title links to the event page, four action tiles (Billets + price, "Intéressé ?" → *Intéressé* / *J'y vais* status kept in the browser, Agenda Google, WhatsApp), venue + itinéraire, price + styles, the venue's text about the show (description or Claude summary, "lire la suite" when long, Wikipedia as fallback), the player right below it (Bandcamp, else Spotify, else Deezer; other acts one tap away), "Dans le même esprit" (Deezer related artists, names only) and search links. |

Pages are cached 6 h in `data/cache/` (`--fresh` to bypass). Run `scrape.py` daily (cron / launchd) so
"newly announced" means something.

## Coverage check

The end of every run lists the venues whose own site yielded fewer than 3 events (`low coverage`): that is
almost always a programme page rendered by JavaScript or a URL that moved, not an empty programme. Venues
whose programme only lives on Facebook / Instagram / Shotgun (`"strategy": "none"` with a `note` in
`venues.json`) are covered by the open data feed only.

## Adding a venue

Add an entry to `venues.json`. If the site publishes the Events Calendar REST API use `"strategy": "tribe"`;
otherwise start with `"strategy": "llm"` and the programme URL, and write a parser in `venues_html.py`
if you want it to work without the API key. `genres` on a venue is the default tag when nothing better is known.

## Model

Claude calls use `claude-opus-5` by default; set `LIVEMUSIC_MODEL` to change it.

## Spotify (optional)

Bandcamp needs no key. To also resolve Spotify artists, create an app on the Spotify developer dashboard and
put `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` (client-credentials flow, no user login).
Without them the lookup is skipped silently and the sheet falls back to Deezer when the act is not on Bandcamp.
