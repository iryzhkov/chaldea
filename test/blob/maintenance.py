"""Private real-Garage maintenance sequencing integration. No NAS or production."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from garage import Garage, bootstrap
from image import prepare_binary

root = Path.cwd()
home = Path(os.environ["HOME"])
assert home == root / ".blob-image/home"
assert Path(os.environ["TMPDIR"]) == root / ".blob-image/tmp"
os.umask(0o077)
binary, image = prepare_binary()
module = bootstrap(home)
garage = Garage(binary, home)
try:
    garage.start()
    name = "maintenance-fixture"
    spec = {"layout": {"zone": "fixture", "capacity": 1024**3},
        "buckets": [{"name": name, "max_size": 1024**2, "max_objects": 16,
                     "expire_days": 14, "abort_multipart_days": 1}],
        "keys": [{"name": key, "buckets": {name: perms}} for key, perms in [
            ("bootstrap", ["read", "write", "owner"]),
            ("publisher-a", ["read", "write"]), ("publisher-b", ["read", "write"]),
            ("reader", ["read"]), ("cleanup", ["read", "write"])]],
        "lifecycle_key": "bootstrap"}
    endpoint = "http://127.0.0.1:" + str(garage.s3)
    module.converge(garage, spec, True, lambda a, s: module.S3(endpoint, a, s))
    keys = {k["name"]: k["id"] for k in garage("ListKeys")}
    bucket = next(b["id"] for b in garage("ListBuckets") if name in b["globalAliases"])
    garage("DenyBucketKey", {"bucketId": bucket, "accessKeyId": keys["bootstrap"],
                           "permissions": {"read": True, "write": True, "owner": True}})
    credential = home / "cleanup.json"
    info = garage("GetKeyInfo", {"id": keys["cleanup"], "showSecretKey": True})
    credential.write_text(json.dumps({"accessKeyId": keys["cleanup"], "secretAccessKey": info["secretAccessKey"]}))
    credential.chmod(0o600)
    # Graceful stop is required. The old fixture helper's KILL fallback is not used.
    process = garage.process
    process.terminate()
    process.wait(timeout=10)
    assert process.returncode == 0
    garage.process = None
    garage.log.close()
    garage.log = None
    f = {"binary": str(binary), "config": str(garage.config), "meta": str(garage.meta),
         "data": str(garage.data), "rpc": str(garage.secret), "endpoint": endpoint, "root": str(home),
         "result": str(root / "blob-maintenance-integration.json"),
         "binding": {"bucket": name, "bucketId": bucket, "principal": "fixture",
                     "publishers": [keys["publisher-a"], keys["publisher-b"]], "readers": [keys["reader"]],
                     "cleanupKey": keys["cleanup"], "credentialFile": str(credential)}}
    fixture = home / "fixture.json"
    fixture.write_text(json.dumps(f))
    subprocess.run(["node", "test/blob/maintenance.ts", str(fixture)], check=True, timeout=180)
finally:
    if garage.process is not None:
        exact = garage.process
        exact.terminate()
        try: exact.wait(timeout=5)
        except subprocess.TimeoutExpired:
            exact.kill()
            exact.wait(timeout=5)
    if garage.log is not None:
        garage.log.close()
