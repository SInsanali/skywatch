import asyncio
import logging

import httpx

log = logging.getLogger("skywatch")

USGS_QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"
QUAKES_REFRESH_SECONDS = 300  # 5 minutes


async def fetch_earthquakes(earthquake_state):
    """Download earthquake data from USGS."""
    try:
        log.info("Downloading earthquake data from USGS...")
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(USGS_QUAKES_URL)
            resp.raise_for_status()
        earthquake_state.clear()
        earthquake_state.update(resp.json())
        count = len(earthquake_state.get("features", []))
        log.info("Earthquake data loaded: %d events", count)
    except Exception as e:
        log.error("Failed to fetch earthquake data: %s", e)


async def refresh_earthquakes(earthquake_state):
    """Periodically re-fetch earthquake data."""
    await fetch_earthquakes(earthquake_state)
    while True:
        await asyncio.sleep(QUAKES_REFRESH_SECONDS)
        await fetch_earthquakes(earthquake_state)
