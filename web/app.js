/* Live in Paris — week planner (direction A "Programme") + filters + concert detail sheet. Plain JS, no build step. */
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
  const TABS = ["week", "month", "new", "all"];
  const WALK_KMH = 4.5;

  let DATA = { events: [], tags: [], venues: [] };
  let state = load({ tab: "week", week: 0, genres: [], styles: [], venues: [], free: false, saved: false, others: false, q: "", near: false, radius: 5 });
  let saved = loadSaved(); // ids of concerts the user bookmarked ("Enregistrer")
  let me = null; // {lat, lon}
  let stylesOpen = false; // "+N autres" expanded (not persisted)
  let venueOpen = false; // venue picker popover (not persisted)
  let venueHi = null;    // venue name highlighted with the arrow keys in the picker
  let venueShown = [];   // venues currently listed in the picker, in display order

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
  function load(def) {
    let s = def;
    try { s = Object.assign(def, JSON.parse(localStorage.getItem("lip-state") || "{}")); } catch { /* keep defaults */ }
    if (s.tab === "nextweek") { s.tab = "week"; s.week = 1; }   // tab from the previous UI
    if (!TABS.includes(s.tab)) s.tab = "week";
    s.week = 0;   // always land on the current week; the offset is only kept while browsing
    if (!Array.isArray(s.genres)) s.genres = [];
    if (!Array.isArray(s.styles)) s.styles = [];
    if (!Array.isArray(s.venues)) s.venues = [];
    s.venues = s.venues.filter(v => typeof v === "string" && v);
    if (typeof s.venue === "string" && s.venue && !s.venues.length) s.venues = [s.venue];   // single-venue dropdown from the previous UI
    delete s.venue;
    return s;
  }
  function save() { try { localStorage.setItem("lip-state", JSON.stringify(state)); } catch {} }
  function loadSaved() {
    try { const a = JSON.parse(localStorage.getItem("lip-saved") || "[]"); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
  }
  function toggleSaved(id) {
    if (saved.has(id)) saved.delete(id); else saved.add(id);
    try { localStorage.setItem("lip-saved", JSON.stringify([...saved])); } catch {}
  }
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
  function weekLabel(mon) {
    const sun = addDays(mon, 6);
    const year = sun.getFullYear() !== today0().getFullYear() ? ` ${sun.getFullYear()}` : "";
    return (mon.getMonth() === sun.getMonth() ? `${mon.getDate()} – ${sun.getDate()} ${MONTHS[mon.getMonth()]}` : `${fmtShort(mon)} – ${fmtShort(sun)}`) + year;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function km(a, b) {
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function plural(n, w) { return `${n} ${w}${n > 1 ? "s" : ""}`; }

  // Date ranges for the views, computed from the machine's "today" (weeks start on Monday).
  function ranges() {
    const today = today0();
    const wk = addDays(monday(today), 7 * state.week);
    return {
      week: [isoDate(state.week ? wk : today), isoDate(addDays(wk, 6))],
      month: [isoDate(today), isoDate(addDays(today, 30))],
      new: [isoDate(today), "9999-12-31"],
      all: [isoDate(today), "9999-12-31"],
    };
  }
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
  function inTab(e, tab) {
    const [a, b] = ranges()[tab];
    if (e.date < a || e.date > b) return false;
    if (tab === "new" && !isNew(e)) return false;
    return true;
  }
  function baseFilter(e) {
    if (!state.others && !e.is_music) return false;
    if (state.venues.length && !state.venues.includes(e.venue)) return false;
    if (state.free && !e.free) return false;
    if (state.saved && !saved.has(e.id)) return false;
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
  function visible() { return DATA.events.filter(e => baseFilter(e) && inTab(e, state.tab)); }

  // ------------------------------------------------------------ rendering
  function renderNav() {
    const today = today0(), mon = addDays(monday(today), 7 * state.week);
    const label = $("#weeklabel");
    if (state.tab === "week") label.textContent = weekLabel(mon);
    else if (state.tab === "month") label.textContent = `${fmtShort(today)} – ${fmtShort(addDays(today, 30))}`;
    else if (state.tab === "new") label.textContent = `Annoncés ces ${DATA.new_window_days || 7} derniers jours`;
    else {
      const last = DATA.events.reduce((m, e) => e.date > m ? e.date : m, "");
      label.textContent = last ? `Jusqu'au ${fmtDay(last)}` : "Tout";
    }
    $("#arrows").hidden = state.tab !== "week";
    $("#prev").disabled = state.week === 0;
    $("#thisweek").hidden = !(state.tab === "week" && state.week > 0);
    $$("#tabs button").forEach(b => {
      const t = b.dataset.tab;
      b.classList.toggle("on", t === state.tab);
      b.querySelector("b").textContent = DATA.events.filter(e => baseFilter(e) && inTab(e, t)).length;
    });
  }
  function renderGenres() {
    const counts = {};
    DATA.events.filter(e => inTab(e, state.tab) && (state.others || e.is_music)).forEach(e => e.genres.forEach(g => counts[g] = (counts[g] || 0) + 1));
    $("#genres").innerHTML = `<button class="chip ${state.genres.length ? "" : "on"}" data-g="">Tout</button>` + DATA.tags.map(t =>
      `<button class="chip ${state.genres.includes(t) ? "on" : ""}" data-g="${t}">${TAG_LABELS[t] || t}<small>${counts[t] || 0}</small></button>`).join("");
    $("#free").classList.toggle("on", state.free);
    $("#saved").classList.toggle("on", state.saved);
    $("#saved small").textContent = saved.size || "";
    renderStyles();
  }
  // Fine-grained styles, shown only in context: once a coarse genre is picked (or a style is active), the
  // styles found in the current view for those genres, most frequent first, top STYLES_SHOWN + "N autres".
  const STYLES_SHOWN = 12;
  function renderStyles() {
    const box = $("#styles");
    const show = state.genres.length || state.styles.length;
    box.hidden = !show;
    if (!show) { box.innerHTML = ""; return; }
    const counts = {};
    DATA.events.filter(e => inTab(e, state.tab) && (state.others || e.is_music) && (!state.genres.length || e.genres.some(g => state.genres.includes(g))))
      .forEach(e => (e.subgenres || []).forEach(s => counts[s] = (counts[s] || 0) + 1));
    state.styles.forEach(s => counts[s] = counts[s] || 0);   // keep an active style visible even if the view has none left
    const all = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "fr"));
    const head = new Set([...all.slice(0, STYLES_SHOWN), ...state.styles]);
    const shown = stylesOpen ? all : all.filter(s => head.has(s));
    const rest = all.length - shown.length;
    const chip = s => `<button class="chip style ${state.styles.includes(s) ? "on" : ""}" data-s="${esc(s)}">${esc(s)}<small>${counts[s]}</small></button>`;
    box.innerHTML = `<span class="lbl">Styles</span>` + (all.length ? shown.map(chip).join("") : '<span class="none">aucun style connu</span>') +
      (rest > 0 ? `<button class="link" data-more>+ ${rest} autres</button>` : stylesOpen && all.length > STYLES_SHOWN ? '<button class="link" data-more>réduire</button>' : "");
  }
  function toggleStyle(s) {
    state.styles = state.styles.includes(s) ? state.styles.filter(x => x !== s) : [...state.styles, s];
    render();
  }
  // Venue picker: a chip-like trigger + a popover with a search box and one checkbox per venue. Several venues
  // can be picked at once (state.venues, OR between them); each pick is also a removable chip next to the trigger.
  // Counts follow the current tab like the genre chips do.
  function renderVenues() {
    const n = state.venues.length, btn = $("#venue");
    btn.textContent = !n ? "Toutes les salles" : n === 1 ? state.venues[0] : `${n} salles`;
    btn.title = n > 1 ? state.venues.join(", ") : "";
    btn.classList.toggle("on", n > 0);
    btn.setAttribute("aria-expanded", String(venueOpen));
    $("#venuesel").innerHTML = state.venues.map(v => `<button type="button" class="chip on" data-rm="${esc(v)}" title="Retirer « ${esc(v)} »">${esc(v)}<b aria-hidden="true">×</b></button>`).join("");
    const pop = $("#venuepop");
    if (venueOpen) { cancelExit(pop); pop.hidden = false; }
    else if (!pop.hidden && !pop._exit) exitThen(pop, "out", 120, () => { pop.hidden = true; });
    $("#venue-clear").hidden = !n;
    if (venueOpen) renderVenueList();
  }
  // "maroq" -> La Maroquinerie, "38" -> 38Riv Jazz Club, "petit bain" / "bain petit" -> Petit Bain: accent/case-insensitive
  // substring anywhere in the name, or every typed word is the prefix of some word of the name.
  function matchVenue(name, q) {
    const n = norm(name);
    if (!q || n.includes(q)) return true;
    const words = n.split(/[^a-z0-9]+/).filter(Boolean);
    return q.split(/\s+/).every(w => words.some(x => x.startsWith(w)));
  }
  // Selected venues first, then the ones with concerts in the current view, then the empty ones (still selectable).
  // Only the list is rebuilt, so the search text and its focus survive; a focused checkbox is re-focused by name.
  function renderVenueList() {
    const list = $("#venuelist"), input = $("#venue-q"), q = norm(input.value.trim());
    const focused = document.activeElement && document.activeElement.closest("#venuelist") ? document.activeElement.dataset.v : null;
    const counts = {};
    DATA.events.filter(e => inTab(e, state.tab) && (state.others || e.is_music)).forEach(e => counts[e.venue] = (counts[e.venue] || 0) + 1);
    const sel = v => state.venues.includes(v);
    venueShown = DATA.venues.filter(v => matchVenue(v, q))
      .sort((a, b) => sel(b) - sel(a) || !!counts[b] - !!counts[a]);   // stable: keeps the alphabetical order within each group
    if (!venueShown.includes(venueHi)) venueHi = null;
    list.innerHTML = venueShown.length ? venueShown.map((v, i) =>
      `<label id="vo-${i}" role="option" class="${counts[v] ? "" : "zero"}${v === venueHi ? " hi" : ""}" aria-selected="${v === venueHi}" aria-checked="${sel(v)}">
        <input type="checkbox" tabindex="-1" data-v="${esc(v)}" ${sel(v) ? "checked" : ""}><span>${esc(v)}</span><small>${counts[v] || 0}</small></label>`).join("")
      : '<div class="none">Aucune salle ne correspond.</div>';
    const hi = $("label.hi", list);
    if (hi) { hi.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", hi.id); } else input.removeAttribute("aria-activedescendant");
    if (focused != null) { const cb = $$("input", list).find(x => x.dataset.v === focused); if (cb) cb.focus(); }
  }
  function openVenues() { if (venueOpen) return; venueOpen = true; venueHi = null; renderVenues(); $("#venue-q").focus(); }
  function closeVenues(refocus) {
    if (!venueOpen) return;
    venueOpen = false; venueHi = null; $("#venue-q").value = "";
    renderVenues();
    if (refocus) $("#venue").focus();
  }
  function toggleVenue(v) {
    state.venues = state.venues.includes(v) ? state.venues.filter(x => x !== v) : [...state.venues, v];
    render();
  }
  // Arrows move the highlight, Enter toggles it (or the only match), Backspace on an empty search drops the last pick.
  function venueKeys(ev) {
    const input = $("#venue-q"), n = venueShown.length, i = venueShown.indexOf(venueHi);
    const move = j => { if (!n) return; venueHi = venueShown[Math.max(0, Math.min(n - 1, j))]; renderVenueList(); };
    switch (ev.key) {
      case "ArrowDown": move(i + 1); break;
      case "ArrowUp": move(i < 0 ? n - 1 : i - 1); break;
      case "Home": if (ev.target === input && input.value) return; move(0); break;
      case "End": if (ev.target === input && input.value) return; move(n - 1); break;
      case "Enter": { const v = ev.target.dataset.v || (i >= 0 ? venueHi : n === 1 ? venueShown[0] : null); if (v) toggleVenue(v); break; }
      case "Backspace": if (ev.target === input && !input.value && state.venues.length) { state.venues = state.venues.slice(0, -1); render(); } return;
      default: return;
    }
    ev.preventDefault();
  }
  function genreTags(e) {
    return e.genres.map(g => `<span class="tag src-${e.genre_source || ""}" title="source : ${e.genre_source || "?"}">${TAG_LABELS[g] || g}</span>`).join("");
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
    if (!e.is_music) b.push('<span class="tag other">Non-concert</span>');
    if (saved.has(e.id)) b.push('<span class="tag saved">★ Enregistré</span>');
    return b.join("");
  }
  function gigHtml(e) {
    const [head, ...sup] = lineup(e);
    const genre = e.genres.find(g => state.genres.includes(g)) || e.genres[0];
    const price = e.free ? '<span class="tag free">Gratuit</span>' : (p => p ? `<span class="tag">${esc(p)}</span>` : "")(shortPrice(e.price));
    return `<div class="gig${e.is_music ? "" : " other"}${e.cancelled ? " cancelled" : ""}" data-id="${e.id}">
      <time>${fmtTime(e.time)}</time>
      <div class="who">${esc(head)}${sup.length ? `<span>${esc(sup.join(", "))}</span>` : ""}</div>
      <div class="where">${esc([e.venue, e.area, walk(e)].filter(Boolean).join(" · "))}</div>
      <div class="tags">${price}${genre ? `<span class="tag">${TAG_LABELS[genre] || genre}</span>` : ""}${subHtml(e)}${statusTags(e)}</div>
    </div>`;
  }
  // One calendar week, Monday to Sunday. `from`/`to` bound the current view; days before today are "past".
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
    const [from, to] = ranges()[state.tab];
    let html = "";
    if (state.tab === "week") {
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
    const week = d.events.filter(e => e.is_music && e.date >= a && e.date <= b).length;
    const upd = new Date(d.generated_at);
    $("#meta").textContent = `${plural(week, "concert")} cette semaine · ${d.events.length} à venir · mis à jour ${DAYS[upd.getDay()]} ${String(upd.getHours()).padStart(2, "0")}:${String(upd.getMinutes()).padStart(2, "0")}`;
  }
  function render() { renderNav(); renderGenres(); renderVenues(); renderList(); save(); }

  // ------------------------------------------------------------ detail sheet
  const detail = $("#detail"), sheet = $(".sheet", detail), hero = $("#hero");
  let current = null;
  let closing = false;   // exit animation (or the closing view transition) in flight
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
    sheet.scrollTop = 0; hero.style.transform = "";
    hero.style.backgroundImage = e.image ? `url("${e.image}")` : "";
    const [head, ...sup] = lineup(e);
    $("#hero-text").innerHTML = `<div class="when">${fmtDay(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}</div>
      <h2>${esc(head)}</h2>${sup.length ? `<div class="support">avec ${esc(sup.join(", "))}</div>` : ""}
      <div class="where">${esc([e.venue, e.area, e.address].filter(Boolean).join(" · "))}${walk(e) ? " · " + walk(e) : ""}</div>`;
    const artists = e.headliner ? [head, ...sup] : splitArtists(e.title);
    const ticket = safeUrl(e.ticket_url), page = safeUrl(e.url);
    $("#detail-body").innerHTML = `
      <div class="actions">
        ${ticket ? `<a href="${esc(ticket)}" target="_blank" rel="noopener">Billets ↗</a>` : ""}
        ${page ? `<a${ticket ? ' class="secondary"' : ""} href="${esc(page)}" title="${esc(hostOf(page))}" target="_blank" rel="noopener">Page de l'événement ↗</a>` : ""}
        ${e.lat != null ? `<a class="secondary" href="https://www.google.com/maps?q=${e.lat},${e.lon}" target="_blank" rel="noopener">Itinéraire</a>` : ""}
        <a class="secondary" href="${esc(gcalUrl(e))}" target="_blank" rel="noopener">Agenda Google</a>
        <a class="secondary" href="${esc(whatsappUrl(e))}" target="_blank" rel="noopener">WhatsApp</a>
        <button id="savebtn" type="button"></button>
      </div>
      <div class="muted tagline">${genreTags(e)}${subHtml(e, 99)} ${e.raw_genre ? "· " + esc(e.raw_genre) : ""} ${e.price ? "· " + esc(e.price) : ""} ${statusTags(e)}</div>
      ${blurbHtml(e)}
      ${artists.length > 1 ? `<div class="artist-pick">${artists.map((a, i) => `<button data-i="${i}" class="${i ? "" : "on"}">${esc(a)}</button>`).join("")}</div>` : ""}
      <div id="artist"></div>`;
    renderSaveButton();
    $("#savebtn").onclick = () => { toggleSaved(e.id); renderSaveButton(); replay($("#savebtn"), "pop"); render(); };
    const more = $(".blurb [data-more]", detail);
    if (more) more.onclick = () => {   // "lire la suite" / "réduire" swaps the text in place
      const open = more.textContent !== "lire la suite";
      $(".blurb .txt", detail).textContent = open ? BLURB_CUT(blurb(e)) : blurb(e);
      more.textContent = open ? "lire la suite" : "réduire";
    };
    $$(".artist-pick button", detail).forEach(b => b.onclick = () => {
      if (b.classList.contains("on")) return;
      $$(".artist-pick button", detail).forEach(x => x.classList.remove("on")); b.classList.add("on");
      swapArtist(artists[Number(b.dataset.i)], e);
    });
    if (artists.length) loadArtist(artists[0], e);
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
  function renderSaveButton() {
    const b = $("#savebtn"); if (!b || !current) return;
    const on = saved.has(current.id);
    b.classList.toggle("on", on);
    b.innerHTML = `<span class="star">${on ? "★" : "☆"}</span> ${on ? "Enregistré" : "Enregistrer"}`;
  }
  // Cross-fade #artist: fade out, swap the content at the mid-point, fade in.
  function swapArtist(name, e) {
    const box = $("#artist");
    if (!motionOK()) { loadArtist(name, e); return; }
    replay(box, "swap");
    setTimeout(() => loadArtist(name, e), 110);
  }
  // Closing reverses the opening motion; #detail is hidden once it ends. The state (current, hash, body scroll)
  // is reset synchronously, so a second call or a click during the exit is a no-op.
  function closeDetail() {
    if (detail.hidden || closing) return;
    const e = current; current = null; closing = true;
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
  const cache = {};
  async function loadArtist(name, e) {
    const box = $("#artist");
    box.innerHTML = `<div class="muted">Recherche de « ${esc(name)} »…</div>`;
    const key = norm(name) + (blurb(e) ? "|nowiki" : "");   // Wikipedia only as a fallback when the event page gave nothing
    if (!cache[key]) cache[key] = Promise.all([deezerArtist(name).catch(() => null), blurb(e) ? null : wikiSummary(name)]).catch(() => [null, null]);
    const [dz, wiki] = await cache[key];
    if ($(".artist-pick .on", detail) && $(".artist-pick .on", detail).textContent !== name) return; // user switched
    if (dz && dz.picture_xl && !e.image) $("#hero").style.backgroundImage = `url("${dz.picture_xl}")`;
    const q = encodeURIComponent(name);
    const p = playersOf(e, name);
    const player = playerHtml(p, dz);
    box.innerHTML = `
      <h3>${esc(name)}</h3>
      ${wiki ? `<p>${esc(wiki.extract)} <a class="muted" href="${esc(wiki.url)}" target="_blank" rel="noopener">Wikipédia ↗</a></p>` : ""}
      ${player ? `<div style="margin-top:12px">${player}</div>` : ""}
      <div class="links" style="margin-top:10px">
        <a href="${p.bandcamp ? esc(p.bandcamp.url) : `https://bandcamp.com/search?q=${q}`}" target="_blank" rel="noopener">Bandcamp</a>
        <a href="${p.spotify && safeUrl(p.spotify.url) ? esc(p.spotify.url) : `https://open.spotify.com/search/${q}`}" target="_blank" rel="noopener">Spotify</a>
        ${dz && safeUrl(dz.link) ? `<a href="${esc(dz.link)}" target="_blank" rel="noopener">Deezer</a>` : ""}
        <a href="https://www.youtube.com/results?search_query=${q}+live" target="_blank" rel="noopener">YouTube</a>
      </div>
      <div id="similar"></div>`;
    if (dz) {
      const rel = await deezerRelated(dz.id).catch(() => []);
      if (rel.length) {
        $("#similar").innerHTML = `<h3 style="margin-top:16px">Artistes similaires</h3><div class="similar">${rel.slice(0, 10).map(a =>
          `<a href="${esc(safeUrl(a.link) || "#")}" target="_blank" rel="noopener"><img src="${esc(safeUrl(a.picture_medium) || "")}" alt="">${esc(a.name)}</a>`).join("")}</div>`;
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
  function goWeek(n) { state.tab = "week"; state.week = Math.max(0, n); render(); window.scrollTo({ top: 0 }); }
  $("#prev").onclick = () => goWeek(state.week - 1);
  $("#next").onclick = () => goWeek(state.week + 1);
  $("#thisweek").onclick = () => goWeek(0);
  $("#tabs").onclick = ev => {
    const b = ev.target.closest("button"); if (!b || b.dataset.tab === state.tab) return;
    state.tab = b.dataset.tab; render(); replay($("#list"), "swap");
  };
  $("#genres").onclick = ev => {
    const b = ev.target.closest(".chip"); if (!b) return;
    const g = b.dataset.g;
    state.genres = !g ? [] : state.genres.includes(g) ? state.genres.filter(x => x !== g) : [...state.genres, g];
    if (!g) state.styles = [];
    render();
  };
  $("#styles").onclick = ev => {
    if (ev.target.closest("[data-more]")) { stylesOpen = !stylesOpen; renderStyles(); return; }
    const b = ev.target.closest(".chip.style"); if (b) toggleStyle(b.dataset.s);
  };
  $("#free").onclick = () => { state.free = !state.free; render(); };
  $("#saved").onclick = () => { state.saved = !state.saved; render(); };
  $("#venue").onclick = () => venueOpen ? closeVenues() : openVenues();
  $("#venue").onkeydown = ev => { if (ev.key === "ArrowDown" && !venueOpen) { ev.preventDefault(); openVenues(); } };
  $("#venuepop").onkeydown = venueKeys;
  $("#venue-q").oninput = () => { venueHi = null; renderVenueList(); };
  $("#venuelist").onchange = ev => { const cb = ev.target.closest("input[data-v]"); if (cb) toggleVenue(cb.dataset.v); };
  $("#venuelist").onmousemove = ev => { const row = ev.target.closest("label[role=option]"); if (row && !row.classList.contains("hi")) { venueHi = $("input", row).dataset.v; renderVenueList(); } };
  $("#venue-clear").onclick = () => { state.venues = []; render(); $("#venue-q").focus(); };
  $("#venuesel").onclick = ev => { const b = ev.target.closest("[data-rm]"); if (b) toggleVenue(b.dataset.rm); };
  document.addEventListener("click", ev => { if (venueOpen && !ev.target.closest("#venuepick")) closeVenues(); });
  $("#others").onchange = ev => { state.others = ev.target.checked; render(); };
  $("#search").oninput = ev => { state.q = ev.target.value.trim(); render(); };
  $("#reset").onclick = () => { state = { ...state, genres: [], styles: [], venues: [], free: false, saved: false, others: false, q: "", near: false }; closeVenues(); syncInputs(); render(); };
  $("#radius").onchange = ev => { state.radius = ev.target.value; render(); };
  $("#near").onclick = () => {
    if (state.near) { state.near = false; syncInputs(); render(); return; }
    if (!navigator.geolocation) { alert("Géolocalisation indisponible"); return; }
    $("#near").textContent = "…";
    navigator.geolocation.getCurrentPosition(pos => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.near = true; syncInputs(); render();
    }, () => { syncInputs(); alert("Position refusée"); }, { timeout: 10000 });
  };
  $("#list").onclick = ev => {
    if (ev.target.closest("[data-next]")) { goWeek(state.week + 1); return; }
    const sub = ev.target.closest(".tag.sub");
    if (sub) { toggleStyle(sub.dataset.sub); return; }
    const row = ev.target.closest(".gig"); if (!row) return;
    const e = DATA.events.find(x => x.id === row.dataset.id); if (e) openDetail(e, row);
  };
  $("#close").onclick = closeDetail;
  detail.onclick = ev => { if (ev.target === detail) closeDetail(); };
  detail.addEventListener("click", ev => { const sub = ev.target.closest(".tag.sub"); if (sub) { closeDetail(); toggleStyle(sub.dataset.sub); } });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && venueOpen) { closeVenues(true); return; }
    if (ev.key === "Escape" && !detail.hidden) { closeDetail(); return; }
    if (!detail.hidden || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName) || state.tab !== "week") return;
    if (ev.key === "ArrowLeft" && state.week > 0) goWeek(state.week - 1);
    if (ev.key === "ArrowRight") goWeek(state.week + 1);
  });

  function syncInputs() {
    $("#others").checked = state.others;
    $("#search").value = state.q; $("#radius").value = state.radius;
    $("#near").classList.toggle("on", state.near); $("#near").textContent = state.near ? "Près de moi ✓" : "Près de moi";
    $("#radius").hidden = !state.near;
  }

  // ------------------------------------------------------------ boot
  fetch("events.json?" + Date.now()).then(r => r.json()).catch(() => {
    $("#list").innerHTML = '<div class="empty">events.json introuvable — lance <code>python scrape.py</code> puis <code>python serve.py</code>.</div>';
    return null;
  }).then(d => {
    if (!d) return;
    DATA = d;
    state.near = false; // ask for the position again on each visit
    renderMeta(); syncInputs(); render();
    const m = location.hash.match(/^#e=([a-f0-9]+)/);   // shareable link straight to a concert
    const linked = m && d.events.find(x => x.id === m[1]);
    if (linked) openDetail(linked);
  });
})();
