"""Read-only contract fixture runner. All host IO is replaced, never provisioned."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
from unittest.mock import patch

request = json.load(sys.stdin)
root = Path(__file__).resolve().parent
starter = "/usr/local/libexec/garage-storage-native.py"
preflight = "/usr/local/libexec/garage-storage-preflight.py"
storage = request["storage"]
files = {
    starter: (root / "garage-storage-native.py").read_bytes(),
    preflight: (root / "garage-storage-preflight.py").read_bytes(),
    "/etc/garage/storage.json": json.dumps(storage, separators=(",", ":")).encode(),
    "/mnt/docker-data/swarm/objectstore/config/garage.toml": request["garage"].encode(),
}
real_spec = importlib.util.spec_from_file_location
real_read = Path.read_bytes

class Probe:
    def lstat(self, path):
        owner = 1000 if path in (storage["data"]["path"], storage["metadata"]["path"] + "/meta") else 0
        return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=owner, st_gid=owner, st_dev=1)
    def mount(self, path):
        label = "data" if path.startswith("/mnt/nas/") else "metadata"
        result = dict(storage[label]["mount"])
        result["options"] = ",".join(result["options"])
        if request.get("mount_loss"):
            result["source"] = "wrong"
        return result

def spec(name, path):
    assert str(path) == preflight
    result = real_spec(name, root / "garage-storage-preflight.py")
    assert result is not None and result.loader is not None
    original = result.loader.exec_module
    def load(module):
        original(module)
        module.HostProbe = Probe
    result.loader.exec_module = load
    return result

def statvfs(path):
    label = "data" if path == storage["data"]["path"] else "metadata"
    values = request["telemetry"][label]
    if values == "OSError":
        raise OSError("injected statvfs failure")
    return SimpleNamespace(**values)

fds = {}
def opened(path, flags):
    assert str(path) in files
    fd = 10000 + len(fds)
    fds[fd] = files[str(path)]
    return fd

with patch.object(Path, "read_bytes", lambda p: files[str(p)] if str(p) in files else real_read(p)), \
     patch.object(Path, "lstat", lambda p: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)), \
     patch.object(os, "open", opened), \
     patch.object(os, "fstat", lambda fd: SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_uid=0, st_size=len(fds[fd]))), \
     patch.object(os, "fdopen", lambda fd, *a, **kw: io.BytesIO(fds[fd])), \
     patch.object(os, "close", lambda fd: None), \
     patch.object(os, "statvfs", statvfs), \
     patch.object(importlib.util, "spec_from_file_location", spec), \
     patch.object(sys, "stdin", io.StringIO(json.dumps(request["pins"]))):
    exec(compile(request["snippet"], "<fixed-maintenance-headroom>", "exec"))
