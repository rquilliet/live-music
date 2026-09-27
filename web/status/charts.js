/* Charts of the status page (REM-68): what Claude cost (a day, a month, since the start) and the sources connected
   over time. Reads timeline.json, one row per day, kept up to date by livemusic/status.py at every scrape. */
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fmtDay = s => { const d = parseISO(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const fmtShort = s => { const d = parseISO(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const fmtMonth = (m, long) => { const [y, n] = m.split("-").map(Number); return `${MONTHS[n - 1]}${long ? " " + y : " " + String(y).slice(2)}`; };
  const usd = n => "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : Number(n).toFixed(2));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const MAX_DAYS = 92;   // the daily views show the last three months, the monthly one everything
  const VIEWS = [["daily", "Daily"], ["monthly", "Monthly"], ["total", "Cumulative"]];

  let ALL = [], view = "daily";
  try { view = localStorage.getItem("lip-status-cost") || "daily"; } catch (e) { /* private mode */ }
  if (!VIEWS.some(v => v[0] === view)) view = "daily";

  // One entry per calendar day from the first scrape to the last: a day without a scrape keeps the sources
  // connected of the day before, answered nothing and cost nothing that we know of.
  function calendar(rows) {
    const by = {}, out = [];
    rows.forEach(r => { if (r && /^\d{4}-\d\d-\d\d$/.test(r.date || "")) by[r.date] = r; });
    const dates = Object.keys(by).sort();
    if (!dates.length) return out;
    let connected = 0;
    for (let d = parseISO(dates[0]); iso(d) <= dates[dates.length - 1]; d.setDate(d.getDate() + 1)) {
      const r = by[iso(d)];
      if (r && typeof r.sources === "number") connected = r.sources;
      out.push({ date: iso(d), ran: !!r, sources: connected, ok: r && typeof r.ok === "number" ? r.ok : null,
        usd: r && typeof r.usd === "number" ? r.usd : null, first: r && typeof r.first === "number" ? r.first : null });
    }
    return out;
  }

  function months(days) {
    const by = {};
    days.forEach(d => {
      const m = by[d.date.slice(0, 7)] = by[d.date.slice(0, 7)] || { month: d.date.slice(0, 7), usd: null, measured: 0, sources: 0 };
      if (d.usd != null) { m.usd = (m.usd || 0) + d.usd; m.measured++; }
      m.sources = d.sources;
    });
    return Object.keys(by).sort().map(k => by[k]);
  }

  const nice = raw => { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const column = (x, y, w, h) => { const r = Math.min(4, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

  /* The frame shared by the charts: gridlines, ticks, and one tooltip that follows the pointer.
     o: {n, max, bars, fmt(v), label(i), draw(g) -> svg, tip(i) -> {title, rows: [{color, name, value}]}, dots(i) -> [{v, color}]} */
  function plot(el, o) {
    const W = Math.max(260, el.clientWidth), H = 196, L = 46, R = 14, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const step = o.whole ? Math.max(1, Math.round(nice(Math.max(o.max, 1) / 4))) : nice(Math.max(o.max, 1e-6) / 4);
    const top = Math.max(step, Math.ceil(o.max / step - 1e-9) * step);
    const y = v => T + ph - v / top * ph;
    const band = o.bars ? pw / o.n : o.n > 1 ? pw / (o.n - 1) : 0;
    const x = i => o.bars ? L + band * (i + .5) : o.n > 1 ? L + band * i : L + pw / 2;
    let s = "";
    for (let j = 0; j <= Math.round(top / step); j++) {
      const v = j * step;
      s += `<line class="grid${j ? "" : " base"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(o.fmt(v))}</text>`;
    }
    const every = Math.max(1, Math.ceil(o.n / Math.max(1, Math.floor(pw / 62))));
    for (let i = o.n - 1; i >= 0; i -= every) {
      const last = i === o.n - 1 && o.n > 1;
      s += `<text class="tick" x="${last ? Math.min(W - 2, x(i) + 18) : x(i)}" y="${H - 7}" text-anchor="${last ? "end" : "middle"}">${esc(o.label(i))}</text>`;
    }
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">${s}` +
      `<line class="cross" y1="${T}" y2="${T + ph}" visibility="hidden"/>${o.draw({ x, y, band, base: T + ph })}<g class="hov"></g></svg><div class="tip" hidden></div>`;
    const svg = el.firstChild, tip = el.lastChild, cross = svg.querySelector(".cross"), hov = svg.querySelector(".hov");

    function show(e) {
      const px = e.clientX - svg.getBoundingClientRect().left;
      const i = Math.max(0, Math.min(o.n - 1, o.bars ? Math.floor((px - L) / band) : band ? Math.round((px - L) / band) : 0));
      svg.classList.add("hover");
      svg.querySelectorAll("[data-i]").forEach(m => m.classList.toggle("on", Number(m.dataset.i) === i));
      if (!o.bars) {
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        hov.innerHTML = (o.dots ? o.dots(i) : []).filter(d => d.v != null).map(d => `<circle class="dot" cx="${x(i)}" cy="${y(d.v)}" r="5" fill="${d.color}"/>`).join("");
      }
      const t = o.tip(i);
      tip.textContent = "";
      const h = document.createElement("b"); h.textContent = t.title; tip.appendChild(h);
      t.rows.forEach(r => {
        const row = document.createElement("div"), v = document.createElement("strong"), n = document.createElement("span");
        if (r.color) {   // the tooltip is ink: the key of the ink series is drawn in paper
          const k = document.createElement("i");
          k.style.background = r.color === "var(--ink)" ? "var(--paper)" : r.color;
          row.appendChild(k);
        }
        v.textContent = r.value; n.textContent = r.name; row.appendChild(v); row.appendChild(n); tip.appendChild(row);
      });
      tip.hidden = false;
      const w = tip.offsetWidth, left = x(i) + 14 + w > W ? x(i) - 14 - w : x(i) + 14;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = T + "px";
    }
    function hide() {
      svg.classList.remove("hover"); tip.hidden = true; hov.innerHTML = ""; cross.setAttribute("visibility", "hidden");
      svg.querySelectorAll(".on").forEach(m => m.classList.remove("on"));
    }
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointerleave", hide);
  }

  // a line through the points that exist; a day without a value breaks it
  function path(values, g, stepped) {
    let d = "", pen = false, before = null;
    values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += !pen ? `M${g.x(i)},${g.y(v)}` : stepped ? `H${g.x(i)}V${g.y(v)}` : `L${g.x(i)},${g.y(v)}`;
      pen = true; before = i;
    });
    return { d, last: before };
  }

  function renderCost() {
    const all = calendar(ALL), days = all.slice(-MAX_DAYS), measured = all.filter(d => d.usd != null);
    const el = $("#cost .plot"), today = all[all.length - 1];
    const sum = l => l.reduce((t, d) => t + d.usd, 0);
    const month = today.date.slice(0, 7), inMonth = measured.filter(d => d.date.startsWith(month));
    const week = measured.filter(d => d.date > iso(new Date(parseISO(today.date).getTime() - 7 * 864e5 + 36e5)));
    const stat = (v, label, small) => `<div class="stat"><b>${v}</b><span>${label}</span>${small ? `<small>${small}</small>` : ""}</div>`;
    $("#cost .stats").innerHTML =
      stat(today.usd != null ? usd(today.usd) : "—", today.usd != null ? `last scrape, ${esc(fmtShort(today.date))}` : "last scrape: not measured") +
      stat(week.length ? usd(sum(week)) : "—", "last 7 days", week.length ? `${plural(week.length, "day")} measured` : "") +
      stat(inMonth.length ? usd(sum(inMonth)) : "—", `${esc(fmtMonth(month, true))} so far`, inMonth.length ? `${usd(sum(inMonth) / inMonth.length)} a day` : "") +
      stat(measured.length ? usd(sum(measured)) : "—", "since inception", measured.length ? `${plural(measured.length, "day")} measured` : "");
    $("#cost .note").textContent = !measured.length ? "Claude's cost is not measured yet: it is logged at the end of every scrape."
      : measured[0].date > all[0].date ? `Measured since ${fmtDay(measured[0].date)} (usage log of every Claude call); the days before it are shown as not measured, not as $0.` : "";
    $("#cost .seg").innerHTML = VIEWS.map(([k, t]) => `<button type="button" data-v="${k}" aria-pressed="${view === k}">${t}</button>`).join("");
    if (!measured.length) { el.innerHTML = `<p class="empty">Nothing to draw yet.</p>`; return; }

    if (view === "monthly") {
      const ms = months(all);
      plot(el, { title: "Claude cost per month", bars: true, n: ms.length, max: Math.max(...ms.map(m => m.usd || 0)), fmt: tick,
        label: i => fmtMonth(ms[i].month), draw: g => columns(ms.map(m => m.usd), g),
        tip: i => ({ title: fmtMonth(ms[i].month, true), rows: ms[i].usd == null ? [{ value: "—", name: "not measured" }]
          : [{ color: "var(--ink)", value: usd(ms[i].usd), name: `over ${plural(ms[i].measured, "day")}` }, { value: usd(ms[i].usd / ms[i].measured), name: "a day" }] }) });
    } else if (view === "total") {
      let run = 0;
      const from = all.findIndex(d => d.usd != null), line = all.slice(from).slice(-MAX_DAYS).map(d => ({ date: d.date, usd: d.usd }));
      const before = sum(measured) - sum(line.filter(d => d.usd != null));   // what the days left of the chart cost
      run = before;
      line.forEach(d => { run += d.usd || 0; d.total = run; });
      plot(el, { title: "Claude cost, cumulated since the first measure", n: line.length, max: run, fmt: tick, label: i => fmtShort(line[i].date),
        draw: g => {
          const p = path(line.map(d => d.total), g), end = line.length - 1;
          return (line.length > 1 ? `<path class="wash" d="${p.d}V${g.base}H${g.x(0)}Z"/><path class="line" d="${p.d}"/>` : "") +
            `<circle class="dot" cx="${g.x(end)}" cy="${g.y(run)}" r="5" fill="var(--ink)"/>`;
        },
        dots: i => [{ v: line[i].total, color: "var(--ink)" }],
        tip: i => ({ title: fmtDay(line[i].date), rows: [{ color: "var(--ink)", value: usd(line[i].total), name: "since inception" },
          { value: line[i].usd == null ? "—" : usd(line[i].usd), name: line[i].usd == null ? "that day: not measured" : "that day" }] }) });
    } else {
      plot(el, { title: "Claude cost per day", bars: true, n: days.length, max: Math.max(...days.map(d => d.usd || 0)), fmt: tick,
        label: i => fmtShort(days[i].date), draw: g => columns(days.map(d => d.usd), g),
        tip: i => ({ title: fmtDay(days[i].date), rows: [days[i].usd == null ? { value: "—", name: days[i].ran ? "not measured" : "no scrape that day" }
          : { color: "var(--ink)", value: usd(days[i].usd), name: "Claude" }] }) });
    }
  }
  const tick = v => "$" + (Number.isInteger(v) ? v : v.toFixed(Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 3 : 2));
  function columns(values, g) {
    const w = Math.max(1, Math.min(24, g.band - 2));
    return values.map((v, i) => v == null ? `<rect class="col none" data-i="${i}" x="${g.x(i) - w / 2}" y="${g.base - 2}" width="${w}" height="2"/>`
      : `<path class="col" data-i="${i}" d="${column(g.x(i) - w / 2, Math.min(g.y(v), g.base - 1), w, Math.max(1, g.base - g.y(v)))}"/>`).join("");
  }

  function renderSources() {
    const all = calendar(ALL), days = all.slice(-MAX_DAYS), today = all[all.length - 1], first = all[0];
    const start = first.first != null ? first.first : first.sources;
    const lastRun = [...all].reverse().find(d => d.ok != null);
    const stat = (v, label, small) => `<div class="stat"><b>${v}</b><span>${label}</span>${small ? `<small>${small}</small>` : ""}</div>`;
    const age = Math.round((parseISO(today.date) - parseISO(first.date)) / 864e5) + 1;
    $("#sources .stats").innerHTML = stat(today.sources, "sources connected", today.sources > start ? `+${today.sources - start} since the first commit` : "") +
      stat(lastRun ? lastRun.ok : "—", "answered at the last scrape", lastRun ? esc(fmtShort(lastRun.date)) : "") +
      stat(start, "at launch", `${esc(fmtShort(first.date))} · ${plural(age, "day")} ago`);
    const lead = days[0] === first && first.first != null;   // the day of the launch: from the first commit to the evening
    plot($("#sources .plot"), { title: "Sources connected and sources that answered, per day", n: days.length, whole: true,
      max: Math.max(...days.map(d => d.sources)), fmt: v => String(Math.round(v)), label: i => fmtShort(days[i].date),
      draw: g => {
        const c = path(days.map(d => d.sources), g, true), ok = path(days.map(d => d.ok), g);
        const d = lead ? `M${g.x(0)},${g.y(first.first)}V${g.y(first.sources)}` + c.d.replace(/^M[^HVL]*/, "") : c.d;
        // a scrape between two days without one is a point on its own, that no line would show
        const alone = days.map((x, i) => x.ok != null && (!days[i - 1] || days[i - 1].ok == null) && (!days[i + 1] || days[i + 1].ok == null)
          ? `<circle cx="${g.x(i)}" cy="${g.y(x.ok)}" r="3" fill="var(--ok)"/>` : "").join("");
        return `<path class="line ok" d="${ok.d}"/>${alone}` + (ok.last != null ? `<circle class="dot" cx="${g.x(ok.last)}" cy="${g.y(days[ok.last].ok)}" r="5" fill="var(--ok)"/>` : "") +
          `<path class="line" d="${d}"/><circle class="dot" cx="${g.x(days.length - 1)}" cy="${g.y(today.sources)}" r="5" fill="var(--ink)"/>`;
      },
      dots: i => [{ v: days[i].ok, color: "var(--ok)" }, { v: days[i].sources, color: "var(--ink)" }],
      tip: i => ({ title: fmtDay(days[i].date), rows: [{ color: "var(--ink)", value: String(days[i].sources), name: "connected" },
        { color: "var(--ok)", value: days[i].ok == null ? "—" : String(days[i].ok), name: days[i].ok == null ? "no scrape that day" : "answered" }] }) });
  }

  // every figure of the charts, for who cannot hover
  function renderTable() {
    const all = calendar(ALL), ms = months(all).reverse();
    const money = v => v == null ? `<span class="na">not measured</span>` : usd(v);
    $("#figures").innerHTML = `<summary>Show the figures as a table</summary><div class="tables">` +
      `<table><caption>Per month</caption><thead><tr><th>Month</th><th>Claude cost</th><th>Days measured</th><th>Sources connected</th></tr></thead><tbody>` +
      ms.map(m => `<tr><td>${esc(fmtMonth(m.month, true))}</td><td>${money(m.usd)}</td><td>${m.measured}</td><td>${m.sources}</td></tr>`).join("") + `</tbody></table>` +
      `<table><caption>Per day</caption><thead><tr><th>Day</th><th>Claude cost</th><th>Sources connected</th><th>Answered</th></tr></thead><tbody>` +
      [...all].reverse().map(d => `<tr><td>${esc(fmtDay(d.date))} ${d.date.slice(0, 4)}</td><td>${d.ran ? money(d.usd) : `<span class="na">no scrape</span>`}</td><td>${d.sources}</td><td>${d.ok == null ? "—" : d.ok}</td></tr>`).join("") +
      `</tbody></table></div>`;
  }

  function render() {
    if (!calendar(ALL).length) return;
    $("#trends").hidden = false;
    renderCost(); renderSources(); renderTable();
  }

  $("#cost .seg").addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    view = b.dataset.v;
    try { localStorage.setItem("lip-status-cost", view); } catch (err) { /* private mode */ }
    renderCost();
  });
  // the charts are drawn at the width of their card: draw them again when it changes
  let timer = 0, width = 0;
  const redraw = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const w = $("#cost .plot").clientWidth; if (w && w !== width && !$("#trends").hidden) { width = w; renderCost(); renderSources(); } }, 120);
  };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($("#trends")); else window.addEventListener("resize", redraw);

  fetch("../timeline.json?t=" + Date.now()).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(rows => { ALL = Array.isArray(rows) ? rows : []; render(); })
    .catch(() => { /* no timeline yet: the page stays as it was */ });
})();
