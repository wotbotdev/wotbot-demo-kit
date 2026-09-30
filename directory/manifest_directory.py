"""Serve one participant's curated WoT Thing Directory from a JSON manifest."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI

from wot_directory import install

HERE = Path(__file__).resolve().parent
PARTICIPANTS = Path(os.environ.get("PARTICIPANT_MANIFEST", HERE / "participants.json"))
THINGS = Path(os.environ.get("PARTICIPANT_TD_DIR", HERE.parent / "td-loader" / "things"))


def create_app(
    participant: str | None = None,
    base_url: str | None = None,
    things_dir: Path | None = None,
) -> FastAPI:
    """Build a directory; uvicorn supplies its participant through the environment."""

    participant = participant or os.environ["PARTICIPANT_KEY"]
    specs = json.loads(PARTICIPANTS.read_text())
    if participant not in specs:
        raise ValueError(f"Unknown participant: {participant}")
    spec = specs[participant]
    base_url = (base_url or os.environ["PARTICIPANT_BASE_URL"]).rstrip("/")
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ValueError("PARTICIPANT_BASE_URL must be an HTTP(S) origin")
    things_dir = things_dir or THINGS

    def documents() -> list[dict]:
        result = []
        for filename in spec["things"]:
            if Path(filename).name != filename or not filename.endswith(".json"):
                raise ValueError(f"Invalid Thing filename: {filename}")
            result.append(json.loads((things_dir / filename).read_text()))
        ids = [td.get("id") for td in result]
        if not all(ids) or len(ids) != len(set(ids)):
            raise ValueError(f"Duplicate or missing Thing ID in {participant}")
        return result

    offerings = documents()  # Fail startup when a configured TD is missing or invalid JSON.
    app = FastAPI(title=spec["title"])

    @app.get("/health")
    def health():
        return {"status": "ok", "offerings": len(offerings)}

    install(
        app,
        thing_id=f"urn:datasummit2026:directory:{participant}",
        title=spec["title"],
        base_url=base_url,
        documents=documents,
    )
    return app
