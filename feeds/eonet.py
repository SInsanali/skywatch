import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger("skywatch")

EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20"


def normalize_events(payload: dict[str, Any]) -> list[dict]:
    events = payload.get("events") or []
    out = []
    for ev in events:
        geom = ev.get("geometry") or []
        if not geom:
            continue
        cat = "unknown"
        cats = ev.get("categories") or []
        if cats:
            cat = cats[0].get("id", "unknown")
        last_update = max((g.get("date") or "" for g in geom), default="")
        out.append({
            "id": ev.get("id"),
            "title": ev.get("title"),
            "category": cat,
            "geometry": [
                {"date": g.get("date"), "type": g.get("type"), "coordinates": g.get("coordinates")}
                for g in geom
            ],
            "last_update": last_update,
        })
    return out


async def fetch_eonet(eonet_state, store):
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(EONET_URL)
            resp.raise_for_status()
        events = normalize_events(resp.json())
        eonet_state.clear()
        eonet_state.extend(events)
        store.record_error("eonet", None)
        log.info("EONET loaded: %d events", len(events))
    except Exception as e:
        log.error("Failed to fetch EONET: %s", e)
        store.record_error("eonet", str(e))


async def refresh_eonet(store, eonet_state):
    while True:
        feed = store.get("eonet")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_eonet(eonet_state, store)
        await asyncio.sleep(feed.interval_seconds)
