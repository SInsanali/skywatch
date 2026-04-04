import asyncio
import logging
import signal
import sys
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from feeds.aircraft import (
    load_airlines,
    load_airports,
    poll_aircraft,
    refresh_aircraft_db,
)
from feeds.satellites import refresh_tles, propagate_satellites_loop
from feeds.earthquakes import refresh_earthquakes
from feeds.ships import refresh_ships
from feeds.jamming import refresh_gpsjam

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("skywatch")

VIEWER_TIMEOUT = 60


class RateLimiter:
    """Simple in-memory per-IP rate limiter using sliding window."""

    def __init__(self, max_requests: int, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window = window_seconds
        self.requests: dict[str, list[float]] = defaultdict(list)
        self._last_cleanup = time.time()

    def is_allowed(self, ip: str) -> bool:
        now = time.time()
        cutoff = now - self.window

        # periodic cleanup every 5 minutes
        if now - self._last_cleanup > 300:
            self._cleanup(cutoff)

        timestamps = self.requests[ip]
        # trim old entries for this IP
        while timestamps and timestamps[0] < cutoff:
            timestamps.pop(0)

        if len(timestamps) >= self.max_requests:
            return False
        timestamps.append(now)
        return True

    def _cleanup(self, cutoff: float):
        self._last_cleanup = time.time()
        stale = [ip for ip, ts in self.requests.items()
                 if not ts or ts[-1] < cutoff]
        for ip in stale:
            del self.requests[ip]


data_limiter = RateLimiter(max_requests=60, window_seconds=60)
light_limiter = RateLimiter(max_requests=120, window_seconds=60)


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

satellite_records = []  # list of (name, Satrec, group) tuples from parsed TLEs
satellite_state = []  # latest propagated satellite positions
earthquake_state = {}  # cached USGS GeoJSON
ship_state = {"ships": [], "timestamp": 0}  # cached AIS ship data
jamming_state = {"zones": [], "timestamp": 0}  # GPS jamming detection grid
gpsjam_state = []  # cached GPSJam.org daily zones


def has_active_viewer():
    return (time.time() - last_viewer_heartbeat) < VIEWER_TIMEOUT


async def resilient_task(name, coro_func):
    """Run a background task, restarting on unexpected failures."""
    while True:
        try:
            await coro_func()
            break  # normal exit
        except asyncio.CancelledError:
            raise  # let cancellation propagate
        except Exception as e:
            log.error("Task '%s' crashed: %s -- restarting in 30s", name, e)
            await asyncio.sleep(30)


def _set_satellite_state(result):
    global satellite_state
    satellite_state = result


@asynccontextmanager
async def lifespan(app):
    await load_airports(airports)
    await load_airlines(airline_db)
    db_task = asyncio.create_task(resilient_task(
        "refresh_aircraft_db", lambda: refresh_aircraft_db(aircraft_db)))
    poll_task = asyncio.create_task(resilient_task(
        "poll_aircraft",
        lambda: poll_aircraft(config, aircraft_state, aircraft_db, airline_db,
                              jamming_state, has_active_viewer)))
    tle_task = asyncio.create_task(resilient_task(
        "refresh_tles", lambda: refresh_tles(satellite_records)))
    sat_task = asyncio.create_task(resilient_task(
        "propagate_satellites_loop",
        lambda: propagate_satellites_loop(satellite_records, _set_satellite_state)))
    quake_task = asyncio.create_task(resilient_task(
        "refresh_earthquakes", lambda: refresh_earthquakes(earthquake_state)))
    ship_task = asyncio.create_task(resilient_task(
        "refresh_ships",
        lambda: refresh_ships(config, ship_state, has_active_viewer)))
    gpsjam_task = asyncio.create_task(resilient_task(
        "refresh_gpsjam", lambda: refresh_gpsjam(gpsjam_state)))
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

LIGHT_ENDPOINTS = {"/api/health", "/api/heartbeat"}


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/"):
        ip = request.client.host if request.client else "unknown"
        limiter = light_limiter if path in LIGHT_ENDPOINTS else data_limiter
        if not limiter.is_allowed(ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests"},
            )
    return await call_next(request)


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
