from feeds.eonet import normalize_events


SAMPLE_EVENTS_RESPONSE = {
    "events": [
        {
            "id": "EONET_6789",
            "title": "Wildfires - California",
            "categories": [{"id": "wildfires", "title": "Wildfires"}],
            "geometry": [
                {
                    "magnitudeValue": 1500.0,
                    "magnitudeUnit": "acres",
                    "date": "2026-04-30T18:00:00Z",
                    "type": "Point",
                    "coordinates": [-120.5, 38.7],
                }
            ],
        },
        {
            "id": "EONET_4242",
            "title": "Tropical Storm",
            "categories": [{"id": "severeStorms", "title": "Severe Storms"}],
            "geometry": [
                {"date": "2026-04-29T12:00:00Z", "type": "Point", "coordinates": [-75.0, 25.0]},
                {"date": "2026-04-30T12:00:00Z", "type": "Point", "coordinates": [-77.0, 27.0]},
            ],
        },
    ]
}


def test_normalize_events_basic():
    out = normalize_events(SAMPLE_EVENTS_RESPONSE)
    assert len(out) == 2
    fire = out[0]
    assert fire["id"] == "EONET_6789"
    assert fire["title"] == "Wildfires - California"
    assert fire["category"] == "wildfires"
    assert fire["geometry"] == [
        {"date": "2026-04-30T18:00:00Z", "type": "Point", "coordinates": [-120.5, 38.7]}
    ]
    assert fire["last_update"] == "2026-04-30T18:00:00Z"

    storm = out[1]
    assert storm["id"] == "EONET_4242"
    assert len(storm["geometry"]) == 2
    assert storm["last_update"] == "2026-04-30T12:00:00Z"


def test_normalize_events_skips_event_without_geometry():
    payload = {"events": [{"id": "X", "title": "Empty", "categories": [{"id": "wildfires"}], "geometry": []}]}
    assert normalize_events(payload) == []


def test_normalize_events_handles_missing_keys():
    assert normalize_events({}) == []
    assert normalize_events({"events": None}) == []
