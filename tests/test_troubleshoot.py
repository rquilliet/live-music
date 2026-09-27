import datetime as dt
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

from livemusic import troubleshoot as T

TODAY = dt.date(2026, 9, 27)
CREDIT = "0 events parsed (was 8): Claude API error 400: Your credit balance is too low"


def src(slug, error="HTTP 503", since="2026-09-27", prev=20, status="failed", strategy="cigale", **kw):
    return dict({"venue": slug.title(), "slug": slug, "strategy": strategy, "status": status, "error": error,
                 "failing_since": since, "prev_count": prev, "url": f"https://{slug}.fr/"}, **kw)


class TriageTest(unittest.TestCase):
    def test_shared_cause_is_not_a_parser_problem(self):
        status = {"sources": [src("a", CREDIT), src("b", CREDIT.replace("8", "64")), src("c", "HTTP 418 for https://c.fr/"),
                              src("d", status="ok")]}
        systemic, todo, skipped = T.triage(status, {}, TODAY)
        self.assertEqual([(g["cause"], len(g["sources"])) for g in systemic],
                         [("Claude API error 400: Your credit balance is too low", 2)])
        self.assertEqual([s["slug"] for s in todo], ["c"])
        self.assertEqual(skipped, [])

    def test_three_sources_with_the_same_error(self):
        status = {"sources": [src(s, f"TimeoutError: timed out for https://{s}.fr/") for s in "abc"]}
        systemic, todo, _ = T.triage(status, {}, TODAY)
        self.assertEqual((len(systemic[0]["sources"]), todo), (3, []))

    def test_caps(self):
        status = {"sources": [src(f"s{n}", f"error {n}", since=f"2026-09-{20 + n}") for n in range(8)]}
        state = {"sources": {"s0": {"since": "2026-09-20", "days": ["2026-09-27"]},
                             "s1": {"since": "2026-09-21", "days": ["2026-09-24", "2026-09-25", "2026-09-26"]},
                             "s2": {"since": "2026-08-01", "days": ["2026-08-01", "2026-08-02", "2026-08-03"]}}}
        _, todo, skipped = T.triage(status, state, TODAY)
        self.assertEqual([s["slug"] for s in todo], ["s2", "s3", "s4", "s5", "s6"])   # s2: an older streak does not count
        self.assertEqual([(s["slug"], why.split(",")[0].split(" ")[0]) for s, why in skipped],
                         [("s0", "already"), ("s1", "tried"), ("s7", "over")])

    def test_plausible(self):
        self.assertTrue(T.plausible(18, 20)[0])
        self.assertTrue(T.plausible(3, None)[0])
        self.assertFalse(T.plausible(0, None)[0])
        self.assertFalse(T.plausible(2, 60)[0])
        self.assertFalse(T.plausible(400, 60)[0])
        self.assertTrue(T.plausible(12, 1)[0])


