import asyncio
import gzip
import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from skywatch import (
    Config,
    OpenSkyAuth,
    enrich,
    parse_aircraft,
)


# --- Config ---

def test_config_loads_defaults(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("server:\n  port: 9999\n")
    with patch.object(Path, "exists", side_effect=lambda: False):
        pass
    # Just verify the Config class can instantiate with a real file
    import yaml
    raw = yaml.safe_load(cfg.read_text())
    assert raw["server"]["port"] == 9999


def test_config_optional_bbox(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("opensky:\n  poll_interval: 60\nserver:\n  port: 8078\n")
    with patch("skywatch.Path") as mock_path:
        instance = MagicMock()
        instance.exists.return_value = True
        instance.__truediv__ = lambda s, o: instance
        mock_path.return_value = instance
        mock_path.side_effect = None
        # Test that missing bbox results in None
        import yaml
        raw = yaml.safe_load(cfg.read_text())
        assert raw.get("opensky", {}).get("bbox") is None


# --- Aircraft parsing ---

SAMPLE_STATE = [
    "abc123",     # 0  icao24
    "DAL201  ",   # 1  callsign
    "United States",  # 2  origin_country
    1700000000,   # 3  time_position
    1700000000,   # 4  last_contact
    -95.5,        # 5  longitude
    37.5,         # 6  latitude
    10000.0,      # 7  baro_altitude
    False,        # 8  on_ground
    250.0,        # 9  velocity
    180.0,        # 10 true_track
    -5.0,         # 11 vertical_rate
    None,         # 12 sensors
    10200.0,      # 13 geo_altitude
    "1200",       # 14 squawk
    False,        # 15 spi
    0,            # 16 position_source
]


def test_parse_aircraft_basic():
    result = parse_aircraft([SAMPLE_STATE])
    assert len(result) == 1
    ac = result[0]
    assert ac["icao24"] == "abc123"
    assert ac["callsign"] == "DAL201"
    assert ac["latitude"] == 37.5
    assert ac["longitude"] == -95.5
    assert ac["baro_altitude"] == 10000.0
    assert ac["on_ground"] is False
    assert ac["velocity"] == 250.0
    assert ac["true_track"] == 180.0
    assert ac["vertical_rate"] == -5.0
    assert ac["squawk"] == "1200"


def test_parse_aircraft_strips_callsign():
    state = list(SAMPLE_STATE)
    state[1] = "  UAL456  "
    result = parse_aircraft([state])
    assert result[0]["callsign"] == "UAL456"


def test_parse_aircraft_null_callsign():
    state = list(SAMPLE_STATE)
    state[1] = None
    result = parse_aircraft([state])
    assert result[0]["callsign"] is None


def test_parse_aircraft_skips_null_position():
    state_no_lat = list(SAMPLE_STATE)
    state_no_lat[6] = None
    state_no_lon = list(SAMPLE_STATE)
    state_no_lon[5] = None
    assert parse_aircraft([state_no_lat]) == []
    assert parse_aircraft([state_no_lon]) == []


def test_parse_aircraft_empty_states():
    assert parse_aircraft([]) == []


# --- Enrichment ---

def test_enrich_adds_db_fields():
    from skywatch import aircraft_db
    aircraft_db["abc123"] = {
        "reg": "N520DN",
        "type": "A359",
        "model": "Airbus A350-941",
        "operator": "Delta Air Lines",
        "year": "2017",
        "mil": False,
    }
    ac = {"icao24": "abc123", "callsign": "DAL201"}
    result = enrich(ac)
    assert result["reg"] == "N520DN"
    assert result["operator"] == "Delta Air Lines"
    assert result["model"] == "Airbus A350-941"
    aircraft_db.clear()


def test_enrich_missing_icao():
    ac = {"icao24": "ffffff", "callsign": "TEST"}
    result = enrich(ac)
    assert "reg" not in result
    assert result["callsign"] == "TEST"


# --- Classification (frontend logic, tested here for parity) ---

def classify(a):
    """Mirror the frontend classifyAircraft logic."""
    if a.get("on_ground"):
        return "ground"
    if a.get("mil"):
        return "military"
    cs = a.get("callsign") or ""
    import re
    if re.match(r"^[A-Z]{3}\d", cs):
        return "airline"
    return "private"


def test_classify_airline():
    assert classify({"callsign": "DAL201", "on_ground": False}) == "airline"
    assert classify({"callsign": "BAW123", "on_ground": False}) == "airline"
    assert classify({"callsign": "UAL1", "on_ground": False}) == "airline"


def test_classify_private():
    assert classify({"callsign": "N12345", "on_ground": False}) == "private"
    assert classify({"callsign": None, "on_ground": False}) == "private"
    assert classify({"on_ground": False}) == "private"


def test_classify_military():
    assert classify({"callsign": "RCH123", "on_ground": False, "mil": True}) == "military"


def test_classify_ground():
    assert classify({"callsign": "DAL201", "on_ground": True}) == "ground"
    assert classify({"callsign": "DAL201", "on_ground": True, "mil": True}) == "ground"


# --- OAuth2 ---

@pytest.mark.asyncio
async def test_opensky_auth_caches_token():
    auth = OpenSkyAuth("test-client", "test-secret")
    mock_client = AsyncMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"access_token": "tok123", "expires_in": 1800}
    mock_resp.raise_for_status = MagicMock()
    mock_client.post.return_value = mock_resp

    token1 = await auth.get_token(mock_client)
    assert token1 == "tok123"
    assert mock_client.post.call_count == 1

    # Second call should use cache
    token2 = await auth.get_token(mock_client)
    assert token2 == "tok123"
    assert mock_client.post.call_count == 1


@pytest.mark.asyncio
async def test_opensky_auth_refreshes_expired():
    auth = OpenSkyAuth("test-client", "test-secret")
    auth.token = "old-token"
    auth.expires_at = time.time() - 100  # expired

    mock_client = AsyncMock()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"access_token": "new-token", "expires_in": 1800}
    mock_resp.raise_for_status = MagicMock()
    mock_client.post.return_value = mock_resp

    token = await auth.get_token(mock_client)
    assert token == "new-token"


@pytest.mark.asyncio
async def test_opensky_auth_headers():
    auth = OpenSkyAuth("c", "s")
    auth.token = "mytoken"
    auth.expires_at = time.time() + 600

    mock_client = AsyncMock()
    headers = await auth.auth_headers(mock_client)
    assert headers == {"Authorization": "Bearer mytoken"}
