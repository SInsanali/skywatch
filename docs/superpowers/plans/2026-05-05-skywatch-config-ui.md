# Skywatch Config UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/settings` route in Skywatch where the user can toggle each backend feed, adjust polling rates, and edit API keys, with enable/disable and interval changes applied live (no restart). Wire NASA EONET (Earth Observatory Natural Event Tracker) end-to-end as the v1 proof feed.

**Architecture:** A `ConfigStore` singleton replaces the existing `Config` class. It loads three YAML layers (`config.yaml` defaults → `secrets.yaml` legacy keys → `runtime-config.yaml` UI overrides) and holds a typed `Feed` dataclass per source. Each feed background task reads `store.get(name).enabled` and `.interval_seconds` at the top of every loop, so UI edits propagate without restarting tasks. API key changes flag "restart required" inline. Frontend gains a `/settings` route via `react-router-dom`.

**Tech Stack:** Python 3.12 (FastAPI, asyncio, httpx, PyYAML), React 19 + TypeScript + Vite, Resium/Cesium, Vitest, react-router-dom, pytest.

---

## File Structure

**New files (backend):**
- `config_store.py` — `Feed` dataclass, `ConfigStore` (load, get, update, persist, mask, record_error)
- `feeds/eonet.py` — fetch + normalize EONET events
- `tests/test_config_store.py`
- `tests/test_eonet.py`

**New files (frontend):**
- `frontend/src/hooks/useConfig.ts`
- `frontend/src/hooks/useEonet.ts`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/components/FeedCard.tsx`
- `frontend/src/components/EonetLayer.tsx`
- `frontend/src/__tests__/useConfig.test.ts`
- `frontend/src/__tests__/FeedCard.test.tsx`
- `frontend/src/__tests__/SettingsPage.test.tsx`
- `frontend/src/__tests__/useEonet.test.ts`

**Modified files:**
- `skywatch.py` — replace `Config`, add `/api/config` + `/api/eonet`, register EONET task
- `feeds/aircraft.py`, `feeds/satellites.py`, `feeds/ships.py`, `feeds/earthquakes.py`, `feeds/jamming.py` — read enabled/interval from store each loop
- `frontend/src/App.tsx` — BrowserRouter, `/settings` route, mount `EonetLayer`
- `frontend/src/components/Sidebar.tsx` — gear icon linking to `/settings`
- `frontend/package.json` — add `react-router-dom`
- `.gitignore` — `runtime-config.yaml`
- `docker-compose.yml` — mount `runtime-config.yaml` read-write
- `config.yaml` — add `feeds:` defaults block

**Generated at runtime:**
- `runtime-config.yaml` — gitignored, created on first UI save

---

## Tasks

### Task 1: ConfigStore — schema and layered load

**Files:**
- Create: `config_store.py`
- Test: `tests/test_config_store.py`

- [ ] **Step 1: Write the failing test for layered load**

Create `tests/test_config_store.py`:

```python
from pathlib import Path
import pytest
import yaml
from config_store import ConfigStore, Feed


def write_yaml(path: Path, data: dict):
    path.write_text(yaml.safe_dump(data))


def test_load_defaults_only(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {
        "polling": {"interval": 15, "timeout": 30},
        "server": {"host": "0.0.0.0", "port": 8078},
        "feeds": {
            "aircraft": {"enabled": True, "interval": 15, "fixed": True},
            "earthquakes": {"enabled": True, "interval": 300},
            "eonet": {"enabled": False, "interval": 1800},
        },
    })
    store = ConfigStore.load(config_path=cfg)
    assert store.get("aircraft").enabled is True
    assert store.get("aircraft").interval_seconds == 15
    assert store.get("aircraft").fixed is True
    assert store.get("eonet").enabled is False
    assert store.poll_interval == 15
    assert store.port == 8078


def test_load_secrets_overlay_for_ais_key(tmp_path):
    cfg = tmp_path / "config.yaml"
    secrets = tmp_path / "secrets.yaml"
    write_yaml(cfg, {
        "feeds": {"ships": {"enabled": True, "interval": 60, "needs_key": True}},
    })
    write_yaml(secrets, {"aisstream": {"api_key": "legacy-key-abc"}})
    store = ConfigStore.load(config_path=cfg, secrets_path=secrets)
    assert store.get("ships").api_key == "legacy-key-abc"


def test_runtime_overlay_wins(tmp_path):
    cfg = tmp_path / "config.yaml"
    runtime = tmp_path / "runtime-config.yaml"
    write_yaml(cfg, {
        "feeds": {"earthquakes": {"enabled": True, "interval": 300}},
    })
    write_yaml(runtime, {
        "feeds": {"earthquakes": {"enabled": False, "interval": 600}},
    })
    store = ConfigStore.load(config_path=cfg, runtime_path=runtime)
    assert store.get("earthquakes").enabled is False
    assert store.get("earthquakes").interval_seconds == 600


def test_unknown_feed_name_raises(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {"feeds": {"aircraft": {"enabled": True, "interval": 15}}})
    store = ConfigStore.load(config_path=cfg)
    with pytest.raises(KeyError):
        store.get("not_a_feed")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_config_store.py -v`
Expected: ImportError — `config_store` module does not exist yet.

- [ ] **Step 3: Implement `config_store.py`**

Create `config_store.py`:

```python
import asyncio
import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("skywatch")

DEFAULT_FEEDS = {
    "aircraft":    {"enabled": True,  "interval": 15,    "fixed": True,  "needs_key": False},
    "satellites":  {"enabled": True,  "interval": 5,     "fixed": False, "needs_key": False},
    "earthquakes": {"enabled": True,  "interval": 300,   "fixed": False, "needs_key": False},
    "ships":       {"enabled": True,  "interval": 60,    "fixed": False, "needs_key": True},
    "gpsjam":      {"enabled": True,  "interval": 21600, "fixed": False, "needs_key": False},
    "eonet":       {"enabled": False, "interval": 1800,  "fixed": False, "needs_key": False},
}


@dataclass
class Feed:
    name: str
    enabled: bool
    interval_seconds: int
    fixed: bool = False
    needs_key: bool = False
    api_key: str | None = None
    last_error: str | None = None


