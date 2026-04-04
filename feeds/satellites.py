import asyncio
import logging
import math
from datetime import datetime, timezone

from sgp4.api import Satrec, WGS72
from sgp4.api import jday

log = logging.getLogger("skywatch")

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
STARLINK_MAX = 200
TLE_REFRESH_HOURS = 6
SAT_PROPAGATE_INTERVAL = 15  # seconds


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


async def fetch_tles(satellite_records):
    """Download TLEs from CelesTrak for multiple constellation groups."""
    try:
        import httpx
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

        satellite_records.clear()
        satellite_records.extend(all_records)
        log.info("TLEs loaded: %d total satellites", len(all_records))
    except Exception as e:
        log.error("Failed to fetch TLEs: %s", e)


def propagate_satellites(satellite_records):
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


async def refresh_tles(satellite_records):
    """Periodically re-fetch TLEs from CelesTrak."""
    await fetch_tles(satellite_records)
    while True:
        await asyncio.sleep(TLE_REFRESH_HOURS * 3600)
        await fetch_tles(satellite_records)


async def propagate_satellites_loop(satellite_records, set_satellite_state):
    """Propagate satellite positions every few seconds."""
    while True:
        if satellite_records:
            result = await asyncio.get_event_loop().run_in_executor(
                None, propagate_satellites, satellite_records
            )
            set_satellite_state(result)
        await asyncio.sleep(SAT_PROPAGATE_INTERVAL)
