#!/usr/bin/env python3
"""Refresh web/events.json from every configured source.

  python scrape.py                 # all venues, LLM tagging if ANTHROPIC_API_KEY is set
  python scrape.py --no-llm        # skip Claude (genres from site tags + keyword rules only)
  python scrape.py --only cigale bataclan opendata   # subset (venue slugs or strategy names)
  python scrape.py --fresh         # ignore the 6h page cache
"""
import argparse
import sys

from livemusic import fetch, pipeline
from livemusic.config import load_dotenv


def main():
    sys.stdout.reconfigure(line_buffering=True)  # readable progress when piped to a log file
    load_dotenv()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", nargs="*", help="venue slugs or strategy names to run")
    p.add_argument("--no-llm", action="store_true", help="never call the Claude API")
    p.add_argument("--fresh", action="store_true", help="bypass the HTTP cache")
    a = p.parse_args()
    fetch.FRESH = a.fresh
    out = pipeline.run(only=set(a.only) if a.only else None, use_llm=not a.no_llm)
    failed = [r for r in out["report"] if not r["ok"]]
    if failed:
        print(f"{len(failed)} source(s) failed: " + ", ".join(r["venue"] for r in failed), file=sys.stderr)
        sys.exit(1)  # let cron / launchd notice


if __name__ == "__main__":
    main()
