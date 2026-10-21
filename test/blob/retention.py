"""Production cleanup against the unchanged pinned Garage acquisition."""
import hashlib
import json
import subprocess
import time
import uuid


def prove(home, endpoint, client):
    root = home / "bounded-retention"
    root.mkdir(mode=0o700)
    key = root / "key.json"
    key.write_text(json.dumps({"accessKeyId": client.access, "secretAccessKey": client.secret}))
    key.chmod(0o600)
    config = root / "blob.json"
    config.write_text(json.dumps({"endpoint": endpoint, "bucket": "artifact-d", "principal": "d",
                                 "region": "garage", "credentialFile": str(key)}))
    config.chmod(0o600)
    created = int(time.time())
    upload_path = None
    for index in range(3):
        identity = str(uuid.uuid4())
        payload = ("bounded retention " + str(index)).encode()
        digest = hashlib.sha256(payload).hexdigest()
        prefix = "artifact-d/v1/" + identity + "/"
        upload_path = prefix + "objects/" + digest
        assert client.request("PUT", upload_path, payload)[0] == 200
        manifest = {"version": 1, "jobId": identity, "principal": "d", "createdAt": created,
                    "expiresAt": created + 14 * 86400, "requested": ["report"],
                    "artifacts": [{"path": "report", "sha256": digest, "size": len(payload)}]}
        data = json.dumps(manifest).encode()
        assert client.request("PUT", prefix + "manifests/" + hashlib.sha256(data).hexdigest() + ".json", data)[0] == 200
    # Opaque upload IDs on the same key exercise the compound marker.
    assert upload_path is not None
    for _ in range(3):
        assert client.request("POST", upload_path + "?uploads")[0] == 200
    result = subprocess.run(["node", "test/blob/retention.ts", str(config), str(created + 14 * 86400 + 60)],
                            capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, "bounded retention fixture failed: " + result.stderr[-6000:]
    return json.loads(result.stdout)
