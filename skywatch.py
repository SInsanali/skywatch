import asyncio
import csv
import gzip
import io
import json
import logging
import math
import signal
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import h3
import httpx
import uvicorn
import websockets
import yaml
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sgp4.api import Satrec, WGS72
from sgp4.api import jday

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

CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP="
CELESTRAK_GROUPS = {
    "stations": "Space Stations",
    "starlink": "Starlink",
    "gps-ops": "GPS",
    "galileo": "Galileo",
    "iridium-NEXT": "Iridium",
    "globalstar": "Globalstar",
    "oneweb": "OneWeb",
    "weather": "Weather",
    "noaa": "NOAA",
    "goes": "GOES",
    "planet": "Planet Labs",
    "military": "Military",
    "science": "Science",
}
# Limit Starlink to avoid overwhelming the globe
STARLINK_MAX = 200
TLE_REFRESH_HOURS = 6
SAT_PROPAGATE_INTERVAL = 15  # seconds

USGS_QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"
QUAKES_REFRESH_SECONDS = 300  # 5 minutes

GPSJAM_URL_TEMPLATE = "https://gpsjam.org/data/{date}-h3_4.csv"
GPSJAM_REFRESH_HOURS = 6

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


class Config:
    def __init__(self):
        path = Path("/app/config.yaml")
        if not path.exists():
            path = Path("config.yaml")
        with open(path) as f:
            raw = yaml.safe_load(f)

        # Overlay secrets.yaml if it exists (gitignored, holds API keys)
        secrets_path = path.parent / "secrets.yaml"
        if secrets_path.exists():
            with open(secrets_path) as f:
                secrets = yaml.safe_load(f) or {}
            for key, val in secrets.items():
                if isinstance(val, dict) and isinstance(raw.get(key), dict):
                    raw[key].update(val)
                else:
                    raw[key] = val

        polling = raw.get("polling", {})
        self.poll_interval = polling.get("interval", 15)
        self.timeout = polling.get("timeout", 20)

        ais = raw.get("aisstream", {})
        self.ais_api_key = ais.get("api_key", "")
        self.ais_burst_duration = ais.get("burst_duration", 20)
        self.ais_cache_ttl = ais.get("cache_ttl", 60)

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

satellite_records = []  # list of (name, Satrec) tuples from parsed TLEs
satellite_state = []  # latest propagated satellite positions
earthquake_state = {}  # cached USGS GeoJSON
ship_state = {"ships": [], "timestamp": 0}  # cached AIS ship data
jamming_state = {"zones": [], "timestamp": 0}  # GPS jamming detection grid
gpsjam_state = []  # cached GPSJam.org daily zones


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
        if a.get("nic") is not None:
            ac["nic"] = a["nic"]
        if a.get("nac_p") is not None:
            ac["nac_p"] = a["nac_p"]

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


async def fetch_gpsjam():
    global gpsjam_state
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
            gpsjam_state = zones
            log.info("GPSJam data loaded (%s): %d jamming zones", date.isoformat(), len(zones))
            return
        except Exception as e:
            log.warning("Failed to fetch GPSJam data for %s: %s", date.isoformat(), e)

    log.error("Could not fetch GPSJam data for today or yesterday")


async def refresh_gpsjam():
    await fetch_gpsjam()
    while True:
        await asyncio.sleep(GPSJAM_REFRESH_HOURS * 3600)
        await fetch_gpsjam()


def parse_tles(tle_text):
    """Parse TLE text into list of (name, Satrec) tuples."""
    lines = [l.strip() for l in tle_text.strip().splitlines() if l.strip()]
    records = []
    i = 0
    while i + 2 < len(lines):
        name = lines[i]
        line1 = lines[i + 1]
        line2 = lines[i + 2]
        if not line1.startswith("1 ") or not line2.startswith("2 "):
            i += 1
            continue
        try:
            sat = Satrec.twoline2rv(line1, line2, WGS72)
            records.append((name, sat))
        except Exception:
            pass
        i += 3
    return records


