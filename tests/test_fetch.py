import io
import os
import tempfile
import unittest
import urllib.error
from unittest import mock

from livemusic import fetch as F

URL = "https://www.example-venue.test/agenda"


def http_error(code):
    return urllib.error.HTTPError(URL, code, "blocked", {}, io.BytesIO(b""))


class BotWallFallbackTest(unittest.TestCase):
    """A 418 / 403 from a bot wall gets one try through curl (a different TLS fingerprint) before failing."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [mock.patch.object(F, "CACHE_DIR", self.tmp.name), mock.patch.object(F, "FRESH", True),
                        mock.patch.object(F.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_418_is_retried_through_curl(self):
        with mock.patch.object(F.urllib.request, "urlopen", side_effect=http_error(418)) as urlopen, \
             mock.patch.object(F, "_curl", return_value="<html>programme</html>") as curl:
            self.assertEqual(F.get(URL), "<html>programme</html>")
        self.assertEqual(urlopen.call_count, 1)   # no second urllib attempt: the wall would answer the same
        curl.assert_called_once_with(URL, 25)
        self.assertTrue(os.listdir(self.tmp.name))   # the body was cached like any other page

    def test_403_is_retried_through_curl(self):
        with mock.patch.object(F.urllib.request, "urlopen", side_effect=http_error(403)), \
             mock.patch.object(F, "_curl", return_value="<html>ok</html>"):
            self.assertEqual(F.get(URL), "<html>ok</html>")

    def test_wall_that_refuses_curl_too_reports_the_status(self):
        with mock.patch.object(F.urllib.request, "urlopen", side_effect=http_error(418)), \
             mock.patch.object(F, "_curl", return_value=None):
            with self.assertRaises(F.FetchError) as cm:
                F.get(URL)
        self.assertEqual(str(cm.exception), f"HTTP 418 for {URL}")
        self.assertFalse(os.listdir(self.tmp.name))   # nothing cached

    def test_404_is_not_retried(self):
        with mock.patch.object(F.urllib.request, "urlopen", side_effect=http_error(404)), \
             mock.patch.object(F, "_curl") as curl:
            with self.assertRaises(F.FetchError):
                F.get(URL)
        curl.assert_not_called()


if __name__ == "__main__":
    unittest.main()
