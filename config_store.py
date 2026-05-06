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
