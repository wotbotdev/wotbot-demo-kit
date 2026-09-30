"""Read-only W3C WoT Thing Description Directory endpoints for a participant.

Serves the subset of the WoT Discovery Directory API that WoTBot's built-in
``wot-tdd`` provider consumes: the ``/.well-known/wot`` introduction, the
``/things`` listing, and ``/things/{id}`` retrieval. Participants hold a handful
of TDs, so the listing is not paginated; the spec leaves that to the server.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

TD_CONTEXT = "https://www.w3.org/2022/wot/td/v1.1"
DISCOVERY_CONTEXT = "https://www.w3.org/2022/wot/discovery"


def install(
    app: FastAPI,
    *,
    thing_id: str,
    title: str,
    base_url: str,
    documents: Callable[[], list[dict]],
) -> None:
    """Add the directory routes, listing whatever ``documents()`` returns."""

    base_url = base_url.rstrip("/")

    @app.get("/.well-known/wot")
    def introduction():
        return JSONResponse(
            {
                "@context": [TD_CONTEXT, DISCOVERY_CONTEXT],
                "@type": "ThingDirectory",
                "id": thing_id,
                "title": title,
                "base": f"{base_url}/",
                "securityDefinitions": {"nosec_sc": {"scheme": "nosec"}},
                "security": "nosec_sc",
                "properties": {
                    "things": {
                        "description": "Retrieve all Thing Descriptions",
                        "type": "array",
                        "readOnly": True,
                        "forms": [{"href": "things", "contentType": "application/ld+json"}],
                    }
                },
                "actions": {
                    "retrieveThing": {
                        "uriVariables": {"id": {"type": "string", "format": "iri-reference"}},
                        "safe": True,
                        "idempotent": True,
                        "forms": [{"href": "things/{id}", "contentType": "application/td+json"}],
                    }
                },
            },
            media_type="application/td+json",
        )

    @app.get("/things")
    def things():
        return JSONResponse(documents(), media_type="application/ld+json")

    @app.get("/things/{requested_id}")
    def thing(requested_id: str):
        document = next((td for td in documents() if td.get("id") == requested_id), None)
        if document is None:
            raise HTTPException(status_code=404, detail="Thing is not offered by this participant")
        return JSONResponse(document, media_type="application/td+json")
