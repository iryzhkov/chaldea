#!/usr/bin/env python3
"""Create a reproducible public host artifact; no Git or host state required."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

version, output, stage = sys.argv[1:]
output = Path(output)
output.mkdir(parents=True, exist_ok=True)
files = {}
for root in (Path("host"), Path(stage) / "host"):
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("artifact refuses symlinks")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            name = "host/" + path.relative_to(root).as_posix()
            files[name] = path.read_bytes()
archive = output / "chaldea-host.tar.gz"
with archive.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o755 if data.startswith(b"#!") else 0o644
            entry.mtime = entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            tar.addfile(entry, io.BytesIO(data))
manifest = {"version": version, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
(output / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
print(json.dumps({"version": version, "sha256": manifest["sha256"]}))
