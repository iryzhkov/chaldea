"""Trust packaging contracts and byte-only fetch failure paths; no real services or keys."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

from jinja2 import Environment, StrictUndefined
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
import importlib.machinery
loader = importlib.machinery.SourceFileLoader("trust_fetch", str(ROOT / "chaldea-access-trust-fetch"))
spec = importlib.util.spec_from_loader(loader.name, loader)
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)


@pytest.fixture
def config(tmp_path):
    assert Path.home() != Path("/home/igor")
    assert Path.home().is_relative_to(tmp_path.parent)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    key, known = tmp_path / "key", tmp_path / "known_hosts"
    key.write_text("disposable transport fixture, not a private key")
    key.chmod(0o600)
    known.write_text("fixture")
    known.chmod(0o644)
    output = tmp_path / "bundle.jws"
    output.write_bytes(b"previous verified bundle")
    return {"state": str(state), "key": str(key), "known_hosts": str(known),
            "node": "/fixture/node", "runtime": "/fixture/maintenance.ts",
            "health": "/fixture/health", "anchors": "/fixture/anchors",
            "output": str(output)}


def fake_commands(monkeypatch, config, *, failure=None, size=6):
    calls = []
    monkeypatch.setattr(fetcher, "trusted_runtime", lambda path: None)

    def run(args, **kwargs):
        calls.append((args, kwargs))
        assert kwargs["check"] is True and kwargs["timeout"] <= 20
        assert not kwargs.get("shell", False)
        env = kwargs["env"]
        assert env["HOME"] == config["state"]
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        assert "StrictHostKeyChecking=yes" in env["GIT_SSH_COMMAND"]
        assert "GlobalKnownHostsFile=/dev/null" in env["GIT_SSH_COMMAND"]
        if failure and failure in args:
            raise subprocess.CalledProcessError(1, args)
        if args[0] == config["node"]:
            assert Path(config["state"], "candidate.jws").read_bytes() == b"signed"
            assert "--state-file" in args and "--clock-health-file" in args
            assert args[args.index("--output") + 1] == config["output"]
        data = b""
        if "rev-parse" in args:
            data = b"a" * 40 + b"\n"
        if "-s" in args:
            data = str(size).encode()
        if "blob" in args:
            data = b"signed"
        return subprocess.CompletedProcess(args, 0, data, b"")

    monkeypatch.setattr(fetcher.subprocess, "run", run)
    return calls


def test_fetch_only_signed_bytes_and_install_via_package_c(monkeypatch, config):
    calls = fake_commands(monkeypatch, config)
    fetcher.fetch(config)
    git_calls = [args for args, _ in calls if args[0] == "/usr/bin/git"]
    assert any(fetcher.REMOTE in args for args in git_calls)
    assert not any("checkout" in args or "reset" in args for args in git_calls)
    assert not Path(config["state"], "candidate.jws").exists()
    # Only the real TypeScript installer may replace public bytes.
    assert Path(config["output"]).read_bytes() == b"previous verified bundle"


@pytest.mark.parametrize("failure", ["fetch", "/fixture/node"])
def test_network_or_verification_failure_preserves_public_bytes(monkeypatch, config, failure):
    fake_commands(monkeypatch, config, failure=failure)
    with pytest.raises(subprocess.CalledProcessError):
        fetcher.fetch(config)
    assert Path(config["output"]).read_bytes() == b"previous verified bundle"
    assert not Path(config["state"], "candidate.jws").exists()


def test_oversize_and_unsafe_transport_key_fail_before_install(monkeypatch, config):
    calls = fake_commands(monkeypatch, config, size=262145)
    with pytest.raises(ValueError):
        fetcher.fetch(config)
    assert all(args[0] != config["node"] for args, _ in calls)
    Path(config["key"]).chmod(0o644)
    calls.clear()
    with pytest.raises(ValueError):
        fetcher.fetch(config)
    assert calls == []


def test_gc_failure_does_not_block_a_verified_install(monkeypatch, config):
    calls = fake_commands(monkeypatch, config, failure="gc")
    fetcher.fetch(config)
    install = next(i for i, (args, _) in enumerate(calls) if args[0] == config["node"])
    gc = next(i for i, (args, _) in enumerate(calls) if "gc" in args)
    assert install < gc


def test_runtime_rejects_writable_or_symlink_paths(tmp_path):
    target = tmp_path / "runtime"
    target.write_text("fixture")
    target.chmod(0o666)
    with pytest.raises(ValueError):
        fetcher.trusted_runtime(str(target))
    link = tmp_path / "symlink"
    link.symlink_to(target)
    with pytest.raises(ValueError):
        fetcher.trusted_runtime(str(link))


