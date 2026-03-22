# Skywatch

Self-hosted global intelligence tracker. Ingests public API data to populate a live 3D globe with aircraft, satellites, ships, and earthquakes. Single Docker container — just `docker compose up` and go.

Built with Python (FastAPI), React, CesiumJS, and Vite.

## Features

- **3D Globe** — CesiumJS with dark and satellite map styles, Bing Maps imagery, English labels
- **~8,000+ aircraft** tracked globally with ~15 second updates from airplanes.live
- **~150 satellites** tracked in real-time using CelesTrak TLE data + SGP4 orbital propagation
- **~800+ ships** tracked via AIS maritime data (AISStream.io WebSocket bursts)
- **100+ earthquakes** from USGS (M4.5+ past week)
- Aircraft enrichment: registration, model, operator, airline decoded from callsign
- Flight data: altitude, speed, heading, IAS, Mach, wind, OAT, selected altitude
- Distinct airplane icons colored by category (airline, private, military, ground)
- Flight trails on selected aircraft
- Hover tooltips and click-to-detail panels with FR24 link
- Callsign labels appear when zoomed in (radar-scope style)
- Selection glow effect on clicked objects
- Region quick-filters and full-text search
- Camera altitude indicator
- Heartbeat-based polling — only fetches data when someone is viewing

## Quick Start

```bash
git clone https://github.com/SInsanali/skywatch.git
cd skywatch
docker compose up -d
```

Open `http://localhost:8078`.

### Ship Tracking (Optional)

Ship tracking requires a free API key from [AISStream.io](https://aisstream.io):

1. Sign up at aisstream.io (GitHub auth supported)
2. Generate an API key
3. Add it to `config.yaml`:

```yaml
aisstream:
  api_key: "your-key-here"
```

Without the key, everything else works — ships are just skipped.

## Data Sources

| Source | What | Refresh | Key Required |
|--------|------|---------|:---:|
| [airplanes.live](https://airplanes.live) | Live aircraft positions (ADS-B/MLAT) | 15s | No |
| [CelesTrak](https://celestrak.org) | Satellite TLE orbital data | 6h (TLE), 5s (propagation) | No |
| [USGS](https://earthquake.usgs.gov) | Earthquake data (M4.5+ weekly) | 5 min | No |
| [AISStream.io](https://aisstream.io) | Live ship positions (AIS) | 60s (20s bursts) | Free key |
| [ADS-B Exchange](https://www.adsbexchange.com) | Aircraft registration, model, operator | Daily | No |
| [OpenFlights](https://openflights.org/data) | Airline code to name mapping | Startup | No |
| [OurAirports](https://ourairports.com/data/) | Airport locations and metadata | Startup | No |

## Configuration

Edit `config.yaml`:

```yaml
polling:
  interval: 15             # seconds between aircraft poll cycles
  timeout: 30              # HTTP request timeout

aisstream:
  api_key: ""              # AISStream.io API key (free, optional)
  burst_duration: 20       # seconds to collect AIS data per burst
  cache_ttl: 60            # seconds to cache ship data

server:
  host: "0.0.0.0"
  port: 8078
```

## Architecture

Single Python process with multiple async data feeds:

- **Aircraft poller** — fetches the full global aircraft set from airplanes.live every 15s
- **Satellite propagator** — fetches TLEs from CelesTrak every 6h, propagates positions with SGP4 every 5s
- **Earthquake poller** — fetches USGS GeoJSON every 5 min
- **AIS collector** — connects to AISStream.io WebSocket for 20-second bursts, collecting ~800+ moving ships
- **API server** — FastAPI serving data endpoints and the built React frontend

Frontend is React + CesiumJS (Resium), built with Vite. Aircraft, satellites, ships, and earthquakes are rendered as CesiumJS BillboardCollections for performance. The Vite build outputs to `static/` which FastAPI serves.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/aircraft` | GET | Current aircraft positions + metadata |
| `/api/satellites` | GET | Current satellite positions (SGP4-propagated) |
| `/api/earthquakes` | GET | USGS earthquake GeoJSON |
| `/api/ships` | GET | Current ship positions (AIS) |
| `/api/airports` | GET | Airport database |
| `/api/health` | GET | System status + counts |
| `/api/heartbeat` | POST | Signal viewer presence |

## Deployment

### Docker Compose

```bash
docker compose up -d
```

### Remote Server (AlmaLinux 9)

```bash
bash deploy.sh
```

Rsyncs to the server, builds with `docker compose`, and starts the service.

### Local Development

Backend:
```bash
pip install -r requirements.txt
python skywatch.py
```

Frontend (hot reload):
```bash
cd frontend
npm install
npm run dev
```

Vite dev server at `http://localhost:5173` proxies API calls to the backend on port 8078.

### Production Build

```bash
cd frontend
npm run build    # outputs to ../static/
```

## Tests

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## License

MIT
