"""Toolchain provisioning tests: reviewed pins, local archives, no host changes."""
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
from unittest.mock import patch
import urllib.request

import pytest
import yaml

ROLE = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("job_toolchains", str(ROLE / "chaldea-job-toolchains"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
manager = importlib.util.module_from_spec(spec)
loader.exec_module(manager)
# Fixed release-name fixtures, not deployment inventory. Downloads below are mocked.
DEFAULTS = {"node": ["26.12.0"], "go": ["1.27.0"], "rust": ["1.99.0"], "uv": ["0.12.10"]}
PINS = {tool: {version: {arch: {name: "0" * 64 for _, name in manager.release(tool, version, arch)}
        for arch in ("x86_64", "aarch64")} for version in versions} for tool, versions in DEFAULTS.items()}


@pytest.fixture(autouse=True)
def restore_scratch_permissions(tmp_path):
    """Keep immutable fixtures during assertions, then allow runner cleanup."""
    yield
    for directory, _dirs, _files in os.walk(tmp_path, followlinks=False):
        Path(directory).chmod(0o755)


def bundle(tool, component="rustc"):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        def add(name, payload, mode=0o644):
            entry = tarfile.TarInfo("release/" + name)
            entry.size, entry.mode, entry.uid, entry.gid = len(payload), mode, 12345, 12345
            archive.addfile(entry, io.BytesIO(payload))
        if tool == "rust":
            name = "lib/rustlib/native/lib/std.rlib" if component == "rust-std" else "bin/" + component
            record = "dir:lib/rustlib/native/lib\n" if component == "rust-std" else "file:" + name + "\n"
            add("rust-installer-version", b"3\n")
            add("components", (component + "\n").encode())
            add(component + "/manifest.in", record.encode())
            add(component + "/" + name, b"payload", 0o755)
            add("install.sh", b"#!/bin/sh\nexit 99\n", 0o755)
        else:
            names = ("uv", "uvx") if tool == "uv" else ("bin/" + tool,)
            for name in names:
                add(name, b"#!/bin/sh\nexit 0\n", 0o755)
    return data.getvalue()


def archive_payload(tool, name):
    return bundle(tool, name.split("-1.99.0-")[0]) if tool == "rust" else bundle(tool)


def fixture_pins(tool, payload=None):
    version = DEFAULTS[tool][0]
    return {tool: {version: {"x86_64": {
        name: hashlib.sha256(payload if payload is not None else archive_payload(tool, name)).hexdigest()
        for _url, name in manager.release(tool, version, "x86_64")
    }}}}


@pytest.mark.parametrize("tool", ["node", "go", "uv"])
def test_install_is_atomic_immutable_and_idempotent(tmp_path, tool):
    root = tmp_path / "tree"
    root.mkdir()
    pins = fixture_pins(tool)
    def fetch(url, destination):
        destination.write_bytes(bundle(tool))
    with patch.object(manager, "fetch", side_effect=fetch) as network:
        assert manager.install(root, tool, DEFAULTS[tool][0], "x86_64", pins)
        assert not manager.install(root, tool, DEFAULTS[tool][0], "x86_64", pins)
        assert network.call_count == 1, "no checksum download or repeated archive download"
    directory = root / tool / DEFAULTS[tool][0]
    assert (directory.stat().st_mode & 0o777) == 0o555
    assert ((directory / "bin" / tool).stat().st_mode & 0o777) == 0o555
    assert not list(root.glob(".stage-*"))
    manifest = json.loads((directory / manager.MARKER).read_text())
    assert manifest["architecture"] == "x86_64"
    assert manifest["sha256"] == pins[tool][DEFAULTS[tool][0]]["x86_64"]


@pytest.mark.parametrize("tool", manager.TOOLS)
def test_checksum_failure_never_extracts_or_publishes(tmp_path, tool):
    root = tmp_path / "tree"
    root.mkdir()
    pins = fixture_pins(tool)
    pins[tool][DEFAULTS[tool][0]]["x86_64"] = {
        name: "0" * 64 for name in pins[tool][DEFAULTS[tool][0]]["x86_64"]}
    payload = bundle(tool)
    with patch.object(manager, "fetch", side_effect=lambda url, dest: dest.write_bytes(payload)):
        with patch.object(manager.tarfile, "open", side_effect=AssertionError("extraction")):
            with pytest.raises(ValueError, match="SHA256 mismatch"):
                manager.install(root, tool, DEFAULTS[tool][0], "x86_64", pins)
    assert not (root / tool / DEFAULTS[tool][0]).exists()
    assert not list(root.glob(".stage-*"))


@pytest.mark.parametrize("pins", [{}, {"node": {}}, {"node": {"26.12.0": {"x86_64": {}}}}])
def test_missing_pin_refused_before_network_or_install(tmp_path, pins):
    with patch.object(manager, "fetch", side_effect=AssertionError("network")):
        with pytest.raises(ValueError, match="pin"):
            manager.install(tmp_path, "node", "26.12.0", "x86_64", pins)
    assert not (tmp_path / "node").exists()


def test_rust_copies_manifests_only_after_all_pins_verify_without_execution(tmp_path):
    root = tmp_path / "tree"
    root.mkdir()
    events = []
    def fetch(url, destination):
        events.append("fetch")
        destination.write_bytes(archive_payload("rust", destination.name))
    copy = manager.copy_rust_components
    def copied(source, payload):
        assert events.count("fetch") == 3
        events.append("copy")
        copy(source, payload)
    with patch.object(manager, "fetch", side_effect=fetch):
        with patch.object(manager, "copy_rust_components", side_effect=copied):
            with patch.object(subprocess, "run", side_effect=AssertionError("archive execution")):
                manager.install(root, "rust", "1.99.0", "x86_64", fixture_pins("rust"))
    assert events == ["fetch"] * 3 + ["copy"] * 3
    directory = root / "rust/1.99.0"
    assert (directory / "bin/rustc").read_bytes() == b"payload"
    assert (directory / "bin/cargo").read_bytes() == b"payload"
    assert (directory / "lib/rustlib/native/lib/std.rlib").read_bytes() == b"payload"
    assert not list(directory.rglob("install.sh"))


@pytest.mark.parametrize("record", ["file:../../escape", "file:/etc/escape", "bad:bin/rustc"])
def test_rust_manifest_paths_and_kinds_are_checked(tmp_path, record):
    source, payload = tmp_path / "source", tmp_path / "payload"
    (source / "rustc").mkdir(parents=True)
    payload.mkdir()
    (source / "components").write_text("rustc\n")
    (source / "rust-installer-version").write_text("3\n")
    (source / "rustc/manifest.in").write_text(record + "\n")
    with pytest.raises(ValueError):
        manager.copy_rust_components(source, payload)
    assert not list(payload.iterdir())


def test_prune_keeps_all_configured_plus_former_default_and_is_idempotent(tmp_path):
    parent = tmp_path / "node"
    parent.mkdir()
    for version in ("20.1.0", "22.1.0", "24.1.0", "26.1.0", "26.2.0"):
        path = parent / version
        path.mkdir()
        (path / "file").write_text(version)
        manager.seal(path)
    configured = ["26.1.0", "26.2.0"]
    planned = manager.prune(tmp_path, "node", configured, previous="22.1.0", dry_run=True)
    assert len(planned) == 2 and len(list(parent.iterdir())) == 5
    assert manager.prune(tmp_path, "node", configured, previous="22.1.0") == planned
    assert {p.name for p in parent.iterdir()} == set(configured + ["22.1.0"])
    assert manager.prune(tmp_path, "node", configured, previous="22.1.0") == []


def test_plan_missing_tree_does_not_write_or_download(tmp_path):
    root = tmp_path / "absent"
    with patch.object(manager, "fetch", side_effect=AssertionError("network")):
        assert len(manager.reconcile(root, DEFAULTS, "x86_64", PINS, dry_run=True)) == 4
    assert not root.exists()


@pytest.mark.parametrize("architecture,node,go,rust", [
    ("x86_64", "x64", "amd64", "x86_64"),
    ("aarch64", "arm64", "arm64", "aarch64"),
])
def test_release_names_and_pin_schema(architecture, node, go, rust):
    manager.validate(DEFAULTS, architecture)
    assert f"linux-{node}" in manager.release("node", "26.12.0", architecture)[0][0]
    assert f"linux-{go}" in manager.release("go", "1.27.0", architecture)[0][0]
    assert rust + "-unknown-linux-gnu" in manager.release("uv", "0.12.10", architecture)[0][0]
    for tool, versions in DEFAULTS.items():
        for version in versions:
            assert manager.pinned(PINS, tool, version, architecture)


@pytest.mark.parametrize("version", ["stable", "../escape", "1x2x3", "1.2.3/evil"])
def test_unpinned_or_unsafe_version_refused(version):
    with pytest.raises(ValueError):
        manager.validate({**DEFAULTS, "node": [version]}, "x86_64")


def test_symlink_destination_refused(tmp_path):
    (tmp_path / "node").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        manager.install(tmp_path, "node", "26.12.0", "x86_64", PINS)


def test_wrong_existing_architecture_or_pins_refused(tmp_path):
    path = tmp_path / "node/26.12.0"
    path.mkdir(parents=True)
    (path / manager.MARKER).write_text(json.dumps(
        {"tool": "node", "version": "26.12.0", "architecture": "aarch64"}))
    with pytest.raises(ValueError, match="does not match"):
        manager.install(tmp_path, "node", "26.12.0", "x86_64", PINS)


def test_archive_path_escape_refused_before_publish(tmp_path):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        entry = tarfile.TarInfo("../../escape")
        entry.size = 1
        archive.addfile(entry, io.BytesIO(b"x"))
    payload = data.getvalue()
    with patch.object(manager, "fetch", side_effect=lambda url, dest: dest.write_bytes(payload)):
        with pytest.raises(tarfile.FilterError):
            manager.install(tmp_path, "node", "26.12.0", "x86_64", fixture_pins("node", payload))
    assert not (tmp_path / "escape").exists()
    assert not (tmp_path / "node/26.12.0").exists()


def test_abandoned_staging_is_pruned_on_apply(tmp_path):
    abandoned = tmp_path / ".stage-crashed/payload"
    abandoned.mkdir(parents=True)
    (abandoned / "partial").write_text("partial")
    manager.seal(abandoned)
    with patch.object(manager, "install", return_value=False):
        changes = manager.reconcile(tmp_path, DEFAULTS, "x86_64", PINS)
    assert changes == ["remove abandoned staging " + str(abandoned.parent)]
    assert not abandoned.parent.exists()


def test_busy_job_installs_and_defers_prune_then_idle_host_prunes(tmp_path, monkeypatch, capsys):
    import fcntl

    root = tmp_path / "tree"
    old = root / "node"
    old.mkdir(parents=True)
    for version in ("20.1.0", "22.1.0", "24.1.0"):
        (old / version).mkdir()
    active = tmp_path / "active.json"
    active.write_text(json.dumps({"toolchain_defaults": {"node": "22.1.0"}}))
    pins = {tool: fixture_pins(tool)[tool] for tool in manager.TOOLS}
    payloads = {name: archive_payload(tool, name)
                for tool in manager.TOOLS
                for _url, name in manager.release(tool, DEFAULTS[tool][0], "x86_64")}
    monkeypatch.setattr(manager, "fetch", lambda url, dest: dest.write_bytes(payloads[dest.name]))
    lock = tmp_path / "admission.lock"
    monkeypatch.setattr(sys, "argv", [
        "chaldea-job-toolchains", "--root", str(root), "--versions", json.dumps(DEFAULTS),
        "--checksums", json.dumps(pins), "--architecture", "x86_64",
        "--admission-lock", str(lock), "--active-config", str(active)])

    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        manager.main()
        output = capsys.readouterr()
        result = json.loads(output.out)
        assert result["changed"]
        assert set(result["changes"]) == {f"install {t}@{v[0]}" for t, v in DEFAULTS.items()}
        assert "pruning deferred to the next run" in output.err
        assert {p.name for p in old.iterdir()} == {"20.1.0", "22.1.0", "24.1.0", *DEFAULTS["node"]}
        for tool, versions in DEFAULTS.items():
            assert (root / tool / versions[0] / "bin").is_dir()

        manager.main()
        output = capsys.readouterr()
        assert json.loads(output.out) == {"changed": False, "changes": []}
        assert "pruning deferred" in output.err

    manager.main()
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert result["changed"]
    assert set(result["changes"]) == {"prune " + str(old / v) for v in ("20.1.0", "24.1.0")}
    assert not output.err
    assert {p.name for p in old.iterdir()} == {"22.1.0", *DEFAULTS["node"]}
    manager.main()
    assert json.loads(capsys.readouterr().out) == {"changed": False, "changes": []}


def test_missing_admission_lock_installs_but_defers_prune(tmp_path, capsys):
    lock = tmp_path / "missing"
    with patch.object(manager, "install", return_value=True) as install:
        with patch.object(manager, "prune", side_effect=AssertionError("pruning without lock")):
            changes = manager.reconcile(tmp_path / "tree", DEFAULTS, "x86_64", PINS,
                                        admission_lock_path=lock)
    assert install.call_count == 4
    assert len(changes) == 4
    assert "pruning deferred to the next run" in capsys.readouterr().err
    assert not lock.exists()


def test_admission_lock_missing_is_skipped_without_creating(tmp_path):
    assert manager.admission_lock(tmp_path / "missing") is None
    assert not list(tmp_path.iterdir())


def test_admission_lock_is_readonly_and_never_mutates_job_file(tmp_path):
    path = tmp_path / "admission.lock"
    path.write_text("sentinel")
    path.chmod(0o400)
    descriptor = manager.admission_lock(path)
    assert descriptor is not None
    try:
        with pytest.raises(OSError):
            os.write(descriptor, b"no")
    finally:
        os.close(descriptor)
    assert path.read_text() == "sentinel"
    assert path.stat().st_mode & 0o777 == 0o400


@pytest.mark.parametrize("kind", ["symlink", "fifo"])
def test_admission_lock_symlink_and_fifo_refused_without_mutating_target(tmp_path, kind):
    target = tmp_path / "target"
    target.write_text("sentinel")
    path = tmp_path / "admission.lock"
    if kind == "symlink":
        path.symlink_to(target)
    else:
        os.mkfifo(path)
    with pytest.raises((ValueError, OSError)):
        manager.admission_lock(path)
    assert target.read_text() == "sentinel"


@pytest.mark.parametrize("scheme", ["http", "ftp", "file"])
def test_redirect_downgrades_are_refused_before_following(scheme):
    request = urllib.request.Request("https://example.com/archive")
    with pytest.raises(ValueError, match="non-HTTPS"):
        manager.HTTPSRedirects().redirect_request(request, None, 302, "Found", {}, scheme + "://example.com/archive")


def test_https_redirects_remain_supported():
    request = urllib.request.Request("https://example.com/archive")
    redirected = manager.HTTPSRedirects().redirect_request(
        request, None, 302, "Found", {}, "https://cdn.example.com/archive")
    assert redirected.full_url == "https://cdn.example.com/archive"




def test_prune_requires_every_slot_and_releases_partial_acquisition(tmp_path, capsys):
    import fcntl
    zero = tmp_path / "admission.lock"
    one = tmp_path / "admission-1.lock"
    zero.touch()
    one.touch()
    with one.open("r") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with patch.object(manager, "install", return_value=False), patch.object(manager, "prune") as prune:
            assert manager.reconcile(tmp_path / "tools", DEFAULTS, "x86_64", PINS,
                                     admission_lock_path=zero, slots=2) == []
            prune.assert_not_called()
        assert "pruning deferred" in capsys.readouterr().err
        descriptor = manager.admission_lock(zero)
        assert descriptor is not None, "partial acquisition leaked slot zero"
        os.close(descriptor)
    def check_locked(*args, **kwargs):
        assert manager.admission_lock(zero) is None
        assert manager.admission_lock(one) is None
        return []
    with patch.object(manager, "install", return_value=False), patch.object(manager, "prune", side_effect=check_locked):
        manager.reconcile(tmp_path / "tools", DEFAULTS, "x86_64", PINS,
                          admission_lock_path=zero, slots=2)
