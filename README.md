# Skywatch

Self-hosted flight tracker with a live map UI. Pulls real-time aircraft data and displays it on an interactive map. No ADS-B hardware or API keys required.

Built with Python (FastAPI), Leaflet.js, and OpenStreetMap. Runs as a single container.

## Features

- Live global aircraft tracking with ~15 second updates
- Aircraft enrichment with model, registration, operator, and airline decoded from callsign
- Rich flight data including IAS, Mach, wind, temperature, and selected altitude
- Different icons for jets, widebodies, helicopters, and light aircraft
- 9,000+ airports with zoom-tiered visibility
- Day/night terminator overlay
- Timezone bar that follows the map viewport
- Region quick-filters and full-text search
- Dark and light mode
- Heartbeat-based polling (only fetches data when someone is viewing)

## Quick Start (Docker)

```bash
git clone https://github.com/SInsanali/skywatch.git
cd skywatch
docker compose up -d
```

Open `http://localhost:8078` in your browser. That's it.

## Data Sources

| Source | What | Refresh |
|--------|------|---------|
| [airplanes.live](https://airplanes.live) | Live aircraft positions (ADS-B/MLAT) | Every 15s (when viewed) |
| [ADS-B Exchange](https://www.adsbexchange.com) | Aircraft registration, model, operator | Daily |
| [OpenFlights](https://openflights.org/data) | ICAO airline code to name mapping | On startup |
| [OurAirports](https://ourairports.com/data/) | Airport locations and metadata | On startup |

No API keys or accounts needed. All data sources are free and open.

## Configuration

Edit `config.yaml` to adjust settings:

```yaml
polling:
  interval: 15             # seconds between poll cycles
  timeout: 30              # HTTP request timeout

server:
  host: "0.0.0.0"
  port: 8078
```

## Podman / Systemd

For headless server deployments with Podman and systemd (tested on AlmaLinux 9), see [deploy.sh](deploy.sh) and [skywatch.container](skywatch.container) for the Quadlet unit file.

## Local Development

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
