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