async def fetch_tles():
    """Download TLEs from CelesTrak for multiple constellation groups."""
    global satellite_records
    try:
        log.info("Downloading TLEs from CelesTrak (%d groups)...", len(CELESTRAK_GROUPS))
        all_records = []
        seen_names = set()

        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            for group, label in CELESTRAK_GROUPS.items():
                try:
                    resp = await client.get(f"{CELESTRAK_BASE}{group}")
                    resp.raise_for_status()
                    records = parse_tles(resp.text)

                    # Limit Starlink to avoid overwhelming
                    if group == "starlink" and len(records) > STARLINK_MAX:
                        records = records[:STARLINK_MAX]

                    count = 0
                    for name, sat in records:
                        if name not in seen_names:
                            seen_names.add(name)
                            all_records.append((name, sat, label))
                            count += 1

                    log.info("  %s: %d satellites", label, count)
                except Exception as e:
                    log.warning("  Failed to fetch %s: %s", label, e)

        satellite_records = all_records
        log.info("TLEs loaded: %d total satellites", len(all_records))
    except Exception as e:
        log.error("Failed to fetch TLEs: %s", e)


def propagate_satellites():
    """Propagate all satellite positions to the current time using SGP4."""
    now = datetime.now(timezone.utc)
    jd, fr = jday(now.year, now.month, now.day,
                  now.hour, now.minute, now.second + now.microsecond / 1e6)

    results = []
    for entry in satellite_records:
        name, sat = entry[0], entry[1]
        group = entry[2] if len(entry) > 2 else "Unknown"
        try:
            e, r, v = sat.sgp4(jd, fr)
            if e != 0:
                continue
            x, y, z = r  # km in TEME
            vx, vy, vz = v  # km/s in TEME

            # Convert TEME (ECI) to geodetic lat/lon/alt
            # Earth radius in km (WGS72)
            a_earth = 6378.135

            r_mag = math.sqrt(x * x + y * y + z * z)
            lon_rad = math.atan2(y, x)

            # Approximate GMST for ECI -> ECEF rotation
            d = jd - 2451545.0 + fr
            gmst = math.fmod(280.46061837 + 360.98564736629 * d, 360.0)
            gmst_rad = math.radians(gmst)

            # Rotate to ECEF
            x_ecef = x * math.cos(gmst_rad) + y * math.sin(gmst_rad)
            y_ecef = -x * math.sin(gmst_rad) + y * math.cos(gmst_rad)
            z_ecef = z

            lon_deg = math.degrees(math.atan2(y_ecef, x_ecef))
            lat_rad = math.atan2(z_ecef, math.sqrt(x_ecef ** 2 + y_ecef ** 2))

            # Iterative lat for oblate earth
            e2 = 0.006694317778
            for _ in range(5):
                sin_lat = math.sin(lat_rad)
                N = a_earth / math.sqrt(1 - e2 * sin_lat ** 2)
                lat_rad = math.atan2(z_ecef + e2 * N * sin_lat,
                                     math.sqrt(x_ecef ** 2 + y_ecef ** 2))

            lat_deg = math.degrees(lat_rad)
            sin_lat = math.sin(lat_rad)
            cos_lat = math.cos(lat_rad)
            N = a_earth / math.sqrt(1 - e2 * sin_lat ** 2)
            alt_km = math.sqrt(x_ecef ** 2 + y_ecef ** 2) / cos_lat - N if abs(cos_lat) > 1e-10 else abs(z_ecef) / abs(sin_lat) - N * (1 - e2)

            velocity_km_s = math.sqrt(vx * vx + vy * vy + vz * vz)

            results.append({
                "name": name.strip(),
                "group": group,
                "latitude": round(lat_deg, 4),
                "longitude": round(lon_deg, 4),
                "altitude": round(alt_km, 2),
                "velocity": round(velocity_km_s, 4),
            })
        except Exception:
            continue

    return results


async def refresh_tles():
    """Periodically re-fetch TLEs from CelesTrak."""
    await fetch_tles()
    while True:
        await asyncio.sleep(TLE_REFRESH_HOURS * 3600)
        await fetch_tles()


