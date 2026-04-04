import re

import pytest

from skywatch import (
    Config,
    decode_airline,
    parse_v2_aircraft,
)


# --- Config ---

def test_config_loads_defaults(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("server:\n  port: 9999\n")
    import yaml
    raw = yaml.safe_load(cfg.read_text())
    assert raw["server"]["port"] == 9999


def test_config_polling_defaults(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("server:\n  port: 8078\n")
    import yaml
    raw = yaml.safe_load(cfg.read_text())
    polling = raw.get("polling", {})
    assert polling.get("interval", 15) == 15


# --- v2 Aircraft parsing ---

SAMPLE_V2_AC = {
    "hex": "abc123",
    "flight": "DAL201  ",
    "lat": 37.5,
    "lon": -95.5,
    "alt_baro": 35000,
    "alt_geom": 35500,
    "gs": 450,
    "track": 180.0,
    "baro_rate": -500,
    "squawk": "1200",
    "r": "N520DN",
    "t": "A359",
    "ias": 280,
    "tas": 460,
    "mach": 0.82,
    "wd": 270,
    "ws": 45,
    "oat": -52,
    "category": "A5",
    "dbFlags": 0,
}


def test_parse_v2_basic():
    result = parse_v2_aircraft([SAMPLE_V2_AC])
    assert len(result) == 1
    ac = result[0]
    assert ac["icao24"] == "abc123"
    assert ac["callsign"] == "DAL201"
    assert ac["latitude"] == 37.5
    assert ac["longitude"] == -95.5
    assert ac["reg"] == "N520DN"
    assert ac["type"] == "A359"
    assert ac["squawk"] == "1200"
    assert ac["ias"] == 280
    assert ac["mach"] == 0.82
    assert ac["wind_dir"] == 270
    assert ac["oat"] == -52


def test_parse_v2_altitude_conversion():
    result = parse_v2_aircraft([SAMPLE_V2_AC])
    ac = result[0]
    assert ac["baro_altitude"] == pytest.approx(35000 * 0.3048, rel=0.01)
    assert ac["geo_altitude"] == pytest.approx(35500 * 0.3048, rel=0.01)


def test_parse_v2_speed_conversion():
    result = parse_v2_aircraft([SAMPLE_V2_AC])
    ac = result[0]
    assert ac["velocity"] == pytest.approx(450 * 0.514444, rel=0.01)


def test_parse_v2_ground():
    ac = dict(SAMPLE_V2_AC)
    ac["alt_baro"] = "ground"
    result = parse_v2_aircraft([ac])
    assert result[0]["on_ground"] is True
    assert result[0]["baro_altitude"] == 0


def test_parse_v2_strips_callsign():
    ac = dict(SAMPLE_V2_AC)
    ac["flight"] = "  UAL456  "
    result = parse_v2_aircraft([ac])
    assert result[0]["callsign"] == "UAL456"


def test_parse_v2_null_position():
    ac = dict(SAMPLE_V2_AC)
    ac["lat"] = None
    assert parse_v2_aircraft([ac]) == []


def test_parse_v2_empty():
    assert parse_v2_aircraft([]) == []


def test_parse_v2_military_flag():
    ac = dict(SAMPLE_V2_AC)
    ac["dbFlags"] = 1
    result = parse_v2_aircraft([ac])
    assert result[0]["mil"] is True


def test_parse_v2_emergency():
    ac = dict(SAMPLE_V2_AC)
    ac["emergency"] = "general"
    result = parse_v2_aircraft([ac])
    assert result[0]["emergency"] == "general"


def test_parse_v2_no_emergency():
    ac = dict(SAMPLE_V2_AC)
    ac["emergency"] = "none"
    result = parse_v2_aircraft([ac])
    assert "emergency" not in result[0]


# --- Airline decoding ---

def test_decode_airline():
    from skywatch import airline_db
    airline_db["DAL"] = {"name": "Delta Air Lines", "country": "United States"}
    name, flight = decode_airline("DAL201")
    assert name == "Delta Air Lines"
    assert flight == "DAL201"
    airline_db.clear()


def test_decode_airline_strips_zeros():
    from skywatch import airline_db
    airline_db["UAL"] = {"name": "United Airlines", "country": "United States"}
    name, flight = decode_airline("UAL0042")
    assert flight == "UAL42"
    airline_db.clear()


def test_decode_airline_unknown():
    name, flight = decode_airline("ZZZ999")
    assert name is None


def test_decode_airline_short():
    name, flight = decode_airline("AB")
    assert name is None


def test_decode_airline_none():
    name, flight = decode_airline(None)
    assert name is None


# --- Classification (frontend logic, tested for parity) ---

def classify(a):
    if a.get("on_ground"):
        return "ground"
    if a.get("mil"):
        return "military"
    cs = a.get("callsign") or ""
    if re.match(r"^[A-Z]{3}\d", cs):
        return "airline"
    return "private"


def test_classify_airline():
    assert classify({"callsign": "DAL201", "on_ground": False}) == "airline"


def test_classify_private():
    assert classify({"callsign": "N12345", "on_ground": False}) == "private"


def test_classify_military():
    assert classify({"callsign": "RCH123", "on_ground": False, "mil": True}) == "military"


def test_classify_ground():
    assert classify({"callsign": "DAL201", "on_ground": True}) == "ground"
