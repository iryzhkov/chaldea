"""Recently touched shared Go caches must survive unattended retention."""
import os
from pathlib import Path
import subprocess
import time

import pytest

from test_retention import load_script


@pytest.mark.parametrize("dry_run", [False, True])
def test_recent_cache_never_calls_go_clean_and_mise_still_runs(tmp_path, monkeypatch, dry_run):
    assert Path(os.environ["HOME"]).is_relative_to(Path(os.environ["TMPDIR"]))
    assert Path(os.environ["HOME"]).name.startswith("home-")
    retention = load_script()
    cache = tmp_path / "go-build"
    bucket = cache / "00"
    bucket.mkdir(parents=True)
    entry = bucket / "active-d"
    entry.write_bytes(b"build in progress")
    old = time.time() - 3 * retention.DAY
    os.utime(cache, (old, old))
    os.utime(bucket, (old, old))
    # Only the nested entry is recent; checking the cache root alone misses it.
    monkeypatch.setattr(retention, "held_paths", set)
    monkeypatch.setattr(retention.shutil, "which", lambda name: "/fake/go")
    monkeypatch.setattr(retention, "size_of", lambda path: 20 * retention.GIB)
    commands, later = [], []

    def command(argv, **kwargs):
        commands.append(argv)
        if argv[1:] == ["env", "GOCACHE"]:
            return subprocess.CompletedProcess(argv, 0, stdout=str(cache))
        # Deterministic representation of an active writer racing go clean.
        return subprocess.CompletedProcess(argv, 1)

    monkeypatch.setattr(retention.subprocess, "run", command)
    monkeypatch.setattr(retention, "prune_worktrees", lambda *args: 0)
    monkeypatch.setattr(retention, "prune_tmp", lambda *args: None)
    monkeypatch.setattr(retention, "prune_mise", lambda *args: later.append("mise"))
    assert retention.main(["--go-cache-max-gb", "10", "--protect-hours", "24"] + (["--dry-run"] if dry_run else [])) == 0
    assert commands == [["/fake/go", "env", "GOCACHE"]]
    assert entry.read_bytes() == b"build in progress"
    assert retention.outcome["changed"] == 0 and later == ["mise"]


def test_stale_cache_is_still_cleaned(tmp_path, monkeypatch):
    assert Path(os.environ["HOME"]).is_relative_to(Path(os.environ["TMPDIR"]))
    retention = load_script()
    cache = tmp_path / "go-build"
    cache.mkdir()
    old = time.time() - 3 * retention.DAY
    os.utime(cache, (old, old))
    monkeypatch.setattr(retention.shutil, "which", lambda name: "/fake/go")
    monkeypatch.setattr(retention, "size_of", lambda path: 20 * retention.GIB)
    commands = []

    def command(argv, **kwargs):
        commands.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=str(cache))

    monkeypatch.setattr(retention.subprocess, "run", command)
    args = retention.parse_args(["--go-cache-max-gb", "10", "--protect-hours", "24"])
    retention.prune_go_cache(args, set())
    assert commands == [["/fake/go", "env", "GOCACHE"], ["/fake/go", "clean", "-cache"]]
    assert retention.outcome["changed"] == 1 and retention.problems == []
