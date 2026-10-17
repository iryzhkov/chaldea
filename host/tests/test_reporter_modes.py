"""The former two reporters keep their delivery contract in one fsynced program."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest


def load():
    path = Path(__file__).resolve().parents[1] / "chaldea-timer-report"
    loader = importlib.machinery.SourceFileLoader("reporter_modes", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.mark.parametrize("mode,delivery", [("feed", "no-credential"), ("queue", "queued")])
def test_delivery_mode_controls_sink_without_fallback(tmp_path, monkeypatch, mode, delivery):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.delenv("FEED_TOKEN", raising=False)
    monkeypatch.setenv("FEED_KEY_FILE", str(tmp_path / "absent"))
    config = tmp_path / ".config/chaldea"
    config.mkdir(parents=True)
    (config / "timer-reporting.json").write_text(json.dumps({"delivery": mode}))
    module = load()
    module.record_outcome("chaldea-retention", "a" * 32, 1)
    record = json.loads((module.STATE / "fleet-status.json").read_text())[-1]
    assert record["delivery"] == delivery
    assert (module.STATE / "timer-spool").exists() is (mode == "queue")


def test_both_modes_fsync_status_file_and_parent(tmp_path, monkeypatch):
    module = load()
    calls = []
    original = module.os.fsync
    def sync(fd):
        calls.append(fd)
        original(fd)
    monkeypatch.setattr(module.os, "fsync", sync)
    module.write_json(tmp_path / "status.json", {"changed": 1})
    assert len(calls) == 2
