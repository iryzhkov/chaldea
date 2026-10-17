"""A feed POST is never repeated after an ambiguous crash."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


def load():
    path = Path(__file__).resolve().parents[1] / "chaldea-timer-report"
    loader = importlib.machinery.SourceFileLoader("feed_claim", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_claim_is_durable_before_feed_and_failure_handler_never_reposts(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.setenv("FEED_TOKEN", "disposable")
    module = load()
    bindir = tmp_path / "bin"
    bindir.mkdir()
    feed = bindir / "feed"
    feed.write_text("#!" + sys.executable + "\n" + """
import json,os,pathlib
home = pathlib.Path(os.environ["HOME"])
records = json.loads((home / ".local/state/chaldea/fleet-status.json").read_text())
assert records[-1]["invocation"] == "a" * 32
assert records[-1]["delivery"] == "pending"
(home / "posted").write_text("once")
""")
    feed.chmod(0o755)
    monkeypatch.setenv("PATH", str(bindir) + ":" + os.environ["PATH"])
    module.record_outcome("chaldea-retention", "a" * 32, 1)
    assert (tmp_path / "posted").read_text() == "once"
    assert json.loads((module.STATE / "fleet-status.json").read_text())[-1]["delivery"] == "posted"
    (tmp_path / "posted").unlink()
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "a" * 32)
    module.main(["failure", "--job", "chaldea-retention"])
    assert not (tmp_path / "posted").exists()


def test_crash_during_post_leaves_pending_claim_and_failure_does_not_retry(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    module = load()
    calls = []
    def ambiguous(record):
        calls.append(record["invocation"])
        assert json.loads((module.STATE / "fleet-status.json").read_text())[-1]["delivery"] == "pending"
        raise SystemExit(1)
    monkeypatch.setattr(module, "feed_delivery", ambiguous)
    with pytest.raises(SystemExit):
        module.record_outcome("chaldea-retention", "a" * 32, 1)
    monkeypatch.setenv("MONITOR_INVOCATION_ID", "a" * 32)
    module.main(["failure", "--job", "chaldea-retention"])
    assert calls == ["a" * 32]
