/* Live in Paris - list + filters + concert detail sheet. Plain JS, no build step. */
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
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

  let DATA = { events: [], tags: [], venues: [] };
  let state = load({ tab: "week", genres: [], venue: "", free: false, others: false, q: "", near: false, radius: 5 });
  let me = null; // {lat, lon}

  // ------------------------------------------------------------ helpers
  function load(def) {
    let s = def;
    try { s = Object.assign(def, JSON.parse(localStorage.getItem("lip-state") || "{}")); } catch { /* keep defaults */ }
    if (!["week", "nextweek", "month", "new", "all"].includes(s.tab)) s.tab = "week";
    if (!Array.isArray(s.genres)) s.genres = [];
    return s;
  }
  function save() { try { localStorage.setItem("lip-state", JSON.stringify(state)); } catch {} }
  // Local calendar date, never toISOString (UTC would shift Paris midnight to the previous day).
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function safeUrl(u) { return u && /^https?:\/\//i.test(u) ? u : null; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function fmtDay(s) { const d = parseISO(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function km(a, b) {
    const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function norm(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  // Date ranges for the tabs, computed from the machine's "today" (weeks start on Monday).
  function ranges() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7; // 0 = Monday
    const sunday = addDays(today, 6 - dow);
    const nextMon = addDays(sunday, 1), nextSun = addDays(sunday, 7);
    return {
      week: [isoDate(today), isoDate(sunday)],
      nextweek: [isoDate(nextMon), isoDate(nextSun)],
      month: [isoDate(today), isoDate(addDays(today, 30))],
      all: [isoDate(today), "9999-12-31"],
      new: [isoDate(today), "9999-12-31"],
    };
  }
  function isNew(e) {
    if (!e.first_seen || e.first_seen === "baseline") return false;
    const age = (Date.now() - parseISO(e.first_seen).getTime()) / 864e5;
    return age <= (DATA.new_window_days || 7);
  }

  // ------------------------------------------------------------ filtering
  function inTab(e, tab) {
    const [a, b] = ranges()[tab];
    if (e.date < a || e.date > b) return false;
    if (tab === "new" && !isNew(e)) return false;
    return true;
  }
  function baseFilter(e) {
    if (!state.others && !e.is_music) return false;
    if (state.venue && e.venue !== state.venue) return false;
    if (state.free && !e.free) return false;
    if (state.genres.length && !e.genres.some(g => state.genres.includes(g))) return false;
    if (state.q) {
      const q = norm(state.q);
      if (!norm(`${e.title} ${e.venue} ${e.raw_genre || ""} ${e.description || ""}`).includes(q)) return false;
    }
    if (state.near && me) {
      if (e.lat == null || e.lon == null) return false;
      if (km(me, e) > Number(state.radius)) return false;
    }
    return true;
  }
  function visible() { return DATA.events.filter(e => baseFilter(e) && inTab(e, state.tab)); }

  // ------------------------------------------------------------ rendering
  function renderTabs() {
    $$("#tabs button").forEach(b => {
      const t = b.dataset.tab;
      b.classList.toggle("on", t === state.tab);
      b.querySelector("b").textContent = DATA.events.filter(e => baseFilter(e) && inTab(e, t)).length;
    });
  }
  function renderGenres() {
    const counts = {};
    DATA.events.filter(e => inTab(e, state.tab) && (state.others || e.is_music)).forEach(e => e.genres.forEach(g => counts[g] = (counts[g] || 0) + 1));
    $("#genres").innerHTML = DATA.tags.map(t =>
      `<button class="chip ${state.genres.includes(t) ? "on" : ""}" data-g="${t}">${TAG_LABELS[t] || t}<small>${counts[t] || 0}</small></button>`).join("");
  }
  function renderVenues() {
    const sel = $("#venue");
    const cur = state.venue;
    sel.innerHTML = '<option value="">Toutes les salles</option>' + DATA.venues.map(v => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  }
  function tagHtml(e) {
    return e.genres.map(g => `<span class="tag src-${e.genre_source || ""}" title="source : ${e.genre_source || "?"}">${TAG_LABELS[g] || g}</span>`).join("");
  }
  function badges(e) {
    const b = [];
    if (isNew(e)) b.push('<span class="badge new">nouveau</span>');
    if (e.free) b.push('<span class="badge free">gratuit</span>');
    if (e.sold_out) b.push('<span class="badge sold">complet</span>');
    if (e.cancelled) b.push('<span class="badge cancel">annulé</span>');
    if (!e.is_music) b.push('<span class="badge other">non-concert</span>');
    return b.join("");
  }
  function renderList() {
    let evs = visible();
    if (state.near && me) evs = evs.slice().sort((a, b) => a.date.localeCompare(b.date) || km(me, a) - km(me, b));
    const list = $("#list");
    if (!evs.length) {
      list.innerHTML = `<div class="empty">Rien pour ces filtres. ${DATA.events.length ? "" : "Lance <code>python scrape.py</code> pour remplir la liste."}</div>`;
      return;
    }
    let html = "", day = null;
    for (const e of evs) {
      if (e.date !== day) { day = e.date; html += `<div class="day">${fmtDay(day)}</div>`; }
      const dist = state.near && me && e.lat != null ? ` · ${km(me, e).toFixed(1)} km` : "";
      html += `<div class="ev ${e.is_music ? "" : "other"}" data-id="${e.id}">
        <div class="time">${e.time || "—"}</div>
        <div>
          <div class="title">${esc(e.title)}</div>
          <div class="sub"><span>${esc(e.venue)}${dist}</span>${e.price && !e.free ? `<span>${esc(e.price)}</span>` : ""}${badges(e)}</div>
        </div>
        <div class="tags">${tagHtml(e)}</div>
      </div>`;
    }
    const failed = (DATA.report || []).filter(r => !r.ok);
    if (failed.length) {
      html += `<details class="report"><summary>${failed.length} source(s) en erreur au dernier scraping</summary>${failed.map(r => `<div>${esc(r.venue)} — ${esc(r.error)}</div>`).join("")}</details>`;
    }
    list.innerHTML = html;
  }
  function render() { renderTabs(); renderGenres(); renderList(); save(); }

  // ------------------------------------------------------------ detail sheet
  const detail = $("#detail");
  function openDetail(e) {
    detail.hidden = false;
    history.replaceState(null, "", "#e=" + e.id);
    document.body.style.overflow = "hidden";
    $("#hero").style.backgroundImage = e.image ? `url("${e.image}")` : "";
    $("#hero-text").innerHTML = `<div class="when">${fmtDay(e.date)}${e.time ? " · " + e.time : ""}</div>
      <h2>${esc(e.title)}</h2><div class="where">${esc(e.venue)}${e.address ? " · " + esc(e.address) : ""}</div>`;
    const artists = splitArtists(e.title);
    const ticket = safeUrl(e.ticket_url), page = safeUrl(e.url);
    const link = ticket || page;
    $("#detail-body").innerHTML = `
      <div class="actions">
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${ticket ? "Billets" : "Page de la salle"} ↗</a>` : ""}
        ${ticket && page ? `<a class="secondary" href="${esc(page)}" target="_blank" rel="noopener">Page de la salle ↗</a>` : ""}
        ${e.lat != null ? `<a class="secondary" href="https://www.google.com/maps?q=${e.lat},${e.lon}" target="_blank" rel="noopener">Itinéraire</a>` : ""}
      </div>
      <div class="muted">${tagHtml(e)} ${e.raw_genre ? "· " + esc(e.raw_genre) : ""} ${e.price && !e.free ? "· " + esc(e.price) : ""} ${badges(e)}</div>
      ${e.description ? `<p>${esc(e.description)}</p>` : ""}
      ${artists.length > 1 ? `<div class="artist-pick">${artists.map((a, i) => `<button data-i="${i}" class="${i ? "" : "on"}">${esc(a)}</button>`).join("")}</div>` : ""}
      <div id="artist"></div>`;
    $$(".artist-pick button", detail).forEach(b => b.onclick = () => {
      $$(".artist-pick button", detail).forEach(x => x.classList.remove("on")); b.classList.add("on");
      loadArtist(artists[Number(b.dataset.i)], e);
    });
    if (artists.length) loadArtist(artists[0], e);
  }
  function closeDetail() { detail.hidden = true; document.body.style.overflow = ""; history.replaceState(null, "", location.pathname); }

  // "Jaguar Sun • Sean Nicholas Savage • Yes Please!" -> ["Jaguar Sun", "Sean Nicholas Savage", "Yes Please!"]
  function splitArtists(title) {
    let t = title.replace(/\((.*?)\)/g, " ").replace(/\[(.*?)\]/g, " ");
    t = t.replace(/\b(complet|sold ?out|annul[ée]|report[ée]|nouvelle date|guests?|first part|1ère partie|premi[eè]re partie|release party|tour|tourn[ée]e|live)\b/gi, " ");
    const parts = t.split(/\s*(?:•|\+|\/|\||,|&|\bet\b|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bw\/|\binvite\b|\bwith\b|\s-\s|\s–\s|:)\s*/i)
      .map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length > 1 && !/^\d+$/.test(s));
    return parts.slice(0, 5);
  }

  // Wikipedia (FR then EN) for the blurb, Deezer (JSONP, no key) for picture, player and similar artists.
  const cache = {};
  async function loadArtist(name, e) {
    const box = $("#artist");
    box.innerHTML = `<div class="muted">Recherche de « ${esc(name)} »…</div>`;
    const key = norm(name);
    if (!cache[key]) cache[key] = Promise.all([deezerArtist(name), wikiSummary(name)]).catch(() => [null, null]);
    const [dz, wiki] = await cache[key];
    if ($(".artist-pick .on", detail) && $(".artist-pick .on", detail).textContent !== name) return; // user switched
    if (dz && dz.picture_xl && !e.image) $("#hero").style.backgroundImage = `url("${dz.picture_xl}")`;
    const q = encodeURIComponent(name);
    box.innerHTML = `
      <h3>${esc(name)}</h3>
      ${wiki ? `<p>${esc(wiki.extract)} <a class="muted" href="${esc(wiki.url)}" target="_blank" rel="noopener">Wikipédia ↗</a></p>` : `<p class="muted">Pas de fiche Wikipédia trouvée.</p>`}
      ${dz ? `<div class="player" style="margin-top:12px"><iframe title="Deezer" src="https://widget.deezer.com/widget/dark/artist/${Number(dz.id)}/top_tracks" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" allow="encrypted-media; clipboard-write"></iframe></div>` : ""}
      <div class="links" style="margin-top:10px">
        <a href="https://open.spotify.com/search/${q}" target="_blank" rel="noopener">Spotify</a>
        <a href="https://bandcamp.com/search?q=${q}" target="_blank" rel="noopener">Bandcamp</a>
        <a href="https://www.youtube.com/results?search_query=${q}+live" target="_blank" rel="noopener">YouTube</a>
        ${dz ? `<a href="${esc(dz.link)}" target="_blank" rel="noopener">Deezer</a>` : ""}
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
  $("#tabs").onclick = ev => { const b = ev.target.closest("button"); if (!b) return; state.tab = b.dataset.tab; render(); };
  $("#genres").onclick = ev => {
    const b = ev.target.closest(".chip"); if (!b) return;
    const g = b.dataset.g;
    state.genres = state.genres.includes(g) ? state.genres.filter(x => x !== g) : [...state.genres, g];
    render();
  };
  $("#venue").onchange = ev => { state.venue = ev.target.value; render(); };
  $("#free").onchange = ev => { state.free = ev.target.checked; render(); };
  $("#others").onchange = ev => { state.others = ev.target.checked; render(); };
  $("#search").oninput = ev => { state.q = ev.target.value.trim(); render(); };
  $("#reset").onclick = () => { state = { ...state, genres: [], venue: "", free: false, others: false, q: "", near: false }; syncInputs(); render(); };
  $("#radius").onchange = ev => { state.radius = ev.target.value; render(); };
  $("#near").onclick = () => {
    if (state.near) { state.near = false; syncInputs(); render(); return; }
    if (!navigator.geolocation) { alert("Géolocalisation indisponible"); return; }
    $("#near").textContent = "📍 …";
    navigator.geolocation.getCurrentPosition(pos => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.near = true; syncInputs(); render();
    }, () => { $("#near").textContent = "📍 Près de moi"; alert("Position refusée"); }, { timeout: 10000 });
  };
  $("#list").onclick = ev => { const row = ev.target.closest(".ev"); if (!row) return; const e = DATA.events.find(x => x.id === row.dataset.id); if (e) openDetail(e); };
  $("#close").onclick = closeDetail;
  detail.onclick = ev => { if (ev.target === detail) closeDetail(); };
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !detail.hidden) closeDetail(); });

  function syncInputs() {
    $("#venue").value = state.venue; $("#free").checked = state.free; $("#others").checked = state.others;
    $("#search").value = state.q; $("#radius").value = state.radius;
    $("#near").classList.toggle("on", state.near); $("#near").textContent = state.near ? "📍 Actif" : "📍 Près de moi";
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
    $("#meta").textContent = `${d.events.length} événements · mis à jour ${new Date(d.generated_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}`;
    renderVenues(); syncInputs(); render();
    const m = location.hash.match(/^#e=([a-f0-9]+)/);   // shareable link straight to a concert
    const linked = m && d.events.find(x => x.id === m[1]);
    if (linked) openDetail(linked);
  });
})();