class GuardTest(unittest.TestCase):
    def test_editable(self):
        for f in ["venues.json", "livemusic/sources/venues_html.py", "livemusic/sources/tribe.py"]:
            self.assertTrue(T.EDITABLE.match(f), f)
        for f in ["livemusic/sources/llm.py", "livemusic/sources/opendata.py", "livemusic/sources/__init__.py",
                  "livemusic/sources/new_venue.py", "livemusic/pipeline.py", "tests/test_util.py",
                  ".github/workflows/scrape.yml", "scrape.py", "web/app.js", "livemusic/sources/../fetch.py"]:
            self.assertFalse(T.EDITABLE.match(f), f)

    def test_venues(self):
        old = [{"name": "A", "slug": "a", "strategy": "llm", "url": "https://a.fr/", "lat": 1}, {"name": "B", "slug": "b", "strategy": "llm", "url": "https://b.fr/"}]
        dump = json.dumps

        def after(i, **kw):
            new = [dict(v) for v in old]
            new[i].update(kw)
            return dump(new)

        self.assertEqual(T.guard_venues(dump(old), after(0, url="https://a.fr/agenda", urls=["https://a.fr/agenda"]), "a"), [])
        self.assertEqual(T.guard_venues(dump(old), after(0, strategy="tribe"), "a"), [])
        self.assertIn("entry of b", T.guard_venues(dump(old), after(1, url="https://evil.example/"), "a")[0])
        self.assertIn("lat of a", T.guard_venues(dump(old), after(0, lat=2), "a")[0])
        self.assertIn("switched off", T.guard_venues(dump(old), after(0, strategy="none"), "a")[0])
        self.assertIn("added, removed", T.guard_venues(dump(old), dump(old[:1]), "a")[0])
        self.assertIn("not valid JSON", T.guard_venues(dump(old), "[", "a")[0])

    def test_code(self):
        before = "import re\nimport urllib.parse\n\nfrom ..fetch import get\n\n\ndef cigale(v, ctx):\n    return []\n"
        good = before + "\n\ndef parse(html, venue):\n    import json\n    return [urllib.parse.urljoin(venue['url'], m.group(1)) for m in re.finditer('a', html)]\n"
        self.assertEqual(T.guard_code("x.py", before, good), [])
        for line in ["import os", "import json, os as o", "from pathlib import Path", "from urllib import request as rq",
                     "import re, sys as s", "import subprocess", "x = open('/proc/self/environ')", "x = getattr(re, 'a')",
                     "x = re.__class__", "x = eval('1')", "x = urllib.request", "x = __builtins__", "from .. import fetch"]:
            self.assertEqual(len(T.guard_code("x.py", before, before + line + "\n")), 1, line)
        self.assertIn("does not parse", T.guard_code("x.py", before, "def (:\n")[0])
        # what the file already did is not held against the repair
        self.assertEqual(T.guard_code("x.py", "import os\n", "import os\nimport re\n"), [])


WHO = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}


def sh(root, *args):   # a CI runner has no git identity
    subprocess.run(args, cwd=root, check=True, capture_output=True, env=dict(os.environ, **WHO))


