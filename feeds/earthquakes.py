import asyncio
import logging

import httpx

log = logging.getLogger("skywatch")

USGS_QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"


async def fetch_earthquakes(earthquake_state, store):
    try:
        log.info("Downloading earthquake data from USGS...")
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(USGS_QUAKES_URL)
            resp.raise_for_status()
        earthquake_state.clear()
        earthquake_state.update(resp.json())
        store.record_error("earthquakes", None)
        count = len(earthquake_state.get("features", []))
        log.info("Earthquake data loaded: %d events", count)
    except Exception as e:
        log.error("Failed to fetch earthquake data: %s", e)
        store.record_error("earthquakes", str(e))


async def refresh_earthquakes(store, earthquake_state):
    while True:
        feed = store.get("earthquakes")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_earthquakes(earthquake_state, store)
        await asyncio.sleep(feed.interval_seconds)
