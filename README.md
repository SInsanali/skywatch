# Skywatch

Self-hosted global flight tracker. Single Docker container, no API keys, no hardware — just `docker compose up` and you've got a live map of every aircraft worldwide.

Built with Python (FastAPI), Leaflet.js, and CARTO/OSM tiles.

## Features

- **~8,000+ aircraft** tracked globally with ~15 second updates
- Aircraft enrichment: registration, model, operator, airline decoded from callsign
- Flight data: altitude, speed, heading, IAS, Mach, wind, OAT, selected altitude
- Distinct icons for jets, widebodies, helicopters, and light aircraft (canvas-rendered for performance)
- 9,000+ airports with zoom-tiered visibility
- Day/night terminator overlay
- Timezone bar synced to map viewport
- Region quick-filters and full-text search
- Collapsible sidebar with aircraft type breakdown (ICAO codes mapped to friendly names)
- Map styles: Dark, Light, Satellite, Terrain
- Independent dark/light menu theme
- Heartbeat-based polling — only fetches data when someone is viewing

## Quick Start

```bash
git clone https://github.com/SInsanali/skywatch.git
cd skywatch
docker compose up -d
```

Open `http://localhost:8078`. That's it.

## Data Sources

| Source | What | Refresh |
|--------|------|---------|
| [airplanes.live](https://airplanes.live) | Live aircraft positions (ADS-B/MLAT) | Every 15s (when viewed) |
| [ADS-B Exchange](https://www.adsbexchange.com) | Aircraft registration, model, operator | Daily |
| [OpenFlights](https://openflights.org/data) | ICAO airline code → name mapping | On startup |
| [OurAirports](https://ourairports.com/data/) | Airport locations and metadata | On startup |

No API keys or accounts needed. All data sources are free and open.

## Configuration

Edit `config.yaml`:

```yaml
polling:
  interval: 15             # seconds between poll cycles
  timeout: 30              # HTTP request timeout

server:
  host: "0.0.0.0"
  port: 8078
```

## Architecture

Single Python process with two async tasks:

- **Poller** — fetches the full global aircraft set from airplanes.live in a single API call every 15 seconds (only when a viewer is connected via heartbeat)
- **API server** — FastAPI serving `/api/aircraft`, `/api/airports`, `/api/health`, `/api/heartbeat`, and the static frontend

The frontend renders all aircraft on a single HTML5 canvas (no DOM markers), with hit detection for click popups and hover tooltips. This keeps the browser smooth even with 8,000+ aircraft.

## Deployment

### Docker Compose

```bash
docker compose up -d
```

### Podman / Systemd (AlmaLinux 9)

For headless server deployments with Podman rootless and systemd Quadlet:

```bash
bash deploy.sh
```

This rsyncs to the server, builds the container, installs the Quadlet unit, and restarts the service. See [deploy.sh](deploy.sh) and [skywatch.container](skywatch.container).

### Local Development

```bash
pip install -r requirements.txt
python skywatch.py
```

Open `http://localhost:8078`.

## Tests

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## License

MIT
