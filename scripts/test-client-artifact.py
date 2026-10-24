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
    assert (root / "src/waits/calendar.py").is_file()
    assert (root / "src/exec/blob_pair.py").is_file()
    for arguments in (["quota", "observe", "--help"], ["wait", "--help"], ["access", "--help"], ["mcp", "--help"]):
        result = subprocess.run(["node", str(root / "bin/chaldea"), *arguments],
                                cwd=home, text=True, capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr
    result = subprocess.run(["node", str(root / "bin/chaldea"), "exec"], cwd=home,
                            text=True, capture_output=True)
    assert result.returncode == 255 and "invalid exec arguments" in result.stderr, result.stderr
    result = subprocess.run(["node", str(root / "bin/chaldea"), "blob-maintenance"],
                            cwd=home, text=True, capture_output=True)
    assert result.returncode == 2 and "Blob maintenance failed" in result.stderr
print("Client archive checksums, production dependencies and entry points passed")
