"""Tests for the frontend HTML to verify key elements exist."""
import sys
from pathlib import Path

import pytest

STATIC_DIR = Path(__file__).parent.parent / "static"


@pytest.fixture
def html():
    return (STATIC_DIR / "index.html").read_text()


def test_html_has_leaflet(html):
    assert "leaflet@1.9.4" in html


def test_html_has_map_div(html):
    assert 'id="map"' in html


def test_html_has_sidebar(html):
    assert 'id="sidebar"' in html


def test_html_has_timezone_bar(html):
    assert 'id="tz-bar"' in html


def test_html_has_filter_checkboxes(html):
    for f in ["f-airline", "f-private", "f-military", "f-ground", "f-airports", "f-night"]:
        assert f'id="{f}"' in html, f"Missing filter: {f}"


def test_html_has_theme_toggle(html):
    assert 'id="f-theme"' in html


def test_html_has_heartbeat(html):
    assert "/api/heartbeat" in html


def test_html_has_aircraft_fetch(html):
    assert "/api/aircraft" in html


def test_html_has_airport_fetch(html):
    assert "/api/airports" in html


def test_html_has_carto_tiles(html):
    assert "basemaps.cartocdn.com" in html


def test_html_has_dark_and_light_tiles(html):
    assert "dark_nolabels" in html
    assert "voyager" in html


def test_html_has_fr24_link(html):
    assert "flightradar24.com" in html
    assert "Track on FR24" in html


def test_html_has_callsign_tooltip(html):
    assert "callsign-tooltip" in html


def test_html_has_popup_structure(html):
    for cls in ["popup-header", "popup-callsign", "popup-aircraft-card", "popup-data", "popup-footer"]:
        assert cls in html, f"Missing popup class: {cls}"


def test_html_has_top_types(html):
    assert 'id="top-types"' in html


def test_html_has_css_variables(html):
    assert "--bg:" in html
    assert "--accent:" in html
    assert "body.light" in html


def test_html_has_search(html):
    assert 'id="search-input"' in html
    assert 'id="search-results"' in html


def test_html_has_region_pills(html):
    assert "region-pill" in html
    for r in ["global", "na", "eu", "asia", "me", "af", "sa", "oc"]:
        assert f'data-region="{r}"' in html, f"Missing region: {r}"


def test_html_has_region_bounds(html):
    assert "inRegion" in html
