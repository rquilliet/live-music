/* Scraper status page (REM-45): reads status.json written by livemusic/status.py at the end of every scrape. */
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const LABEL = { ok: "OK", low: "Low", failed: "Failed" };
  const ORDER = { failed: 0, low: 1, ok: 2 };
  const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDay = s => { if (!s) return ""; const d = parseISO(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const usd = n => "$" + (n >= 100 ? Math.round(n) : Number(n).toFixed(2));
  const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : "";
  // "0 events parsed (was 53): Claude API error 400: …" -> the part shared by every source hit by the same problem
  const cause = e => String(e || "").replace(/^0 events parsed \(was \d+\)(: )?/, "").replace(/ for https?:\/\/\S+$/, "");

  let DATA = null, filter = "all";
  try { filter = localStorage.getItem("lip-status-filter") || "all"; } catch (e) { /* private mode */ }

  function dayState(v, low) {
    if (v === undefined) return "";
    if (typeof v === "string") return "failed";
    return v < low ? "low" : "ok";
  }

  function renderHead() {
    const d = DATA, n = { ok: 0, low: 0, failed: 0 };
    d.sources.forEach(s => n[s.status]++);
    const at = new Date(d.generated_at);
    const when = isNaN(at) ? esc(d.today) : `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const took = d.duration_s ? ` · took ${d.duration_s >= 90 ? Math.round(d.duration_s / 60) + " min" : d.duration_s + " s"}` : "";
    const log = safeUrl(d.run_url) ? ` · <a href="${esc(d.run_url)}" target="_blank" rel="noopener">GitHub Actions log ↗</a>` : "";
    $("#meta").innerHTML = `Last scrape ${when}${took}${log}`;
    $("#tiles").innerHTML =
      `<div class="tile"><b>${d.sources.length}</b><span>sources</span></div>` +
      `<div class="tile ok"><b>${n.ok}</b><span>ok</span></div>` +
      `<div class="tile low"><b>${n.low}</b><span>low coverage (under ${d.low_below || 3} events)</span></div>` +
      `<div class="tile failed"><b>${n.failed}</b><span>failed</span></div>` + costTile();
    // many sources down for one reason is one problem (API credit, network), not as many broken parsers
    const groups = {};
    d.sources.filter(s => s.status === "failed").forEach(s => { const c = cause(s.error); if (c) (groups[c] = groups[c] || []).push(s); });
    $("#cause").innerHTML = Object.entries(groups).filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length)
      .map(([c, l]) => `<div class="cause"><b>${l.length} sources fail for the same reason</b><span>${esc(c)}</span></div>`).join("");
    $("#filters").innerHTML = [["all", "All", d.sources.length], ["failed", "Failed", n.failed], ["low", "Low coverage", n.low], ["ok", "OK", n.ok]]
      .map(([k, t, c]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t} <small>${c}</small></button>`).join("");
  }

  // What Claude cost today (scrape + troubleshooting agent, REM-55 usage log) and over the last 14 days.
  function costTile() {
    const d = DATA, c = d.cost && d.cost.date === d.today ? d.cost : null;
    const by = {};
    ((c && c.steps) || []).forEach(s => { by[s.what] = (by[s.what] || 0) + (s.usd || 0); });
    const parts = Object.entries(by).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${usd(v)}`).join(" · ");
    const hist = [...d.history].reverse(), known = hist.filter(h => typeof h.usd === "number");
    const max = Math.max(0.01, ...known.map(h => h.usd));
    const bars = known.length < 2 ? "" : `<div class="bars" aria-label="Claude cost, last 14 days">` + hist.map(h =>
      typeof h.usd === "number" ? `<i style="height:${Math.max(2, Math.round(h.usd / max * 26))}px" title="${esc(fmtDay(h.date))}: ${usd(h.usd)}"></i>`
        : `<i class="none" title="${esc(fmtDay(h.date))}: not measured"></i>`).join("") + `</div>`;
    const sum = known.reduce((t, h) => t + h.usd, 0);
    return `<div class="tile cost"><b>${c ? usd(c.usd) : "—"}</b><span>Claude today${c ? "" : " (not measured yet)"}</span>` +
      (parts ? `<small>${parts}</small>` : "") + (known.length > 1 ? `<small>${usd(sum)} over ${plural(known.length, "day")}</small>` : "") + bars + `</div>`;
  }

  function row(s) {
    const d = DATA, low = d.low_below || 3;
    const hist = [...d.history].reverse();   // oldest first, today at the right
    const pad = Math.max(0, 14 - hist.length);
    const days = "<i></i>".repeat(pad) + hist.map(h => {
      const v = (h.sources || {})[s.slug], st = s.strategy === "opendata" && typeof v === "number" ? "ok" : dayState(v, low);
      const tip = v === undefined ? "not run" : typeof v === "string" ? v : plural(v, "event");
      return `<i class="${st}" title="${esc(fmtDay(h.date))}: ${esc(tip)}"></i>`;
    }).join("");
    let num;
    if (s.status === "failed") {
      num = `<b>—</b>${s.prev_count != null ? `<small>was ${s.prev_count}</small>` : ""}${s.carried ? `<small>showing ${s.carried} kept</small>` : ""}`;
    } else {
      const diff = s.prev_count != null ? s.count - s.prev_count : 0;
      num = `<b>${s.count}</b>${s.prev_count != null ? `<small>${diff ? `<span class="${diff < 0 ? "down" : "up"}">${diff > 0 ? "+" : "−"}${Math.abs(diff)}</span> vs ${s.prev_count}` : "same as last time"}</small>` : ""}`;
    }
    const why = s.status === "failed" ? esc(s.error)
      : s.status === "low" ? `Only ${plural(s.count, "event")}: programme rendered by JavaScript, or the URL moved?` : "";
    const n = s.failing_since ? daysBetween(s.failing_since, d.today) + 1 : 0;
    const since = s.failing_since ? `${esc(fmtDay(s.failing_since))}<small>${plural(n, "day")}</small>` : "";
    const last = s.status === "failed" ? (s.last_ok ? esc(fmtDay(s.last_ok)) : "<small>never seen working</small>") : "";
    const url = safeUrl(s.url);
    return `<div class="row ${s.status}">
      <div class="cell st"><span class="badge ${s.status}"><i class="dot ${s.status}"></i>${LABEL[s.status]}</span></div>
      <div class="cell src">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.venue)}</a>` : `<b>${esc(s.venue)}</b>`}<small>${esc(s.strategy)}${s.seconds != null ? ` · ${s.seconds} s` : ""}</small></div>
      <div class="cell num"><span class="lab">Events today</span>${num}</div>
      <div class="cell why${why ? "" : " none"}">${why || "—"}</div>
      <div class="cell since">${since ? `<span class="lab">Failing since</span>${since}` : ""}</div>
      <div class="cell last">${last ? `<span class="lab">Last success</span>${last}` : ""}</div>
      <div class="cell days" aria-label="Last 14 days">${days}</div>
    </div>`;
  }

  function renderRows() {
    const list = DATA.sources.map((s, i) => [s, i]).filter(([s]) => filter === "all" || s.status === filter)
      .sort((a, b) => ORDER[a[0].status] - ORDER[b[0].status] || a[1] - b[1]).map(([s]) => s);
    $("#rows").innerHTML = `<div class="head"><span>Status</span><span>Source</span><span>Events today</span><span>Reason</span><span>Failing since</span><span>Last success</span><span>Last 14 days</span></div>` +
      (list.length ? list.map(row).join("") : `<div class="empty">No source in this state.</div>`);
  }

  function renderFixes() {
    const fixes = DATA.fixes || [];
    $("#fixes").innerHTML = !fixes.length ? "" : `<h2>Repairs by the troubleshooting agent</h2>` + fixes.map(f => {
      const c = safeUrl(f.pr_url);
      return `<div class="fix"><b>${esc(f.venue)}</b> · ${esc(fmtDay(f.date))} · ${esc(f.summary)}<br><small>was: ${esc(f.error)}${f.count != null ? ` · now ${plural(f.count, "event")}` : ""}${typeof f.usd === "number" ? ` · cost ${usd(f.usd)}` : ""}${c ? ` · <a href="${esc(c)}" target="_blank" rel="noopener">pull request ↗</a>` : ""}</small></div>`;
    }).join("");
  }

  function render() { renderHead(); renderRows(); renderFixes(); }

  $("#filters").addEventListener("click", e => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    filter = b.dataset.f;
    try { localStorage.setItem("lip-status-filter", filter); } catch (err) { /* private mode */ }
    render();
  });

  fetch("../status.json?t=" + Date.now()).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => { DATA = d; if (!["all", "failed", "low", "ok"].includes(filter)) filter = "all"; render(); })
    .catch(e => { $("#meta").textContent = "No status report yet: it is written at the end of a scrape (" + e.message + ")."; });
})();
