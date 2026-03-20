import asyncio
import csv
import gzip
import io
import json
import logging
import signal
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
import yaml
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("skywatch")

ADSBX_BASE = "https://api.airplanes.live/v2"
ACDB_URL = "https://downloads.adsbexchange.com/downloads/basic-ac-db.json.gz"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
ACDB_REFRESH_HOURS = 24
VIEWER_TIMEOUT = 60
GLOBAL_QUERY_RADIUS = 10000  # nm — large enough to cover the entire globe


class Config:
    def __init__(self):
        path = Path("/app/config.yaml")
        if not path.exists():
            path = Path("config.yaml")
        with open(path) as f:
            raw = yaml.safe_load(f)

        polling = raw.get("polling", {})
        self.poll_interval = polling.get("interval", 15)
        self.timeout = polling.get("timeout", 20)

        server = raw.get("server", {})
        self.host = server.get("host", "0.0.0.0")
        self.port = server.get("port", 8078)


config = Config()

aircraft_state = {
    "timestamp": 0,
    "aircraft": [],
}

aircraft_db = {}
airline_db = {}
airports = []
last_viewer_heartbeat = 0


def has_active_viewer():
    return (time.time() - last_viewer_heartbeat) < VIEWER_TIMEOUT


async def load_airlines():
    global airline_db
    try:
        log.info("Downloading airline database...")
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(AIRLINES_URL)
            resp.raise_for_status()

        db = {}
        for line in resp.text.splitlines():
            parts = line.split(",")
            if len(parts) < 8:
                continue
            name = parts[1].strip('"')
            icao = parts[4].strip('"')
            country = parts[6].strip('"')
            if not icao or icao == "\\N" or icao == "-":
                continue
            db[icao] = {"name": name, "country": country}

        airline_db = db
        log.info("Airline database loaded: %d airlines", len(db))
    except Exception as e:
        log.error("Failed to load airline database: %s", e)


async def load_airports():
    global airports
    try:
        log.info("Downloading airport database...")
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(AIRPORTS_URL)
            resp.raise_for_status()

        reader = csv.DictReader(io.StringIO(resp.text))
        result = []
        for row in reader:
            iata = (row.get("iata_code") or "").strip()
            icao = (row.get("icao_code") or "").strip()
            ap_type = row.get("type", "")
            if not iata or ap_type == "closed":
                continue
            if ap_type not in ("large_airport", "medium_airport", "small_airport"):
                continue
            try:
                lat = float(row["latitude_deg"])
                lon = float(row["longitude_deg"])
            except (ValueError, KeyError):
                continue
            size = "L" if ap_type == "large_airport" else "M" if ap_type == "medium_airport" else "S"
            result.append({
                "iata": iata, "icao": icao,
                "name": row.get("name", ""), "lat": lat, "lon": lon, "size": size,
            })

        airports = result
        log.info("Airport database loaded: %d airports", len(airports))
    except Exception as e:
        log.error("Failed to load airport database: %s", e)


async def load_aircraft_db():
    global aircraft_db
    try:
        log.info("Downloading aircraft database...")
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(ACDB_URL)
            resp.raise_for_status()

        raw = gzip.decompress(resp.content).decode("utf-8")
        db = {}
        for line in raw.splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            icao = rec.get("icao", "").strip().lower()
            if not icao:
                continue
            db[icao] = {
                "reg": rec.get("reg") or None,
                "type": rec.get("icaotype") or None,
                "model": rec.get("model") or None,
                "operator": rec.get("ownop") or None,
                "year": rec.get("year") or None,
                "mil": bool(rec.get("mil")),
            }

        aircraft_db = db
        log.info("Aircraft database loaded: %d entries", len(db))
    except Exception as e:
        log.error("Failed to load aircraft database: %s", e)


async def refresh_aircraft_db():
    await load_aircraft_db()
    while True:
        await asyncio.sleep(ACDB_REFRESH_HOURS * 3600)
        await load_aircraft_db()


def decode_airline(callsign):
    if not callsign or len(callsign) < 4:
        return None, None
    prefix = callsign[:3]
    if not prefix.isalpha():
        return None, None
    info = airline_db.get(prefix.upper())
    if info:
        flight_num = callsign[3:].lstrip("0")
        return info["name"], f'{prefix}{flight_num}'
    return None, None


