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

OPENSKY_URL = "https://opensky-network.org/api/states/all"
OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
ACDB_URL = "https://downloads.adsbexchange.com/downloads/basic-ac-db.json.gz"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat"
ACDB_REFRESH_HOURS = 24
VIEWER_TIMEOUT = 60


class Config:
    def __init__(self):
        path = Path("/app/config.yaml")
        if not path.exists():
            path = Path("config.yaml")
        with open(path) as f:
            raw = yaml.safe_load(f)

        opensky = raw.get("opensky", {})
        self.poll_interval = opensky.get("poll_interval", 30)
        self.timeout = opensky.get("timeout", 15)
        bbox = opensky.get("bbox")
        if bbox:
            self.bbox = {
                "lamin": bbox.get("lat_min"),
                "lamax": bbox.get("lat_max"),
                "lomin": bbox.get("lon_min"),
                "lomax": bbox.get("lon_max"),
            }
        else:
            self.bbox = None

        self.client_id = None
        self.client_secret = None
        creds_paths = [
            Path("/run/secrets/opensky_credentials"),
            Path("/app/opensky_credentials.json"),
            Path("skywatch_api_credentials.json"),
        ]
        for cp in creds_paths:
            if cp.exists():
                try:
                    creds = json.loads(cp.read_text())
                    self.client_id = creds.get("clientId")
                    self.client_secret = creds.get("clientSecret")
                    log.info("Loaded OpenSky credentials from %s", cp)
                    break
                except Exception:
                    pass

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


class OpenSkyAuth:
    def __init__(self, client_id, client_secret):
        self.client_id = client_id
        self.client_secret = client_secret
        self.token = None
        self.expires_at = 0

    async def get_token(self, client):
        if self.token and time.time() < self.expires_at - 30:
            return self.token

        resp = await client.post(OPENSKY_TOKEN_URL, data={
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        })
        resp.raise_for_status()
        data = resp.json()

        self.token = data["access_token"]
        self.expires_at = time.time() + data.get("expires_in", 1800)
        log.info("OpenSky token acquired, expires in %ds", data.get("expires_in", 0))
        return self.token

    async def auth_headers(self, client):
        token = await self.get_token(client)
        return {"Authorization": f"Bearer {token}"}


opensky_auth = None
if config.client_id and config.client_secret:
    opensky_auth = OpenSkyAuth(config.client_id, config.client_secret)
    log.info("OpenSky OAuth2 enabled (4000 credits/day)")
else:
    log.warning("No OpenSky credentials found, using anonymous access (400 credits/day)")


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
            active = parts[7].strip('"')
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
                "iata": iata,
                "icao": icao,
                "name": row.get("name", ""),
                "lat": lat,
                "lon": lon,
                "size": size,
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


def enrich(aircraft):
    info = aircraft_db.get(aircraft["icao24"])
    if info:
        aircraft.update(info)

    airline_name, flight_id = decode_airline(aircraft.get("callsign"))
    if airline_name:
        aircraft["airline"] = airline_name
        if not aircraft.get("operator"):
            aircraft["operator"] = airline_name
    if flight_id:
        aircraft["flight"] = flight_id

    return aircraft


def parse_aircraft(states):
    aircraft = []
    for s in states:
        if s[6] is None or s[5] is None:
            continue
        callsign = (s[1] or "").strip()
        ac = {
            "icao24": s[0],
            "callsign": callsign if callsign else None,
            "origin_country": s[2],
            "latitude": s[6],
            "longitude": s[5],
            "baro_altitude": s[7],
            "on_ground": s[8],
            "velocity": s[9],
            "true_track": s[10],
            "vertical_rate": s[11],
            "geo_altitude": s[13],
            "squawk": s[14],
        }
        aircraft.append(enrich(ac))
    return aircraft


async def poll_opensky():
    interval = config.poll_interval
    was_idle = True

    async with httpx.AsyncClient(timeout=config.timeout) as client:
        while True:
            if not has_active_viewer():
                if not was_idle:
                    log.info("No active viewers, pausing OpenSky polling")
                    was_idle = True
                await asyncio.sleep(5)
                continue

            if was_idle:
                log.info("Viewer connected, resuming OpenSky polling")
                was_idle = False

            try:
                headers = {}
                if opensky_auth:
                    headers = await opensky_auth.auth_headers(client)

                params = config.bbox if config.bbox else {}
                resp = await client.get(OPENSKY_URL, params=params, headers=headers)

                if resp.status_code == 429:
                    retry_after = resp.headers.get("X-Rate-Limit-Retry-After-Seconds")
                    if retry_after:
                        wait = int(retry_after) + 5
                    else:
                        wait = min(interval * 4, 600)
                    remaining = resp.headers.get("X-Rate-Limit-Remaining", "?")
                    log.warning("Rate limited (remaining: %s), waiting %ds", remaining, wait)
                    await asyncio.sleep(wait)
                    continue

                resp.raise_for_status()
                data = resp.json()

                remaining = resp.headers.get("X-Rate-Limit-Remaining")
                states = data.get("states") or []
                aircraft_state["aircraft"] = parse_aircraft(states)
                aircraft_state["timestamp"] = data.get("time", int(time.time()))

                credits_left = int(remaining) if remaining and remaining.isdigit() else None
                if credits_left is not None and credits_left < 500:
                    log.warning("Low credits: %d remaining", credits_left)
                elif credits_left is not None and credits_left < 100:
                    log.error("Credits nearly exhausted: %d remaining", credits_left)

                log.info("Tracking %d aircraft (credits remaining: %s)",
                         len(aircraft_state["aircraft"]), remaining or "n/a")

            except httpx.HTTPStatusError as e:
                log.error("HTTP %d from OpenSky", e.response.status_code)
            except (httpx.RequestError, Exception) as e:
                log.error("OpenSky poll failed: %s", e)

            await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app):
    await load_airports()
    await load_airlines()
    db_task = asyncio.create_task(refresh_aircraft_db())
    poll_task = asyncio.create_task(poll_opensky())
    log.info("Skywatch started on port %d", config.port)
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
