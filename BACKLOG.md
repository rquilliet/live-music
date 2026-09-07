# Backlog (to be moved to Linear once the connector is authenticated)

1. **Player priority: Bandcamp > Spotify > Deezer** — in the concert detail sheet, embed the first
   available player in that order instead of always Deezer. Bandcamp has no public search API
   (scrape `bandcamp.com/search?q=` or use the artist's Bandcamp link when the venue page has one);
   Spotify embeds need an artist id (Spotify Web API, client-credentials flow, free).
2. **Specific genre labels** — keep the 19 coarse tags for filtering, but show fine-grained
   sub-genres as labels: stoner rock, psychedelic rock, drone, post-grindcore, shoegaze, etc.
   Source: venue tags (Hasard Ludique hashtags, Point Éphémère descriptors, Cigale genres) plus
   Claude tagging with a free-text `subgenres` field; filter chips could expand to sub-genres.
3. **"Add to my calendar (Google)" and "Share on WhatsApp" buttons** on the detail sheet
   (Google Calendar template URL with title/date/time/venue; `https://wa.me/?text=` with the
   `#e=<id>` link).
4. **Coverage check for small venues** — verify that Instants Chavirés (Montreuil) and similar
   minor venues show up; add parsers or LLM entries in `venues.json` for the missing ones.
5. **"Artists I should dig" filter from Spotify likes** — optional Spotify login (PKCE, no
   server secret); pull liked songs / top artists, match against event artists and similar
   artists (Deezer related / Spotify related), surface a filter chip.