def parse_v2_aircraft(ac_list):
    """Parse airplanes.live v2 format into our standard format."""
    aircraft = []
    for a in ac_list:
        lat = a.get("lat")
        lon = a.get("lon")
        if lat is None or lon is None:
            continue

        hex_code = (a.get("hex") or "").strip().lower()
        if not hex_code:
            continue

        callsign = (a.get("flight") or "").strip() or None
        alt_baro = a.get("alt_baro")
        if alt_baro == "ground":
            alt_baro = 0
            on_ground = True
        else:
            on_ground = alt_baro is not None and alt_baro <= 0

        # Convert feet to meters for consistency with frontend expectations
        baro_m = round(alt_baro * 0.3048, 1) if isinstance(alt_baro, (int, float)) else None
        geo_alt = a.get("alt_geom")
        geo_m = round(geo_alt * 0.3048, 1) if isinstance(geo_alt, (int, float)) else None

        gs = a.get("gs")
        velocity_ms = round(gs * 0.514444, 2) if gs is not None else None

        track = a.get("track")
        baro_rate = a.get("baro_rate")
        vr_ms = round(baro_rate * 0.00508, 2) if baro_rate is not None else None

        ac = {
            "icao24": hex_code,
            "callsign": callsign,
            "origin_country": None,
            "latitude": lat,
            "longitude": lon,
            "baro_altitude": baro_m,
            "on_ground": on_ground,
            "velocity": velocity_ms,
            "true_track": track,
            "vertical_rate": vr_ms,
            "geo_altitude": geo_m,
            "squawk": a.get("squawk"),
        }

        # v2 has richer fields we can pass through
        if a.get("ias") is not None:
            ac["ias"] = a["ias"]
        if a.get("tas") is not None:
            ac["tas"] = a["tas"]
        if a.get("mach") is not None:
            ac["mach"] = a["mach"]
        if a.get("wd") is not None:
            ac["wind_dir"] = a["wd"]
        if a.get("ws") is not None:
            ac["wind_speed"] = a["ws"]
        if a.get("oat") is not None:
            ac["oat"] = a["oat"]
        if a.get("category") is not None:
            ac["category"] = a["category"]
        if a.get("nav_altitude_mcp") is not None:
            ac["nav_alt"] = a["nav_altitude_mcp"]
        if a.get("emergency") and a["emergency"] != "none":
            ac["emergency"] = a["emergency"]

        # Use v2's built-in reg/type if available, fall back to our DB
        if a.get("r"):
            ac["reg"] = a["r"]
        if a.get("t"):
            ac["type"] = a["t"]
        if a.get("dbFlags"):
            ac["mil"] = bool(a["dbFlags"] & 1)

        # Enrich from our databases
        db_info = aircraft_db.get(hex_code)
        if db_info:
            if not ac.get("reg"):
                ac["reg"] = db_info.get("reg")
            if not ac.get("type"):
                ac["type"] = db_info.get("type")
            if not ac.get("model"):
                ac["model"] = db_info.get("model")
            ac["operator"] = db_info.get("operator")
            if not ac.get("year"):
                ac["year"] = db_info.get("year")
            if "mil" not in ac:
                ac["mil"] = db_info.get("mil", False)

        airline_name, flight_id = decode_airline(callsign)
        if airline_name:
            ac["airline"] = airline_name
            if not ac.get("operator"):
                ac["operator"] = airline_name
        if flight_id:
            ac["flight"] = flight_id

        aircraft.append(ac)
    return aircraft


async def poll_aircraft():
    interval = config.poll_interval
    was_idle = True

    async with httpx.AsyncClient(timeout=config.timeout) as client:
        while True:
            if not has_active_viewer():
                if not was_idle:
                    log.info("No active viewers, pausing polling")
                    was_idle = True
                await asyncio.sleep(5)
                continue

            if was_idle:
                log.info("Viewer connected, resuming polling")
                was_idle = False

            try:
                url = f"{ADSBX_BASE}/point/0/0/{GLOBAL_QUERY_RADIUS}"
                resp = await client.get(url)

                if resp.status_code == 429:
                    log.warning("Rate limited by airplanes.live")
                    await asyncio.sleep(10)
                    continue
                if resp.status_code != 200:
                    log.error("HTTP %d from airplanes.live", resp.status_code)
                    await asyncio.sleep(interval)
                    continue

                data = resp.json()
                aircraft = parse_v2_aircraft(data.get("ac") or [])

                aircraft_state["aircraft"] = aircraft
                aircraft_state["timestamp"] = int(time.time())

                log.info("Tracking %d aircraft", len(aircraft))

            except Exception as e:
                log.error("Poll failed: %s", e)

            await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app):
    await load_airports()
    await load_airlines()
    db_task = asyncio.create_task(refresh_aircraft_db())
    poll_task = asyncio.create_task(poll_aircraft())
    log.info("Skywatch started on port %d (source: airplanes.live)", config.port)
    yield
    poll_task.cancel()
    db_task.cancel()
    for t in [poll_task, db_task]:
        try:
            await t
        except asyncio.CancelledError:
            pass
    log.info("Skywatch stopped")


app = FastAPI(lifespan=lifespan)


@app.get("/api/aircraft")
async def get_aircraft():
    return aircraft_state


@app.get("/api/airports")
async def get_airports():
    return airports


@app.get("/api/health")
async def health():
    age = time.time() - aircraft_state["timestamp"] if aircraft_state["timestamp"] else None
    return {
        "status": "ok",
        "source": "airplanes.live",
        "aircraft_count": len(aircraft_state["aircraft"]),
        "data_age_seconds": round(age) if age else None,
        "airports_loaded": len(airports),
        "aircraft_db_loaded": len(aircraft_db),
        "airline_db_loaded": len(airline_db),
        "has_active_viewer": has_active_viewer(),
    }


@app.post("/api/heartbeat")
async def heartbeat():
    global last_viewer_heartbeat
    last_viewer_heartbeat = time.time()
    return {"status": "ok"}


static_dir = Path(__file__).parent / "static"
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True))


def shutdown(sig, frame):
    log.info("Received %s, shutting down", signal.Signals(sig).name)
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    uvicorn.run(app, host=config.host, port=config.port, log_level="warning")
