/* Live in Paris — week planner (direction A "Programme"), one search bar + Genres panel (REM-26, direction A "Barre unique"),
   concert detail sheet. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const TAG_LABELS = {
    rock: "Rock", indie: "Indie", pop: "Pop", metal: "Metal", punk: "Punk", electro: "Electro",
    "hip-hop": "Hip-hop", "soul-rnb": "Soul / R&B", funk: "Funk", jazz: "Jazz", blues: "Blues",
    folk: "Folk", chanson: "Chanson", world: "World", latin: "Latin", afro: "Afro", reggae: "Reggae",
    classical: "Classique", experimental: "Expérimental",
  };
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const DAYS_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const WALK_KMH = 4.5;
  // Extra words the search bar accepts for the coarse genres ("rap" -> Hip-hop, "techno" -> Electro, "classical" -> Classique).
  const TAG_ALIASES = { "hip-hop": "rap hip hop", "soul-rnb": "soul rnb r&b", electro: "électronique techno house", classical: "classical",
    experimental: "experimental noise", world: "musiques du monde", chanson: "chanson française variété", latin: "latino", afro: "afrobeat" };

  let DATA = { events: [], tags: [], venues: [] };
  let state = load({ week: 0, genres: [], styles: [], venues: [], q: "", near: false, radius: 5, newOnly: false, mine: false });
  const STATUS = { interested: { icon: "☆", label: "Intéressé" }, going: { icon: "✓", label: "J'y vais" } };
  let status = loadStatus(); // {eventId: "interested" | "going"} — REM-18 "Intéressé ? / J'y vais"
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
  // Everything animates in CSS; JS only sequences it. Reduced motion: CSS keeps 120ms fades, JS skips the
  // View Transitions morph and the parallax.
  const MOTION = matchMedia("(prefers-reduced-motion: reduce)");
  const motionOK = () => !MOTION.matches;
  const canVT = () => motionOK() && typeof document.startViewTransition === "function";
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
    s.week = 0;   // always land on the current week; the offset is only kept while browsing
    const strings = a => (Array.isArray(a) ? a : []).filter(v => typeof v === "string" && v);
    s.genres = strings(s.genres); s.styles = strings(s.styles); s.venues = strings(s.venues);
    if (typeof s.venue === "string" && s.venue && !s.venues.length) s.venues = [s.venue];   // single-venue dropdown from the previous UI
    s.q = typeof s.q === "string" ? s.q.trim() : "";
    s.newOnly = s.newOnly === true; s.mine = s.mine === true; s.near = s.near === true;
    if (![2, 5, 10, 25, 1000].includes(Number(s.radius))) s.radius = 5;
    ["tab", "free", "others", "saved", "venue"].forEach(k => delete s[k]);
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
    return !m[2] || m[2] === "00" ? `${+m[1]}h` : `${+m[1]}h${m[2]}`;
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

  // The time frame is the current week (+ the ‹ › offset) — unless Nouveautés, Mes concerts or a free-text search is on:
  // then it is every upcoming week, stacked (4 saved concerts over three months would be useless in a 7-day window;
  // one searches for an artist, not a week). A genre / style / venue pick keeps the week: that is browsing.
  function frame() { return state.newOnly || state.mine || state.q ? "all" : "week"; }
  function range() {
    const today = today0();
    if (frame() === "all") return [isoDate(today), "9999-12-31"];
    const wk = addDays(monday(today), 7 * state.week);
    return [isoDate(state.week ? wk : today), isoDate(addDays(wk, 6))];
  }
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
  // "De 6 à 9 euros." -> "6–9 €", "Tarif plein : 10 EUR" -> "10 €", "payant" -> "payant", nothing usable -> null.
  // Only amounts followed by a currency word count (or the low end of "6 à 9 euros"): dates, ages and "1 consommation" do not.
  const AMOUNT = /\d+(?:[.,]\d+)?(?=\s*(?:€|euros?\b|eur\b)|\s*(?:à|-|–|\/)\s*\d+(?:[.,]\d+)?\s*(?:€|euros?\b|eur\b))/gi;
  function shortPrice(p) {
    if (!p) return null;
    const nums = (p.match(AMOUNT) || []).map(x => parseFloat(x.replace(",", "."))).filter(n => n > 0 && n < 1000);
    if (!nums.length) return /payant/i.test(p) ? "payant" : null;
    const f = n => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return lo === hi ? `${f(lo)} €` : `${f(lo)}–${f(hi)} €`;
  }
  function walk(e) {
    if (!(state.near && me && e.lat != null)) return "";
    const d = km(me, e), min = Math.round(d / WALK_KMH * 60);
    return min <= 90 ? `${min} min à pied` : `${d.toFixed(d < 10 ? 1 : 0)} km`;
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
    const details = [e.price, link, shareLink(e)].filter(Boolean).join("\n");
    const q = {
      action: "TEMPLATE",
      text: `${head}${sup.length ? " avec " + sup.join(", ") : ""} @ ${e.venue}`,
      dates, details,
      location: [e.venue, e.address || e.area].filter(Boolean).join(", "),
      ctz: "Europe/Paris",
    };
    return "https://calendar.google.com/calendar/render?" + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }
  // "WhatsApp" link: short French message, one line per fact, links last so the app previews them.
  function whatsappUrl(e) {
    const [head, ...sup] = lineup(e);
    const link = safeUrl(e.ticket_url) || safeUrl(e.url);
    const lines = [
      `🎵 ${head}${sup.length ? " avec " + sup.join(", ") : ""}`,
      `📅 ${fmtDay(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}`,
      `📍 ${e.venue}${e.area ? " (" + e.area + ")" : ""}`,
      link, shareLink(e),
    ].filter(Boolean);
    return "https://wa.me/?text=" + encodeURIComponent(lines.join("\n"));
  }
  function shareLink(e) { return location.origin + location.pathname + "#e=" + e.id; }

  // ------------------------------------------------------------ filtering
  function baseFilter(e) {
    if (!e.is_music) return false;   // expos, ateliers, conférences… are never shown
    if (state.newOnly && !isNew(e)) return false;
    if (state.mine && !status[e.id]) return false;
    if (state.venues.length && !state.venues.includes(e.venue)) return false;
    if (state.genres.length && !e.genres.some(g => state.genres.includes(g))) return false;
    if (state.styles.length && !(e.subgenres || []).some(s => state.styles.includes(s))) return false;
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
      if (!e.is_music || !inFrame(e, r) || (state.newOnly && !isNew(e)) || (state.mine && !status[e.id])) return;
      c.n++;
      e.genres.forEach(g => c.genre[g] = (c.genre[g] || 0) + 1);
      (e.subgenres || []).forEach(x => c.style[x] = (c.style[x] || 0) + 1);
      c.venue[e.venue] = (c.venue[e.venue] || 0) + 1;
    });
    return c;
  }

  // ------------------------------------------------------------ rendering
  function renderNav() {
    const all = frame() === "all";
    $("#weeklabel").textContent = all ? "Tout ce qui vient" : weekLabel(addDays(monday(today0()), 7 * state.week), MOBILE.matches);
    $("#weekcount").textContent = plural(visible().length, "concert");
    $("#arrows").hidden = all;
    $("#prev").disabled = state.week === 0;
    $("#thisweek").hidden = all || state.week === 0;
  }
  // The pills: Genres ▾ (badge = active genres + styles), Nouveautés, Mes concerts, Près de moi (+ radius once active).
  function renderPills() {
    const t = isoDate(today0());
    const nNew = DATA.events.filter(e => e.is_music && e.date >= t && isNew(e)).length, nG = state.genres.length + state.styles.length;
    const set = (id, on, n) => { const b = $(id); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); $("small", b).textContent = n || ""; };
    set("#newonly", state.newOnly, nNew); set("#mine", state.mine, statusCount());
    const g = $("#gbtn");
    g.classList.toggle("on", nG > 0); g.setAttribute("aria-expanded", String(genresOpen));
    $("small", g).textContent = nG || ""; $(".car", g).textContent = genresOpen ? "▴" : "▾";
    const near = $("#near");
    near.classList.toggle("on", state.near); near.setAttribute("aria-pressed", String(state.near)); $("span", near).textContent = "Près de moi";
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
      if (!e.is_music || !inFrame(e, r) || (state.newOnly && !isNew(e)) || (state.mine && !status[e.id])) return;
      if (picked.length && !e.genres.some(g => picked.includes(g))) return;
      (e.subgenres || []).forEach(x => counts[x] = (counts[x] || 0) + 1);
    });
    state.styles.forEach(x => counts[x] = counts[x] || 0);   // an active style stays visible even when the frame has none left
    const all = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "fr"));
    const q = norm($("#gsq").value.trim());
    let shown, rest = 0;
    if (q) shown = all.filter(x => fuzzy(norm(x), q) >= 0);
    else {
      const head = new Set([...all.slice(0, STYLES_SHOWN), ...state.styles]);
      shown = stylesOpen ? all : all.filter(x => head.has(x)); rest = all.length - shown.length;
    }
    $("#gstitle").textContent = picked.length ? `Styles de ${picked.map(g => TAG_LABELS[g] || g).join(", ")}` : "Styles";
    $("#gsq").placeholder = `Filtrer les ${all.length} styles…`;
    const chip = x => `<button type="button" class="g${state.styles.includes(x) ? " on" : ""}" data-s="${esc(x)}" aria-pressed="${state.styles.includes(x)}">${esc(x)}<small>${counts[x]}</small></button>`;
    let more = "";
    if (rest > 0) more = `<button type="button" class="link" data-more>+ ${rest} autres</button>`;
    else if (!q && stylesOpen && all.length > STYLES_SHOWN) more = '<button type="button" class="link" data-more>réduire</button>';
    $("#slist").innerHTML = shown.length ? shown.map(chip).join("") + more
      : `<span class="none">${all.length ? "Aucun style ne correspond." : "aucun style connu"}</span>`;
  }
  // Puts the panel under the "Genres ▾" pill, pulled left when it would overflow the row (the phone stretches it in CSS).
  function placePanel() {
    const p = $("#gpanel"); if (p.hidden) return;
    const b = $("#gbtn").getBoundingClientRect(), r = $("#hrow").getBoundingClientRect();
    p.style.top = `${Math.round(b.bottom - r.top + 8)}px`;
    p.style.left = `${Math.round(Math.max(0, Math.min(b.left - r.left, r.width - p.offsetWidth)))}px`;
  }
  // The active filters as chips inside the bar (lime, name + count + ×), "Tout effacer" after them.
  let chipCount = 0;
  function renderChips() {
    const c = scopeCounts();
    const chip = (kind, key, label, n) => `<span class="chipin"><span>${esc(label)}</span>${n == null ? "" : `<small>${n}</small>`}<button type="button" class="x" data-rm="${kind}" data-key="${esc(key)}" aria-label="Retirer ${esc(label)}">✕</button></span>`;
    const chips = [
      ...state.genres.map(g => chip("genre", g, TAG_LABELS[g] || g, c.genre[g] || 0)),
      ...state.styles.map(x => chip("style", x, x, c.style[x] || 0)),
      ...state.venues.map(v => chip("venue", v, v, c.venue[v] || 0)),
      ...(state.q ? [chip("q", state.q, `« ${state.q} »`, null)] : []),
    ];
    $("#chips").innerHTML = chips.join("") + (chips.length ? '<button type="button" class="link" id="clearall">Tout effacer</button>' : "");
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
    return subs.slice(0, max).map(s => `<button class="tag sub ${state.styles.includes(s) ? "on" : ""}" type="button" data-sub="${esc(s)}" title="${state.styles.includes(s) ? "Retirer le style" : "Filtrer sur"} « ${esc(s)} »">${esc(s)}</button>`).join("");
  }
  function statusTags(e) {
    const b = [];
    if (isNew(e)) b.push('<span class="tag new">Nouveau</span>');
    if (e.sold_out) b.push('<span class="tag sold">Complet</span>');
    if (e.cancelled) b.push('<span class="tag cancel">Annulé</span>');
    const s = getStatus(e.id);
    if (s) b.push(`<span class="tag status ${s}" title="${STATUS[s].label}" aria-label="${STATUS[s].label}">${STATUS[s].icon}</span>`);
    return b.join("");
  }
  function gigHtml(e) {
    const [head, ...sup] = lineup(e);
    const genre = e.genres.find(g => state.genres.includes(g)) || e.genres[0];
    const price = e.free ? '<span class="tag free">Gratuit</span>' : (p => p ? `<span class="tag">${esc(p)}</span>` : "")(shortPrice(e.price));
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
      const note = past ? "passé" : out ? "" : evs.length ? plural(evs.length, "concert") : "—";
      h += `<div class="${cls}"><h2>${DAYS_SHORT[d.getDay()]} ${d.getDate()}<em>${note}</em></h2>`;
      if (evs.length) h += evs.map(gigHtml).join("");
      else if (!past && !out) h += `<div class="empty">Rien d'annoncé.${o.nav ? ' <button class="link" data-next>Voir la semaine suivante ›</button>' : ""}</div>`;
      h += "</div>";
    }
    return h + "</div>";
  }
  // The week grid is the only view: one week (‹ › browse it), or every upcoming week stacked when the frame is widened.
  function renderList() {
    let evs = visible();
    const byTime = (a, b) => (a.time || "99:99").localeCompare(b.time || "99:99");
    evs = evs.slice().sort((a, b) => a.date.localeCompare(b.date) || (state.near && me ? km(me, a) - km(me, b) : byTime(a, b)));
    const list = $("#list");
    if (!DATA.events.length) {
      list.innerHTML = '<div class="empty">Aucun événement. Lance <code>python scrape.py</code> pour remplir le programme.</div>';
      return;
    }
    const byDay = {};
    evs.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
    const today = isoDate(today0());
    const [from, to] = range();
    let html = "";
    if (frame() === "week") {
      html += weekGrid(addDays(monday(today0()), 7 * state.week), byDay, { today, from, to, nav: true });
    } else {
      const mondays = [...new Set(evs.map(e => isoDate(monday(parseISO(e.date)))))].sort();
      if (!mondays.length) html += '<div class="empty">Rien pour ces filtres.</div>';
      for (const m of mondays) {
        const mon = parseISO(m), n = evs.filter(e => isoDate(monday(parseISO(e.date))) === m).length;
        html += `<h3 class="weekhead">${weekLabel(mon)}<em>${plural(n, "concert")}</em></h3>` + weekGrid(mon, byDay, { today, from, to, nav: false });
      }
    }
    const failed = (DATA.report || []).filter(r => !r.ok);
    if (failed.length) {
      html += `<details class="report"><summary>${failed.length} source(s) en erreur au dernier scraping</summary>${failed.map(r => `<div>${esc(r.venue)} — ${esc(r.error)}</div>`).join("")}</details>`;
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
    $("#meta").innerHTML = `<span class="d">${plural(music.length, "concert")} à venir · </span>${week} cette semaine<span class="d"> · mis à jour ${DAYS[upd.getDay()]} ${String(upd.getHours()).padStart(2, "0")}:${String(upd.getMinutes()).padStart(2, "0")}</span>`;
  }
  let lastFrame = null;
  function render() {
    const f = frame();
    renderNav(); renderPills(); renderChips(); renderList(); save();
    if (genresOpen) placePanel();
    if (lastFrame && f !== lastFrame) replay($("#list"), "swap");
    lastFrame = f;
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
      (e.subgenres || []).forEach(x => {
        bump(sc, x);
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
  // genres with the most concerts in the frame as a way in.
  const TA_MAX = { artists: 3, venues: 3, gs: 6 };
  function suggest(raw) {
    const q = norm(raw).trim().replace(/\s+/g, " ");
    if (!IDX) return { q, groups: [] };
    if (!q) {
      const c = scopeCounts().genre;
      const gs = IDX.genres.filter(g => c[g.tag]).sort((a, b) => c[b.tag] - c[a.tag]).slice(0, TA_MAX.gs);
      return { q, groups: gs.length ? [{ title: "Genres & styles", note: frame() === "week" ? "les plus joués cette semaine" : "les plus joués", items: gs }] : [] };
    }
    const rank = (list, tie) => list.map(x => [fuzzy(x.key, q), x]).filter(([sc]) => sc >= 0).sort((a, b) => a[0] - b[0] || tie(a[1], b[1])).map(([, x]) => x);
    const byCount = (a, b) => b.count - a.count;
    const artists = rank(IDX.artists, (a, b) => a.events[0].date.localeCompare(b.events[0].date) || b.events.length - a.events.length);
    const venues = rank(IDX.venues, byCount);
    const gs = [...rank(IDX.genres, byCount), ...rank(IDX.styles, byCount)];
    const groups = [];
    if (artists.length) groups.push({ title: "Artistes", note: artists.length > TA_MAX.artists ? `${artists.length} · les ${TA_MAX.artists} plus proches` : "", items: artists.slice(0, TA_MAX.artists) });
    if (venues.length) groups.push({ title: "Salles", note: venues.length > TA_MAX.venues ? `${venues.length}` : "", items: venues.slice(0, TA_MAX.venues) });
    if (gs.length) groups.push({ title: "Genres & styles", note: gs.length > TA_MAX.gs ? `${gs.length}` : "", items: gs.slice(0, TA_MAX.gs) });
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
      type = "Artiste";
    } else if (it.kind === "venue") {
      th = `<span class="th gl">${PIN}</span>`;
      sub = [it.area, `${plural(it.count, "concert")} à venir`].filter(Boolean).join(" · ");
      type = state.venues.includes(it.name) ? "Salle ✓" : "Salle";
    } else if (it.kind === "genre") {
      th = '<span class="th gen">♪</span>';
      sub = `${plural(it.count, "concert")} à venir` + (frame() === "week" && c.genre[it.tag] ? ` · ${c.genre[it.tag]} cette semaine` : "") + ` · ${plural(it.styles, "style")}`;
      type = state.genres.includes(it.tag) ? "Genre ✓" : "Genre";
    } else {
      th = '<span class="th sty">♪</span>';
      sub = `${plural(it.count, "concert")} à venir${it.genre ? ` · dans ${TAG_LABELS[it.genre] || it.genre}` : ""}`;
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
      + (!groups.length && q ? `<div class="none">Aucun artiste, salle, genre ou style ne correspond à « ${esc(text)} ».</div>` : "")
      + `<div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span><span><kbd>↵</kbd> choisir</span><span><kbd>esc</kbd> fermer</span>${q ? `<button type="button" class="free${taHi < 0 ? " hi" : ""}" data-free>↵ sur le texte : rechercher « ${esc(text)} » partout</button>` : ""}</div>`;
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
  // becomes the full-text filter (« texte » chip), which widens the frame to every upcoming week.
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
    state = { ...state, genres: [], styles: [], venues: [], q: "", newOnly: false, mine: false, near: false };
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

  // ------------------------------------------------------------ detail sheet
  const detail = $("#detail"), sheet = $(".sheet", detail), hero = $("#hero");
  let current = null;
  let closing = false;   // exit animation (or the closing view transition) in flight
  let menuOpen = false;  // status menu under the "Intéressé ?" tile (REM-18)
  // `row` is the .gig the user clicked: with the View Transitions API its time morphs into the hero date while the
  // sheet springs in; otherwise (no API, reduced motion, deep link) the CSS animations on .detail/.sheet play.
  function openDetail(e, row) {
    cancelExit(detail); closing = false;
    const t = row && canVT() && detail.hidden ? $("time", row) : null;
    detail.classList.toggle("vt", !!t);
    if (!t) { fillDetail(e); return; }
    t.style.viewTransitionName = "gig-date";   // old state: the row's time; new state: the hero date (names must not coexist)
    const vt = document.startViewTransition(() => { t.style.viewTransitionName = ""; fillDetail(e); $(".hero-text .when").style.viewTransitionName = "gig-date"; });
    const done = () => { const w = $(".hero-text .when"); if (w) w.style.viewTransitionName = ""; };
    vt.finished.then(done, done);   // finished rejects when the transition is skipped
  }
  function fillDetail(e) {
    current = e;
    detail.hidden = false;
    history.replaceState(null, "", "#e=" + e.id);
    document.body.style.overflow = "hidden";
    const list = $("#list");   // recede around the middle of the viewport, so a long page doesn't slide
    list.style.transformOrigin = `50% ${Math.round(scrollY - list.offsetTop + innerHeight / 2)}px`;
    list.classList.add("receded");
    sheet.scrollTop = 0; hero.style.transform = ""; menuOpen = false;
    hero.style.backgroundImage = e.image ? `url("${e.image}")` : "";
    const [head, ...sup] = lineup(e);
    const page = safeUrl(e.url), domain = page ? hostOf(page) : "";
    // The title is the link to the event page (REM-13): dotted underline + a small ↗, nothing when the url is unusable.
    const title = page ? `<a href="${esc(page)}" target="_blank" rel="noopener" title="Page de l'événement sur ${esc(domain)}">${esc(head)}<span class="ext" aria-hidden="true">↗</span></a>` : esc(head);
    $("#hero-text").innerHTML = `<div class="when">${fmtDay(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}</div>
      <h2>${title}</h2>${sup.length ? `<div class="support">avec ${esc(sup.join(", "))}</div>` : ""}`;
    const artists = e.headliner ? [head, ...sup] : splitArtists(e.title);
    const price = e.free ? "Gratuit" : shortPrice(e.price);
    const maps = e.lat != null && e.lon != null ? `<a href="https://www.google.com/maps?q=${Number(e.lat)},${Number(e.lon)}" target="_blank" rel="noopener">Itinéraire ↗</a>` : "";
    const line2 = [e.address ? esc(e.address) : "", maps, esc(walk(e))].filter(Boolean).join(" · ");
    const meta = [ticketTile(e).ticket ? "" : price ? esc(price) : "", subHtml(e, 4)].filter(Boolean).join(" · ");
    $("#detail-body").innerHTML = `
      <div class="actions">
        ${ticketTile(e).html}
        <div class="status" id="status">
          <button id="statusbtn" class="tile" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="statusmenu"></button>
          <div class="statusmenu" id="statusmenu" role="menu" aria-label="Mon statut" hidden></div>
        </div>
        <a class="tile" href="${esc(gcalUrl(e))}" target="_blank" rel="noopener" title="Ajouter à Google Agenda">Agenda</a>
        <a class="tile" href="${esc(whatsappUrl(e))}" target="_blank" rel="noopener" title="Partager sur WhatsApp">WhatsApp</a>
      </div>
      <div class="venue"><b>${esc(e.venue)}</b>${e.area ? " · " + esc(e.area) : ""}${line2 ? `<br><span>${line2}</span>` : ""}</div>
      ${meta ? `<div class="muted meta">${meta}</div>` : ""}
      ${blurbHtml(e)}
      <div id="artist"></div>`;
    renderStatus();
    const more = $(".blurb [data-more]", detail);
    if (more) more.onclick = () => {   // "lire la suite" / "réduire" swaps the text in place
      const open = more.textContent !== "lire la suite";
      $(".blurb .txt", detail).textContent = open ? BLURB_CUT(blurb(e)) : blurb(e);
      more.textContent = open ? "lire la suite" : "réduire";
    };
    if (artists.length) loadArtist(artists[0], e, artists);
  }
  // Tile 1 of the action row. `ticket` says whether the price is already on it (else the meta line shows it).
  function ticketTile(e) {
    const ticket = safeUrl(e.ticket_url), page = safeUrl(e.url);
    const price = e.free ? "Gratuit" : shortPrice(e.price);
    if (e.cancelled) return { html: '<button class="tile off" type="button" disabled>Annulé</button>' };
    if (e.sold_out) return { html: '<button class="tile off" type="button" disabled>Complet</button>' };
    if (ticket) return { ticket: true, html: `<a class="tile primary" href="${esc(ticket)}" target="_blank" rel="noopener">${price ? `<b>${esc(price)}</b><small>Billets ↗</small>` : "Billets ↗"}</a>` };
    if (page) return { html: `<a class="tile" href="${esc(page)}" target="_blank" rel="noopener" title="${esc(page)}">Voir sur<small>${esc(hostOf(page))} ↗</small></a>` };
    return { html: `<span class="tile off" aria-disabled="true">${price ? esc(price) : "Billets"}</span>` };
  }
  // ---- status tile + menu (REM-18): "Intéressé ? ▾" opens a small menu; once set, the tile shows the status and the
  // menu gains "Retirer". One menu at a time, closed on outside click / Escape (before the sheet's Escape).
  function renderStatus() {
    const b = $("#statusbtn"), m = $("#statusmenu"); if (!b || !current) return;
    const s = getStatus(current.id);
    b.classList.toggle("on", !!s);
    b.setAttribute("aria-expanded", String(menuOpen));
    b.innerHTML = s ? `<span class="star">${STATUS[s].icon}</span> ${STATUS[s].label}` : 'Intéressé ?<span class="caret" aria-hidden="true">▾</span>';
    m.innerHTML = Object.entries(STATUS).map(([k, v]) =>
      `<button type="button" role="menuitemradio" aria-checked="${s === k}" data-status="${k}"><span class="star">${v.icon}</span>${v.label}</button>`).join("") +
      (s ? '<button type="button" role="menuitem" class="rm" data-status="">Retirer</button>' : "");
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
  function blurbHtml(e) {
    const text = blurb(e);
    if (!text) return "";
    const long = text.length > BLURB_MAX, page = safeUrl(e.url);
    let domain = "";
    try { domain = page ? new URL(page).hostname.replace(/^www\./, "") : ""; } catch { /* no attribution */ }
    return `<p class="blurb"><span class="txt">${esc(long ? BLURB_CUT(text) : text)}</span>${long ? ' <button class="link" type="button" data-more>lire la suite</button>' : ""}${domain ? ` <a class="muted" href="${esc(page)}" target="_blank" rel="noopener">source : ${esc(domain)} ↗</a>` : ""}</p>`;
  }
  // Cross-fade #artist: fade out, swap the content at the mid-point, fade in.
  function swapArtist(name, e, artists) {
    const box = $("#artist");
    if (!motionOK()) { loadArtist(name, e, artists); return; }
    replay(box, "swap");
    setTimeout(() => loadArtist(name, e, artists), 110);
  }
  // Closing reverses the opening motion; #detail is hidden once it ends. The state (current, hash, body scroll)
  // is reset synchronously, so a second call or a click during the exit is a no-op.
  function closeDetail() {
    if (detail.hidden || closing) return;
    const e = current; current = null; closing = true; menuOpen = false;
    document.body.style.overflow = ""; history.replaceState(null, "", location.pathname);
    $("#list").classList.remove("receded");
    const hide = () => { closing = false; if (current) return; detail.hidden = true; hero.style.transform = ""; };   // unless reopened meanwhile
    const row = e && detail.classList.contains("vt") && canVT() ? $(`.gig[data-id="${e.id}"]`) : null;
    if (!row) { detail.classList.remove("vt"); exitThen(detail, "closing", 300, hide); return; }
    const t = $("time", row), w = $(".hero-text .when");   // old state: the hero date; new state: the row's time
    w.style.viewTransitionName = "gig-date";
    const done = () => { t.style.viewTransitionName = ""; };
    document.startViewTransition(() => { hide(); w.style.viewTransitionName = ""; t.style.viewTransitionName = "gig-date"; }).finished.then(done, done);
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

  // Wikipedia (FR then EN) for the blurb, Deezer (JSONP, no key) for picture and similar artists.
  // Player: the artist's own Bandcamp page, else Spotify, else Deezer's top tracks (`players` is resolved
  // by the scraper per artist name; older events.json files have none and fall back to Deezer).
  const BC_EMBED = /^https:\/\/bandcamp\.com\/EmbeddedPlayer\/(album|track)=\d+\//;
  function playersOf(e, name) {
    const all = (e && e.players) || {};
    const p = all[name] || all[Object.keys(all).find(k => norm(k) === norm(name))] || {};
    const bc = p.bandcamp && safeUrl(p.bandcamp.url) ? p.bandcamp : null;
    const sp = p.spotify && /^[A-Za-z0-9]{8,64}$/.test(p.spotify.id || "") ? p.spotify : null;
    return { bandcamp: bc, bandcampEmbed: bc && BC_EMBED.test(bc.embed || "") ? bc.embed : null, spotify: sp };
  }
  function playerHtml(p, dz) {
    if (p.bandcampEmbed) return `<div class="player bandcamp"><iframe title="Bandcamp" src="${esc(p.bandcampEmbed)}" seamless loading="lazy"></iframe><div class="muted via">via Bandcamp</div></div>`;
    if (p.spotify) return `<div class="player spotify"><iframe title="Spotify" src="https://open.spotify.com/embed/artist/${encodeURIComponent(p.spotify.id)}?utm_source=generator&theme=0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe><div class="muted via">via Spotify</div></div>`;
    if (dz) return `<div class="player deezer"><iframe title="Deezer" src="https://widget.deezer.com/widget/light/artist/${Number(dz.id)}/top_tracks" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" allow="encrypted-media; clipboard-write"></iframe><div class="muted via">via Deezer</div></div>`;
    return "";
  }
  // #artist, below the blurb: [Wikipedia paragraph when the event gave no text] · "Écouter <act>" + player · the other
  // acts as text buttons (swap the player) · "Dans le même esprit" (Deezer related, names only) · search links.
  // A thin skeleton line stands in while the lookups run; a stale answer (act or sheet changed meanwhile) is dropped.
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
    const p = playersOf(e, name);
    const player = playerHtml(p, dz);
    const others = artists.filter(a => a !== name);
    box.innerHTML = `
      ${wiki ? `<p>${esc(wiki.extract)} <a class="muted" href="${esc(wiki.url)}" target="_blank" rel="noopener">Wikipédia ↗</a></p>` : ""}
      ${player ? `<h3>Écouter ${esc(name)}</h3>${player}` : ""}
      ${others.length ? `<div class="acts muted">Écouter aussi : ${others.map(a => `<button type="button" class="link" data-act="${esc(a)}">${esc(a)}</button>`).join(" · ")}</div>` : ""}
      <div class="esprit muted" id="esprit"></div>
      <div class="links">
        <a href="${p.bandcamp ? esc(p.bandcamp.url) : `https://bandcamp.com/search?q=${q}`}" target="_blank" rel="noopener">Bandcamp</a>
        <a href="${p.spotify && safeUrl(p.spotify.url) ? esc(p.spotify.url) : `https://open.spotify.com/search/${q}`}" target="_blank" rel="noopener">Spotify</a>
        <a href="https://www.youtube.com/results?search_query=${q}+live" target="_blank" rel="noopener">YouTube</a>
        ${dz && safeUrl(dz.link) ? `<a href="${esc(dz.link)}" target="_blank" rel="noopener">Deezer</a>` : ""}
      </div>`;
    $$(".acts [data-act]", box).forEach(b => b.onclick = () => swapArtist(b.dataset.act, e, artists));
    if (dz) {
      const rel = (await deezerRelated(dz.id).catch(() => [])).filter(a => a && a.name).slice(0, 6);
      if (rel.length && !stale()) {
        $("#esprit").innerHTML = "Dans le même esprit : " + rel.map(a =>
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
    for (const lang of ["fr", "en"]) {
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
  function goWeek(n) { state.week = Math.max(0, n); render(); window.scrollTo({ top: 0 }); }
  $("#prev").onclick = () => goWeek(state.week - 1);
  $("#next").onclick = () => goWeek(state.week + 1);
  $("#thisweek").onclick = () => goWeek(0);
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
  $("#radius").onchange = ev => { state.radius = ev.target.value; render(); };
  $("#near").onclick = () => {
    if (state.near) { state.near = false; render(); return; }
    if (!navigator.geolocation) { alert("Géolocalisation indisponible"); return; }
    $("#near span").textContent = "…";
    navigator.geolocation.getCurrentPosition(pos => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.near = true; render();
    }, () => { render(); alert("Position refusée"); }, { timeout: 10000 });
  };
  // Outside clicks close the popovers. composedPath() rather than closest(): a click on a pill re-renders it, so by the
  // time the event reaches the document the target may be detached and closest() would see it as "outside".
  document.addEventListener("click", ev => {
    const within = (...ids) => ev.composedPath().some(el => el && el.id && ids.includes(el.id));
    if (taOpen && !within("sbar")) closeTa();
    if (genresOpen && !within("gbtn", "gpanel")) closeGenres();
    if (menuOpen && !within("status")) closeMenu();
  });
  addEventListener("resize", () => { if (genresOpen) placePanel(); });
  MOBILE.addEventListener("change", () => { if (!MOBILE.matches) document.body.classList.remove("searching"); else if (taOpen) closeTa(true); renderNav(); });
  $("#list").onclick = ev => {
    if (ev.target.closest("[data-next]")) { goWeek(state.week + 1); return; }
    const sub = ev.target.closest(".tag.sub");
    if (sub) { toggleStyle(sub.dataset.sub); return; }
    const row = ev.target.closest(".gig"); if (!row) return;
    const e = DATA.events.find(x => x.id === row.dataset.id); if (e) openDetail(e, row);
  };
  $("#close").onclick = closeDetail;
  detail.onclick = ev => { if (ev.target === detail) closeDetail(); };
  detail.addEventListener("click", ev => {
    const sub = ev.target.closest(".tag.sub"); if (sub) { closeDetail(); toggleStyle(sub.dataset.sub); return; }
    if (ev.target.closest("#statusbtn")) { menuOpen ? closeMenu() : openMenu(); return; }
    const item = ev.target.closest("#statusmenu [data-status]"); if (item) pickStatus(item.dataset.status);
  });
  detail.addEventListener("keydown", ev => {
    if (ev.target.closest("#statusmenu")) { menuKeys(ev); return; }
    if (ev.target.closest("#statusbtn") && ev.key === "ArrowDown" && !menuOpen) { ev.preventDefault(); openMenu(); }
  });
  // ⌘K / Ctrl+K / "/" focus the bar; Escape closes whatever is open (typeahead, panel, status menu, sheet); ← → browse the weeks.
  document.addEventListener("keydown", ev => {
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") { ev.preventDefault(); focusSearch(); return; }
    if (ev.key === "/" && !inField && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); focusSearch(); return; }
    if (ev.key === "Escape" && taOpen) { closeTa(true); return; }
    if (ev.key === "Escape" && genresOpen) { closeGenres(true); return; }
    if (ev.key === "Escape" && menuOpen) { closeMenu(true); return; }
    if (ev.key === "Escape" && !detail.hidden) { closeDetail(); return; }
    if (!detail.hidden || inField || genresOpen || frame() !== "week") return;
    if (ev.key === "ArrowLeft" && state.week > 0) goWeek(state.week - 1);
    if (ev.key === "ArrowRight") goWeek(state.week + 1);
  });

  // ------------------------------------------------------------ boot
  fetch("events.json?" + Date.now()).then(r => r.json()).catch(() => {
    $("#list").innerHTML = '<div class="empty">events.json introuvable — lance <code>python scrape.py</code> puis <code>python serve.py</code>.</div>';
    return null;
  }).then(d => {
    if (!d) return;
    DATA = d;
    state.near = false; // ask for the position again on each visit
    buildIndex(); renderMeta(); render(); renderTa();
    const m = location.hash.match(/^#e=([a-f0-9]+)/);   // shareable link straight to a concert
    const linked = m && d.events.find(x => x.id === m[1]);
    if (linked) openDetail(linked);
  });
})();
