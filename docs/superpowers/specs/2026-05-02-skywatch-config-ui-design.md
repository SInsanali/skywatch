# Skywatch Config UI — Design

**Date:** 2026-05-02
**Branch:** `cesium-3d`
**Status:** Design approved, ready for implementation plan

## Goal

Add a standalone configuration page to Skywatch where the user can:

- See every feed the backend is polling
- Toggle feeds on or off
- Adjust polling rates
- Enter API keys for feeds that need them
- Add NASA's EONET (Earth Observatory Natural Event Tracker) as a new optional feed, proving the catalog supports new sources

Changes that can apply live (enable/disable, polling interval) take effect without a restart. Changes that cannot (API keys) are flagged inline with a clear "restart to apply this feed" message.

## Non-Goals

- Arbitrary user-supplied REST endpoints (no plugin framework). The catalog is curated and adding a new feed type still requires a code change.
- Multi-user accounts or auth on the config page. Skywatch is self-hosted single-user; deployment is responsible for not exposing the page publicly.
- Folding existing localStorage display preferences (layer visibility, map style, sat sub-categories) into the new page. Those stay in the sidebar.
- Implementing GIBS, FIRMS, or DONKI in this iteration. They are out of v1 scope entirely; each ships as its own follow-up PR with backend module + frontend layer + a new `Feed` entry. The v1 catalog contains exactly six feeds: aircraft, satellites, ships, earthquakes, gpsjam, eonet.

## Architecture

A `ConfigStore` singleton replaces the existing `Config` class. It loads three YAML layers, holds the merged config as a typed dataclass tree, persists UI edits to `runtime-config.yaml`, and feeds read from it on every loop iteration so changes propagate without restarting tasks.

```
config.yaml          ──┐
secrets.yaml         ──┼─►  ConfigStore.load()  ─►  in-memory store (mutable)
runtime-config.yaml  ──┘                                   │
                                                           ▼
                  ┌───────────────────────────────────────────┐
                  │  feeds/*.py read store.get(name) per loop │
                  └───────────────────────────────────────────┘
                                                           ▲
              PUT /api/config/{name} ─► validate ─► persist ─► mutate
```

Layer semantics (last writer wins):

1. `config.yaml` — hand-authored defaults (lives in the repo).
2. `secrets.yaml` — legacy API keys (already gitignored). Kept for backwards compatibility; the AIS key migration is documented but not forced.
3. `runtime-config.yaml` — UI-edited overrides. Gitignored. Mounted read-write into the container. Trivial to wipe (`rm runtime-config.yaml`) for factory reset.

On first boot, the existing AIS key in `secrets.yaml` continues to work via the secrets layer; no forced migration. If the user edits the AIS key in the UI, the new value lands in `runtime-config.yaml` and overlays the secrets value.

The store is the single source of truth at runtime; the YAML files only exist so changes survive process restart.

## Backend Components

### `config_store.py` (new)

```python
@dataclass
class Feed:
    name: str
    enabled: bool
    interval_seconds: int
    api_key: str | None = None
    last_error: str | None = None
    requires_restart_for: tuple[str, ...] = ("api_key",)
    fixed: bool = False  # if True, enabled toggle is locked on
```

`ConfigStore`:

- `load()` — read all three YAML layers, merge, build `Dict[str, Feed]` keyed on canonical feed name (`aircraft`, `satellites`, `ships`, `earthquakes`, `gpsjam`, `eonet`)
- `get(name) -> Feed` — used by feed loops
- `update(name, partial: dict) -> {ok, restart_required: list[str], errors: dict}` — validates, mutates in-memory, persists to `runtime-config.yaml`
- `to_public_dict()` — serializes the store for the API; masks `api_key` to `"••••" + last4`
- `record_error(name, msg)` — feeds call this when they hit a fetch failure

The store also exposes the existing top-level config (server host/port, polling defaults, AIS burst settings) so the rest of the app keeps working unchanged.

### `feeds/eonet.py` (new)

Periodic fetch of `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20`. No auth. Normalizes events to a stable shape:

```python
{
    "id": str,
    "title": str,
    "category": str,        # one of "wildfires", "severeStorms", "volcanoes", ...
    "geometry": [...]       # GeoJSON Point or Polygon list with timestamps
    "last_update": str,     # ISO 8601
}
```

Default polling interval: 1800s (30 min). Disabled by default — user opts in via the UI.

### Existing feeds (`aircraft.py`, `satellites.py`, `ships.py`, `earthquakes.py`, `jamming.py`)

Each long-running task gets a small change at the top of its loop:

```python
feed = store.get("eonet")  # or whatever the canonical name is
if not feed.enabled:
    await asyncio.sleep(5)
    continue
interval = feed.interval_seconds
```

