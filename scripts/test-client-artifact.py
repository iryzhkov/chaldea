#!/usr/bin/env python3
"""Exercise the distributable in scratch with no source checkout or npm install."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time

release = Path(sys.argv[1]).resolve()
scratch = Path(os.environ["TMPDIR"]).resolve()
assert scratch != Path("/tmp") and not scratch.is_relative_to("/tmp")
home = Path.home().resolve()
assert home != Path("/home/igor") and home.name == "home", "set an isolated scratch HOME ending in /home"
manifest = json.loads((release / "manifest.json").read_text())
archive = release / "chaldea-client.tar.gz"
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"]
with tempfile.TemporaryDirectory(dir=scratch, prefix="client-smoke-") as temporary:
    root = Path(temporary)
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        assert all(m.isfile() and not m.name.startswith("/") and ".." not in Path(m.name).parts for m in members)
        assert {m.name for m in members} == set(manifest["files"])
        for member in members:
            stream = tar.extractfile(member)
            assert stream is not None
            data = stream.read()
            assert hashlib.sha256(data).hexdigest() == manifest["files"][member.name]
        tar.extractall(root, filter="data")
    assert not (root / "node_modules/esbuild").exists()
    assert not (root / "node_modules/typescript").exists()
    assert (root / "src/exec/blob_pair.py").is_file()
    for arguments in (["quota", "observe", "--help"], ["access", "--help"], ["mcp", "--help"]):
        result = subprocess.run(["node", str(root / "bin/chaldea"), *arguments],
                                cwd=home, text=True, capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr
    config = home / "legacy-mcp.json"
    config.write_text("{retired config is not read")
    result = subprocess.run(["node", str(root / "bin/chaldea"), "mcp", "--config", str(config)],
                            cwd=home, text=True, capture_output=True,
                            input=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) + "\n")
    assert result.returncode == 0, result.stderr
    names = [tool["name"] for tool in json.loads(result.stdout)["result"]["tools"]]
    assert names == ["chaldea_route", "chaldea_route_review_pair"], names
    print("Packaged mcp --config tools/list:", names)
    quota = home / "quota.json"
    quota.write_text(json.dumps({"fleet": {"enabled": True, "endpoint": "https://retired.invalid"}}))
    token = home / "t3-token"
    token.write_text("fixture-token\n")
    token.chmod(0o600)
    state = home / "quota-observer.json"
    observer = subprocess.Popen(["node", str(root / "bin/chaldea"), "quota", "observe",
                                 "--t3-base-dir", str(home / "offline-t3"),
                                 "--token-file", str(token), "--state-file", str(state),
                                 "--feed-command", str(home / "unused-feed"),
                                 "--quota-config", str(quota)],
                                cwd=home, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 15
        while not state.exists() and observer.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert state.exists() and observer.poll() is None, "observer did not start with installed flags"
        observer.terminate()
        stdout, stderr = observer.communicate(timeout=15)
        assert observer.returncode == 0, stdout + stderr
        assert "quota observer starting" in stderr + stdout, stdout + stderr
        print("Packaged quota observe accepts all five installed flags and legacy fleet config")
    finally:
        if observer.poll() is None:
            observer.kill()
            observer.communicate()
    result = subprocess.run(["node", str(root / "bin/chaldea"), "exec"], cwd=home,
                            text=True, capture_output=True)
    assert result.returncode == 255 and "invalid exec arguments" in result.stderr, result.stderr
    result = subprocess.run(["node", str(root / "bin/chaldea"), "blob-maintenance"],
                            cwd=home, text=True, capture_output=True)
    assert result.returncode == 2 and "Blob maintenance failed" in result.stderr
print("Client archive checksums, production dependencies and entry points passed")