async def propagate_satellites_loop():
    """Propagate satellite positions every few seconds."""
    global satellite_state
    while True:
        if satellite_records:
            satellite_state = await asyncio.get_event_loop().run_in_executor(
                None, propagate_satellites
            )
        await asyncio.sleep(SAT_PROPAGATE_INTERVAL)


async def fetch_earthquakes():
    """Download earthquake data from USGS."""
    global earthquake_state
    try:
        log.info("Downloading earthquake data from USGS...")
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(USGS_QUAKES_URL)
            resp.raise_for_status()
        earthquake_state = resp.json()
        count = len(earthquake_state.get("features", []))
        log.info("Earthquake data loaded: %d events", count)
    except Exception as e:
        log.error("Failed to fetch earthquake data: %s", e)


async def refresh_earthquakes():
    """Periodically re-fetch earthquake data."""
    await fetch_earthquakes()
    while True:
        await asyncio.sleep(QUAKES_REFRESH_SECONDS)
        await fetch_earthquakes()


async def collect_ais_burst():
    """Connect to AISStream WebSocket, collect ship data for a burst duration."""
    global ship_state
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

    ship_state = {"ships": moving, "timestamp": int(time.time())}
    log.info("AIS burst: %d total, %d moving ships", len(ships), len(moving))


async def refresh_ships():
    """Periodically collect AIS ship data."""
    if not config.ais_api_key:
        log.info("No AISStream API key configured, skipping ship tracking")
        return
    # First burst immediately on startup
    await collect_ais_burst()
    while True:
        await asyncio.sleep(config.ais_cache_ttl)
        if has_active_viewer():
            await collect_ais_burst()


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

                zones = compute_jamming_grid(aircraft)
                jamming_state["zones"] = zones
                jamming_state["timestamp"] = int(time.time())

                log.info("Tracking %d aircraft, %d jamming zones", len(aircraft), len(zones))

            except Exception as e:
                log.error("Poll failed: %s", e)

            await asyncio.sleep(interval)


async def resilient_task(name, coro_func):
    """Run a background task, restarting on unexpected failures."""
    while True:
        try:
            await coro_func()
            break  # normal exit
        except asyncio.CancelledError:
            raise  # let cancellation propagate
        except Exception as e:
            log.error("Task '%s' crashed: %s — restarting in 30s", name, e)
            await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(app):
    await load_airports()
    await load_airlines()
    db_task = asyncio.create_task(resilient_task("refresh_aircraft_db", refresh_aircraft_db))
    poll_task = asyncio.create_task(resilient_task("poll_aircraft", poll_aircraft))
    tle_task = asyncio.create_task(resilient_task("refresh_tles", refresh_tles))
    sat_task = asyncio.create_task(resilient_task("propagate_satellites_loop", propagate_satellites_loop))
    quake_task = asyncio.create_task(resilient_task("refresh_earthquakes", refresh_earthquakes))
    ship_task = asyncio.create_task(resilient_task("refresh_ships", refresh_ships))
    gpsjam_task = asyncio.create_task(resilient_task("refresh_gpsjam", refresh_gpsjam))
    log.info("Skywatch started on port %d (source: airplanes.live)", config.port)
    yield
    for t in [poll_task, db_task, tle_task, sat_task, quake_task, ship_task, gpsjam_task]:
        t.cancel()
    for t in [poll_task, db_task, tle_task, sat_task, quake_task, ship_task, gpsjam_task]:
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
        "satellites_tracked": len(satellite_state),
        "earthquakes_loaded": len(earthquake_state.get("features", [])),
        "ships_tracked": len(ship_state.get("ships", [])),
        "jamming_zones": len(jamming_state.get("zones", [])),
        "gpsjam_zones": len(gpsjam_state),
        "has_active_viewer": has_active_viewer(),
    }


@app.get("/api/satellites")
async def get_satellites():
    return satellite_state


@app.get("/api/earthquakes")
async def get_earthquakes():
    return earthquake_state


@app.get("/api/ships")
async def get_ships():
    return ship_state


@app.get("/api/jamming")
async def get_jamming():
    combined = jamming_state.get("zones", []) + gpsjam_state
    return {"zones": combined, "timestamp": jamming_state.get("timestamp", 0)}


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
