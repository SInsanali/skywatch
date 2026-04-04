import asyncio
import json
import logging
import time

import websockets

log = logging.getLogger("skywatch")

AISSTREAM_WS_URL = "wss://stream.aisstream.io/v0/stream"

# AIS ship type categories
AIS_SHIP_CATEGORIES = {
    range(60, 70): "passenger",
    range(70, 80): "cargo",
    range(80, 90): "tanker",
    (30,): "fishing",
    (35,): "military",
    (31, 32, 52): "tug",
    (36, 37): "pleasure",
    range(40, 50): "highspeed",
}


def classify_ship_type(ais_type):
    if not ais_type:
        return "other"
    for key, cat in AIS_SHIP_CATEGORIES.items():
        if ais_type in key:
            return cat
    return "other"


async def collect_ais_burst(config, ship_state):
    """Connect to AISStream WebSocket, collect ship data for a burst duration."""
    if not config.ais_api_key:
        return

    ships = {}
    try:
        async with websockets.connect(AISSTREAM_WS_URL) as ws:
            sub = json.dumps({
                "APIKey": config.ais_api_key,
                "BoundingBoxes": [[[-90, -180], [90, 180]]],
                "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
            })
            await ws.send(sub)

            deadline = time.time() + config.ais_burst_duration
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=2)
                    msg = json.loads(raw)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break

                meta = msg.get("MetaData", {})
                mmsi = meta.get("MMSI")
                if not mmsi:
                    continue

                lat = meta.get("latitude", 0)
                lon = meta.get("longitude", 0)
                if abs(lat) < 0.01 and abs(lon) < 0.01:
                    continue
                if lat < -90 or lat > 90 or lon < -180 or lon > 180:
                    continue

                ship = ships.get(mmsi, {"mmsi": mmsi})
                ship["name"] = meta.get("ShipName", "").strip() or ship.get("name", "")
                ship["latitude"] = lat
                ship["longitude"] = lon
                ship["timestamp"] = meta.get("time_utc", "")

                msg_type = msg.get("MessageType", "")
                message = msg.get("Message", {})

                if msg_type == "PositionReport":
                    pr = message.get("PositionReport", {})
                    ship["sog"] = pr.get("Sog", 0)
                    cog = pr.get("Cog", 360)
                    ship["cog"] = cog if cog < 360 else None
                    hdg = pr.get("TrueHeading", 511)
                    ship["heading"] = hdg if hdg != 511 else ship.get("cog")
                    ship["nav_status"] = pr.get("NavigationalStatus", 15)
                elif msg_type == "ShipStaticData":
                    sd = message.get("ShipStaticData", {})
                    ship["ship_type"] = sd.get("Type", 0)
                    ship["category"] = classify_ship_type(sd.get("Type", 0))
                    ship["imo"] = sd.get("ImoNumber", 0)
                    ship["callsign"] = sd.get("CallSign", "").strip()
                    ship["destination"] = sd.get("Destination", "").strip()
                    dim = sd.get("Dimension", {})
                    if dim:
                        ship["length"] = (dim.get("A", 0) or 0) + (dim.get("B", 0) or 0)
                        ship["width"] = (dim.get("C", 0) or 0) + (dim.get("D", 0) or 0)

                ships[mmsi] = ship

    except Exception as e:
        log.error("AIS burst collection failed: %s", e)

    # Filter to moving vessels only
    moving = []
    for s in ships.values():
        sog = s.get("sog", 0)
        nav = s.get("nav_status", 15)
        if sog > 0.5 and nav not in (1, 5, 6):  # not anchored/moored/aground
            if "category" not in s:
                s["category"] = classify_ship_type(s.get("ship_type", 0))
            moving.append(s)

    ship_state["ships"] = moving
    ship_state["timestamp"] = int(time.time())
    log.info("AIS burst: %d total, %d moving ships", len(ships), len(moving))


async def refresh_ships(config, ship_state, has_active_viewer):
    """Periodically collect AIS ship data."""
    if not config.ais_api_key:
        log.info("No AISStream API key configured, skipping ship tracking")
        return
    # First burst immediately on startup
    await collect_ais_burst(config, ship_state)
    while True:
        await asyncio.sleep(config.ais_cache_ttl)
        if has_active_viewer():
            await collect_ais_burst(config, ship_state)
