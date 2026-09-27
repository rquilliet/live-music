"""Scrape report kept between runs: web/status.json, read by web/status/ (REM-45).

{"generated_at": UTC time of the last run, "today": Paris date, "duration_s", "run_url": GitHub Actions log,
 "cost": {"usd", "steps": [{"what", "model", "batch", "calls", "tokens_in", "tokens_out", "usd"}]}: what Claude
         cost today, every run of the day and the troubleshooting agent included (livemusic/usage.py, REM-55),
 "sources": [{"venue", "slug", "strategy", "url", "status": "ok" | "low" | "failed", "count", "error",
              "prev_count": count at the success before this run, "last_ok": date of the last success,
              "failing_since": first day of the current run of failures, "carried": events kept from last_ok,
              "seconds", "checked_at"}],
 "history": [{"date", "run_url", "usd", "sources": {slug: count, or the error of a failed source}}],   newest first
 "fixes": [...]}   what the troubleshooting agent repaired (REM-49)

A run on a subset (--only) updates its sources and leaves the others as the last run saw them; its cost
is added to the day's.
"""
import datetime as dt
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(ROOT, "web", "status.json")
HISTORY_DAYS = 14
FIXES_KEPT = 30


def load(path=None):
    try:
        with open(path or PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write(status, path=None):
    path = path or PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=1)


def run_url(env=None):
    """The log of the GitHub Actions run we are in, None on a laptop."""
    env = os.environ if env is None else env
    if not (env.get("GITHUB_RUN_ID") and env.get("GITHUB_REPOSITORY")):
        return None
    return f"{env.get('GITHUB_SERVER_URL', 'https://github.com')}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}"


def add_cost(status, cost, today):
    """Add {"usd", "steps"} to what the day already cost, in the header and in the day's row of the history."""
    stamp = today if isinstance(today, str) else today.isoformat()
    day = status.get("cost") or {}
    day = dict(day) if day.get("date") == stamp else {"date": stamp, "usd": 0, "steps": []}
    if cost and cost.get("steps"):
        day["steps"] = day["steps"] + cost["steps"]
        day["usd"] = round(sum(s.get("usd") or 0 for s in day["steps"]), 4)
    status["cost"] = day
    for h in status.get("history", []):
        if h.get("date") == stamp:
            h["usd"] = day["usd"]
    return status


def build(scraped, report, state, today, previous=None, timings=None, duration=None, low=3, now=None, url=None,
          cost=None, partial=False, active=None):
    """scraped: the venue configs of this run; report: pipeline.run's; state: seen.json as it was
    *before* the run (counts and dates of the previous successes); previous: the last status.json;
    cost: usage.totals(); partial: a run on a subset; active: the slugs venues.json still scrapes."""
    previous, timings = previous or {}, timings or {}
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = url if url is not None else run_url()
    stamp = today.isoformat()
    by_name = {v["name"]: v for v in scraped}
    before = {s["slug"]: s for s in previous.get("sources", [])}
    fresh = {}
    for r in report:
        v = by_name.get(r["venue"])
        if not v:
            continue
        was = before.get(v["slug"], {})
        last_ok = state.get("last_ok", {}).get(v["name"]) or was.get("last_ok")
        s = {"venue": v["name"], "slug": v["slug"], "strategy": v["strategy"], "url": v.get("url"),
             "prev_count": state.get("counts", {}).get(v["name"]), "seconds": timings.get(v["name"]), "checked_at": now}
        if r["ok"]:
            # a venue site with next to nothing is a moved URL more often than a thin programme
            thin = r["count"] < low and v["strategy"] != "opendata"
            s.update(status="low" if thin else "ok", count=r["count"], last_ok=stamp)
        else:
            if was.get("status") == "failed" and was.get("failing_since"):
                since = was["failing_since"]
            elif last_ok and not was:   # no report of the days in between: the day after the last success
                since = min(stamp, (dt.date.fromisoformat(last_ok) + dt.timedelta(days=1)).isoformat())
            else:
                since = stamp
            s.update(status="failed", error=r["error"], last_ok=last_ok, failing_since=since, carried=r.get("carried", 0))
        fresh[v["slug"]] = s

    if active is not None:   # a venue removed or switched off must not stay "failed" for ever
        before = {slug: s for slug, s in before.items() if slug in active}
    order = list(before) if partial else [v["slug"] for v in scraped]
    order += [slug for slug in list(fresh) + list(before) if slug not in order]
    sources = [fresh.get(slug) or before[slug] for slug in order if slug in fresh or slug in before]

    today_row = {"date": stamp, "run_url": url, "usd": 0, "sources": {}}
    history = [h for h in previous.get("history", []) if h.get("date") != stamp]
    for h in previous.get("history", []):
        if h.get("date") == stamp:   # second run of the day: keep what it does not cover
            today_row["sources"].update(h.get("sources", {}))
    today_row["sources"].update({slug: s["count"] if s["status"] != "failed" else s["error"] for slug, s in fresh.items()})
    oldest = (today - dt.timedelta(days=HISTORY_DAYS - 1)).isoformat()
    history = sorted([today_row] + [h for h in history if oldest <= h.get("date", "") < stamp],
                     key=lambda h: h["date"], reverse=True)
    if partial and previous.get("today") == stamp:   # the header stays the full run's
        now, duration, url = previous.get("generated_at", now), previous.get("duration_s"), previous.get("run_url")
    status = {"generated_at": now, "today": stamp, "duration_s": duration, "run_url": url, "low_below": low,
              "cost": previous.get("cost"), "sources": sources, "history": history,
              "fixes": previous.get("fixes", [])[:FIXES_KEPT]}
    return add_cost(status, cost, stamp)


def failing(status):
    return [s for s in status.get("sources", []) if s.get("status") == "failed"]
