"""Check the shared manifest directory with an isolated participant fixture."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "directory"))
import manifest_directory  # noqa: E402


class ManifestDirectoryTest(unittest.TestCase):
    def test_directory_lists_and_retrieves_only_its_offerings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            things = root / "things"
            things.mkdir()
            manifest = root / "participants.json"
            manifest.write_text(json.dumps({
                "sample": {
                    "title": "Sample participant",
                    "things": ["one.json"],
                }
            }))
            td = {"id": "urn:sample:one", "title": "One"}
            (things / "one.json").write_text(json.dumps(td))
            with patch.object(manifest_directory, "PARTICIPANTS", manifest):
                client = TestClient(manifest_directory.create_app(
                    "sample", "http://sample-participant:9000", things
                ))
            introduction = client.get("/.well-known/wot")
            self.assertEqual(introduction.status_code, 200)
            self.assertEqual(introduction.json()["@type"], "ThingDirectory")
            self.assertEqual(introduction.json()["base"], "http://sample-participant:9000/")
            self.assertEqual(client.get("/things").json(), [td])
            self.assertEqual(client.get("/things/" + quote(td["id"], safe="")).json(), td)
            self.assertEqual(client.get("/things/urn%3Asample%3Atwo").status_code, 404)


if __name__ == "__main__":
    unittest.main()
