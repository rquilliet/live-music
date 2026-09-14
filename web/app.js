/* Live in Paris — week planner (direction A "Programme"), one search bar + Genres panel (REM-26, direction A "Barre unique"),
   concert detail sheet. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const TAG_LABELS = {
    rock: "Rock", indie: "Indie", pop: "Pop", metal: "Metal", punk: "Punk", electro: "Electro",
    "hip-hop": "Hip-hop", "soul-rnb": "Soul / R&B", funk: "Funk", jazz: "Jazz", blues: "Blues",
    folk: "Folk", chanson: "Chanson", world: "World", latin: "Latin", afro: "Afro", reggae: "Reggae",
    classical: "Classical", experimental: "Experimental",
  };
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WALK_KMH = 4.5;
  // Extra words the search bar accepts for the coarse genres ("rap" -> Hip-hop, "techno" -> Electro, "classique" -> Classical): the French
  // names stay searchable now that the labels are English (REM-32).
  const TAG_ALIASES = { "hip-hop": "rap hip hop", "soul-rnb": "soul rnb r&b", electro: "électronique techno house", classical: "classique classical",
    experimental: "expérimental noise", world: "musiques du monde world music", chanson: "chanson française variété", latin: "latino", afro: "afrobeat" };

  let DATA = { events: [], tags: [], venues: [] };
  let state = load({ genres: [], styles: [], venues: [], q: "", near: false, radius: 5, newOnly: false, mine: false, myVenues: false, myArtists: false });
  const STATUS = { interested: { icon: "☆", svg: "star", label: "Interested" }, going: { icon: "✓", svg: "check", label: "Going" } };
  let status = loadStatus(); // {eventId: "interested" | "going"} — REM-18 "Interested? / Going"
  let favVenues = loadFavs(); // favourite venue names (★ on the sheet), localStorage "lip-venues" — REM-28 "Mes salles"
  let me = null; // {lat, lon}
  let stylesOpen = false;  // "+N autres" expanded in the Genres panel (not persisted)
  let genresOpen = false;  // Genres panel under the "Genres ▾" pill
  let taOpen = false;      // typeahead listbox under the search bar
  let taHi = -1;           // highlighted row of the typeahead (-1 = the typed text itself)
  let taItems = [];        // rows currently listed, in display order
  let IDX = null;          // search index (artists, venues, genres, styles), built once events.json is loaded
  const MOBILE = matchMedia("(max-width: 560px)");   // the bar opens as a full-screen sheet
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");

  // ------------------------------------------------------------ motion (REM-15)
  // Everything animates in CSS; JS only sequences it. Reduced motion: CSS keeps 120ms fades, JS skips the parallax.
  const MOTION = matchMedia("(prefers-reduced-motion: reduce)");
  const motionOK = () => !MOTION.matches;
  // Exit animation: add `cls`, hide when it ends (a timer backs up animationend). cancelExit() aborts a pending one.
  function exitThen(el, cls, ms, then) {
    cancelExit(el);
    const done = () => { cancelExit(el); then(); };
    el._exit = { cls, t: setTimeout(done, ms + 80), h: ev => { if (ev.target === el) done(); } };
    el.classList.add(cls);
    el.addEventListener("animationend", el._exit.h);
  }
  function cancelExit(el) {
    if (!el._exit) return;
    clearTimeout(el._exit.t); el.removeEventListener("animationend", el._exit.h); el.classList.remove(el._exit.cls); el._exit = null;
  }
  // Restart a one-shot CSS animation class (remove, reflow, add).
  function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  // ------------------------------------------------------------ helpers
  // Persisted UI state ("lip-state"). Keys of the previous UIs are migrated: the Semaine / 30 jours / Tout tabs, Gratuit
  // and "Inclure les non-concerts" are gone; the Nouveautés tab and "Mes concerts" (saved) are now toggles.
  function load(def) {
    let s = def;
    try { s = Object.assign(def, JSON.parse(localStorage.getItem("lip-state") || "{}")); } catch { /* keep defaults */ }
    if (s.saved === true) s.mine = true;
    if (s.tab === "new") s.newOnly = true;
    const strings = a => (Array.isArray(a) ? a : []).filter(v => typeof v === "string" && v);
    s.genres = strings(s.genres); s.styles = strings(s.styles); s.venues = strings(s.venues);
    if (typeof s.venue === "string" && s.venue && !s.venues.length) s.venues = [s.venue];   // single-venue dropdown from the previous UI
    s.q = typeof s.q === "string" ? s.q.trim() : "";
    s.newOnly = s.newOnly === true; s.mine = s.mine === true; s.myVenues = s.myVenues === true; s.myArtists = s.myArtists === true; s.near = s.near === true;
    if (![2, 5, 10, 25, 1000].includes(Number(s.radius))) s.radius = 5;
    ["tab", "free", "others", "saved", "venue", "week"].forEach(k => delete s[k]);   // week: the ‹ › offset of the one-week view (gone, REM-35)
    return s;
  }
  function save() { try { localStorage.setItem("lip-state", JSON.stringify(state)); } catch {} }
  // Status per concert, kept in localStorage "lip-status". The previous UI stored a plain list of bookmarked ids in
  // "lip-saved" ("Enregistrer"): on first load those become "interested" and the old key is dropped.
  function loadStatus() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem("lip-status") || "{}"); } catch { /* fresh start */ }
    if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
    s = Object.fromEntries(Object.entries(s).filter(([, v]) => v in STATUS));
    try {
      const old = JSON.parse(localStorage.getItem("lip-saved") || "null");
      if (Array.isArray(old)) {
        old.forEach(id => { if (typeof id === "string" && !s[id]) s[id] = "interested"; });
        localStorage.setItem("lip-status", JSON.stringify(s));
        localStorage.removeItem("lip-saved");
      }
    } catch { /* nothing to migrate */ }
    return s;
  }
  function loadFavs() {
    try { const a = JSON.parse(localStorage.getItem("lip-venues") || "[]"); return Array.isArray(a) ? a.filter(v => typeof v === "string" && v) : []; } catch { return []; }
  }
  function isFav(venue) { return favVenues.includes(venue); }
  function toggleFav(venue) {
    favVenues = isFav(venue) ? favVenues.filter(v => v !== venue) : [...favVenues, venue];
    try { localStorage.setItem("lip-venues", JSON.stringify(favVenues)); } catch {}
  }
  function getStatus(id) { return status[id] || null; }
  function setStatus(id, s) {
    if (s in STATUS) status[id] = s; else delete status[id];
    try { localStorage.setItem("lip-status", JSON.stringify(status)); } catch {}
  }
  // "Mes concerts" count: upcoming events with a status (past ones linger in storage but are not counted).
  function statusCount() { const t = isoDate(today0()); return DATA.events.filter(e => status[e.id] && e.date >= t).length; }
  // Local calendar date, never toISOString (UTC would shift Paris midnight to the previous day).
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function safeUrl(u) { return u && /^https?:\/\//i.test(u) ? u : null; }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function today0() { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }
  function monday(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function fmtDay(s) { const d = parseISO(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
  function fmtShort(d) { return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
  function fmtTime(t) {
    const m = /^(\d{1,2})\s*[:h]\s*(\d{2})?/.exec(t || "");
    if (!m) return t || "—";
    return `${+m[1]}:${m[2] || "00"}`;
  }
  function weekLabel(mon, short = false) {
    const sun = addDays(mon, 6), M = short ? MONTHS_SHORT : MONTHS, f = d => `${d.getDate()} ${M[d.getMonth()]}`;
    const year = sun.getFullYear() !== today0().getFullYear() ? ` ${sun.getFullYear()}` : "";
    return (mon.getMonth() === sun.getMonth() ? `${mon.getDate()} – ${sun.getDate()} ${M[mon.getMonth()]}` : `${f(mon)} – ${f(sun)}`) + year;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function km(a, b) {
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function plural(n, w) { return `${n} ${w}${n > 1 ? "s" : ""}`; }

  // The time frame is every upcoming week (REM-35): from today on, stacked under one heading per month (renderList).
  function range() { return [isoDate(today0()), "9999-12-31"]; }
  function inFrame(e, r = range()) { return e.date >= r[0] && e.date <= r[1]; }
  function isNew(e) {
    if (!e.first_seen || e.first_seen === "baseline") return false;
    const age = (Date.now() - parseISO(e.first_seen).getTime()) / 864e5;
    return age <= (DATA.new_window_days || 7);
  }
  // Headliner + support acts (computed by the scraper; split the title for older events.json files).
  function lineup(e) {
    if (e.headliner) return [e.headliner, ...(e.support || [])];
    const parts = splitArtists(e.title);
    return parts.length ? parts : [e.title];
  }
  // "De 6 à 9 euros." -> "6–9 €", "Tarif plein : 10 EUR" -> "10 €", "payant" (paid, no amount) -> "paid", nothing usable -> null.
  // Only amounts followed by a currency word count (or the low end of "6 à 9 euros"): dates, ages and "1 consommation" do not.
  const AMOUNT = /\d+(?:[.,]\d+)?(?=\s*(?:€|euros?\b|eur\b)|\s*(?:à|-|–|\/)\s*\d+(?:[.,]\d+)?\s*(?:€|euros?\b|eur\b))/gi;
  function shortPrice(p) {
    if (!p) return null;
    const nums = (p.match(AMOUNT) || []).map(x => parseFloat(x.replace(",", "."))).filter(n => n > 0 && n < 1000);
    if (!nums.length) return /payant/i.test(p) ? "paid" : null;
    const f = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return lo === hi ? `${f(lo)} €` : `${f(lo)}–${f(hi)} €`;
  }
  function walk(e) {
    if (!(state.near && me && e.lat != null)) return "";
    const d = km(me, e), min = Math.round(d / WALK_KMH * 60);
    return min <= 90 ? `${min} min walk` : `${d.toFixed(d < 10 ? 1 : 0)} km`;
  }

  // "Agenda Google" link: floating local time in Europe/Paris, 2h30 long, or an all-day event when the time is unknown.
  function gcalUrl(e) {
    const [head, ...sup] = lineup(e);
    const d = parseISO(e.date), pad = n => String(n).padStart(2, "0");
    const ymd = x => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}`;
    const m = /^(\d{1,2})\s*[:h]\s*(\d{2})?/.exec(e.time || "");
    let dates;
    if (m) {
      const start = new Date(d); start.setHours(+m[1], +(m[2] || 0), 0, 0);
      const end = new Date(start.getTime() + 150 * 60000);
      const stamp = x => `${ymd(x)}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
      dates = `${stamp(start)}/${stamp(end)}`;
    } else {
      dates = `${ymd(d)}/${ymd(addDays(d, 1))}`;
    }
    const link = safeUrl(e.ticket_url) || safeUrl(e.url);
    const details = [shareLink(e), link, e.price].filter(Boolean).join("\n");
    const q = {
      action: "TEMPLATE",
      text: `${head}${sup.length ? " with " + sup.join(", ") : ""} @ ${e.venue}`,
      dates, details,
      location: [e.venue, e.address || e.area].filter(Boolean).join(", "),
      ctz: "Europe/Paris",
    };
    return "https://calendar.google.com/calendar/render?" + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }
  // "WhatsApp" link (REM-24, REM-29): a recommendation, the facts, the ticket/venue link, our deep link last.
  // The desktop app received only our link out of the previous message (REM-29); nothing documents why, so every
  // suspect is avoided at once: api.whatsapp.com/send rather than wa.me (one redirect and one re-encoding fewer),
  // no emoji and no URL on the first line, both links at the end, the hash-free ?e= form of the deep link (a "#"
  // that WhatsApp re-decodes into its whatsapp://send?text= URL would cut the message there). encodeURIComponent
  // keeps the newlines as %0A and the "#" of any ticket URL as %23.
  function whatsappUrl(e) {
    const [head, ...sup] = lineup(e);
    const ticket = safeUrl(e.ticket_url), link = ticket || safeUrl(e.url);
    const lines = [
      "A concert you might like:",
      `${head}${sup.length ? " with " + sup.join(", ") : ""}`,
      `${fmtDay(e.date)}${e.time ? " \u00b7 " + fmtTime(e.time) : ""}`,
      `${e.venue}${e.area ? " (" + e.area + ")" : ""}`,
      link ? `${ticket ? "Tickets" : "Info"}: ${link}` : "",
      shareLink(e),
    ].filter(Boolean);
    return "https://api.whatsapp.com/send?text=" + encodeURIComponent(lines.join("\n"));
  }
  // The link we hand out (WhatsApp, Agenda): ?e=<id> — a query survives the messengers' re-encoding where a #fragment
  // may not, and it reaches the server (a per-concert preview becomes possible). The page itself keeps #e=<id> in the
  // address bar (fillDetail): opening a sheet must not reload the page, and both forms open the sheet at boot.
  function shareLink(e) { return location.origin + location.pathname + "?e=" + e.id; }

  // ------------------------------------------------------------ filtering
  // The toggles (Nouveautés, Mes concerts, Mes salles, Mes artistes) narrow the programme before the genre / style / venue picks.
  function pillsOK(e) {
    return !(state.newOnly && !isNew(e)) && !(state.mine && !status[e.id]) && !(state.myVenues && !isFav(e.venue)) && !(state.myArtists && !spMatch(e));
  }
  function baseFilter(e) {
    if (!e.is_music) return false;   // expos, ateliers, conférences… are never shown
    if (!pillsOK(e)) return false;
    // The genre / style / venue chips are one OR group (REM-37): a concert shows when it matches any of them. The text
    // and the pills narrow.
    if (state.venues.length || state.genres.length || state.styles.length) {
      const hit = state.venues.includes(e.venue) || e.genres.some(g => state.genres.includes(g)) || (e.subgenres || []).some(x => state.styles.includes(x));
      if (!hit) return false;
    }
    if (state.q) {
      const q = norm(state.q);
      if (!norm(`${e.title} ${e.venue} ${e.area || ""} ${e.raw_genre || ""} ${(e.subgenres || []).join(" ")} ${e.description || ""} ${e.summary || ""}`).includes(q)) return false;
    }
    if (state.near && me) {
      if (e.lat == null || e.lon == null) return false;
      if (km(me, e) > Number(state.radius)) return false;
    }
    return true;
  }
  function visible() { const r = range(); return DATA.events.filter(e => baseFilter(e) && inFrame(e, r)); }
  // Concerts of the frame before the genre / style / venue filters: the counts next to the choices ("Jazz 64") say what
  // picking one would give within this week (or within every upcoming week when a toggle widened the frame).
  function scopeCounts() {
    const r = range(), c = { genre: {}, style: {}, venue: {}, n: 0 };
    DATA.events.forEach(e => {
      if (!e.is_music || !inFrame(e, r) || !pillsOK(e)) return;
      c.n++;
      e.genres.forEach(g => c.genre[g] = (c.genre[g] || 0) + 1);
      (e.subgenres || []).forEach(x => c.style[x] = (c.style[x] || 0) + 1);
      c.venue[e.venue] = (c.venue[e.venue] || 0) + 1;
    });
    return c;
  }

  // ------------------------------------------------------------ rendering
  // The sticky strip (REM-35): the month in view as the big label, the total, and one button per month of the programme
  // that scrolls to its heading. spy() keeps the label and the active button in step with the scroll position.
  let months = [];   // "YYYY-MM" keys of the months listed, in order (set by renderList)
  const yearOf = m => m.slice(0, 4) !== String(today0().getFullYear()) ? " " + m.slice(0, 4) : "";   // the year only when it is not this one
  function renderNav() {
    $("#weekcount").textContent = plural(visible().length, "concert");
    $("#months").innerHTML = months.map(m => `<button type="button" data-m="${m}">${MONTHS_SHORT[+m.slice(5) - 1]}${yearOf(m)}</button>`).join("");
    spy();
  }
  let spyRaf = 0;
  function spy() {
    const line = $(".weeknav").getBoundingClientRect().bottom + 2;
    let cur = months[0] || "";
    $$(".monthhead").forEach(h => { if (h.getBoundingClientRect().top <= line) cur = h.dataset.m; });
    $("#weeklabel").textContent = cur ? MONTHS[+cur.slice(5) - 1] + yearOf(cur) : "Coming up";
    $$("#months button").forEach(b => { b.classList.toggle("on", b.dataset.m === cur); b.setAttribute("aria-current", b.dataset.m === cur ? "true" : "false"); });
  }
  function jumpMonth(m) {
    const h = $$(".monthhead").find(x => x.dataset.m === m); if (!h) return;
    window.scrollTo({ top: h.getBoundingClientRect().top + scrollY - $(".weeknav").offsetHeight + 1, behavior: motionOK() ? "smooth" : "auto" });   // tucked 1px under the strip: spy() counts it as in view
  }
  // The pills: Genres ▾ (badge = active genres + styles), Nouveautés, Mes concerts, Mes salles (badge = favourite venues),
  // Près de moi (+ radius once active).
  function renderPills() {
    const t = isoDate(today0());
    const nNew = DATA.events.filter(e => e.is_music && e.date >= t && isNew(e)).length, nG = state.genres.length + state.styles.length;
    const set = (id, on, n) => { const b = $(id); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); $("small", b).textContent = n || ""; };
    set("#newonly", state.newOnly, nNew); set("#mine", state.mine, statusCount()); set("#myvenues", state.myVenues, favVenues.length);
    renderSpPill();   // Mes artistes (REM-9)
    const g = $("#gbtn");
    g.classList.toggle("on", nG > 0); g.setAttribute("aria-expanded", String(genresOpen));
    $("small", g).textContent = nG || ""; $(".car", g).textContent = genresOpen ? "▴" : "▾";
    const near = $("#near");
    near.classList.toggle("on", state.near); near.setAttribute("aria-pressed", String(state.near)); $("span", near).textContent = "Near me";
    $("#radius").hidden = !state.near; $("#radius").value = state.radius;
    renderGenrePanel();
  }
  // Genres panel: the 19 genres with the counts of the frame, then (once a genre or a style is picked) the styles found
  // in the frame for those genres, most frequent first, STYLES_SHOWN + "N autres", narrowed by the small filter input.
  const STYLES_SHOWN = 12;
  function renderGenrePanel() {
    const panel = $("#gpanel");
    if (!genresOpen) { if (!panel.hidden && !panel._exit) exitThen(panel, "out", 120, () => { panel.hidden = true; }); return; }
    cancelExit(panel); panel.hidden = false;
    const c = scopeCounts();
    $("#gclear").hidden = !(state.genres.length || state.styles.length);
    $("#glist").innerHTML = DATA.tags.map(t => {
      const on = state.genres.includes(t), n = c.genre[t] || 0;
      return `<button type="button" class="g${on ? " on" : ""}${n ? "" : " zero"}" data-g="${t}" aria-pressed="${on}">${TAG_LABELS[t] || t}<small>${n}</small></button>`;
    }).join("");
    const picked = state.genres, show = picked.length || state.styles.length;
    $("#gsty").hidden = !show;
    if (!show) { $("#slist").innerHTML = ""; return; }
    const counts = {}, r = range();
    DATA.events.forEach(e => {
      if (!e.is_music || !inFrame(e, r) || !pillsOK(e)) return;
      if (picked.length && !e.genres.some(g => picked.includes(g))) return;
      (e.subgenres || []).forEach(x => counts[x] = (counts[x] || 0) + 1);
    });
    state.styles.forEach(x => counts[x] = counts[x] || 0);   // an active style stays visible even when the frame has none left
    const all = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "en"));
    const q = norm($("#gsq").value.trim());
    let shown, rest = 0;
    if (q) shown = all.filter(x => fuzzy(norm(x), q) >= 0);
    else {
      const head = new Set([...all.slice(0, STYLES_SHOWN), ...state.styles]);
      shown = stylesOpen ? all : all.filter(x => head.has(x)); rest = all.length - shown.length;
    }
    $("#gstitle").textContent = picked.length ? `Styles of ${picked.map(g => TAG_LABELS[g] || g).join(", ")}` : "Styles";
    $("#gsq").placeholder = `Filter the ${all.length} styles…`;
    const chip = x => `<button type="button" class="g${state.styles.includes(x) ? " on" : ""}" data-s="${esc(x)}" aria-pressed="${state.styles.includes(x)}">${esc(x)}<small>${counts[x]}</small></button>`;
    let more = "";
    if (rest > 0) more = `<button type="button" class="link" data-more>+ ${rest} more</button>`;
    else if (!q && stylesOpen && all.length > STYLES_SHOWN) more = '<button type="button" class="link" data-more>show less</button>';
    $("#slist").innerHTML = shown.length ? shown.map(chip).join("") + more
      : `<span class="none">${all.length ? "No style matches." : "no known style"}</span>`;
  }
  // Puts the panel under the "Genres ▾" pill, pulled left when it would overflow the row (the phone stretches it in CSS).
  function placePanel() {
    const p = $("#gpanel"); if (p.hidden) return;
    const b = $("#gbtn").getBoundingClientRect(), r = $("#hrow").getBoundingClientRect();
    p.style.top = `${Math.round(b.bottom - r.top + 8)}px`;
    p.style.left = `${Math.round(Math.max(0, Math.min(b.left - r.left, r.width - p.offsetWidth)))}px`;
  }
  // The active filters as chips inside the bar (lime, name + count + ×), "Clear all" after them.
  let chipCount = 0;
  function renderChips() {
    const c = scopeCounts();
    // A venue chip also carries the ★ of "Mes salles" (REM-31): the favourite can be set from the bar, without opening a sheet.
    const chip = (kind, key, label, n) => `<span class="chipin"><span>${esc(label)}</span>${n == null ? "" : `<small>${n}</small>`}${kind === "venue" ? favBtn(key) : ""}<button type="button" class="x" data-rm="${kind}" data-key="${esc(key)}" aria-label="Remove ${esc(label)}">✕</button></span>`;
    const chips = [
      ...state.genres.map(g => chip("genre", g, TAG_LABELS[g] || g, c.genre[g] || 0)),
      ...state.styles.map(x => chip("style", x, x, c.style[x] || 0)),
      ...state.venues.map(v => chip("venue", v, v, c.venue[v] || 0)),
      ...(state.q ? [chip("q", state.q, `“${state.q}”`, null)] : []),
    ];
    $("#chips").innerHTML = chips.join("") + (chips.length ? '<button type="button" class="link" id="clearall">Clear all</button>' : "");
    if (chips.length > chipCount) { const last = $$("#chips .chipin").pop(); if (last) last.classList.add("pop"); }   // only the new one springs in
    chipCount = chips.length;
  }
  function toggleStyle(s) {
    state.styles = state.styles.includes(s) ? state.styles.filter(x => x !== s) : [...state.styles, s];
    render();
  }
  function toggleGenre(g) {
    state.genres = state.genres.includes(g) ? state.genres.filter(x => x !== g) : [...state.genres, g];
    render();
  }
  // Fine-grained labels next to the coarse tags; clicking one toggles that style filter. Active styles come first.
  function subHtml(e, max = 2) {
    const subs = (e.subgenres || []).slice().sort((a, b) => state.styles.includes(b) - state.styles.includes(a));
    return subs.slice(0, max).map(s => `<button class="tag sub ${state.styles.includes(s) ? "on" : ""}" type="button" data-sub="${esc(s)}" title="${state.styles.includes(s) ? "Remove the style" : "Filter on"} “${esc(s)}”">${esc(s)}</button>`).join("");
  }
  function statusTags(e) {
    const b = [];
    if (isNew(e)) b.push('<span class="tag new">New</span>');
    if (e.sold_out) b.push('<span class="tag sold">Sold out</span>');
    if (e.cancelled) b.push('<span class="tag cancel">Cancelled</span>');
    const s = getStatus(e.id);
    if (s) b.push(`<span class="tag status ${s}" title="${STATUS[s].label}" aria-label="${STATUS[s].label}">${STATUS[s].icon}</span>`);
    return b.join("");
  }
  function gigHtml(e) {
    const [head, ...sup] = lineup(e);
    const genre = e.genres.find(g => state.genres.includes(g)) || e.genres[0];
    const price = e.free ? '<span class="tag free">Free</span>' : (p => p ? `<span class="tag">${esc(p)}</span>` : "")(shortPrice(e.price));
    return `<div class="gig${e.cancelled ? " cancelled" : ""}" data-id="${e.id}">
      <time>${fmtTime(e.time)}</time>
      <div class="who">${esc(head)}${sup.length ? `<span>${esc(sup.join(", "))}</span>` : ""}</div>
      <div class="where">${esc([e.venue, e.area, walk(e)].filter(Boolean).join(" · "))}</div>
      <div class="tags">${price}${genre ? `<span class="tag">${TAG_LABELS[genre] || genre}</span>` : ""}${subHtml(e)}${statusTags(e)}</div>
    </div>`;
  }
  // One calendar week, Monday to Sunday. `from`/`to` bound the current frame; days before today are "past".
  function weekGrid(mon, byDay, o) {
    let h = '<div class="grid">';
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i), iso = isoDate(d), evs = byDay[iso] || [];
      const past = iso < o.today, out = !past && (iso < o.from || iso > o.to);
      const cls = ["day", iso === o.today && "today", past && "past", out && "out"].filter(Boolean).join(" ");
      const note = past ? "past" : out ? "" : evs.length ? plural(evs.length, "concert") : "—";
      h += `<div class="${cls}"><h2>${DAYS_SHORT[d.getDay()]} ${d.getDate()}<em>${note}</em></h2>`;
      if (evs.length) h += evs.map(gigHtml).join("");
      else if (!past && !out) h += '<div class="empty">Nothing announced.</div>';
      h += "</div>";
    }
    return h + "</div>";
  }
  // Every upcoming week, stacked (REM-35), under one heading per month — a week belongs to the month of its Thursday, the
  // ISO rule. Weeks without a concert are skipped, so a venue or artist filter starts at its first concert.
  function renderList() {
    let evs = visible();
    const byTime = (a, b) => (a.time || "99:99").localeCompare(b.time || "99:99");
    evs = evs.slice().sort((a, b) => a.date.localeCompare(b.date) || (state.near && me ? km(me, a) - km(me, b) : byTime(a, b)));
    const list = $("#list");
    if (!DATA.events.length) {
      list.innerHTML = '<div class="empty">No events. Run <code>python scrape.py</code> to fill the programme.</div>';
      return;
    }
    const byDay = {};
    evs.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
    const today = isoDate(today0());
    const [from, to] = range();
    let html = "";
    const weekOf = e => isoDate(monday(parseISO(e.date))), monthOf = w => isoDate(addDays(parseISO(w), 3)).slice(0, 7);
    const perWeek = {}, perMonth = {};
    evs.forEach(e => { const w = weekOf(e), m = monthOf(w); perWeek[w] = (perWeek[w] || 0) + 1; perMonth[m] = (perMonth[m] || 0) + 1; });
    const mondays = Object.keys(perWeek).sort();
    months = [...new Set(mondays.map(monthOf))];
    if (!mondays.length) html += `<div class="empty">${state.myArtists ? "No concert by your artists for now." : state.myVenues && !favVenues.length ? "Add venues with ★ on a concert or on a venue chip." : "Nothing for these filters."}</div>`;
    let lastMonth = "";
    for (const w of mondays) {
      const m = monthOf(w);
      if (m !== lastMonth) { lastMonth = m; html += `<h2 class="monthhead" data-m="${m}" id="m-${m}">${MONTHS[+m.slice(5) - 1]}<small>${m.slice(0, 4)}</small><em>${plural(perMonth[m], "concert")}</em></h2>`; }
      html += `<h3 class="weekhead">${weekLabel(parseISO(w), MOBILE.matches)}<em>${plural(perWeek[w], "concert")}</em></h3>` + weekGrid(parseISO(w), byDay, { today, from, to });
    }
    const failed = (DATA.report || []).filter(r => !r.ok);
    if (failed.length) {
      html += `<details class="report"><summary>${failed.length} source(s) failed at the last scrape</summary>${failed.map(r => `<div>${esc(r.venue)} — ${esc(r.error)}</div>`).join("")}</details>`;
    }
    list.innerHTML = html;
  }
  function renderMeta() {
    const d = DATA;
    if (!d.generated_at) return;
    const [a, b] = [isoDate(today0()), isoDate(addDays(monday(today0()), 6))];
    const music = d.events.filter(e => e.is_music && e.date >= a);
    const week = music.filter(e => e.date <= b).length;
    const upd = new Date(d.generated_at);
    $("#meta").innerHTML = `<span class="d">${plural(music.length, "concert")} upcoming · </span>${week} this week<span class="d"> · updated ${DAYS[upd.getDay()]} ${String(upd.getHours()).padStart(2, "0")}:${String(upd.getMinutes()).padStart(2, "0")}</span>`;
  }
  function render() {
    renderPills(); renderChips(); renderList(); renderNav(); save();   // the nav reads the month headings: list first
    if (genresOpen) placePanel();
  }

  // ------------------------------------------------------------ search bar (REM-26)
  // One client-side index: the artists (headliner + support of every upcoming concert), the venues, the 19 genres and
  // the styles. Matching is the REM-11 venue rule, accent/case-insensitive: the query is a prefix of the name (0), every
  // typed word is the prefix of some word of the name (1), or a substring anywhere (2); -1 = no match.
  function fuzzy(key, q) {
    if (key.startsWith(q)) return 0;
    const words = key.split(/[^a-z0-9]+/).filter(Boolean), qs = q.split(/[^a-z0-9]+/).filter(Boolean);
    if (qs.length && qs.every(w => words.some(x => x.startsWith(w)))) return 1;
    return key.includes(q) ? 2 : -1;
  }
  function buildIndex() {
    const t = isoDate(today0());
    const up = DATA.events.filter(e => e.is_music && e.date >= t).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "99:99").localeCompare(b.time || "99:99"));
    const artists = new Map(), vc = {}, va = {}, sc = {}, sg = {}, gs = {};
    const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
    up.forEach(e => {
      lineup(e).forEach(name => {
        const k = norm(name).trim(); if (k.length < 2) return;
        let a = artists.get(k); if (!a) artists.set(k, a = { kind: "artist", name: name.trim(), key: k, events: [] });
        a.events.push(e);
      });
      bump(vc, e.venue);
      if (e.area) bump(va[e.venue] = va[e.venue] || {}, e.area);
    });
    // Styles: every label of the whole programme, past concerts included (REM-27: a style with no upcoming date is
    // still findable, its row then says "0 concert à venir"), with its parent genres and the count of upcoming concerts.
    DATA.events.forEach(e => {
      if (!e.is_music) return;
      (e.subgenres || []).forEach(x => {
        sc[x] = (sc[x] || 0) + (e.date >= t ? 1 : 0);
        e.genres.forEach(g => { bump(sg[x] = sg[x] || {}, g); (gs[g] = gs[g] || new Set()).add(x); });
      });
    });
    const top = m => Object.keys(m || {}).sort((a, b) => m[b] - m[a])[0] || "";
    IDX = {
      artists: [...artists.values()],
      venues: DATA.venues.map(v => ({ kind: "venue", name: v, key: norm(v), count: vc[v] || 0, area: top(va[v]) })),
      genres: DATA.tags.map(g => ({ kind: "genre", tag: g, name: TAG_LABELS[g] || g, key: norm(`${TAG_LABELS[g] || g} ${g} ${TAG_ALIASES[g] || ""}`),
        count: up.filter(e => e.genres.includes(g)).length, styles: gs[g] ? gs[g].size : 0 })),
      styles: Object.keys(sc).map(x => ({ kind: "style", name: x, key: norm(x), count: sc[x], genre: top(sg[x]) })),
    };
  }
  // Three groups, Artistes (soonest first) / Salles / Genres & styles, capped at 3 / 3 / 6 rows. An empty query offers the
  // genres with the most concerts in the frame as a way in. Genres and styles are ranked together (a style that starts with
  // the query beats a genre that merely contains it), and the group leads when its best match is closer than the best
  // artist's (REM-27: "bop" is the style "hard bop" before an artist whose name happens to contain the word).
  const TA_MAX = { artists: 3, venues: 3, gs: 6 };
  function suggest(raw) {
    const q = norm(raw).trim().replace(/\s+/g, " ");
    if (!IDX) return { q, groups: [] };
    if (!q) {
      const c = scopeCounts().genre;
      const gs = IDX.genres.filter(g => c[g.tag]).sort((a, b) => c[b.tag] - c[a.tag]).slice(0, TA_MAX.gs);
      return { q, groups: gs.length ? [{ title: "Genres & styles", note: "most played", items: gs }] : [] };
    }
    const rank = (list, tie) => list.map(x => [fuzzy(x.key, q), x]).filter(([sc]) => sc >= 0).sort((a, b) => a[0] - b[0] || tie(a[1], b[1])).map(([, x]) => x);
    const byCount = (a, b) => b.count - a.count;
    const artists = rank(IDX.artists, (a, b) => a.events[0].date.localeCompare(b.events[0].date) || b.events.length - a.events.length);
    const venues = rank(IDX.venues, byCount);
    const gs = rank([...IDX.genres, ...IDX.styles], byCount);
    const best = list => list.length ? fuzzy(list[0].key, q) : Infinity;   // the lists are sorted, their head is their best score
    const groups = [];
    const G = gs.length ? { title: "Genres & styles", note: gs.length > TA_MAX.gs ? `${gs.length}` : "", items: gs.slice(0, TA_MAX.gs) } : null;
    if (G && best(gs) < best(artists)) groups.push(G);
    if (artists.length) groups.push({ title: "Artists", note: artists.length > TA_MAX.artists ? `${artists.length} · the ${TA_MAX.artists} soonest` : "", items: artists.slice(0, TA_MAX.artists) });
    if (venues.length) groups.push({ title: "Venues", note: venues.length > TA_MAX.venues ? `${venues.length}` : "", items: venues.slice(0, TA_MAX.venues) });
    if (G && !groups.includes(G)) groups.push(G);
    return { q, groups };
  }
  const PIN = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';
  function initials(name) {
    const w = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2)).toUpperCase();
  }
  function hue(key) { let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 4 + 1; }
  function taRowHtml(it, i, c) {
    const on = i === taHi;
    let th, sub, type;
    if (it.kind === "artist") {
      const e = it.events[0], d = parseISO(e.date);
      const when = `${DAYS_SHORT[d.getDay()].toLowerCase()} ${d.getDate()}${e.time ? " · " + fmtTime(e.time) : ""}`;
      th = `<span class="th av${hue(it.key)}">${e.image && safeUrl(e.image) ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}${esc(initials(it.name))}</span>`;
      sub = [when, e.venue, e.area].filter(Boolean).join(" · ") + (it.events.length > 1 ? ` · ${it.events.length} dates` : "");
      type = "Artist";
    } else if (it.kind === "venue") {
      th = `<span class="th gl">${PIN}</span>`;
      sub = [isFav(it.name) ? "★ favourite venue" : "", it.area, `${plural(it.count, "concert")} upcoming`].filter(Boolean).join(" · ");
      type = state.venues.includes(it.name) ? "Venue ✓" : "Venue";
    } else if (it.kind === "genre") {
      th = '<span class="th gen">♪</span>';
      sub = `${plural(it.count, "concert")} upcoming · ${plural(it.styles, "style")}`;
      type = state.genres.includes(it.tag) ? "Genre ✓" : "Genre";
    } else {
      th = '<span class="th sty">♪</span>';
      sub = `${it.count ? plural(it.count, "concert") + " upcoming" : "no upcoming concert"}${it.genre ? ` · in ${TAG_LABELS[it.genre] || it.genre}` : ""}`;
      type = state.styles.includes(it.name) ? "Style ✓" : "Style";
    }
    return `<div class="row${on ? " hi" : ""}" role="option" id="ta-${i}" aria-selected="${on}" data-i="${i}">${th}<span><b>${esc(it.name)}</b><small>${esc(sub)}</small></span><span class="type">${type}</span></div>`;
  }
  function renderTa() {
    const ta = $("#ta"), input = $("#search");
    $("#sclear").hidden = !input.value;
    $("#skbd").textContent = document.activeElement === input ? "esc" : MAC ? "⌘K" : "Ctrl K";
    if (!taOpen) {
      if (!ta.hidden && !ta._exit) exitThen(ta, "out", 120, () => { ta.hidden = true; });
      input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
      return;
    }
    cancelExit(ta); ta.hidden = false; input.setAttribute("aria-expanded", "true");
    const { q, groups } = suggest(input.value), c = scopeCounts(), text = input.value.trim();
    taItems = groups.flatMap(g => g.items);
    if (taHi >= taItems.length) taHi = taItems.length - 1;
    let i = 0;
    ta.innerHTML = groups.map(g => `<div class="grp"><h4>${g.title}${g.note ? `<small>${esc(g.note)}</small>` : ""}</h4>${g.items.map(it => taRowHtml(it, i++, c)).join("")}</div>`).join("")
      + (!groups.length && q ? `<div class="none">No artist, venue, genre or style matches “${esc(text)}”.</div>` : "")
      + `<div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> pick</span><span><kbd>esc</kbd> close</span>${q ? `<button type="button" class="free${taHi < 0 ? " hi" : ""}" data-free>↵ on the text: search “${esc(text)}” everywhere</button>` : ""}</div>`;
    const hi = $(".row.hi", ta);
    if (hi) { hi.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", hi.id); } else input.removeAttribute("aria-activedescendant");
  }
  function openTa() {
    if (taOpen) return;
    taOpen = true; taHi = -1;
    if (MOBILE.matches) document.body.classList.add("searching");   // full-screen sheet
    renderTa();
  }
  function closeTa(blur) {
    document.body.classList.remove("searching");
    if (blur && document.activeElement === $("#search")) $("#search").blur();
    if (!taOpen) { renderTa(); return; }
    taOpen = false; taHi = -1; renderTa();
  }
  function focusSearch() {
    if (!detail.hidden) closeDetail();
    closeGenres();
    const i = $("#search"); i.focus(); i.select();
    openTa();
  }
  // Picking: an artist opens its next concert; a venue / genre / style becomes a filter (and a chip); the text itself
  // becomes the full-text filter (“text” chip), which widens the frame to every upcoming week.
  function pick(it) {
    const input = $("#search");
    if (it.kind === "artist") {
      input.value = ""; closeTa(true);
      const e = it.events[0]; openDetail(e, $(`.gig[data-id="${e.id}"]`));
      return;
    }
    if (it.kind === "venue" && !state.venues.includes(it.name)) state.venues = [...state.venues, it.name];
    if (it.kind === "genre" && !state.genres.includes(it.tag)) state.genres = [...state.genres, it.tag];
    if (it.kind === "style" && !state.styles.includes(it.name)) state.styles = [...state.styles, it.name];
    input.value = "";
    if (MOBILE.matches) closeTa(true); else { taOpen = false; taHi = -1; }   // desktop: the bar keeps the focus, the list waits for the next keystroke
    render(); renderTa();
  }
  function pickText(t) { state.q = t; $("#search").value = ""; if (MOBILE.matches) closeTa(true); else { taOpen = false; taHi = -1; } render(); renderTa(); }
  function removeFilter(kind, key) {
    if (kind === "genre") state.genres = state.genres.filter(x => x !== key);
    if (kind === "style") state.styles = state.styles.filter(x => x !== key);
    if (kind === "venue") state.venues = state.venues.filter(x => x !== key);
    if (kind === "q") state.q = "";
    render();
  }
  function clearAll() {
    state = { ...state, genres: [], styles: [], venues: [], q: "", newOnly: false, mine: false, myVenues: false, myArtists: false, near: false };
    stylesOpen = false; $("#gsq").value = ""; $("#search").value = "";
    render(); renderTa();
  }
  // Arrows move the highlight (-1 = back on the text), Enter picks it or searches the text, Escape closes then blurs,
  // Backspace on an empty field drops the last chip.
  function taKeys(ev) {
    const input = $("#search"), n = taItems.length;
    const move = j => { if (!taOpen) { openTa(); return; } taHi = Math.max(-1, Math.min(n - 1, j)); renderTa(); };
    switch (ev.key) {
      case "ArrowDown": move(taHi + 1); break;
      case "ArrowUp": move(taHi - 1); break;
      case "Home": if (taHi < 0) return; move(0); break;
      case "End": if (taHi < 0 && input.value) return; move(n - 1); break;
      case "Enter":
        if (taOpen && taHi >= 0 && taItems[taHi]) pick(taItems[taHi]);
        else if (input.value.trim()) pickText(input.value.trim());
        else return;
        break;
      case "Escape": ev.stopPropagation(); if (taOpen) closeTa(MOBILE.matches); else input.blur(); break;
      case "Backspace":
        if (input.value) return;
        if (state.q) removeFilter("q"); else if (state.venues.length) removeFilter("venue", state.venues.at(-1));
        else if (state.styles.length) removeFilter("style", state.styles.at(-1)); else if (state.genres.length) removeFilter("genre", state.genres.at(-1));
        else return;
        renderTa(); break;
      case "Tab": closeTa(); return;
      default: return;
    }
    ev.preventDefault();
  }
  function openGenres() { if (genresOpen) return; genresOpen = true; closeTa(); renderPills(); placePanel(); }
  function closeGenres(refocus) {
    if (!genresOpen) return;
    genresOpen = false; stylesOpen = false; $("#gsq").value = "";
    renderPills();
    if (refocus) $("#gbtn").focus();
  }

  // ------------------------------------------------------------ Spotify (REM-9) — "Mes artistes"
  // Optional Spotify login, entirely client-side (Authorization Code + PKCE, no secret, client id in web/config.js):
  // the liked songs (`user-library-read`) give a set of artists, the "Mes artistes" pill filters the grid to their
  // concerts. localStorage: "lip-spotify" {access_token, refresh_token, expires_at, name, avatar}, "lip-spotify-artists"
  // {at, names, ids} (read again after a day or on "Actualiser"), "lip-spotify-pkce" {verifier, state} during the redirect.
  const SP_AUTH = "https://accounts.spotify.com", SP_API = "https://api.spotify.com/v1", SP_SCOPE = "user-library-read";
  const SP_TTL = 24 * 3600e3, SP_PAGES = 200;   // library cache lifetime; 200 pages of 50 = 10 000 liked songs at most
  const SP = { tok: spRead("lip-spotify"), lib: spRead("lip-spotify-artists"), keys: new Set(), long: [], ids: new Set(), hits: new Map(), busy: false, error: "", open: false, menu: false };
  const SP_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M6.8 9.4c3.7-1.1 7.6-.7 10.7 1.2M7.4 12.6c3-.9 6.1-.5 8.6 1M8 15.6c2.3-.7 4.6-.4 6.5.8"/></svg>';
  function spRead(k) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : null; } catch { return null; } }
  function spWrite(k, v) { try { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); } catch {} }
  function spClientId() { return String((window.LIP_CONFIG || {}).spotifyClientId || "").trim(); }
  function spLinked() { return !!(SP.tok && SP.tok.refresh_token); }
  // Must equal a redirect URI registered on the Spotify app: http://localhost:8765/ and https://rquilliet.github.io/live-music/.
  function spRedirect() { return location.origin + location.pathname.replace(/index\.html$/, ""); }
  // Artist names as the search index sees them (norm: lower-case, no accents), punctuation collapsed, a leading article
  // dropped: "The Lanskies" / "LANSKIES" / "Zoé Clauzure" / "zoe clauzure" meet.
  function artistKey(name) { return norm(name).trim().replace(/[^a-z0-9]+/g, " ").trim().replace(/^(?:the|les|le|la) /, ""); }
  // Liked-artist names that are also plain words of a bill ("Live", "Trio", "Air"): those match a lineup name only when
  // equal, never inside a longer one (REM-36).
  const SP_STOP = new Set(["live", "trio", "duo", "quartet", "quintet", "band", "club", "jazz", "blues", "night", "party", "session",
    "orchestra", "orchestre", "ensemble", "soir", "concert", "festival", "friends", "guests", "special", "music", "sound", "sounds", "paris", "release"]);
  function spIndex() {
    SP.keys = new Set(((SP.lib || {}).names || []).map(artistKey).filter(Boolean));
    // Keys allowed to match inside a longer lineup name ("kytes en concert cote records" contains "kytes"): five letters or
    // two words at least, and not a plain word. Padded with spaces so only whole words match.
    SP.long = [...SP.keys].filter(k => (k.length >= 5 || k.includes(" ")) && !SP_STOP.has(k)).map(k => ` ${k} `);
    SP.ids = new Set(((SP.lib || {}).ids || []).filter(Boolean));
    SP.hits = new Map();   // event id -> liked keys found in its lineup (memo, reset with the library)
  }
  // The liked artists found in a concert (REM-36): an act matches when its key equals a liked key, or when a liked key
  // appears as whole words inside the act's name — scraped headliners carry "en concert", "(1er soir)", the venue name…
  // A Spotify id resolved by the scraper matches on its own.
  function spHits(e) {
    if (!SP.keys.size && !SP.ids.size) return [];
    let h = SP.hits.get(e.id);
    if (h) return h;
    h = [];
    lineup(e).forEach(n => {
      const k = artistKey(n); if (!k) return;
      if (SP.keys.has(k)) { h.push(k); return; }
      const padded = ` ${k} `;
      SP.long.forEach(x => { if (padded.includes(x)) h.push(x.trim()); });
    });
    Object.values(e.players || {}).forEach(p => { if (p && p.spotify && SP.ids.has(p.spotify.id)) h.push("id:" + p.spotify.id); });
    SP.hits.set(e.id, h);
    return h;
  }
  function spMatch(e) { return spHits(e).length > 0; }
  function spCount() { const t = isoDate(today0()); return DATA.events.filter(e => e.is_music && e.date >= t && spMatch(e)).length; }
  // Liked artists with at least one upcoming concert (the account menu says "12 concerts · 7 of your artists").
  function spArtistCount() {
    const t = isoDate(today0()), s = new Set();
    DATA.events.forEach(e => { if (e.is_music && e.date >= t) spHits(e).forEach(k => s.add(k)); });
    return s.size;
  }
  // ---- PKCE + tokens
  function spRandom(n) {
    const a = crypto.getRandomValues(new Uint8Array(n)), c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(a, b => c[b % c.length]).join("");
  }
  async function spChallenge(verifier) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function spLogin() {
    try {
      const verifier = spRandom(64), st = spRandom(16);
      spWrite("lip-spotify-pkce", { verifier, state: st });
      const q = new URLSearchParams({ client_id: spClientId(), response_type: "code", redirect_uri: spRedirect(), scope: SP_SCOPE,
        code_challenge_method: "S256", code_challenge: await spChallenge(verifier), state: st });
      location.assign(`${SP_AUTH}/authorize?${q}`);
    } catch {   // crypto.subtle needs a secure context (https or localhost)
      SP.error = "Cannot connect: the page must be served over https or on localhost."; renderSpDialog();
    }
  }
  async function spTokenCall(params) {
    const r = await fetch(`${SP_AUTH}/api/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: spClientId(), ...params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw Object.assign(new Error(j.error_description || j.error || `Spotify ${r.status}`), { status: r.status });
    const old = SP.tok || {};
    SP.tok = { ...old, access_token: j.access_token, refresh_token: j.refresh_token || old.refresh_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    spWrite("lip-spotify", SP.tok);
    return SP.tok;
  }
  // A usable access token: the stored one, or a silent refresh when it expires within a minute (Spotify may rotate the
  // refresh token: spTokenCall keeps the new one). A refused refresh unlinks the account.
  async function spAccess(force) {
    if (!spLinked()) throw new Error("Spotify not connected");
    if (!force && SP.tok.access_token && SP.tok.expires_at - Date.now() > 60e3) return SP.tok.access_token;
    try { return (await spTokenCall({ grant_type: "refresh_token", refresh_token: SP.tok.refresh_token })).access_token; }
    catch (err) { if (err.status === 400 || err.status === 401) spDisconnect(); throw err; }
  }
  async function spGet(url, retry = true) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await spAccess()}` } });
    if (r.status === 401 && retry) { await spAccess(true); return spGet(url, false); }
    if (r.status === 401) { spDisconnect(); throw new Error("Spotify session expired"); }
    if (!r.ok) throw new Error(`Spotify ${r.status}`);
    return r.json();
  }
  // ---- library
  async function spLibrary() {
    const names = new Set(), ids = new Set();
    let url = `${SP_API}/me/tracks?limit=50&offset=0`, n = 0;
    while (url && n++ < SP_PAGES) {
      const j = await spGet(url);
      (j.items || []).forEach(it => (((it || {}).track || {}).artists || []).forEach(a => { if (a && a.name) names.add(a.name); if (a && a.id) ids.add(a.id); }));
      url = j.next || null;
    }
    return { at: new Date().toISOString(), names: [...names], ids: [...ids] };
  }
  async function spProfile() {
    const me = await spGet(`${SP_API}/me`);
    SP.tok = { ...SP.tok, name: me.display_name || me.id || "", avatar: safeUrl(((me.images || [])[0] || {}).url) || "" };
    spWrite("lip-spotify", SP.tok);
  }
  // Read the liked artists (profile first, once): nothing happens while the day-old cache is fresh unless `force`.
  async function spSync(force) {
    if (!spLinked() || SP.busy) return;
    const fresh = !!(SP.lib && SP.lib.at && Date.now() - Date.parse(SP.lib.at) < SP_TTL);
    if (fresh && !force && SP.tok.name != null) return;
    SP.busy = true; SP.error = ""; spRender();
    try {
      if (SP.tok.name == null || force) await spProfile();
      if (!fresh || force) { SP.lib = await spLibrary(); spWrite("lip-spotify-artists", SP.lib); spIndex(); }
    } catch (err) { SP.error = spLinked() ? `Spotify unavailable (${err.message}).` : "Spotify session expired: please reconnect."; }
    SP.busy = false; spRender();
  }
  function spDisconnect() {
    SP.tok = null; SP.lib = null; SP.error = ""; SP.menu = false; spIndex();
    ["lip-spotify", "lip-spotify-artists", "lip-spotify-pkce"].forEach(k => spWrite(k, null));
    state.myArtists = false; spRender();
  }
  function spRender() { if (DATA.events.length) render(); else renderPills(); if (SP.open) renderSpDialog(); }
  // Back from Spotify: ?code=…&state=… (or ?error=…). The URL is cleaned at once (the #e= hash survives), the code is
  // exchanged with the stored verifier, the pill turns on and the library is read.
  async function spCallback() {
    const q = new URLSearchParams(location.search);
    const pkce = spRead("lip-spotify-pkce"); spWrite("lip-spotify-pkce", null);
    history.replaceState(null, "", location.pathname + location.hash);
    if (q.get("error") || !q.get("code") || !pkce || pkce.state !== q.get("state")) {
      SP.error = q.get("error") === "access_denied" ? "Spotify connection refused." : `Spotify connection failed (${q.get("error") || "unexpected response"}).`;
      openSp(); return;
    }
    SP.busy = true; spRender();
    try {
      await spTokenCall({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: spRedirect(), code_verifier: pkce.verifier });
      state.myArtists = true; SP.busy = false;
      await spSync(true);
    } catch (err) { SP.busy = false; SP.error = `Spotify connection failed (${err.message}).`; spRender(); openSp(); }
  }
  function spBoot() {
    spIndex();
    if (!spLinked()) state.myArtists = false;
    if (/[?&](code|error)=/.test(location.search)) spCallback(); else if (spLinked()) spSync(false);
  }
  // ---- pill, account menu (under the pill: avatar + name, "N liked artists · updated …", Refresh / Disconnect), connect dialog
  function spAgo(iso) {
    const d = new Date(iso); if (isNaN(d)) return "";
    const min = Math.round((Date.now() - d) / 60e3);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    if (isoDate(d) === isoDate(today0())) return `today at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `on ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  }
  function renderSpPill() {
    const b = $("#myartists"), on = state.myArtists && spLinked();
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    $("small", b).textContent = SP.busy ? "…" : spLinked() && DATA.events.length ? spCount() || "" : "";
    b.title = spLinked() ? "Concerts by the artists of my liked songs on Spotify (right-click or ↓: my account)" : "Connect Spotify to see the concerts of the artists of my liked songs";
    const me = $("#spme");
    me.hidden = !spLinked();
    if (spLinked()) { me.innerHTML = SP.tok.avatar ? `<img src="${esc(SP.tok.avatar)}" alt="">` : "…"; me.setAttribute("aria-expanded", String(SP.menu)); }
    renderSpMenu();
  }
  function spAccountHtml(cls) {
    const n = ((SP.lib || {}).names || []).length, s = n > 1 ? "s" : "";
    const m = SP.lib && DATA.events.length ? spArtistCount() : 0, c = m ? spCount() : 0;
    const sub = SP.busy ? "Reading liked songs…" : SP.lib ? `${n} liked artist${s}${m ? ` · ${plural(c, "concert")} by ${m} of them` : ""} · updated ${spAgo(SP.lib.at)}` : "Liked songs not read yet";
    return `<div class="spwho">${SP.tok.avatar ? `<img src="${esc(SP.tok.avatar)}" alt="">` : `<span class="spav">${SP_ICON}</span>`}<div><b>${esc(SP.tok.name || "Spotify account")}</b><small>${sub}</small></div></div>
      ${SP.error ? `<div class="spnote err">${esc(SP.error)}</div>` : ""}
      <div class="sprow"><button type="button" class="${cls}" role="menuitem" data-sp="sync"${SP.busy ? " disabled" : ""}>Refresh</button><button type="button" class="${cls} sec" role="menuitem" data-sp="out">Disconnect</button></div>`;
  }
  function renderSpMenu() {
    const m = $("#spmenu");
    if (!SP.menu || !spLinked()) { if (!m.hidden && !m._exit) exitThen(m, "out", 120, () => { m.hidden = true; }); return; }
    cancelExit(m); m.hidden = false;
    m.innerHTML = spAccountHtml("mi");
    placeSpMenu();
  }
  function placeSpMenu() {
    const m = $("#spmenu"); if (m.hidden) return;
    const b = $("#myartists").getBoundingClientRect(), r = $("#hrow").getBoundingClientRect();
    m.style.top = `${Math.round(b.bottom - r.top + 8)}px`;
    m.style.left = `${Math.round(Math.max(0, Math.min(b.left - r.left, r.width - m.offsetWidth)))}px`;
  }
  function openSpMenu() { if (SP.menu || !spLinked()) return; SP.menu = true; closeTa(); closeGenres(); renderSpPill(); const f = $("#spmenu button"); if (f) f.focus(); }
  function closeSpMenu(refocus) { if (!SP.menu) return; SP.menu = false; renderSpPill(); if (refocus) $("#myartists").focus(); }
  let spFocusBack = null;
  function openSp() {
    if (SP.open) return;
    SP.open = true; spFocusBack = document.activeElement; closeSpMenu(); closeTa(); closeGenres();
    const d = $("#spdialog"); cancelExit(d); d.hidden = false; renderSpDialog();
    ($("#spbody .spbtn") || $("#spclose")).focus();
  }
  function closeSp() {
    if (!SP.open) return;
    SP.open = false; SP.error = "";
    const d = $("#spdialog"); exitThen(d, "out", 120, () => { d.hidden = true; });
    if (spFocusBack && spFocusBack.focus) spFocusBack.focus();
  }
  function renderSpDialog() {
    const body = $("#spbody");
    if (spLinked()) { body.innerHTML = spAccountHtml("spbtn"); return; }
    body.innerHTML = `<p>Live in Paris only reads your <b>liked songs</b> (<code>user-library-read</code> permission) to find their artists in the programme. Nothing is written to your account; the tokens stay in this browser.</p>`
      + (SP.error ? `<div class="spnote err">${esc(SP.error)}</div>` : "")
      + (spClientId() ? `<button type="button" class="spbtn" data-sp="login">${SP_ICON}Sign in with Spotify</button>`
        : `<div class="spnote">Spotify is not configured (client id missing in <code>web/config.js</code>).</div>`);
  }
  function spAction(ev) {
    const a = ev.target.closest("[data-sp]"); if (!a) return;
    if (a.dataset.sp === "login") spLogin();
    else if (a.dataset.sp === "sync") spSync(true);
    else if (a.dataset.sp === "out") { spDisconnect(); closeSp(); }
  }
  function spMenuKeys(ev) {
    const items = $$("#spmenu button"), i = items.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowRight") items[(i + 1) % items.length].focus();
    else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") items[(i - 1 + items.length) % items.length].focus();
    else if (ev.key === "Tab") { closeSpMenu(); return; }
    else return;
    ev.preventDefault();
  }

  // ------------------------------------------------------------ detail sheet
  const detail = $("#detail"), sheet = $(".sheet", detail), hero = $("#hero");
  let current = null;
  let closing = false;   // exit animation in flight
  let menuOpen = false;  // status menu under the "Interested?" tile (REM-18)
  // Line icons of the action tiles and the status menu (the mockup's symbols): 24px grid, stroke 1.75, currentColor.
  const ICONS = {
    star: '<path d="M12 2.8l2.8 6 6.5.8-4.8 4.5 1.3 6.5L12 17.4l-5.8 3.2 1.3-6.5L2.7 9.6l6.5-.8z"/>',
    check: '<path d="M4 12.5l5.2 5L20 6.5" stroke-width="2.2"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    wa: '<path d="M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3z"/><path d="M9 8.3c0 3.7 3 6.7 6.7 6.7l1-1.7-2.1-1-1 .9a5.2 5.2 0 0 1-2.8-2.8l.9-1-1-2.1z" fill="currentColor" stroke="none"/>',
    ticket: '<path d="M3.5 7.5h17v3.2a1.8 1.8 0 0 0 0 3.6v3.2h-17v-3.2a1.8 1.8 0 0 0 0-3.6z"/><path d="M9.5 7.5v10" stroke-dasharray="2 2.2"/>',
    chevron: '<path d="M6 9.5l6 6 6-6" stroke-width="2"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  };
  const icon = (n, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  // Open: fill, unhide — the CSS animations play (veil fade, sheet slide); .moving keeps a compositor layer on the
  // sheet only while it slides. Deep links and grid clicks take the same path.
  function openDetail(e) {
    cancelExit(detail); closing = false;
    const fresh = detail.hidden;
    fillDetail(e);
    if (fresh && motionOK()) exitThen(sheet, "moving", 320, () => {});
  }
  function fillDetail(e) {
    current = e;
    detail.hidden = false;
    history.replaceState(null, "", location.pathname + "#e=" + e.id);   // drops a ?e= the visitor came in with
    document.body.style.overflow = "hidden";
    sheet.scrollTop = 0; hero.style.transform = ""; menuOpen = false;
    hero.style.backgroundImage = e.image ? `url("${e.image}")` : "";
    const [head, ...sup] = lineup(e);
    const page = safeUrl(e.url), domain = page ? hostOf(page) : "";
    // The title is the link to the event page (REM-13): dotted underline + a small ↗, nothing when the url is unusable.
    const title = page ? `<a href="${esc(page)}" target="_blank" rel="noopener" title="Event page on ${esc(domain)}">${esc(head)}<span class="ext" aria-hidden="true">↗</span></a>` : esc(head);
    $("#hero-text").innerHTML = `<div class="when">${fmtDay(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}</div>
      <h2>${title}</h2>${sup.length ? `<div class="support">with ${esc(sup.join(", "))}</div>` : ""}`;
    const artists = e.headliner ? [head, ...sup] : splitArtists(e.title);
    const price = e.free ? "Free" : shortPrice(e.price);
    const maps = e.lat != null && e.lon != null ? `<a href="https://www.google.com/maps?q=${Number(e.lat)},${Number(e.lon)}" target="_blank" rel="noopener">Directions ↗</a>` : "";
    const line2 = [e.address ? esc(e.address) : "", maps, esc(walk(e))].filter(Boolean).join(" · ");
    const tile = ticketTile(e);
    sheetArtists = artists;
    const i0 = DOCK.e === e ? Math.max(0, artists.indexOf(DOCK.name)) : 0;   // reopened from the dock: start on the act playing
    const meta = [tile.ticket || !price || price === "paid" ? "" : esc(price), subHtml(e, 4)].filter(Boolean).join(" · ");
    $("#detail-body").innerHTML = `
      <div class="actions${tile.html ? "" : " three"}">
        ${tile.html}
        <div class="status" id="status">
          <button id="statusbtn" class="tile" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="statusmenu"></button>
          <div class="statusmenu" id="statusmenu" role="menu" aria-label="My status" hidden></div>
        </div>
        <a class="tile" href="${esc(gcalUrl(e))}" target="_blank" rel="noopener" title="Add to Google Calendar">${icon("cal")}<span class="lbl">Calendar</span></a>
        <a class="tile" href="${esc(whatsappUrl(e))}" target="_blank" rel="noopener" title="Share on WhatsApp">${icon("wa")}<span class="lbl">WhatsApp</span></a>
      </div>
      <div class="venue"><button type="button" class="vname" data-venue="${esc(e.venue)}" title="See the concerts at this venue"><b>${esc(e.venue)}</b></button>${favBtn(e.venue)}${e.area ? " · " + esc(e.area) : ""}${line2 ? `<br><span>${line2}</span>` : ""}</div>
      ${meta ? `<div class="muted meta">${meta}</div>` : ""}
      ${blurbHtml(e)}
      ${artists.length > 1 ? `<div class="listen"><h3>Listen</h3><div class="artist-pick" role="group" aria-label="Artist">${artists.map((a, i) =>
        `<button type="button" class="${i === i0 ? "on" : ""}" aria-pressed="${i === i0}" data-i="${i}">${esc(a)}</button>`).join("")}</div></div>` : ""}
      <div id="artist"></div>`;
    renderStatus();
    // Multi-artist show: the pills switch the player (cross-fade), the active one is filled.
    $$(".artist-pick button", detail).forEach(b => b.onclick = () => {
      if (b.classList.contains("on")) return;
      $$(".artist-pick button", detail).forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      swapArtist(artists[Number(b.dataset.i)], e, artists);
    });
    const more = $(".blurb [data-more]", detail);
    if (more) more.onclick = () => {   // "read more" / "show less" swaps the text in place
      const open = more.textContent !== "read more";
      $(".blurb .txt", detail).textContent = open ? BLURB_CUT(blurb(e)) : blurb(e);
      more.textContent = open ? "read more" : "show less";
    };
    if (artists.length) loadArtist(artists[i0], e, artists);
  }
  // ★ toggle next to the venue name (REM-28): favourite venues feed the "Mes salles" pill.
  function favBtn(venue) {
    const on = isFav(venue);
    return `<button type="button" class="star" data-fav="${esc(venue)}" aria-pressed="${on}" aria-label="${on ? "Remove from favourite venues" : "Add to favourite venues"}" title="${on ? "Favourite venue" : "Add to my venues"}">${on ? "★" : "☆"}</button>`;
  }
  // Tile 1 of the action row (REM-28): only a real ticket link earns it — "Tickets ↗" with the numeric price ("20 €") or
  // "Free" when there is one, never "paid" — plus the Cancelled / Sold out notices. Otherwise there is no tile 1: the
  // row stretches the three others (the title already links to the event page). `ticket` says the price is on the tile.
  function ticketTile(e) {
    const ticket = safeUrl(e.ticket_url);
    const price = e.free ? "Free" : (p => p && p !== "paid" ? p : null)(shortPrice(e.price));
    if (e.cancelled) return { html: '<button class="tile off" type="button" disabled><b>Cancelled</b><small>Tickets</small></button>' };
    if (e.sold_out) return { html: '<button class="tile off" type="button" disabled><b>Sold out</b><small>Tickets</small></button>' };
    if (ticket) return { ticket: true, html: `<a class="tile primary" href="${esc(ticket)}" target="_blank" rel="noopener">${price ? `<b>${esc(price)}</b><small>Tickets ↗</small>` : `${icon("ticket")}<span class="lbl">Tickets ↗</span>`}</a>` };
    return { html: "" };
  }
  // ---- status tile + menu (REM-18): "Interested? ▾" opens a small menu; once set, the tile shows the status and the
  // menu gains "Remove". One menu at a time, closed on outside click / Escape (before the sheet's Escape).
  function renderStatus() {
    const b = $("#statusbtn"), m = $("#statusmenu"); if (!b || !current) return;
    const s = getStatus(current.id);
    b.classList.toggle("on", !!s); b.classList.toggle("going", s === "going");   // gold when interested, lime when going (REM-28)
    b.setAttribute("aria-expanded", String(menuOpen));
    // Rewrite the tile only when its content changes: the click that opens the menu is still bubbling, and replacing
    // the icon/label would detach its target, which the document's outside-click handler would then read as "outside".
    const html = `${icon(s ? STATUS[s].svg : "star")}<span class="lbl">${s ? STATUS[s].label : "Interested?"}${icon("chevron", "chev")}</span>`;
    if (b._html !== html) { b.innerHTML = html; b._html = html; }
    m.innerHTML = Object.entries(STATUS).map(([k, v]) =>
      `<button type="button" role="menuitemradio" aria-checked="${s === k}" data-status="${k}">${icon(v.svg)}${v.label}</button>`).join("") +
      (s ? `<button type="button" role="menuitem" class="rm" data-status="">${icon("x")}Remove</button>` : "");
    if (menuOpen) { cancelExit(m); m.hidden = false; }
    else if (!m.hidden && !m._exit) exitThen(m, "out", 120, () => { m.hidden = true; });
  }
  function openMenu() {
    if (menuOpen || !current) return;
    menuOpen = true; renderStatus();
    ($("#statusmenu [aria-checked=true]") || $("#statusmenu button")).focus();
  }
  function closeMenu(refocus) {
    if (!menuOpen) return;
    menuOpen = false; renderStatus();
    if (refocus) $("#statusbtn").focus();
  }
  function pickStatus(s) {
    setStatus(current.id, s); menuOpen = false;
    renderStatus(); replay($("#statusbtn"), "pop"); $("#statusbtn").focus();
    render();   // grid badge + "Mes concerts" count
  }
  function menuKeys(ev) {
    const items = $$("#statusmenu button"), i = items.indexOf(document.activeElement);
    switch (ev.key) {
      case "ArrowDown": items[(i + 1) % items.length].focus(); break;
      case "ArrowUp": items[(i - 1 + items.length) % items.length].focus(); break;
      case "Home": items[0].focus(); break;
      case "End": items[items.length - 1].focus(); break;
      case "Tab": closeMenu(); return;   // let the focus move on
      default: return;
    }
    ev.preventDefault();
  }
  // What the venue says about the show: the scraped description, else Claude's summary of the event page
  // (see livemusic/summaries.py). Wikipedia is only fetched when both are empty (loadArtist).
  function blurb(e) { return (e.description || e.summary || "").trim(); }
  const BLURB_MAX = 260, BLURB_CUT = t => t.slice(0, 240).replace(/\s+\S*$/, "") + "…";
  // No "source : domain ↗" after the text (REM-28): the title already links to the event page.
  function blurbHtml(e) {
    const text = blurb(e);
    if (!text) return "";
    const long = text.length > BLURB_MAX;
    return `<p class="blurb"><span class="txt">${esc(long ? BLURB_CUT(text) : text)}</span>${long ? ' <button class="link" type="button" data-more>read more</button>' : ""}</p>`;
  }
  // Cross-fade #artist: fade out, swap the content at the mid-point, fade in.
  function swapArtist(name, e, artists) {
    const box = $("#artist");
    if (!motionOK()) { loadArtist(name, e, artists); return; }
    replay(box, "swap");
    setTimeout(() => loadArtist(name, e, artists), 110);
  }
  // Closing reverses the opening motion (veil fades out, sheet slides back); #detail is hidden once it ends. The
  // state (current, hash, body scroll) is reset synchronously, so a second call or a click during the exit is a no-op.
  function closeDetail() {
    if (detail.hidden || closing) return;
    current = null; closing = true; menuOpen = false;
    document.body.style.overflow = ""; history.replaceState(null, "", location.pathname);
    const hide = () => { closing = false; if (current) return; detail.hidden = true; hero.style.transform = ""; };   // unless reopened meanwhile
    if (motionOK()) exitThen(sheet, "moving", 200, () => {});
    exitThen(detail, "closing", 200, hide);
  }
  // Hero parallax: the picture scrolls at a third of the sheet's speed and the body slides over it.
  let heroRaf = 0;
  sheet.addEventListener("scroll", () => {
    if (heroRaf || !motionOK()) return;
    heroRaf = requestAnimationFrame(() => {
      heroRaf = 0;
      const y = Math.min(sheet.scrollTop, hero.offsetHeight);
      hero.style.transform = y > 0 ? `translateY(${Math.round(y * .35)}px)` : "";
    });
  }, { passive: true });

  // "Jaguar Sun • Sean Nicholas Savage • Yes Please!" -> ["Jaguar Sun", "Sean Nicholas Savage", "Yes Please!"]
  function splitArtists(title) {
    let t = title.replace(/\((.*?)\)/g, " ").replace(/\[(.*?)\]/g, " ");
    t = t.replace(/\b(complet|sold ?out|annul[ée]|report[ée]|nouvelle date|guests?|first part|1ère partie|premi[eè]re partie|release party|tour|tourn[ée]e|live)\b/gi, " ");
    const parts = t.split(/\s*(?:•|\+|\/|\||,|&|\bet\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bw\/|\binvite\b|\bwith\b|\s-\s|\s–\s|:)\s*/i)
      .map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length > 1 && !/^\d+$/.test(s));
    return parts.slice(0, 5);
  }

  // Wikipedia (EN then FR) for the blurb, Deezer (JSONP, no key) for picture and similar artists.
  // Player (REM-30): the artist's Spotify page, else its own Bandcamp release, else Deezer's top tracks (`players` is
  // resolved by the scraper per artist name; older events.json files have none and fall back to Deezer). Since REM-10
  // the player lives in the dock at the bottom of the page, not in the sheet. Below the sheet's blurb, "Live": the
  // YouTube live video the scraper found (click-to-play thumbnail, the iframe only exists after the tap), else a link
  // to the YouTube search.
  const BC_EMBED = /^https:\/\/bandcamp\.com\/EmbeddedPlayer\/(album|track)=\d+\//;
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  function playersOf(e, name) {
    const all = (e && e.players) || {};
    const p = all[name] || all[Object.keys(all).find(k => norm(k) === norm(name))] || {};
    const bc = p.bandcamp && safeUrl(p.bandcamp.url) ? p.bandcamp : null;
    const sp = p.spotify && /^[A-Za-z0-9]{8,64}$/.test(p.spotify.id || "") ? p.spotify : null;
    const yt = p.youtube && YT_ID.test(p.youtube.videoId || "") ? p.youtube : null;
    return { bandcamp: bc, bandcampEmbed: bc && BC_EMBED.test(bc.embed || "") ? bc.embed : null, spotify: sp, youtube: yt };
  }
  // ------------------------------------------------------------ player dock (REM-10)
  // The player is a fixed bar at the bottom of the page, never inside the sheet: closing the sheet leaves the music
  // playing. One dock at a time. A sheet docks its act when nothing plays yet (or when the dock already plays this
  // concert: the act pills switch it); while another concert plays, the sheet offers a "Play X" button instead, so
  // reading a concert never cuts the music. ✕ dismisses the dock; its title reopens the concert; ‹ › walk the acts.
  const dock = $("#dock");
  const DOCK = { e: null, name: null, artists: [], key: "" };
  let sheetArtists = [];   // the acts of the open sheet, in pill order
  function dockVia(p, dz) { return p.spotify ? "spotify" : p.bandcampEmbed ? "bandcamp" : dz ? "deezer" : ""; }
  // Compact embeds: Spotify's 80px player, Bandcamp's slim "size=small" bar, Deezer without the track list.
  function dockHtml(p, dz) {
    if (p.spotify) return `<iframe title="Spotify" src="https://open.spotify.com/embed/artist/${encodeURIComponent(p.spotify.id)}?utm_source=generator&theme=0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
    if (p.bandcampEmbed) return `<iframe title="Bandcamp" src="${esc(p.bandcampEmbed.replace(/\/size=\w+\//, "/size=small/").replace(/\/artwork=\w+\//, "/artwork=none/"))}" seamless></iframe>`;
    if (dz) return `<iframe title="Deezer" src="https://widget.deezer.com/widget/light/artist/${Number(dz.id)}/top_tracks?tracklist=false" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" allow="encrypted-media; clipboard-write"></iframe>`;
    return "";
  }
  const VIA = { spotify: "Spotify", bandcamp: "Bandcamp", deezer: "Deezer" };
  function nowLine(via) { return `<div class="nowline">${icon("play")}<span>Playing in the bar at the bottom · via ${VIA[via]}</span></div>`; }
  function dockBtn(name) { return `<button type="button" class="dockbtn" data-dockplay>${icon("play")}Play ${esc(name)}${DOCK.e && DOCK.e !== current ? ` <small>replaces ${esc(DOCK.name)}</small>` : ""}</button>`; }
  function dockPlay(name, e, artists, p, dz) {
    const via = dockVia(p, dz); if (!via) return false;
    const key = `${e.id}|${norm(name)}|${via}`;
    DOCK.e = e; DOCK.name = name; DOCK.artists = artists;
    $("#dname").textContent = name;
    $("#dwhen").textContent = `${e.venue} · ${fmtShort(parseISO(e.date))}${e.time ? " · " + fmtTime(e.time) : ""}`;
    renderDockActs();
    if (DOCK.key !== key) { DOCK.key = key; dock.dataset.src = via; $("#dframe").innerHTML = dockHtml(p, dz); }   // same act again: the iframe, and the music, stay
    dock.hidden = false; document.body.classList.add("docked");
    if (current === e) { const b = $("[data-dockplay]", detail); if (b) b.outerHTML = nowLine(via); }
    return true;
  }
  function renderDockActs() {
    const a = DOCK.artists, i = a.indexOf(DOCK.name);
    $("#dacts").innerHTML = a.length > 1 ? `<button type="button" data-dact="-1" aria-label="Previous act" title="${esc(a[(i - 1 + a.length) % a.length])}">‹</button><small>${i + 1}/${a.length}</small><button type="button" data-dact="1" aria-label="Next act" title="${esc(a[(i + 1) % a.length])}">›</button>` : "";
  }
  async function dockLoad(name, e, artists) {
    const p = playersOf(e, name);
    const dz = p.spotify || p.bandcampEmbed ? null : await deezerArtist(name).catch(() => null);
    dockPlay(name, e, artists, p, dz);
  }
  function dockStep(d) {
    const a = DOCK.artists; if (a.length < 2) return;
    const name = a[(a.indexOf(DOCK.name) + d + a.length) % a.length];
    if (current === DOCK.e) { const b = $$(".artist-pick button", detail).find(x => a[+x.dataset.i] === name); if (b) { b.click(); return; } }   // the sheet shows it: its pill switches both
    dockLoad(name, DOCK.e, a);
  }
  function dockClose() {
    const e = DOCK.e;
    dock.hidden = true; dock.dataset.src = ""; $("#dframe").innerHTML = "";
    DOCK.e = null; DOCK.name = null; DOCK.artists = []; DOCK.key = "";
    document.body.classList.remove("docked");
    if (current && current === e) { const nl = $(".nowline", detail); if (nl) nl.outerHTML = dockBtn(artistShown); }
  }
  // "Live" block: a thumbnail tile (ink play glyph, title + year) that becomes the youtube-nocookie iframe on click;
  // without a resolved video, a link to the YouTube search for "<artist> live".
  const PLAY_GLYPH = '<svg class="play" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M26 20l18 12-18 12z"/></svg>';
  function liveHtml(p, name) {
    const q = encodeURIComponent(name);
    const v = p.youtube;
    if (!v) return `<div class="live"><h3>Live</h3><a class="ytsearch" href="https://www.youtube.com/results?search_query=${q}+live" target="_blank" rel="noopener">Watch live videos on YouTube ↗</a></div>`;
    const year = /^\d{4}/.test(v.publishedAt || "") ? v.publishedAt.slice(0, 4) : "";
    return `<div class="live"><h3>Live</h3>
      <button class="yt" type="button" data-yt="${esc(v.videoId)}" aria-label="Play “${esc(v.title || name)}” on YouTube">
        <img src="https://i.ytimg.com/vi/${esc(v.videoId)}/hqdefault.jpg" alt="" loading="lazy">${PLAY_GLYPH}
        <span class="cap"><span class="t">${esc(v.title || name)}</span>${year ? `<span class="y">${year}</span>` : ""}</span>
      </button>
      <div class="muted via">via YouTube</div></div>`;
  }
  function ytIframe(id) {
    return `<iframe title="YouTube" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  }
  // #artist, below the blurb: [Wikipedia paragraph when the event gave no text] · "Listen to <act>" + the dock line or
  // the "Play" button (with several acts the heading and the pills sit above, in .listen) · "Live" · "In the same
  // vein" (Deezer related, names only) · search links. A thin skeleton line stands in while the lookups run; a stale answer (act or sheet changed
  // meanwhile) is dropped.
  const cache = {};
  let artistShown = null;
  async function loadArtist(name, e, artists = [name]) {
    const box = $("#artist");
    artistShown = name;
    box.innerHTML = '<div class="skel" aria-hidden="true"></div>';
    const key = norm(name) + (blurb(e) ? "|nowiki" : "");   // Wikipedia only as a fallback when the event page gave nothing
    if (!cache[key]) cache[key] = Promise.all([deezerArtist(name).catch(() => null), blurb(e) ? null : wikiSummary(name)]).catch(() => [null, null]);
    const [dz, wiki] = await cache[key];
    const stale = () => current !== e || artistShown !== name;
    if (stale()) return;
    if (dz && dz.picture_xl && !e.image) $("#hero").style.backgroundImage = `url("${dz.picture_xl}")`;
    const q = encodeURIComponent(name);
    const p = playersOf(e, name), via = dockVia(p, dz);
    // The player goes to the dock (REM-10): dock this act when nothing plays or this concert already plays; otherwise
    // offer to take over.
    let player = "";
    if (via && (!DOCK.e || DOCK.e === e)) { dockPlay(name, e, artists, p, dz); player = nowLine(via); }
    else if (via) player = dockBtn(name);
    box.innerHTML = `
      ${wiki ? `<p>${esc(wiki.extract)} <a class="muted" href="${esc(wiki.url)}" target="_blank" rel="noopener">Wikipedia ↗</a></p>` : ""}
      ${player ? `${artists.length > 1 ? "" : `<h3>Listen to ${esc(name)}</h3>`}${player}` : ""}
      ${liveHtml(p, name)}
      <div class="esprit muted" id="esprit"></div>
      <div class="links">
        <a href="${p.bandcamp ? esc(p.bandcamp.url) : `https://bandcamp.com/search?q=${q}`}" target="_blank" rel="noopener">Bandcamp</a>
        <a href="${p.spotify && safeUrl(p.spotify.url) ? esc(p.spotify.url) : `https://open.spotify.com/search/${q}`}" target="_blank" rel="noopener">Spotify</a>
        ${p.youtube ? `<a href="https://www.youtube.com/results?search_query=${q}+live" target="_blank" rel="noopener">YouTube</a>` : ""}
        ${dz && safeUrl(dz.link) ? `<a href="${esc(dz.link)}" target="_blank" rel="noopener">Deezer</a>` : ""}
      </div>`;
    // The tile becomes the player on tap: the iframe is only created now (autoplay), in the same 16:9 box.
    const tile = $(".live .yt", box);
    if (tile) tile.onclick = () => { const id = tile.dataset.yt; if (YT_ID.test(id)) tile.outerHTML = ytIframe(id); };
    if (dz) {
      const rel = (await deezerRelated(dz.id).catch(() => [])).filter(a => a && a.name).slice(0, 6);
      if (rel.length && !stale()) {
        $("#esprit").innerHTML = "In the same vein: " + rel.map(a =>
          safeUrl(a.link) ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)).join(", ");
      }
    }
  }
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = "dz" + Math.random().toString(36).slice(2);
      const s = document.createElement("script");
      const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
      function cleanup() { clearTimeout(t); delete window[cb]; s.remove(); }
      window[cb] = data => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new Error("jsonp")); };
      s.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
      document.head.appendChild(s);
    });
  }
  async function deezerArtist(name) {
    const r = await jsonp(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`);
    const hits = (r && r.data) || [];
    const n = norm(name);
    return hits.find(a => norm(a.name) === n) || (hits[0] && norm(hits[0].name).includes(n.split(" ")[0]) ? hits[0] : null);
  }
  async function deezerRelated(id) {
    const r = await jsonp(`https://api.deezer.com/artist/${id}/related?limit=10`);
    return (r && r.data) || [];
  }
  async function wikiSummary(name) {
    for (const lang of ["en", "fr"]) {
      try {
        const s = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + " musique OR groupe OR musician OR band OR chanteur OR singer OR rappeur OR DJ")}&srlimit=3&format=json&origin=*`).then(r => r.json());
        const hit = (s.query.search || []).find(h => norm(h.title).includes(norm(name).split(" ")[0]));
        if (!hit) continue;
        const p = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`).then(r => r.json());
        if (p.type === "disambiguation" || !p.extract) continue;
        if (!/musi|chant|groupe|band|singer|rapp|DJ|produc|compos|orchest|guitar|pian|jazz|rock|pop|metal|électro|electro|hip.hop|artiste|artist/i.test(p.extract)) continue;
        return { extract: p.extract.length > 420 ? p.extract.slice(0, 400).replace(/\s+\S*$/, "") + "…" : p.extract, url: p.content_urls.desktop.page };
      } catch { /* try next language */ }
    }
    return null;
  }

  // ------------------------------------------------------------ events
  $("#months").onclick = ev => { const b = ev.target.closest("[data-m]"); if (b) jumpMonth(b.dataset.m); };
  addEventListener("scroll", () => { if (spyRaf) return; spyRaf = requestAnimationFrame(() => { spyRaf = 0; spy(); }); }, { passive: true });
  // search bar
  const search = $("#search"), sbar = $("#sbar");
  search.onfocus = () => { openTa(); renderTa(); };
  search.onclick = () => { if (!taOpen) openTa(); };
  search.oninput = () => { taHi = -1; if (taOpen) renderTa(); else openTa(); };
  search.onkeydown = taKeys;
  search.onblur = () => { if (!taOpen) renderTa(); };   // ⌘K hint back
  sbar.addEventListener("focusout", ev => { if (!sbar.contains(ev.relatedTarget) && !MOBILE.matches) closeTa(); });
  $("#srow").onclick = ev => { if (!ev.target.closest("button, input")) search.focus(); };
  $("#sback").onclick = () => { search.value = ""; closeTa(true); };
  $("#sclear").onclick = () => { search.value = ""; taHi = -1; search.focus(); renderTa(); };
  $("#chips").onclick = ev => {
    const x = ev.target.closest("[data-rm]");
    if (x) { closeTa(); removeFilter(x.dataset.rm, x.dataset.key); return; }
    const star = ev.target.closest("[data-fav]");   // ★ on a venue chip (REM-31): toggle, re-render, keep the focus on the new star
    if (star) {
      toggleFav(star.dataset.fav); render();
      const s = $$("#chips [data-fav]").find(b => b.dataset.fav === star.dataset.fav);
      if (s) { replay(s, "pop"); s.focus(); }
      return;
    }
    if (ev.target.closest("#clearall")) { closeTa(); clearAll(); }
  };
  $("#ta").addEventListener("mousedown", ev => ev.preventDefault());   // keep the focus in the bar
  $("#ta").onclick = ev => {
    if (ev.target.closest("[data-free]")) { pickText(search.value.trim()); return; }
    const row = ev.target.closest(".row[data-i]"); if (row) pick(taItems[+row.dataset.i]);
  };
  $("#ta").onmousemove = ev => { const row = ev.target.closest(".row[data-i]"); if (row && +row.dataset.i !== taHi) { taHi = +row.dataset.i; renderTa(); } };
  $("#ta").addEventListener("error", ev => { if (ev.target.tagName === "IMG") ev.target.remove(); }, true);   // broken picture -> initials
  // pills + Genres panel
  $("#gbtn").onclick = () => genresOpen ? closeGenres() : openGenres();
  $("#gbtn").onkeydown = ev => { if (ev.key === "ArrowDown" && !genresOpen) { ev.preventDefault(); openGenres(); const g = $("#glist .g"); if (g) g.focus(); } };
  $("#gpanel").onclick = ev => {
    if (ev.target.closest("#gclear")) { state.genres = []; state.styles = []; render(); return; }
    if (ev.target.closest("[data-more]")) { stylesOpen = !stylesOpen; renderGenrePanel(); return; }
    const g = ev.target.closest("[data-g]"); if (g) { toggleGenre(g.dataset.g); return; }
    const x = ev.target.closest("[data-s]"); if (x) toggleStyle(x.dataset.s);
  };
  $("#gsq").oninput = () => renderGenrePanel();
  $("#newonly").onclick = () => { state.newOnly = !state.newOnly; render(); };
  $("#mine").onclick = () => { state.mine = !state.mine; render(); };
  $("#myvenues").onclick = () => { state.myVenues = !state.myVenues; render(); };
  // Mes artistes (REM-9): one tap toggles the filter once Spotify is linked, else opens the connect dialog; the account
  // menu sits behind the avatar button, a right-click or ↓ on the pill.
  $("#myartists").onclick = () => { if (!spLinked()) { openSp(); return; } state.myArtists = !state.myArtists; render(); };
  $("#myartists").oncontextmenu = ev => { if (spLinked()) { ev.preventDefault(); SP.menu ? closeSpMenu() : openSpMenu(); } };
  $("#myartists").onkeydown = ev => { if (ev.key === "ArrowDown" && spLinked() && !SP.menu) { ev.preventDefault(); openSpMenu(); } };
  $("#spme").onclick = () => SP.menu ? closeSpMenu() : openSpMenu();
  $("#spmenu").onclick = spAction; $("#spmenu").onkeydown = spMenuKeys;
  $("#spdialog").onclick = ev => { if (ev.target.id === "spdialog" || ev.target.closest("#spclose")) closeSp(); else spAction(ev); };
  document.addEventListener("error", ev => {   // unreachable avatar -> "…" on the button, the glyph in the menu / dialog
    const img = ev.target; if (!(img.tagName === "IMG" && img.closest("#spme, .spwho"))) return;
    if (img.parentElement.id === "spme") img.parentElement.textContent = "…"; else img.outerHTML = `<span class="spav">${SP_ICON}</span>`;
  }, true);
  $("#radius").onchange = ev => { state.radius = ev.target.value; render(); };
  $("#near").onclick = () => {
    if (state.near) { state.near = false; render(); return; }
    if (!navigator.geolocation) { alert("Geolocation unavailable"); return; }
    $("#near span").textContent = "…";
    navigator.geolocation.getCurrentPosition(pos => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.near = true; render();
    }, () => { render(); alert("Location denied"); }, { timeout: 10000 });
  };
  // Outside clicks close the popovers. composedPath() rather than closest(): a click on a pill re-renders it, so by the
  // time the event reaches the document the target may be detached and closest() would see it as "outside".
  document.addEventListener("click", ev => {
    const within = (...ids) => ev.composedPath().some(el => el && el.id && ids.includes(el.id));
    if (taOpen && !within("sbar")) closeTa();
    if (genresOpen && !within("gbtn", "gpanel")) closeGenres();
    if (menuOpen && !within("status")) closeMenu();
    if (SP.menu && !within("myartists", "spme", "spmenu")) closeSpMenu();
  });
  addEventListener("resize", () => { if (genresOpen) placePanel(); if (SP.menu) placeSpMenu(); });
  MOBILE.addEventListener("change", () => { if (!MOBILE.matches) document.body.classList.remove("searching"); else if (taOpen) closeTa(true); render(); });   // short / long week labels
  $("#list").onclick = ev => {
    const sub = ev.target.closest(".tag.sub");
    if (sub) { toggleStyle(sub.dataset.sub); return; }
    const row = ev.target.closest(".gig"); if (!row) return;
    const e = DATA.events.find(x => x.id === row.dataset.id); if (e) openDetail(e);
  };
  $("#close").onclick = closeDetail;
  // player dock (REM-10)
  $("#dinfo").onclick = () => { if (DOCK.e) openDetail(DOCK.e); };
  $("#dclose").onclick = dockClose;
  $("#dacts").onclick = ev => { const b = ev.target.closest("[data-dact]"); if (b) dockStep(+b.dataset.dact); };
  detail.onclick = ev => { if (ev.target === detail) closeDetail(); };
  detail.addEventListener("click", ev => {
    const sub = ev.target.closest(".tag.sub"); if (sub) { closeDetail(); toggleStyle(sub.dataset.sub); return; }
    // The venue name filters the grid on that venue (a chip in the bar, like picking it in the typeahead); ★ toggles the favourite.
    const vn = ev.target.closest("[data-venue]");
    if (vn) { const v = vn.dataset.venue; closeDetail(); if (!state.venues.includes(v)) state.venues = [...state.venues, v]; render(); return; }
    const star = ev.target.closest("[data-fav]");
    if (star) { toggleFav(star.dataset.fav); star.outerHTML = favBtn(star.dataset.fav); replay($(".venue .star", detail), "pop"); render(); return; }
    if (ev.target.closest("[data-dockplay]")) { if (current) dockLoad(artistShown, current, sheetArtists); return; }   // take the dock over (REM-10)
    if (ev.target.closest("#statusbtn")) { menuOpen ? closeMenu() : openMenu(); return; }
    const item = ev.target.closest("#statusmenu [data-status]"); if (item) pickStatus(item.dataset.status);
  });
  detail.addEventListener("keydown", ev => {
    if (ev.target.closest("#statusmenu")) { menuKeys(ev); return; }
    if (ev.target.closest("#statusbtn") && ev.key === "ArrowDown" && !menuOpen) { ev.preventDefault(); openMenu(); }
  });
  // ⌘K / Ctrl+K / "/" focus the bar; Escape closes whatever is open (typeahead, panel, status menu, sheet).
  document.addEventListener("keydown", ev => {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") { ev.preventDefault(); focusSearch(); return; }
    if (ev.key === "/" && !inField && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); focusSearch(); return; }
    if (ev.key === "Escape" && SP.open) { closeSp(); return; }
    if (ev.key === "Escape" && SP.menu) { closeSpMenu(true); return; }
    if (ev.key === "Escape" && taOpen) { closeTa(true); return; }
    if (ev.key === "Escape" && genresOpen) { closeGenres(true); return; }
    if (ev.key === "Escape" && menuOpen) { closeMenu(true); return; }
    if (ev.key === "Escape" && !detail.hidden) closeDetail();
  });

  // ------------------------------------------------------------ boot
  spBoot();   // Spotify (REM-9): sanitise the pill, handle the ?code= callback, read the liked artists when the cache is stale
  fetch("events.json?" + Date.now()).then(r => r.json()).catch(() => {
    $("#list").innerHTML = '<div class="empty">events.json not found — run <code>python scrape.py</code> then <code>python serve.py</code>.</div>';
    return null;
  }).then(d => {
    if (!d) return;
    DATA = d;
    state.near = false; // ask for the position again on each visit
    buildIndex(); renderMeta(); render(); renderTa();
    // Shareable link straight to a concert: ?e=<id> (what we hand out since REM-29) or the older #e=<id>.
    const m = /[?&]e=([a-f0-9]+)/.exec(location.search) || /^#e=([a-f0-9]+)/.exec(location.hash);
    const linked = m && d.events.find(x => x.id === m[1]);
    if (linked) openDetail(linked);
  });
})();
