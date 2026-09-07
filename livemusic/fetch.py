"""HTTP fetching with a browser-like User-Agent and an on-disk cache."""
import gzip
import hashlib
import json
import os
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "cache")
CACHE_TTL = 6 * 3600  # seconds
FRESH = False  # set by CLI --fresh to bypass the cache


class FetchError(Exception):
    pass


def _cache_path(url: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".cache")


def get(url: str, accept: str = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        timeout: int = 25, retries: int = 2) -> str:
    """Return the body of `url` as text. Cached for CACHE_TTL unless FRESH."""
    path = _cache_path(url)
    if not FRESH and os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": accept,
            "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                charset = resp.headers.get_content_charset() or "utf-8"
                body = raw.decode(charset, errors="replace")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(body)
                return body
        except urllib.error.HTTPError as e:
            last = FetchError(f"HTTP {e.code} for {url}")
            if e.code in (403, 404, 406, 410):
                break
        except Exception as e:  # timeouts, DNS, TLS
            last = FetchError(f"{type(e).__name__}: {e} for {url}")
        time.sleep(1.5 * (attempt + 1))
    raise last


def get_json(url: str, **kw):
    return json.loads(get(url, accept="application/json", **kw))