class ConfigStore:
    def __init__(self):
        self.feeds: dict[str, Feed] = {}
        self.poll_interval: int = 15
        self.timeout: int = 30
        self.ais_burst_duration: int = 20
        self.host: str = "0.0.0.0"
        self.port: int = 8078
        self._runtime_path: Path | None = None
        self._lock = asyncio.Lock()

    @classmethod
    def load(
        cls,
        config_path: Path | None = None,
        secrets_path: Path | None = None,
        runtime_path: Path | None = None,
    ) -> "ConfigStore":
        store = cls()

        if config_path is None:
            config_path = Path("/app/config.yaml")
            if not config_path.exists():
                config_path = Path("config.yaml")
        if secrets_path is None:
            secrets_path = config_path.parent / "secrets.yaml"
        if runtime_path is None:
            runtime_path = config_path.parent / "runtime-config.yaml"

        store._runtime_path = runtime_path

        with open(config_path) as f:
            base = yaml.safe_load(f) or {}

        # Start feeds from defaults, overlay base.feeds
        feed_data: dict[str, dict] = {
            name: dict(cfg) for name, cfg in DEFAULT_FEEDS.items()
        }
        for name, partial in (base.get("feeds") or {}).items():
            if name in feed_data:
                feed_data[name].update(partial)

        # Top-level non-feed config
        polling = base.get("polling") or {}
        store.poll_interval = polling.get("interval", 15)
        store.timeout = polling.get("timeout", 30)

        ais = base.get("aisstream") or {}
        store.ais_burst_duration = ais.get("burst_duration", 20)

        server = base.get("server") or {}
        store.host = server.get("host", "0.0.0.0")
        store.port = server.get("port", 8078)

        # Secrets overlay (legacy: reads aisstream.api_key into ships feed)
        if secrets_path.exists():
            with open(secrets_path) as f:
                secrets = yaml.safe_load(f) or {}
            legacy_ais_key = (secrets.get("aisstream") or {}).get("api_key")
            if legacy_ais_key and "ships" in feed_data:
                feed_data["ships"]["api_key"] = legacy_ais_key

        # Runtime overlay (last writer wins)
        if runtime_path.exists():
            with open(runtime_path) as f:
                runtime = yaml.safe_load(f) or {}
            for name, partial in (runtime.get("feeds") or {}).items():
                if name in feed_data:
                    feed_data[name].update(partial)

        # Build Feed instances
        for name, cfg in feed_data.items():
            store.feeds[name] = Feed(
                name=name,
                enabled=bool(cfg.get("enabled", False)),
                interval_seconds=int(cfg.get("interval", 60)),
                fixed=bool(cfg.get("fixed", False)),
                needs_key=bool(cfg.get("needs_key", False)),
                api_key=cfg.get("api_key"),
            )

        return store

    def get(self, name: str) -> Feed:
        if name not in self.feeds:
            raise KeyError(f"Unknown feed: {name}")
        return self.feeds[name]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_config_store.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add config_store.py tests/test_config_store.py
git commit -m "Add ConfigStore with layered YAML load"
```

---

### Task 2: ConfigStore — update, persist, mask

**Files:**
- Modify: `config_store.py`
- Modify: `tests/test_config_store.py`

- [ ] **Step 1: Add tests for update + persist + mask**

Append to `tests/test_config_store.py`:

```python
import asyncio


def test_update_persists_to_runtime(tmp_path):
    cfg = tmp_path / "config.yaml"
    runtime = tmp_path / "runtime-config.yaml"
    write_yaml(cfg, {
        "feeds": {"earthquakes": {"enabled": True, "interval": 300}},
    })
    store = ConfigStore.load(config_path=cfg, runtime_path=runtime)

    asyncio.run(store.update("earthquakes", {"enabled": False, "interval": 600}))

    assert store.get("earthquakes").enabled is False
    assert store.get("earthquakes").interval_seconds == 600
    persisted = yaml.safe_load(runtime.read_text())
    assert persisted["feeds"]["earthquakes"]["enabled"] is False
    assert persisted["feeds"]["earthquakes"]["interval"] == 600


def test_update_rejects_disabling_fixed_feed(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {
        "feeds": {"aircraft": {"enabled": True, "interval": 15, "fixed": True}},
    })
    store = ConfigStore.load(config_path=cfg, runtime_path=tmp_path / "runtime-config.yaml")
    with pytest.raises(ValueError, match="fixed"):
        asyncio.run(store.update("aircraft", {"enabled": False}))


def test_update_rejects_out_of_range_interval(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {"feeds": {"earthquakes": {"enabled": True, "interval": 300}}})
    store = ConfigStore.load(config_path=cfg, runtime_path=tmp_path / "runtime-config.yaml")
    with pytest.raises(ValueError, match="interval"):
        asyncio.run(store.update("earthquakes", {"interval": 1}))
    with pytest.raises(ValueError, match="interval"):
        asyncio.run(store.update("earthquakes", {"interval": 99999}))


def test_to_public_dict_masks_api_key(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {
        "feeds": {"ships": {"enabled": True, "interval": 60, "needs_key": True}},
    })
    secrets = tmp_path / "secrets.yaml"
    write_yaml(secrets, {"aisstream": {"api_key": "abcdef123456"}})
    store = ConfigStore.load(config_path=cfg, secrets_path=secrets, runtime_path=tmp_path / "runtime-config.yaml")
    pub = store.to_public_dict()
    ships = next(f for f in pub["feeds"] if f["name"] == "ships")
    assert ships["api_key_masked"] == "••••3456"
    assert ships["has_api_key"] is True
    assert "api_key" not in ships  # raw key never exposed


