import asyncio
import csv
import io
import logging
import math
from datetime import datetime, timedelta, timezone

import h3
import httpx

log = logging.getLogger("skywatch")

GPSJAM_URL_TEMPLATE = "https://gpsjam.org/data/{date}-h3_4.csv"
GPSJAM_REFRESH_HOURS = 6


def compute_jamming_grid(aircraft):
    grid = {}
    for ac in aircraft:
        lat = ac.get("latitude")
        lon = ac.get("longitude")
        nic = ac.get("nic")
        if lat is None or lon is None or nic is None:
            continue
        if ac.get("on_ground"):
            continue
        cell_lat = int(math.floor(lat))
        cell_lon = int(math.floor(lon))
        key = (cell_lat, cell_lon)
        if key not in grid:
            grid[key] = {"total": 0, "degraded": 0}
        grid[key]["total"] += 1
        if nic < 7:
            grid[key]["degraded"] += 1

    zones = []
    for (cell_lat, cell_lon), counts in grid.items():
        if counts["total"] < 4:
            continue
        pct = counts["degraded"] / counts["total"]
        if pct < 0.25:
            continue
        if counts["degraded"] < 3:
            continue
        level = "high" if pct >= 0.6 else "medium" if pct >= 0.4 else "low"
        zones.append({
            "lat": cell_lat + 0.5,
            "lon": cell_lon + 0.5,
            "total": counts["total"],
            "degraded": counts["degraded"],
            "pct": round(pct * 100, 1),
            "level": level,
            "source": "realtime",
        })

    zones.sort(key=lambda z: z["pct"], reverse=True)
    return zones


async def fetch_gpsjam(gpsjam_state):
    today = datetime.now(timezone.utc).date()
    dates_to_try = [today, today - timedelta(days=1)]

    for date in dates_to_try:
        url = GPSJAM_URL_TEMPLATE.format(date=date.isoformat())
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()

            zones = []
            reader = csv.DictReader(io.StringIO(resp.text))
            for row in reader:
                hex_id = row.get("hex", "").strip()
                if not hex_id:
                    continue
                try:
                    good = int(row.get("count_good_aircraft", 0))
                    bad = int(row.get("count_bad_aircraft", 0))
                except (ValueError, TypeError):
                    continue

                total = good + bad
                if total == 0 or bad < 3:
                    continue
                ratio = bad / total
                if ratio < 0.10:
                    continue

                try:
                    lat, lon = h3.cell_to_latlng(hex_id)
                except Exception:
                    continue

                pct = round(ratio * 100, 1)
                level = "high" if ratio >= 0.6 else "medium" if ratio >= 0.4 else "low"

                zones.append({
                    "lat": round(lat, 4),
                    "lon": round(lon, 4),
                    "total": total,
                    "degraded": bad,
                    "pct": pct,
                    "level": level,
                    "source": "gpsjam",
                })

            zones.sort(key=lambda z: z["pct"], reverse=True)
            gpsjam_state.clear()
            gpsjam_state.extend(zones)
            log.info("GPSJam data loaded (%s): %d jamming zones", date.isoformat(), len(zones))
            return
        except Exception as e:
            log.warning("Failed to fetch GPSJam data for %s: %s", date.isoformat(), e)

    log.error("Could not fetch GPSJam data for today or yesterday")


async def refresh_gpsjam(store, gpsjam_state):
    while True:
        feed = store.get("gpsjam")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_gpsjam(gpsjam_state)
        await asyncio.sleep(feed.interval_seconds)
