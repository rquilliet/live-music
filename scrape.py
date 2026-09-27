#!/usr/bin/env python3
"""Refresh web/events.json from every configured source.

  python scrape.py                 # all venues, LLM tagging if ANTHROPIC_API_KEY is set
  python scrape.py --no-llm        # skip Claude (genres from site tags + keyword rules only)
  python scrape.py --no-players    # skip the Bandcamp / Spotify artist lookups
  python scrape.py --only cigale bataclan opendata   # subset (venue slugs or strategy names)
  python scrape.py --fresh         # ignore the 6h page cache
  python scrape.py --only cigale --patch   # scrape La Cigale again, keep the rest of the last programme
  python scrape.py --check cigale  # try one source and print the result as JSON, nothing is written
"""
import argparse
import json
import sys

from livemusic import fetch, pipeline
from livemusic.config import load_dotenv


def main():
    sys.stdout.reconfigure(line_buffering=True)  # readable progress when piped to a log file
    load_dotenv()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", nargs="*", help="venue slugs or strategy names to run")
    p.add_argument("--no-llm", action="store_true", help="never call the Claude API")
    p.add_argument("--no-players", action="store_true", help="skip the Bandcamp / Spotify artist lookups")
    p.add_argument("--fresh", action="store_true", help="bypass the HTTP cache")
    p.add_argument("--patch", action="store_true", help="with --only: keep the events of the other sources")
    p.add_argument("--check", metavar="SLUG", help="scrape one source, print JSON, write nothing")
    a = p.parse_args()
    if a.patch and not a.only:
        p.error("--patch needs --only")
    fetch.FRESH = a.fresh
    if a.check:
        fetch.FRESH = True
        res = pipeline.check(a.check, log=lambda m: print(m, file=sys.stderr))
        print(json.dumps(res, ensure_ascii=False))
        sys.exit(0 if res["ok"] else 1)
    out = pipeline.run(only=set(a.only) if a.only else None, use_llm=not a.no_llm, players=not a.no_players,
                       patch=a.patch)
    if a.patch:   # the day's report holds sources this run did not touch: only ours decide the exit code
        ours = {v["name"] for v in pipeline.load_venues() if v["slug"] in a.only or v["strategy"] in a.only}
        out["report"] = [r for r in out["report"] if r["venue"] in ours]
    failed = [r for r in out["report"] if not r["ok"]]
    if failed:
        print(f"{len(failed)} source(s) failed: " + ", ".join(r["venue"] for r in failed), file=sys.stderr)
        sys.exit(1)  # let cron / launchd notice


if __name__ == "__main__":
    main()