class RunTest(unittest.TestCase):
    """The whole loop in a throw-away repository, the agent and the scraper replaced by functions."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = root = self.tmp.name
        for d in ("livemusic/sources", "data", "web", "tests"):
            os.makedirs(os.path.join(root, d))
        self.venues = [{"name": "Cigale", "slug": "cigale", "strategy": "cigale", "url": "https://cigale.fr/"},
                       {"name": "Java", "slug": "java", "strategy": "llm", "url": "https://java.fr/"},
                       {"name": "Trianon", "slug": "trianon", "strategy": "trianon", "url": "https://trianon.fr/"}]
        self.write("venues.json", json.dumps(self.venues, indent=1))
        self.write("livemusic/sources/venues_html.py", "def cigale(v, ctx):\n    return []\n")
        self.write("livemusic/pipeline.py", "X = 1\n")
        self.write("tests/test_ok.py", "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n")
        self.write(".gitignore", ".troubleshoot/\n")
        self.status = {"today": "2026-09-27", "sources": [
            src("cigale", "0 events parsed (was 20)", prev=20), src("java", "HTTP 404 for https://java.fr/", prev=10, strategy="llm"),
            src("trianon", status="ok", strategy="trianon", count=30)]}
        self.write("web/status.json", json.dumps(self.status))
        sh(root, "git", "init", "-q")
        sh(root, "git", "add", "-A")
        sh(root, "git", "commit", "-q", "-m", "init")
        self.counts = {"cigale": 0, "java": 0, "trianon": 30}
        self.logs = []

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text, root=None):
        path = os.path.join(root or self.root, path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def check(self, slug, root=None):
        n = self.counts[slug]
        return {"slug": slug, "ok": n > 0, "count": n, "error": None if n else "0 events parsed"}

    def run_with(self, agent):
        return T.run(self.root, log=self.logs.append, check=self.check, agent=agent, today=TODAY)

    def dirty(self):
        out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=self.root, capture_output=True, text=True)
        return out.stdout.splitlines()

    def log_of(self):
        return subprocess.run(["git", "log", "--format=%s"], cwd=self.root, capture_output=True, text=True).stdout.split("\n")

    def test_repair_is_committed_and_a_bad_one_thrown_away(self):
        def agent(source, entry, root):
            if source["slug"] == "cigale":   # a real repair
                self.write("livemusic/sources/venues_html.py", "def cigale(v, ctx):\n    return ['fixed']\n", root=root)
                self.write(".troubleshoot/cigale.md", "The markup changed: shows are now <article> blocks.\n\nCheck: 18 events.", root=root)
                self.counts["cigale"] = 18
            else:                            # repairs java by editing what it must not
                self.write("livemusic/pipeline.py", "X = 2\n", root=root)
                self.write("venues.json", json.dumps([dict(v, url="https://java.fr/agenda") if v["slug"] == "java" else v
                                                      for v in self.venues], indent=1), root=root)
                self.counts["java"] = 9
            return True, "done"

        self.write("notes.txt", "mine, untracked")
        report = self.run_with(agent)
        self.assertEqual([(x["slug"], x["count"], x["summary"]) for x in report["fixed"]],
                         [("cigale", 18, "The markup changed: shows are now <article> blocks.")])
        self.assertEqual(report["fixed"][0]["files"], ["livemusic/sources/venues_html.py"])
        self.assertEqual([(x["slug"], x["problems"]) for x in report["unresolved"]],
                         [("java", ["livemusic/pipeline.py: not a file the agent may change"])])
        with open(os.path.join(self.root, "venues.json")) as f:
            self.assertNotIn("agenda", f.read())
        self.assertIn("+  \"url\": \"https://java.fr/agenda\"", report["unresolved"][0]["diff"])
        self.assertEqual(self.log_of()[:2], ["Auto-fix cigale: The markup changed: shows are now <article> blocks.", "init"])
        # nothing of the refused repair is left; the state and what was lying around are kept
        self.assertEqual(self.dirty(), ["?? data/troubleshoot.json", "?? notes.txt"])
        state = T.load_state(os.path.join(self.root, "data/troubleshoot.json"))
        self.assertEqual(state["sources"]["java"]["days"], ["2026-09-27"])
        self.assertEqual(state["last"]["date"], "2026-09-27")

        # same day, second run: nobody is tried twice
        calls = []
        again = self.run_with(lambda *a: calls.append(a) or (True, ""))
        self.assertEqual((calls, [x["why"] for x in again["skipped"]]), ([], ["already tried today"] * 2))

    def test_refusals(self):
        def implausible(source, entry, root):
            self.write("livemusic/sources/venues_html.py", "def cigale(v, ctx):\n    return ['nav links']\n", root=root)
            self.counts[source["slug"]] = 2
            return True, ""

        def breaks_a_neighbour(source, entry, root):
            self.write("livemusic/sources/venues_html.py", "def cigale(v, ctx):\n    return ['x']\n", root=root)
            self.counts.update({source["slug"]: 20, "trianon": 0})
            return True, ""

        def reads_the_environment(source, entry, root):
            self.write("livemusic/sources/venues_html.py", "import os\n\n\ndef cigale(v, ctx):\n    return [os.environ]\n", root=root)
            self.write("tests/__pycache__/x.pyc", "bytecode", root=root)
            self.counts[source["slug"]] = 20
            return True, ""

        def new_file(source, entry, root):
            self.write("livemusic/sources/mine.py", "X = 1\n", root=root)
            return True, ""

        def link(source, entry, root):
            os.remove(os.path.join(root, "venues.json"))
            os.symlink("/etc/hosts", os.path.join(root, "venues.json"))
            return True, ""

        def crash(source, entry, root):
            raise RuntimeError("boom")

        def nothing(source, entry, root):
            return True, "The venue closed for good."

        self.status["sources"] = [s for s in self.status["sources"] if s["slug"] != "java"]
        self.write("web/status.json", json.dumps(self.status))
        sh(self.root, "git", "commit", "-qam", "status")
        for agent, expected in [(implausible, "implausible result: 2 events against 20"),
                                (breaks_a_neighbour, "Trianon worked this morning (30 events) and now gives 0"),
                                (reads_the_environment, "is not allowed in a parser"),
                                (new_file, "livemusic/sources/mine.py: not a file the agent may change"),
                                (link, "venues.json: a symbolic link"),
                                (crash, "the troubleshooting program failed: RuntimeError('boom')"),
                                (nothing, "the agent changed nothing")]:
            self.counts.update({"cigale": 0, "trianon": 30})
            if os.path.exists(os.path.join(self.root, "data/troubleshoot.json")):
                os.remove(os.path.join(self.root, "data/troubleshoot.json"))
            report = self.run_with(agent)
            self.assertEqual(report["fixed"], [], agent.__name__)
            self.assertIn(expected, report["unresolved"][0]["problems"][0])
            self.assertEqual(self.dirty(), ["?? data/troubleshoot.json"])
            self.assertEqual(self.log_of()[0], "status")
        self.assertEqual(report["unresolved"][0]["notes"], "The venue closed for good.")

    def test_cost_is_counted_and_capped(self):
        def check(slug, root=None):   # an LLM venue: the check itself calls Claude
            return dict(self.check(slug, root), usd=0.1)

        def agent(source, entry, root):
            self.write("livemusic/sources/venues_html.py", "def cigale(v, ctx):\n    return ['fixed']\n", root=root)
            self.counts["cigale"] = 18
            return True, "The markup changed.", 1.25

        with mock.patch.dict(os.environ, {"TROUBLESHOOT_DAILY_USD": "1"}):
            report = T.run(self.root, log=self.logs.append, check=check, agent=agent, today=TODAY)
        # cigale: first check + session + check after the repair + one neighbour (trianon)
        self.assertEqual([(x["slug"], x["usd"], x["usd_agent"]) for x in report["fixed"]], [("cigale", 1.55, 1.25)])
        self.assertEqual([(x["slug"], x["why"]) for x in report["skipped"]],
                         [("java", "over the day's budget ($1.55 spent of $1.00)")])
        self.assertEqual((report["usd"], report["sessions"]), (1.55, 1))
        self.assertIn("Cost of the repair: $1.55", subprocess.run(["git", "log", "-1", "--format=%B"], cwd=self.root,
                                                                  capture_output=True, text=True).stdout)
        state = T.load_state(os.path.join(self.root, "data/troubleshoot.json"))
        self.assertEqual((state["spent"], state["sources"]["cigale"]["usd"]), ({"date": "2026-09-27", "usd": 1.55}, 1.55))
        self.assertNotIn("java", state["sources"])   # not an attempt

    def test_passing_failure_and_agent_out_of_credit(self):
        self.counts["cigale"] = 19   # the site was down at 6, it is back
        calls = []

        def agent(source, entry, root):
            calls.append(source["slug"])
            return False, "Your credit balance is too low to access the Anthropic API"

        report = self.run_with(agent)
        self.assertEqual([x["slug"] for x in report["recovered"]], ["cigale"])
        self.assertEqual(calls, ["java"])
        self.assertEqual(report["unresolved"], [])
        self.assertEqual(report["systemic"][0]["cause"], "Your credit balance is too low to access the Anthropic API")
        state = T.load_state(os.path.join(self.root, "data/troubleshoot.json"))
        self.assertEqual(state["sources"]["java"]["days"], [])   # not counted as an attempt


class FinishTest(unittest.TestCase):
    def test_issue_is_created_once_then_commented(self):
        calls = []

        def api(open_issue):
            def call(query, variables=None, key=None):
                calls.append((query.split("(")[0].split()[0], variables))
                if "issues(" in query:
                    return {"issues": {"nodes": [open_issue] if open_issue else []}}
                if "viewer" in query:
                    return {"viewer": {"id": "me"}, "teams": {"nodes": [{"id": "team"}]}}
                if "issueCreate" in query:
                    return {"issueCreate": {"issue": {"id": "1", "identifier": "REM-60", "url": "https://linear.app/x/REM-60"}}}
                return {"commentCreate": {"success": True}}
            return call

        self.assertEqual(T.file_issue("Scraper down: Java", "body", api(None)), ("REM-60", "https://linear.app/x/REM-60", True))
        self.assertEqual(calls[-1][1]["input"], {"teamId": "team", "title": "Scraper down: Java", "description": "body",
                                                 "priority": 2, "assigneeId": "me"})
        ref = T.file_issue("Scraper down: Java", "day 2", api({"id": "1", "identifier": "REM-60", "url": "u"}))
        self.assertEqual((ref, calls[-1]), (("REM-60", "u", False), ("mutation", {"id": "1", "body": "day 2"})))

    def test_finish(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "data"))
            os.makedirs(os.path.join(root, "web"))
            sh(root, "git", "init", "-q")
            report = {"date": "2026-09-27", "run_url": None, "skipped": [], "recovered": [], "usd": 2.0, "sessions": 2,
                      "fixed": [{"venue": "Cigale", "slug": "cigale", "error": "0 events parsed (was 20)", "count": 18,
                                 "summary": "The markup changed.", "notes": "", "usd": 1.55}],
                      "unresolved": [{"venue": "Java", "slug": "java", "error": "HTTP 404", "since": "2026-09-26", "prev_count": 10,
                                      "url": "https://java.fr/", "problems": ["the agent changed nothing"],
                                      "notes": "The venue closed.", "diff": "", "attempts": 2, "usd": 0.45, "usd_total": 1.2}],
                      "systemic": [{"cause": "Claude API error 400: credit", "venues": ["A", "B", "C"]}]}
            T.save_state({"sources": {"java": {}}, "last": report}, os.path.join(root, "data/troubleshoot.json"))
            with open(os.path.join(root, "web/status.json"), "w") as f:
                json.dump({"today": "2026-09-27", "sources": [], "fixes": [{"slug": "old"}],
                           "cost": {"date": "2026-09-27", "usd": 3.0, "steps": [{"what": "venues", "usd": 3.0}]},
                           "history": [{"date": "2026-09-27", "usd": 3.0, "sources": {}}]}, f)
            filed, scraped, pings = [], [], []

            def api(query, variables=None, key=None):
                if "issues(" in query:
                    return {"issues": {"nodes": []}}
                if "viewer" in query:
                    return {"viewer": {"id": "me"}, "teams": {"nodes": [{"id": "team"}]}}
                filed.append(variables["input"])
                return {"issueCreate": {"issue": {"id": "1", "identifier": f"REM-6{len(filed)}", "url": "https://linear.app/i"}}}

            with mock.patch.dict(os.environ, {"LINEAR_API_KEY": "k"}), \
                    mock.patch.object(T, "ping", lambda *a: pings.append(a)):
                code = T.finish(root, log=lambda m: None, scrape=lambda slugs: scraped.append(slugs) or 0, api=api)
                self.assertEqual(T.finish(root, log=lambda m: None, api=api), 0)   # a second call does nothing
            self.assertEqual((code, scraped), (1, [["cigale"]]))
            self.assertEqual([i["title"] for i in filed], ["Scraper down: Java", "Scrapers down: Claude API error 400: credit"])
            self.assertIn("attempt 2 of 3", filed[0]["description"])
            self.assertIn("Cost of this attempt: $0.45 ($1.20 on this failure so far)", filed[0]["description"])
            self.assertIn("The venue closed.", filed[0]["description"])
            self.assertEqual(pings[0][1], "Scraper down: Java (REM-61)\nScrapers down: Claude API error 400: credit (REM-62)")
            with open(os.path.join(root, "web/status.json")) as f:
                status = json.load(f)
            self.assertEqual([(x["slug"], x.get("summary"), x.get("usd")) for x in status["fixes"]],
                             [("cigale", "The markup changed.", 1.55), ("old", None, None)])
            self.assertEqual((status["cost"]["usd"], status["history"][0]["usd"]), (5.0, 5.0))
            self.assertEqual(status["cost"]["steps"][-1], {"what": "troubleshooting", "model": "Claude Code", "batch": False,
                                                           "calls": 2, "usd": 2.0})
            self.assertEqual(T.load_state(os.path.join(root, "data/troubleshoot.json"))["sources"]["java"]["issue"], "REM-61")


if __name__ == "__main__":
    unittest.main()