`aircraft` is marked `fixed=True` — its enabled toggle is rendered but non-interactive (greyed, can't be flipped) because it's the primary data source and disabling it would empty most of the app. The backend also rejects any `PUT` that tries to disable a `fixed` feed with HTTP 400.

### `skywatch.py`

- Replace `config = Config()` with `store = ConfigStore.load()`
- Pass `store` into each background task instead of the old `config` object
- Add endpoints (rate-limited via the existing limiter):
  - `GET /api/config` → `store.to_public_dict()`
  - `PUT /api/config/{feed_name}` → validates body, calls `store.update()`, returns `{ok, restart_required, errors}`

## Frontend Components

### `/settings` route

The frontend currently has no router. We introduce `react-router-dom` (already a small dep, well-supported with Vite) and split `App.tsx` into two routes:

- `/` — existing globe view
- `/settings` — new full-viewport settings page

The sidebar gains a small gear icon (top-right, next to the existing reset-view button) that links to `/settings`.

### Components

- `SettingsPage.tsx` — top-level layout. Fetches `/api/config` on mount, holds the edited copy in local state, lists feeds in a single column of cards.
- `FeedCard.tsx` — one card per feed. Shows:
  - feed name + status dot (green = healthy, amber = disabled, red = last_error set)
  - enabled toggle (locked-on if `fixed`)
  - polling interval (number input with min/max validation, plus a slider for quick adjustment)
  - API key field if the feed needs one (masked display, "Edit" button reveals an input)
  - per-card "Save" button
  - inline "Restart required" banner if a `requires_restart_for` field was changed
  - "last error" line in red if present
- `BackLink.tsx` — small "← Globe" link top-left that returns to `/`.

### State flow

`SettingsPage` holds a local edited copy. Each `FeedCard` calls `onSave(feedName, partial)` which issues `PUT /api/config/{feed_name}`. On success, the page refreshes its config from the server and shows a toast. Live-applied changes (enable, interval) take effect on the backend within one loop iteration. Key changes show a "Restart required" banner with a copyable `docker compose restart` command.

## Data Flow Example: Enabling EONET

1. User flips the EONET toggle in the UI, hits Save.
2. Frontend issues `PUT /api/config/eonet` with `{enabled: true}`.
3. `ConfigStore.update("eonet", {enabled: true})` validates, mutates the in-memory `Feed`, writes `runtime-config.yaml`.
4. The EONET background task — already running but idle in its 5-second "disabled" check — sees `enabled=True` on its next iteration, fetches data, populates `eonet_state`.
5. Frontend `useEonet()` hook (polling `/api/eonet` every 30s) starts seeing data within ~15s.
6. The EONET layer renders on the globe.

Disabling reverses this: the next loop iteration sees `enabled=False`, the task drops back into idle, and `eonet_state` stops updating. (We do not clear `eonet_state` on disable so the layer can fade gracefully if the user re-enables soon.)

## Error Handling

- **Validation**: `ConfigStore.update()` enforces `interval_seconds ∈ [5, 3600]`, validates key formats per feed (e.g. FIRMS MAP_KEY is hex). Returns HTTP 400 with field-level errors.
- **Write failures**: if `runtime-config.yaml` cannot be written (permission, disk full), the in-memory mutation is rolled back and the API returns HTTP 500. The UI shows an error and does not update its local state.
- **Feed crash after enable**: the existing `resilient_task` wrapper handles it — restarts the task after 30s, logs the error. The feed calls `store.record_error(name, msg)` so the UI surfaces "last error" via `/api/config`.
- **Bad NASA API key**: feed starts, hits HTTP 403, calls `record_error`, retries with backoff. UI shows the error within ~30s.
- **Concurrent edits**: `ConfigStore.update()` is wrapped in an `asyncio.Lock` so a slow file write cannot interleave with another update.

## Testing

### Backend

- `tests/test_config_store.py`:
  - load order: `runtime-config.yaml` overrides `secrets.yaml` overrides `config.yaml`
  - `update()` round-trip: mutate, read back through `to_public_dict()`, restart from disk and confirm persistence
  - mask logic: an API key like `"abc123def456"` returns `"••••3456"` from `to_public_dict()`
  - validation: out-of-range interval rejected, bad key format rejected
- `tests/test_eonet.py`:
  - fetch + normalize against a recorded JSON fixture (no live network call in CI)

### Frontend

- `SettingsPage.test.tsx` — renders mocked `/api/config` response, lists all feeds
- `FeedCard.test.tsx` — toggle calls `onSave` with correct partial; save button disabled while pending
- `useConfig.test.ts` — mirrors the existing `useFlights` test pattern

### Manual smoke

- Enable EONET in the UI; verify events appear within 30s.
- Flip off; verify the layer stops updating.
- Change polling rate from 1800s to 60s; verify the next fetch occurs at the new cadence.
- Set a bogus FIRMS key; verify "last error" surfaces in the FIRMS card within ~30s.

## File Inventory

**New files:**
- `config_store.py`
- `feeds/eonet.py`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/components/FeedCard.tsx`
- `frontend/src/hooks/useConfig.ts`
- `frontend/src/hooks/useEonet.ts`
- `frontend/src/components/EonetLayer.tsx`
- `runtime-config.yaml` (gitignored, created on first save)
- `tests/test_config_store.py`
- `tests/test_eonet.py`
- `frontend/src/__tests__/SettingsPage.test.tsx`
- `frontend/src/__tests__/FeedCard.test.tsx`
- `frontend/src/__tests__/useConfig.test.ts`

**Modified files:**
- `skywatch.py` — replace `Config` with `ConfigStore`, add `/api/config` endpoints, add EONET task
- `feeds/aircraft.py`, `feeds/satellites.py`, `feeds/ships.py`, `feeds/earthquakes.py`, `feeds/jamming.py` — read enabled/interval from store each iteration
- `frontend/src/App.tsx` — wrap in router, add `/settings` route
- `frontend/src/components/Sidebar.tsx` — add gear icon linking to `/settings`
- `frontend/package.json` — add `react-router-dom`
- `.gitignore` — add `runtime-config.yaml`
- `docker-compose.yml` — mount `runtime-config.yaml` read-write
- `config.yaml` — add `feeds:` block with default values for each feed (enabled, interval)

## Follow-up Roadmap

Each NASA feed below ships as its own PR after v1 lands. They are deferred, not abandoned. Listed in recommended build order.

### FIRMS (Fire Information for Resource Management System)

- **Endpoint**: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{source}/world/1`
- **Auth**: Free MAP_KEY from `firms.modaps.eosdis.nasa.gov` (separate from api.nasa.gov)
- **Cadence**: Near-real-time (~3 hr lag). Recommended polling: 600s (10 min)
- **Geometry**: Lat/lon points with brightness, FRP, confidence, satellite source
- **UI**: New `FireLayer.tsx` rendering colored points scaled by FRP
- **Why deferred**: Same polling shape as EONET — almost a copy-paste once the v1 catalog exists. Adding it post-v1 is the cheapest follow-up.
- **Estimated work**: ~1 hour

### DONKI + NOAA SWPC OVATION (Space Weather)

- **DONKI endpoint**: `https://api.nasa.gov/DONKI/{CME,FLR,GST}` — needs api.nasa.gov key
- **OVATION endpoint**: `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` — no auth
- **Cadence**: Hourly for DONKI events, every ~5 min for OVATION. Recommended polling: 1800s for DONKI, 300s for OVATION
- **Geometry**: DONKI events are mostly solar-frame (HUD card material); OVATION returns the auroral oval as a heatmap polygon
- **UI**: `AuroraLayer.tsx` for the OVATION oval; sidebar HUD card for "current Kp index" and "latest CME"
- **Why deferred**: Two sources to wire up rather than one, and the visualization is hybrid (polygon + HUD), so it's not a copy-paste pattern. Pairs naturally with the existing GPS jamming layer (geomagnetic storms degrade GNSS).
- **Estimated work**: ~half-day

### GIBS (Global Imagery Browse Services)

- **Endpoint**: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{Layer}/default/{Time}/{TileMatrixSet}/{z}/{y}/{x}.{ext}`
- **Auth**: None
- **Cadence**: Daily for most layers (yesterday's imagery available by ~14:00 UTC)
- **Geometry**: WMTS imagery tiles consumed natively by Cesium's `WebMapTileServiceImageryProvider`
- **UI**: Toggleable imagery overlay with opacity slider; layer picker (true color, cloud cover, fires/thermal, snow cover)
- **Required architectural change**: The `Feed` dataclass currently models polling feeds (`enabled`, `interval_seconds`, `api_key`). GIBS needs a different shape (`layer_name`, `date`, `opacity`). The catalog must grow a `kind: "polling" | "imagery"` discriminant, and `FeedCard` must render two card variants.
- **Why deferred**: Forces an abstraction widening, not a copy-paste of EONET. Worth doing well.
- **Estimated work**: ~half to full day

### NeoWs (Near-Earth Objects)

- **Endpoint**: `https://api.nasa.gov/neo/rest/v1/feed`
- **Auth**: api.nasa.gov key (1000/hr)
- **Geometry**: Not strongly geospatial (heliocentric/geocentric distance only). Best as a sidebar HUD ("today's closest approach") rather than a globe layer.
- **Status**: Lower priority. Skipped from the v1+follow-up roadmap unless requested. Including it would be a small HUD widget, no new backend feed.
