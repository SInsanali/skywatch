"""Integration tests for the Skywatch API endpoints."""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from skywatch import app, aircraft_state, aircraft_db, airports


@pytest.fixture(autouse=True)
def reset_state():
    aircraft_state["timestamp"] = 0
    aircraft_state["aircraft"] = []
    aircraft_db.clear()
    airports.clear()
    yield
    aircraft_state["timestamp"] = 0
    aircraft_state["aircraft"] = []
    aircraft_db.clear()
    airports.clear()


@pytest.fixture
def client():
    return TestClient(app, raise_server_exceptions=False)


def test_aircraft_endpoint_empty(client):
    resp = client.get("/api/aircraft")
    assert resp.status_code == 200
    data = resp.json()
    assert data["timestamp"] == 0
    assert data["aircraft"] == []


def test_aircraft_endpoint_with_data(client):
    aircraft_state["timestamp"] = 1700000000
    aircraft_state["aircraft"] = [
        {"icao24": "abc123", "callsign": "DAL201", "latitude": 37.5, "longitude": -95.5,
         "baro_altitude": 10000, "on_ground": False, "velocity": 250, "true_track": 180,
         "vertical_rate": 0, "geo_altitude": 10200, "squawk": "1200", "origin_country": "US"},
    ]
    resp = client.get("/api/aircraft")
    data = resp.json()
    assert len(data["aircraft"]) == 1
    assert data["aircraft"][0]["callsign"] == "DAL201"
    assert data["timestamp"] == 1700000000


def test_airports_endpoint_empty(client):
    resp = client.get("/api/airports")
    assert resp.status_code == 200
    assert resp.json() == []


def test_airports_endpoint_with_data(client):
    airports.extend([
        {"iata": "LAX", "icao": "KLAX", "name": "Los Angeles Intl", "lat": 33.94, "lon": -118.41, "size": "L"},
        {"iata": "DEN", "icao": "KDEN", "name": "Denver Intl", "lat": 39.86, "lon": -104.67, "size": "L"},
    ])
    resp = client.get("/api/airports")
    data = resp.json()
    assert len(data) == 2
    assert data[0]["iata"] == "LAX"


def test_heartbeat_endpoint(client):
    resp = client.post("/api/heartbeat")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_health_endpoint(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "aircraft_count" in data
    assert "airports_loaded" in data
    assert "aircraft_db_loaded" in data
    assert "airline_db_loaded" in data
    assert "has_active_viewer" in data


def test_static_index_served(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Skywatch" in resp.text


def test_aircraft_enrichment_in_response(client):
    aircraft_db["abc123"] = {
        "reg": "N520DN", "type": "A359", "model": "Airbus A350",
        "operator": "Delta", "year": "2017", "mil": False,
    }
    aircraft_state["timestamp"] = 1700000000
    aircraft_state["aircraft"] = [
        {"icao24": "abc123", "callsign": "DAL201", "latitude": 37.5, "longitude": -95.5,
         "baro_altitude": 10000, "on_ground": False, "velocity": 250, "true_track": 180,
         "vertical_rate": 0, "geo_altitude": 10200, "squawk": "1200", "origin_country": "US",
         "reg": "N520DN", "type": "A359", "model": "Airbus A350", "operator": "Delta",
         "year": "2017", "mil": False},
    ]
    resp = client.get("/api/aircraft")
    ac = resp.json()["aircraft"][0]
    assert ac["reg"] == "N520DN"
    assert ac["operator"] == "Delta"
