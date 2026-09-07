#!/usr/bin/env python3
"""Serve the web UI on http://localhost:8765 (add --scrape to refresh events first)."""
import argparse
import functools
import http.server
import os
import sys
import webbrowser

from livemusic.config import load_dotenv

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from web/, never cached (events.json changes after every scrape)."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--scrape", action="store_true", help="run the scraper before serving")
    p.add_argument("--no-browser", action="store_true")
    a = p.parse_args()
    load_dotenv()
    if a.scrape:
        from livemusic import pipeline
        pipeline.run()
    handler = functools.partial(Handler, directory=WEB)
    Handler.extensions_map[".js"] = "application/javascript"
    srv, port = None, a.port
    for port in range(a.port, a.port + 10):  # the requested port may be held by a previous run
        try:
            srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
            break
        except OSError:
            print(f"port {port} busy, trying {port + 1}")
    if srv is None:
        sys.exit(f"no free port between {a.port} and {a.port + 9}")
    url = f"http://localhost:{port}/"
    print(f"Serving {WEB} at {url}")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