def test_to_public_dict_no_key_set(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {
        "feeds": {"ships": {"enabled": True, "interval": 60, "needs_key": True}},
    })
    store = ConfigStore.load(config_path=cfg, runtime_path=tmp_path / "runtime-config.yaml")
    pub = store.to_public_dict()
    ships = next(f for f in pub["feeds"] if f["name"] == "ships")
    assert ships["api_key_masked"] is None
    assert ships["has_api_key"] is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_config_store.py -v`
Expected: 5 new failures (AttributeError: no `update` / `to_public_dict`).

- [ ] **Step 3: Implement update, persist, to_public_dict**

Append to `config_store.py` (inside the `ConfigStore` class):

```python
    INTERVAL_MIN = 5
    INTERVAL_MAX = 86400  # 24 hours

    async def update(self, name: str, partial: dict[str, Any]) -> dict:
        async with self._lock:
            if name not in self.feeds:
                raise KeyError(f"Unknown feed: {name}")
            feed = self.feeds[name]

            if "enabled" in partial:
                if feed.fixed and partial["enabled"] is False:
                    raise ValueError(f"Feed '{name}' is fixed and cannot be disabled")
            if "interval" in partial or "interval_seconds" in partial:
                interval = partial.get("interval_seconds", partial.get("interval"))
                if not isinstance(interval, int) or not (self.INTERVAL_MIN <= interval <= self.INTERVAL_MAX):
                    raise ValueError(
                        f"interval must be int in [{self.INTERVAL_MIN}, {self.INTERVAL_MAX}], got {interval!r}"
                    )

            restart_required: list[str] = []
            new_enabled = partial.get("enabled", feed.enabled)
            new_interval = partial.get("interval_seconds", partial.get("interval", feed.interval_seconds))
            new_api_key = partial.get("api_key", feed.api_key)
            if new_api_key != feed.api_key:
                restart_required.append("api_key")

            updated = Feed(
                name=feed.name,
                enabled=new_enabled,
                interval_seconds=new_interval,
                fixed=feed.fixed,
                needs_key=feed.needs_key,
                api_key=new_api_key,
                last_error=feed.last_error,
            )
            self.feeds[name] = updated
            self._persist_runtime_overlay()
            return {"ok": True, "restart_required": restart_required}

    def _persist_runtime_overlay(self):
        if self._runtime_path is None:
            return
        out = {"feeds": {}}
        for name, feed in self.feeds.items():
            entry = {
                "enabled": feed.enabled,
                "interval": feed.interval_seconds,
            }
            if feed.api_key is not None:
                entry["api_key"] = feed.api_key
            out["feeds"][name] = entry
        tmp = self._runtime_path.with_suffix(".yaml.tmp")
        tmp.write_text(yaml.safe_dump(out, sort_keys=True))
        tmp.replace(self._runtime_path)

    @staticmethod
    def _mask_key(key: str | None) -> str | None:
        if not key:
            return None
        last4 = key[-4:] if len(key) >= 4 else key
        return "••••" + last4

    def to_public_dict(self) -> dict:
        feeds_out = []
        for name, feed in self.feeds.items():
            feeds_out.append({
                "name": feed.name,
                "enabled": feed.enabled,
                "interval_seconds": feed.interval_seconds,
                "fixed": feed.fixed,
                "needs_key": feed.needs_key,
                "has_api_key": bool(feed.api_key),
                "api_key_masked": self._mask_key(feed.api_key),
                "last_error": feed.last_error,
            })
        return {
            "feeds": feeds_out,
            "server": {"host": self.host, "port": self.port},
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_config_store.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add config_store.py tests/test_config_store.py
git commit -m "Add ConfigStore.update with persist, masking, validation"
```

---

### Task 3: ConfigStore — record_error

**Files:**
- Modify: `config_store.py`
- Modify: `tests/test_config_store.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_config_store.py`:

```python
def test_record_error_sets_last_error(tmp_path):
    cfg = tmp_path / "config.yaml"
    write_yaml(cfg, {"feeds": {"earthquakes": {"enabled": True, "interval": 300}}})
    store = ConfigStore.load(config_path=cfg, runtime_path=tmp_path / "runtime-config.yaml")

    store.record_error("earthquakes", "HTTP 503 from USGS")
    assert store.get("earthquakes").last_error == "HTTP 503 from USGS"

    store.record_error("earthquakes", None)  # clear
    assert store.get("earthquakes").last_error is None

    pub = store.to_public_dict()
    eq = next(f for f in pub["feeds"] if f["name"] == "earthquakes")
    assert eq["last_error"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_config_store.py::test_record_error_sets_last_error -v`
Expected: AttributeError — no `record_error`.

- [ ] **Step 3: Implement `record_error`**

Append to `ConfigStore` class:

```python
    def record_error(self, name: str, msg: str | None):
        if name in self.feeds:
            self.feeds[name].last_error = msg
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_config_store.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add config_store.py tests/test_config_store.py
git commit -m "Add ConfigStore.record_error for surfacing feed failures"
```

---

### Task 4: Wire ConfigStore into skywatch.py

**Files:**
- Modify: `skywatch.py`

- [ ] **Step 1: Replace `Config` with `ConfigStore.load()`**

In `skywatch.py`, replace the `Config` class (lines 76-107) and `config = Config()` (line 109) with:

```python
from config_store import ConfigStore

store = ConfigStore.load()
```

Remove `class Config: ...` and the legacy `config = Config()` instantiation. Keep all other imports.

Update every reference to `config` in this file:
- `config.poll_interval` → `store.poll_interval`
- `config.timeout` → `store.timeout`
- `config.host` → `store.host`
- `config.port` → `store.port`

The lifespan currently passes `config` into feed coroutines. Update the four lambdas that take `config` to pass `store` instead:

```python
poll_task = asyncio.create_task(resilient_task(
    "poll_aircraft",
    lambda: poll_aircraft(store, aircraft_state, aircraft_db, airline_db,
                          jamming_state, has_active_viewer)))
```

```python
ship_task = asyncio.create_task(resilient_task(
    "refresh_ships",
    lambda: refresh_ships(store, ship_state, has_active_viewer)))
```

The other tasks (`refresh_aircraft_db`, `refresh_tles`, `propagate_satellites_loop`, `refresh_earthquakes`, `refresh_gpsjam`) currently don't take `config`. Update them to accept `store` (Task 5 will add the per-loop checks).

- [ ] **Step 2: Update `tests/test_skywatch.py` import**

The existing test imports `from skywatch import Config`. Update to:

```python
from config_store import ConfigStore
```

Replace the two `test_config_*` tests (lines 11-25) with:

```python
def test_config_store_loads_top_level(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("server:\n  port: 9999\npolling:\n  interval: 30\n")
    store = ConfigStore.load(config_path=cfg, runtime_path=tmp_path / "runtime-config.yaml")
    assert store.port == 9999
    assert store.poll_interval == 30
```

- [ ] **Step 3: Run all backend tests**

Run: `pytest -v`
Expected: all green (existing aircraft parsing tests still pass; new config tests pass).

- [ ] **Step 4: Smoke-run the server**

Run: `python skywatch.py` in one terminal, then `curl -s http://localhost:8078/api/health` in another.
Expected: JSON response with `aircraft_count`, etc. Stop the server (Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add skywatch.py tests/test_skywatch.py
git commit -m "Replace Config with ConfigStore in skywatch.py"
```

---

### Task 5: Update existing feeds to read enabled/interval per loop

**Files:**
- Modify: `feeds/earthquakes.py`
- Modify: `feeds/jamming.py`
- Modify: `feeds/satellites.py`
- Modify: `feeds/ships.py`
- Modify: `feeds/aircraft.py`

This task changes feed loop signatures so each iteration consults the store. Aircraft is `fixed=True` so it skips the disabled-check, but still reads `interval_seconds` from the store.

- [ ] **Step 1: Update `feeds/earthquakes.py`**

Replace the file's contents:

```python
import asyncio
import logging

import httpx

log = logging.getLogger("skywatch")

USGS_QUAKES_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson"


async def fetch_earthquakes(earthquake_state, store):
    try:
        log.info("Downloading earthquake data from USGS...")
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(USGS_QUAKES_URL)
            resp.raise_for_status()
        earthquake_state.clear()
        earthquake_state.update(resp.json())
        store.record_error("earthquakes", None)
        count = len(earthquake_state.get("features", []))
        log.info("Earthquake data loaded: %d events", count)
    except Exception as e:
        log.error("Failed to fetch earthquake data: %s", e)
        store.record_error("earthquakes", str(e))


async def refresh_earthquakes(store, earthquake_state):
    while True:
        feed = store.get("earthquakes")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_earthquakes(earthquake_state, store)
        await asyncio.sleep(feed.interval_seconds)
```

- [ ] **Step 2: Update `feeds/jamming.py`**

Modify only `refresh_gpsjam` (replace the function at the end of the file):

```python
async def refresh_gpsjam(store, gpsjam_state):
    while True:
        feed = store.get("gpsjam")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_gpsjam(gpsjam_state)
        await asyncio.sleep(feed.interval_seconds)
```

(`fetch_gpsjam` and `compute_jamming_grid` stay unchanged.)

- [ ] **Step 3: Update `feeds/satellites.py`**

The file has two long-running coroutines. Open the file and find each. For `refresh_tles`, gate on `store.get("satellites")`:

```python
async def refresh_tles(store, satellite_records):
    while True:
        feed = store.get("satellites")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await _fetch_tles_once(satellite_records)  # rename existing inner work
        await asyncio.sleep(86400)  # TLEs only refresh daily
```

If the existing `refresh_tles` body is one block, extract it as `_fetch_tles_once(satellite_records)` and call it from the new wrapper.

For `propagate_satellites_loop`:

```python
async def propagate_satellites_loop(store, satellite_records, set_state):
    while True:
        feed = store.get("satellites")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        # ... existing propagation work for one tick ...
        await asyncio.sleep(feed.interval_seconds)
```

(Read the current implementation and adapt; preserve the propagation math.)

- [ ] **Step 4: Update `feeds/ships.py`**

Replace `refresh_ships` (the last function):

```python
async def refresh_ships(store, ship_state, has_active_viewer):
    while True:
        feed = store.get("ships")
        if not feed.enabled or not feed.api_key:
            await asyncio.sleep(5)
            continue
        if has_active_viewer():
            await collect_ais_burst_v2(store, ship_state)
        await asyncio.sleep(feed.interval_seconds)
```

Add a new `collect_ais_burst_v2` that reads from `store` instead of the legacy `config` object:

```python
async def collect_ais_burst_v2(store, ship_state):
    feed = store.get("ships")
    if not feed.api_key:
        return
    # Adapt the existing collect_ais_burst body, replacing:
    #   config.ais_api_key      -> feed.api_key
    #   config.ais_burst_duration -> store.ais_burst_duration
    # Keep all message-parsing logic identical.
```

(Open `feeds/ships.py`, copy the existing `collect_ais_burst` body, swap the two references above.)

- [ ] **Step 5: Update `feeds/aircraft.py`**

Aircraft is `fixed=True` so its enabled flag is always True, but the polling rate should still come from the store. Find the `poll_aircraft` function. Update its signature to accept `store` first:

```python
async def poll_aircraft(store, aircraft_state, aircraft_db, airline_db, jamming_state, has_active_viewer):
    # ... existing setup ...
    while True:
        feed = store.get("aircraft")
        # aircraft is fixed=True, skip the enabled check
        # ... existing one-iteration body ...
        await asyncio.sleep(feed.interval_seconds)
```

The aircraft-DB-refresh coroutine `refresh_aircraft_db` does not need a store (it's not user-controlled), but accept `store` for signature uniformity:

```python
async def refresh_aircraft_db(store, aircraft_db):
    # ... existing body unchanged ...
```

- [ ] **Step 6: Update lifespan in `skywatch.py` to pass store**

Update each `asyncio.create_task` call in `lifespan` to pass `store` to its coroutine:

```python
db_task = asyncio.create_task(resilient_task(
    "refresh_aircraft_db", lambda: refresh_aircraft_db(store, aircraft_db)))
poll_task = asyncio.create_task(resilient_task(
    "poll_aircraft",
    lambda: poll_aircraft(store, aircraft_state, aircraft_db, airline_db,
                          jamming_state, has_active_viewer)))
tle_task = asyncio.create_task(resilient_task(
    "refresh_tles", lambda: refresh_tles(store, satellite_records)))
sat_task = asyncio.create_task(resilient_task(
    "propagate_satellites_loop",
    lambda: propagate_satellites_loop(store, satellite_records, _set_satellite_state)))
quake_task = asyncio.create_task(resilient_task(
    "refresh_earthquakes", lambda: refresh_earthquakes(store, earthquake_state)))
ship_task = asyncio.create_task(resilient_task(
    "refresh_ships",
    lambda: refresh_ships(store, ship_state, has_active_viewer)))
gpsjam_task = asyncio.create_task(resilient_task(
    "refresh_gpsjam", lambda: refresh_gpsjam(store, gpsjam_state)))
```

- [ ] **Step 7: Run backend tests**

Run: `pytest -v`
Expected: all green (no behavior tests for loops; existing parsers and ConfigStore tests still pass).

- [ ] **Step 8: Smoke-run server, verify aircraft data still flows**

Run: `python skywatch.py` and `curl -s http://localhost:8078/api/health | jq .aircraft_count`. Expected: a non-zero number after ~30s. Stop server.

- [ ] **Step 9: Commit**

```bash
git add feeds/ skywatch.py
git commit -m "Read enabled/interval from ConfigStore in feed loops"
```

---

### Task 6: GET /api/config endpoint

**Files:**
- Modify: `skywatch.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_api.py`:

```python
from fastapi.testclient import TestClient


def test_get_config_returns_feeds(monkeypatch, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("feeds:\n  aircraft: {enabled: true, interval: 15, fixed: true}\n  eonet: {enabled: false, interval: 1800}\n")
    monkeypatch.chdir(tmp_path)
    # Reload skywatch with new cwd
    import importlib, skywatch
    importlib.reload(skywatch)

    client = TestClient(skywatch.app)
    resp = client.get("/api/config")
    assert resp.status_code == 200
    body = resp.json()
    names = [f["name"] for f in body["feeds"]]
    assert "aircraft" in names
    assert "eonet" in names
    aircraft = next(f for f in body["feeds"] if f["name"] == "aircraft")
    assert aircraft["fixed"] is True
    assert "api_key" not in aircraft
```

- [ ] **Step 2: Run test to verify failure**

Run: `pytest tests/test_api.py::test_get_config_returns_feeds -v`
Expected: 404 (endpoint doesn't exist).

- [ ] **Step 3: Add endpoint to `skywatch.py`**

Insert after the existing `/api/jamming` endpoint:

```python
@app.get("/api/config")
async def get_config():
    return store.to_public_dict()
```

- [ ] **Step 4: Run test**

Run: `pytest tests/test_api.py::test_get_config_returns_feeds -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skywatch.py tests/test_api.py
git commit -m "Add GET /api/config endpoint"
```

---

### Task 7: PUT /api/config/{feed_name} endpoint

**Files:**
- Modify: `skywatch.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_api.py`:

```python
def test_put_config_updates_feed(monkeypatch, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("feeds:\n  earthquakes: {enabled: true, interval: 300}\n")
    monkeypatch.chdir(tmp_path)
    import importlib, skywatch
    importlib.reload(skywatch)

    client = TestClient(skywatch.app)
    resp = client.put("/api/config/earthquakes", json={"enabled": False, "interval": 600})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["restart_required"] == []

    # Confirm via GET
    state = client.get("/api/config").json()
    eq = next(f for f in state["feeds"] if f["name"] == "earthquakes")
    assert eq["enabled"] is False
    assert eq["interval_seconds"] == 600


def test_put_config_rejects_unknown_feed(monkeypatch, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("feeds: {}\n")
    monkeypatch.chdir(tmp_path)
    import importlib, skywatch
    importlib.reload(skywatch)
    client = TestClient(skywatch.app)
    resp = client.put("/api/config/nonexistent", json={"enabled": False})
    assert resp.status_code == 404


def test_put_config_validates_interval(monkeypatch, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("feeds:\n  earthquakes: {enabled: true, interval: 300}\n")
    monkeypatch.chdir(tmp_path)
    import importlib, skywatch
    importlib.reload(skywatch)
    client = TestClient(skywatch.app)
    resp = client.put("/api/config/earthquakes", json={"interval": 1})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/test_api.py -v -k put_config`
Expected: 3 failures (404 for the endpoint).

- [ ] **Step 3: Add PUT endpoint**

Insert in `skywatch.py` near the GET endpoint:

```python
from fastapi import HTTPException
from pydantic import BaseModel


class FeedUpdate(BaseModel):
    enabled: bool | None = None
    interval: int | None = None
    api_key: str | None = None


@app.put("/api/config/{feed_name}")
async def put_config(feed_name: str, body: FeedUpdate):
    if feed_name not in store.feeds:
        raise HTTPException(status_code=404, detail=f"Unknown feed: {feed_name}")
    partial = body.model_dump(exclude_none=True)
    try:
        result = await store.update(feed_name, partial)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_api.py -v -k put_config`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add skywatch.py tests/test_api.py
git commit -m "Add PUT /api/config/{feed_name} endpoint"
```

---

### Task 8: feeds/eonet.py — fetch + normalize

**Files:**
- Create: `feeds/eonet.py`
- Test: `tests/test_eonet.py`

- [ ] **Step 1: Write failing test with fixture**

Create `tests/test_eonet.py`:

```python
import json
import pytest
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/test_eonet.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement `feeds/eonet.py`**

Create `feeds/eonet.py`:

```python
import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger("skywatch")

EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=20"


def normalize_events(payload: dict[str, Any]) -> list[dict]:
    events = payload.get("events") or []
    out = []
    for ev in events:
        geom = ev.get("geometry") or []
        if not geom:
            continue
        cat = "unknown"
        cats = ev.get("categories") or []
        if cats:
            cat = cats[0].get("id", "unknown")
        last_update = max((g.get("date") or "" for g in geom), default="")
        out.append({
            "id": ev.get("id"),
            "title": ev.get("title"),
            "category": cat,
            "geometry": [
                {"date": g.get("date"), "type": g.get("type"), "coordinates": g.get("coordinates")}
                for g in geom
            ],
            "last_update": last_update,
        })
    return out


async def fetch_eonet(eonet_state, store):
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(EONET_URL)
            resp.raise_for_status()
        events = normalize_events(resp.json())
        eonet_state.clear()
        eonet_state.extend(events)
        store.record_error("eonet", None)
        log.info("EONET loaded: %d events", len(events))
    except Exception as e:
        log.error("Failed to fetch EONET: %s", e)
        store.record_error("eonet", str(e))


async def refresh_eonet(store, eonet_state):
    while True:
        feed = store.get("eonet")
        if not feed.enabled:
            await asyncio.sleep(5)
            continue
        await fetch_eonet(eonet_state, store)
        await asyncio.sleep(feed.interval_seconds)
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_eonet.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add feeds/eonet.py tests/test_eonet.py
git commit -m "Add EONET feed module with fetch and normalize"
```

---

### Task 9: Wire EONET into lifespan + /api/eonet endpoint

**Files:**
- Modify: `skywatch.py`
- Test: `tests/test_api.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_api.py`:

```python
def test_get_eonet_returns_list(monkeypatch, tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("feeds:\n  eonet: {enabled: false, interval: 1800}\n")
    monkeypatch.chdir(tmp_path)
    import importlib, skywatch
    importlib.reload(skywatch)
    client = TestClient(skywatch.app)
    resp = client.get("/api/eonet")
    assert resp.status_code == 200
    body = resp.json()
    assert "events" in body
    assert isinstance(body["events"], list)
```

- [ ] **Step 2: Run test to verify failure**

Run: `pytest tests/test_api.py::test_get_eonet_returns_list -v`
Expected: 404.

- [ ] **Step 3: Add EONET state, task, and endpoint**

In `skywatch.py`:

Add to imports:
```python
from feeds.eonet import refresh_eonet
```

Add near other state declarations (after `gpsjam_state = []`):
```python
eonet_state = []
```

Add inside `lifespan` (after `gpsjam_task`):
```python
eonet_task = asyncio.create_task(resilient_task(
    "refresh_eonet", lambda: refresh_eonet(store, eonet_state)))
```

Update both task lists in lifespan teardown to include `eonet_task`.

Add endpoint near other GET endpoints:
```python
@app.get("/api/eonet")
async def get_eonet():
    return {"events": eonet_state}
```

Add to `/api/health` response inside the dict:
```python
"eonet_count": len(eonet_state),
```

- [ ] **Step 4: Run tests**

Run: `pytest -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add skywatch.py tests/test_api.py
git commit -m "Wire EONET feed into lifespan and add /api/eonet endpoint"
```

---

### Task 10: Frontend — install react-router-dom and scaffold routes

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Install dependency**

Run from repo root:
```bash
cd frontend && npm install react-router-dom
```

- [ ] **Step 2: Refactor `App.tsx` to extract globe view**

The existing `App.tsx` becomes the `/` route. Extract its current contents (everything inside the `return (...)`) into a new `GlobeView` component within the same file, then wrap with a router.

Top of `frontend/src/App.tsx`, add import:
```typescript
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import SettingsPage from './pages/SettingsPage';
```

At the bottom of the file, replace `export default function App()` with two functions:

```typescript
function GlobeView() {
  // ... move all current App() body here, unchanged ...
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<GlobeView />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Create stub `SettingsPage` so the route resolves**

Create `frontend/src/pages/SettingsPage.tsx`:

```typescript
export default function SettingsPage() {
  return <div style={{ padding: 24, color: '#b0b8c4', fontFamily: '-apple-system, sans-serif' }}>Settings — coming up</div>;
}
```

- [ ] **Step 4: Verify dev build**

Run: `cd frontend && npm run build`
Expected: build succeeds. The compiled output goes to `../static/`.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/App.tsx frontend/src/pages/SettingsPage.tsx
git commit -m "Add react-router-dom and scaffold /settings route"
```

---

### Task 11: Frontend — useConfig hook

**Files:**
- Create: `frontend/src/hooks/useConfig.ts`
- Test: `frontend/src/__tests__/useConfig.test.ts`

- [ ] **Step 1: Write failing test**

Create `frontend/src/__tests__/useConfig.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useConfig } from '../hooks/useConfig';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockConfigResponse = {
  feeds: [
    { name: 'aircraft', enabled: true, interval_seconds: 15, fixed: true, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
    { name: 'eonet', enabled: false, interval_seconds: 1800, fixed: false, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
  ],
  server: { host: '0.0.0.0', port: 8078 },
};

describe('useConfig', () => {
  it('fetches config on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockConfigResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { result } = renderHook(() => useConfig());
    await waitFor(() => {
      expect(result.current.feeds.length).toBe(2);
    });
    expect(result.current.feeds[0].name).toBe('aircraft');
  });

  it('updateFeed PUTs and refetches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 })) // initial GET
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, restart_required: [] }), { status: 200 })) // PUT
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 })); // refetch

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.feeds.length).toBe(2));

    await act(async () => {
      await result.current.updateFeed('eonet', { enabled: true });
    });

    const putCall = fetchMock.mock.calls.find(c => (c[1] as any)?.method === 'PUT');
    expect(putCall).toBeTruthy();
    expect(putCall![0]).toBe('/api/config/eonet');
    expect(JSON.parse((putCall![1] as any).body)).toEqual({ enabled: true });
  });

  it('exposes error from a failed update', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'interval out of range' }), { status: 400 }));

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.feeds.length).toBe(2));

    let caught: Error | null = null;
    await act(async () => {
      try {
        await result.current.updateFeed('eonet', { interval: 1 });
      } catch (e) {
        caught = e as Error;
      }
    });
    expect(caught).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd frontend && npm test -- useConfig`
Expected: ImportError for `../hooks/useConfig`.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useConfig.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';

export interface FeedConfig {
  name: string;
  enabled: boolean;
  interval_seconds: number;
  fixed: boolean;
  needs_key: boolean;
  has_api_key: boolean;
  api_key_masked: string | null;
  last_error: string | null;
}

export interface ConfigSnapshot {
  feeds: FeedConfig[];
  server: { host: string; port: number };
}

export interface FeedUpdatePartial {
  enabled?: boolean;
  interval?: number;
  api_key?: string;
}

export function useConfig() {
  const [feeds, setFeeds] = useState<FeedConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ConfigSnapshot = await res.json();
      setFeeds(data.feeds);
      setError(null);
    } catch (e: any) {
      console.error('[Skywatch] Config fetch failed:', e);
      setError(e.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const updateFeed = useCallback(async (name: string, partial: FeedUpdatePartial) => {
    const res = await fetch(`/api/config/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const result = await res.json();
    await refetch();
    return result as { ok: boolean; restart_required: string[] };
  }, [refetch]);

  return { feeds, loading, error, updateFeed, refetch };
}
```

- [ ] **Step 4: Run test**

Run: `cd frontend && npm test -- useConfig`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useConfig.ts frontend/src/__tests__/useConfig.test.ts
git commit -m "Add useConfig hook with GET and PUT"
```

---

### Task 12: Frontend — FeedCard component

**Files:**
- Create: `frontend/src/components/FeedCard.tsx`
- Test: `frontend/src/__tests__/FeedCard.test.tsx`

- [ ] **Step 1: Write failing test**

Create `frontend/src/__tests__/FeedCard.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeedCard from '../components/FeedCard';
import type { FeedConfig } from '../hooks/useConfig';

afterEach(() => { vi.restoreAllMocks(); });

const baseFeed: FeedConfig = {
  name: 'eonet', enabled: false, interval_seconds: 1800,
  fixed: false, needs_key: false, has_api_key: false,
  api_key_masked: null, last_error: null,
};

describe('FeedCard', () => {
  it('renders feed name and interval', () => {
    render(<FeedCard feed={baseFeed} onSave={vi.fn()} />);
    expect(screen.getByText(/eonet/i)).toBeTruthy();
  });

  it('calls onSave with toggled enabled when Save clicked after toggling', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, restart_required: [] });
    render(<FeedCard feed={baseFeed} onSave={onSave} />);
    const toggle = screen.getByRole('checkbox', { name: /enabled/i });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('eonet', expect.objectContaining({ enabled: true }));
  });

  it('disables enabled toggle when feed.fixed is true', () => {
    render(<FeedCard feed={{ ...baseFeed, name: 'aircraft', fixed: true, enabled: true }} onSave={vi.fn()} />);
    const toggle = screen.getByRole('checkbox', { name: /enabled/i });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
  });

  it('shows masked key and an Edit button when has_api_key', () => {
    render(<FeedCard feed={{ ...baseFeed, name: 'ships', needs_key: true, has_api_key: true, api_key_masked: '••••3456' }} onSave={vi.fn()} />);
    expect(screen.getByText('••••3456')).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
  });

  it('shows last_error in red when set', () => {
    render(<FeedCard feed={{ ...baseFeed, last_error: 'HTTP 503' }} onSave={vi.fn()} />);
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd frontend && npm test -- FeedCard`
Expected: ImportError.

- [ ] **Step 3: Implement `FeedCard.tsx`**

Create `frontend/src/components/FeedCard.tsx`:

```typescript
import { useState } from 'react';
import type { FeedConfig, FeedUpdatePartial } from '../hooks/useConfig';

interface Props {
  feed: FeedConfig;
  onSave: (name: string, partial: FeedUpdatePartial) => Promise<{ ok: boolean; restart_required: string[] }>;
}

export default function FeedCard({ feed, onSave }: Props) {
  const [enabled, setEnabled] = useState(feed.enabled);
  const [interval, setIntervalValue] = useState(feed.interval_seconds);
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [restartRequired, setRestartRequired] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = enabled !== feed.enabled || interval !== feed.interval_seconds || (editingKey && keyDraft);

  const handleSave = async () => {
    const partial: FeedUpdatePartial = {};
    if (enabled !== feed.enabled) partial.enabled = enabled;
    if (interval !== feed.interval_seconds) partial.interval = interval;
    if (editingKey && keyDraft) partial.api_key = keyDraft;

    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave(feed.name, partial);
      setRestartRequired(result.restart_required);
      setEditingKey(false);
      setKeyDraft('');
    } catch (e: any) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const statusColor = feed.last_error ? '#ef5350' : feed.enabled ? '#69f0ae' : '#6b7685';

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={{ ...styles.dot, background: statusColor }} />
        <span style={styles.name}>{feed.name}</span>
      </div>

      <label style={styles.row}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={feed.fixed}
          aria-label="enabled"
          onChange={e => setEnabled(e.target.checked)}
        />
        <span>Enabled{feed.fixed ? ' (locked)' : ''}</span>
      </label>

      <label style={styles.row}>
        <span style={styles.label}>Polling interval (s)</span>
        <input
          type="number"
          min={5}
          max={86400}
          value={interval}
          onChange={e => setIntervalValue(Number(e.target.value))}
          style={styles.input}
        />
      </label>

      {feed.needs_key && (
        <div style={styles.row}>
          <span style={styles.label}>API key</span>
          {!editingKey ? (
            <>
              <span style={styles.maskedKey}>{feed.api_key_masked || '— not set —'}</span>
              <button onClick={() => setEditingKey(true)} style={styles.smallBtn}>Edit</button>
            </>
          ) : (
            <input
              type="text"
              value={keyDraft}
              onChange={e => setKeyDraft(e.target.value)}
              placeholder="paste new key"
              style={styles.input}
            />
          )}
        </div>
      )}

      {feed.last_error && (
        <div style={styles.error}>Last error: {feed.last_error}</div>
      )}
      {restartRequired.length > 0 && (
        <div style={styles.warn}>Restart required for: {restartRequired.join(', ')}. Run: <code>docker compose restart</code></div>
      )}
      {saveError && <div style={styles.error}>{saveError}</div>}

      <button onClick={handleSave} disabled={!dirty || saving} style={styles.saveBtn}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { background: '#141c26', border: '1px solid #1a2230', borderRadius: 10, padding: 16, marginBottom: 14, color: '#b0b8c4', fontFamily: '-apple-system, sans-serif' },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  dot: { width: 10, height: 10, borderRadius: '50%' },
  name: { fontSize: 16, fontWeight: 700, textTransform: 'capitalize' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 },
  label: { minWidth: 140, color: '#6b7685' },
  input: { background: '#0a1018', border: '1px solid #1a2230', borderRadius: 6, color: '#b0b8c4', padding: '4px 8px', fontSize: 13 },
  maskedKey: { fontFamily: 'monospace', color: '#b0b8c4' },
  smallBtn: { background: 'none', border: '1px solid #1a2230', color: '#4a90d9', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11 },
  error: { color: '#ef5350', fontSize: 12, marginTop: 6 },
  warn: { color: '#ffb74d', fontSize: 12, marginTop: 6 },
  saveBtn: { background: '#4a90d9', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 10 },
};
```

- [ ] **Step 4: Run test**

Run: `cd frontend && npm test -- FeedCard`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FeedCard.tsx frontend/src/__tests__/FeedCard.test.tsx
git commit -m "Add FeedCard component with toggle, interval, key, save"
```

---

### Task 13: Frontend — SettingsPage

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx` (replace stub)
- Test: `frontend/src/__tests__/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing test**

Create `frontend/src/__tests__/SettingsPage.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';

afterEach(() => { vi.restoreAllMocks(); });

const mockConfig = {
  feeds: [
    { name: 'aircraft', enabled: true, interval_seconds: 15, fixed: true, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
    { name: 'eonet', enabled: false, interval_seconds: 1800, fixed: false, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
  ],
  server: { host: '0.0.0.0', port: 8078 },
};

describe('SettingsPage', () => {
  it('renders one card per feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockConfig), { status: 200 }));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('aircraft')).toBeTruthy();
      expect(screen.getByText('eonet')).toBeTruthy();
    });
  });

  it('shows back link to globe', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockConfig), { status: 200 }));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /globe/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd frontend && npm test -- SettingsPage`
Expected: failures (current stub doesn't render any cards).

- [ ] **Step 3: Implement `SettingsPage.tsx`**

Replace `frontend/src/pages/SettingsPage.tsx` contents:

```typescript
import { Link } from 'react-router-dom';
import FeedCard from '../components/FeedCard';
import { useConfig } from '../hooks/useConfig';

export default function SettingsPage() {
  const { feeds, loading, error, updateFeed } = useConfig();

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <Link to="/" style={styles.back}>← Globe</Link>
        <h1 style={styles.title}>Settings</h1>
      </div>
      {loading && <div style={styles.note}>Loading…</div>}
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.list}>
        {feeds.map(f => (
          <FeedCard key={f.name} feed={f} onSave={updateFeed} />
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0a0e14', color: '#b0b8c4', fontFamily: '-apple-system, sans-serif', padding: 24 },
  header: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 },
  back: { color: '#4a90d9', textDecoration: 'none', fontSize: 13 },
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: '#f0c040' },
  list: { maxWidth: 720 },
  note: { color: '#6b7685', fontSize: 13 },
  error: { color: '#ef5350', fontSize: 13 },
};
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- SettingsPage`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx frontend/src/__tests__/SettingsPage.test.tsx
git commit -m "Add SettingsPage with feed cards and back link"
```

---

### Task 14: Frontend — useEonet hook + EonetLayer + tests

**Files:**
- Create: `frontend/src/hooks/useEonet.ts`
- Create: `frontend/src/components/EonetLayer.tsx`
- Test: `frontend/src/__tests__/useEonet.test.ts`

- [ ] **Step 1: Write hook test**

Create `frontend/src/__tests__/useEonet.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEonet } from '../hooks/useEonet';

afterEach(() => { vi.restoreAllMocks(); });

const mockResp = {
  events: [
    { id: 'X1', title: 'Fire', category: 'wildfires', geometry: [{ date: '2026-04-30T18:00:00Z', type: 'Point', coordinates: [-120.5, 38.7] }], last_update: '2026-04-30T18:00:00Z' },
  ],
};

describe('useEonet', () => {
  it('returns empty when disabled', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { result } = renderHook(() => useEonet(false));
    expect(result.current).toEqual([]);
  });

  it('fetches and returns events when enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockResp), { status: 200 }));
    const { result } = renderHook(() => useEonet(true));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].id).toBe('X1');
    expect(result.current[0].category).toBe('wildfires');
  });

  it('returns empty on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useEonet(true));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd frontend && npm test -- useEonet`
Expected: ImportError.

- [ ] **Step 3: Implement `useEonet.ts`**

Create `frontend/src/hooks/useEonet.ts`:

```typescript
import { useState, useEffect } from 'react';

export interface EonetGeometryPoint {
  date: string;
  type: string;
  coordinates: number[];
}

export interface EonetEvent {
  id: string;
  title: string;
  category: string;
  geometry: EonetGeometryPoint[];
  last_update: string;
}

const POLL_INTERVAL = 60_000;

export function useEonet(enabled: boolean) {
  const [events, setEvents] = useState<EonetEvent[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('/api/eonet');
        if (!res.ok) { console.error(`[Skywatch] EONET fetch failed: HTTP ${res.status}`); return; }
        const data = await res.json();
        if (!cancelled) setEvents(data.events || []);
      } catch (e) {
        console.error('[Skywatch] EONET fetch error:', e);
      }
    };
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return events;
}
```

- [ ] **Step 4: Implement `EonetLayer.tsx`**

Create `frontend/src/components/EonetLayer.tsx`:

```typescript
import { Entity, BillboardGraphics } from 'resium';
import { Cartesian3, Color, VerticalOrigin } from 'cesium';
import type { EonetEvent } from '../hooks/useEonet';

interface Props {
  events: EonetEvent[];
}

const CATEGORY_COLORS: Record<string, string> = {
  wildfires: '#ff5722',
  severeStorms: '#29b6f6',
  volcanoes: '#ff9800',
  seaLakeIce: '#90caf9',
  earthquakes: '#ffb74d',
  drought: '#fbc02d',
  dustHaze: '#bcaaa4',
  manmade: '#9e9e9e',
  snow: '#e0e0e0',
  waterColor: '#26a69a',
  landslides: '#a1887f',
  default: '#b388ff',
};

function latestPoint(ev: EonetEvent): [number, number] | null {
  for (let i = ev.geometry.length - 1; i >= 0; i--) {
    const g = ev.geometry[i];
    if (g.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return [g.coordinates[0], g.coordinates[1]];
    }
  }
  return null;
}

export default function EonetLayer({ events }: Props) {
  return (
    <>
      {events.map(ev => {
        const pt = latestPoint(ev);
        if (!pt) return null;
        const [lon, lat] = pt;
        const color = CATEGORY_COLORS[ev.category] || CATEGORY_COLORS.default;
        return (
          <Entity
            key={ev.id}
            position={Cartesian3.fromDegrees(lon, lat)}
            point={{
              pixelSize: 8,
              color: Color.fromCssColorString(color),
              outlineColor: Color.WHITE,
              outlineWidth: 1,
            }}
            description={`${ev.title} (${ev.category}) — last seen ${ev.last_update}`}
          />
        );
      })}
    </>
  );
}
```

- [ ] **Step 5: Run hook test**

Run: `cd frontend && npm test -- useEonet`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useEonet.ts frontend/src/components/EonetLayer.tsx frontend/src/__tests__/useEonet.test.ts
git commit -m "Add useEonet hook and EonetLayer component"
```

---

### Task 15: Frontend — Sidebar gear icon and wire EonetLayer

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add gear icon to Sidebar that links to /settings**

In `frontend/src/components/Sidebar.tsx`, find the brand+reset row (around line 227):

```typescript
<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
  <div style={styles.brand}>Sky<span style={{ color: '#4a90d9' }}>watch</span></div>
  <button onClick={() => onFlyToRegion('global')} title="Reset view" style={styles.resetBtn}>&#8962;</button>
</div>
```

Replace with:

```typescript
<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
  <div style={styles.brand}>Sky<span style={{ color: '#4a90d9' }}>watch</span></div>
  <div style={{ display: 'flex', gap: 6 }}>
    <a href="/settings" title="Settings" style={styles.resetBtn}>&#9881;</a>
    <button onClick={() => onFlyToRegion('global')} title="Reset view" style={styles.resetBtn}>&#8962;</button>
  </div>
</div>
```

(Using `<a href>` instead of `<Link>` is fine here — full page reload is acceptable since the globe re-mounts cleanly. If you prefer SPA nav, import `Link` from `react-router-dom` and use `<Link to="/settings">`.)

- [ ] **Step 2: Mount `EonetLayer` in `GlobeView`**

In `frontend/src/App.tsx`, at the top of `GlobeView`:

```typescript
import EonetLayer from './components/EonetLayer';
import { useEonet } from './hooks/useEonet';
```

Inside `GlobeView`, add state and hook (next to `useEarthquakes` etc.):

```typescript
const [showEonet, setShowEonet] = useState(prefs.showEonet ?? true);
const eonetEvents = useEonet(showEonet);
```

Add to the localStorage persist effect (extend the dependency list and the persisted object):

```typescript
showEonet,
```

Inside the `<Globe>` JSX block, near the other layers:

```typescript
{showEonet && <EonetLayer events={eonetEvents} />}
```

Optionally add a sidebar toggle for the EONET layer (matches the existing pattern for earthquakes), but this is cosmetic and can be deferred.

- [ ] **Step 3: Build the frontend to verify**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/App.tsx
git commit -m "Add settings gear icon and mount EonetLayer"
```

---

### Task 16: Update infra files

**Files:**
- Modify: `.gitignore`
- Modify: `docker-compose.yml`
- Modify: `config.yaml`

- [ ] **Step 1: Add `runtime-config.yaml` to .gitignore**

Append one line to `.gitignore`:

```
runtime-config.yaml
```

- [ ] **Step 2: Mount `runtime-config.yaml` read-write in docker-compose**

In `docker-compose.yml`, replace the `volumes:` block:

```yaml
    volumes:
      - ./secrets.yaml:/app/secrets.yaml:ro
      - ./runtime-config.yaml:/app/runtime-config.yaml
```

Note no `:ro` on the runtime overlay — backend writes to it.

If the file doesn't exist on the host, Docker creates a directory by default. Pre-create an empty file:

```bash
touch runtime-config.yaml
```

- [ ] **Step 3: Add `feeds:` defaults to `config.yaml`**

Append to `config.yaml`:

```yaml
feeds:
  aircraft:    {enabled: true,  interval: 15,    fixed: true,  needs_key: false}
  satellites:  {enabled: true,  interval: 5,     fixed: false, needs_key: false}
  earthquakes: {enabled: true,  interval: 300,   fixed: false, needs_key: false}
  ships:       {enabled: true,  interval: 60,    fixed: false, needs_key: true}
  gpsjam:      {enabled: true,  interval: 21600, fixed: false, needs_key: false}
  eonet:       {enabled: false, interval: 1800,  fixed: false, needs_key: false}
```

- [ ] **Step 4: Verify ConfigStore picks up the new defaults**

Run: `python -c "from config_store import ConfigStore; s = ConfigStore.load(); print({n: (f.enabled, f.interval_seconds) for n, f in s.feeds.items()})"`
Expected: shows all six feeds with the expected enabled/interval values.

- [ ] **Step 5: Commit**

```bash
git add .gitignore docker-compose.yml config.yaml runtime-config.yaml
git commit -m "Wire runtime-config.yaml into infra and add feeds defaults"
```

---

### Task 17: Manual smoke test

This is verification only — no commit required.

- [ ] **Step 1: Start the backend**

```bash
python skywatch.py
```

In another terminal, start the dev frontend:

```bash
cd frontend && npm run dev
```

- [ ] **Step 2: Verify settings page loads**

Open `http://localhost:5173/settings` (or whichever port Vite reports). Expected: list of feed cards. The `aircraft` card has its enabled toggle locked.

- [ ] **Step 3: Enable EONET via the UI**

Toggle EONET enabled, click Save. Expected: success toast / button returns to "Save". Within ~30s, `curl -s http://localhost:8078/api/eonet | jq '.events | length'` returns a non-zero count.

- [ ] **Step 4: Verify the layer renders**

Navigate to `/`. Confirm EONET points appear on the globe.

- [ ] **Step 5: Change polling interval and verify cadence**

Set EONET interval to 60s, save. Wait ~70s. Watch the backend logs:

```
EONET loaded: 42 events
```

Confirm the second log line appears within ~60-70s of the first.

- [ ] **Step 6: Verify disable works**

Toggle EONET off, save. Wait ~10s. The backend should stop fetching (no new "EONET loaded" lines). The frontend layer keeps the last data until refresh.

- [ ] **Step 7: Verify runtime-config.yaml was written**

```bash
cat runtime-config.yaml
```

Expected: contains `feeds: { eonet: { enabled: false, interval: 60 } }` (and whatever else you toggled).

- [ ] **Step 8: Verify aircraft toggle is locked**

In the settings page, attempt to toggle off the `aircraft` feed via the API directly:

```bash
curl -X PUT http://localhost:8078/api/config/aircraft -H "Content-Type: application/json" -d '{"enabled": false}'
```

Expected: 400 with detail mentioning "fixed".

---

## Verification Summary

After all tasks land:

- `pytest -v` — all backend tests pass (existing + 18 new)
- `cd frontend && npm test` — all frontend tests pass (existing + 13 new)
- `cd frontend && npm run build` — production build succeeds
- Manual smoke (Task 17) — settings page works end-to-end
- `git log --oneline` shows ~17 commits, one per task

The follow-up roadmap (FIRMS, DONKI+OVATION, GIBS, NeoWs) lives in the spec at `docs/superpowers/specs/2026-05-02-skywatch-config-ui-design.md` and is out of scope for this plan.
