# Skywatch

Self-hosted flight tracker with a live map UI. Pulls real-time aircraft data from the OpenSky Network API and displays it on an interactive map. No ADS-B hardware required.

Built with Python (FastAPI), Leaflet.js, and OpenStreetMap. Runs as a single Podman container.

## Features

- Live global aircraft tracking with 30-second updates
- Aircraft enrichment with model, registration, operator, and airline decoded from callsign
- Different icons for jets, widebodies, helicopters, and light aircraft
- 9,000+ airports with zoom-tiered visibility
- Day/night terminator overlay
- Timezone bar that follows the map viewport
- Region quick-filters and full-text search
- Dark and light mode
- Heartbeat-based polling so API credits are only used when someone is viewing

## Data Sources

| Source | What | Refresh |
|--------|------|---------|
| [OpenSky Network](https://opensky-network.org) | Live aircraft positions | Every 30s (when viewed) |
| [ADS-B Exchange](https://www.adsbexchange.com) | Aircraft registration, model, operator | Daily |
| [OpenFlights](https://openflights.org/data) | ICAO airline code to name mapping | On startup |
| [OurAirports](https://ourairports.com/data/) | Airport locations and metadata | On startup |

## Getting Started

### Prerequisites

- A Linux server with Podman installed (tested on AlmaLinux 9)
- An [OpenSky Network account](https://opensky-network.org) with API client credentials
- SSH access to the server from your dev machine

### OpenSky API Setup

1. Create a free account at [opensky-network.org](https://opensky-network.org)
2. Go to your [account page](https://opensky-network.org/my-opensky/account)
3. Under "API Client", click **Create & Download Credential**
4. Save the downloaded JSON file as `skywatch_api_credentials.json` in the project root
5. This file is gitignored and will be deployed as a Podman secret

Free accounts get 4,000 API credits per day. Global queries cost 4 credits each. At 30-second intervals, that's about 8 hours of active viewing per day. The app only polls when a browser tab is open.

### Server Setup

Create the service user:

```bash
sudo useradd -r -m -d /home/skywatch -s /bin/bash -c 'Skywatch flight tracker' skywatch
sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 skywatch
sudo loginctl enable-linger skywatch
```

Create the project and Quadlet directories:

```bash
sudo -u skywatch mkdir -p /home/skywatch/.config/containers/systemd /home/skywatch/skywatch
```

Open the firewall port:

```bash
sudo firewall-cmd --permanent --add-port=8078/tcp
sudo firewall-cmd --reload
```

### Deploy

```bash
./deploy.sh
```

This rsyncs the project to the server, creates the credentials as a Podman secret, builds the container image, installs the Quadlet systemd unit, and starts the service.

Then open `http://<server-ip>:8078` in your browser.

### Configuration

Edit `config.yaml` to adjust polling interval or restrict to a geographic region:

```yaml
opensky:
  poll_interval: 30
  # bbox:
  #   lat_min: 24.0
  #   lat_max: 50.0
  #   lon_min: -125.0
  #   lon_max: -66.0
```

### Local Development

```bash
pip install -r requirements.txt
python skywatch.py
```

### Tests

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## License

MIT
