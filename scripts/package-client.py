#!/usr/bin/env python3
"""Package the Node 26 client with locked production dependencies, without Git."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

version, destination = sys.argv[1:]
if not re.fullmatch(r"client-(?:v[0-9]+\.[0-9]+\.[0-9]+|[a-f0-9]{40})", version):
    raise ValueError("expected client-vX.Y.Z or client-COMMIT")
output = Path(destination).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="client-build-") as temporary:
    stage = Path(temporary)
    for name in ("src", "bin", "vendor"):
        shutil.copytree(name, stage / name)
    (stage / "host").mkdir()
    shutil.copyfile("host/exec-protocol.json", stage / "host/exec-protocol.json")
    for name in ("package.json", "package-lock.json", "LICENSE"):
        shutil.copyfile(name, stage / name)
    subprocess.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                   cwd=stage, check=True)
    files = {}
    archive = output / "chaldea-client.tar.gz"
    with archive.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for path in sorted(stage.rglob("*")):
                if path.is_symlink():
                    raise ValueError("client artifact refuses symlinks")
                if not path.is_file():
                    continue
                data = path.read_bytes()
                name = path.relative_to(stage).as_posix()
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o755 if name.startswith("bin/") else 0o644
                entry.mtime = entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                tar.addfile(entry, io.BytesIO(data))
                files[name] = hashlib.sha256(data).hexdigest()
    manifest = {"version": version, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "files": files}
    (output / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    print(json.dumps({"version": version, "sha256": manifest["sha256"]}))
