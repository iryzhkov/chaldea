"""Failure recovery, disk accounting and explicit legacy/scoped cutover."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def reporter(home, monkeypatch):
    monkeypatch.setenv("HOME", str(home))
    assert Path.home() == home
    config = home / ".config/chaldea"
    config.mkdir(parents=True)
    (config / "timer-reporting.json").write_text('{"delivery":"queue"}')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    path = ROOT / "chaldea-timer-report"
    loader = importlib.machinery.SourceFileLoader("queued_timer", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_many_small_files_are_bounded_by_blocks_and_file_count(tmp_path, monkeypatch):
    module = reporter(tmp_path, monkeypatch)
    spool = module.STATE / "timer-spool"
    spool.mkdir(parents=True)
    for i in range(1024):
        (spool / f"{i}.jsonl").write_text("{}\n")
    (spool / "orphan.new").write_text("incomplete")
    module.record_outcome("chaldea-retention", "a" * 32, 1)
    records = json.loads((module.STATE / "fleet-status.json").read_text())
    assert records[-1]["delivery"] == "queue-full"
    assert not (spool / "orphan.new").exists()
    assert json.loads((module.STATE / "timer-spool-count.json").read_text())["dropped"] == 1
    assert sum(p.stat().st_blocks * 512 for p in spool.iterdir()) <= 8 * 1024 * 1024


def test_queue_io_failure_preserves_status_and_does_not_use_shared_key(tmp_path, monkeypatch):
    module = reporter(tmp_path, monkeypatch)
    module.STATE.mkdir(parents=True)
    (module.STATE / "timer-spool").write_text("not a directory")
    monkeypatch.setenv("FEED_TOKEN", "must-not-be-used")
    module.record_outcome("chaldea-retention", "b" * 32, 1)
    records = json.loads((module.STATE / "fleet-status.json").read_text())
    assert records[-1]["delivery"] == "queue-failed"


def test_explicit_delivery_mode_defaults_to_feed_and_rejects_invalid(tmp_path, monkeypatch):
    module = reporter(tmp_path, monkeypatch)
    config = tmp_path / ".config/chaldea/timer-reporting.json"
    assert module.delivery_mode() == "queue"
    config.unlink()
    assert module.delivery_mode() == "feed"
    config.write_text('{"delivery":"invalid"}')
    import pytest
    with pytest.raises(ValueError):
        module.delivery_mode()
