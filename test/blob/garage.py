"""M2 isolated Garage custody/permissions/restore probe. No production state."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import uuid

from image import prepare_binary
from protocol import AGE, cleanup, retrieve
from exec_client import prove as prove_exec_client

BOOTSTRAP_COMMIT = "730491fb9d63ba3e788011a00b15495d8bb53dd9"
BOOTSTRAP_BLOB = "61e2e824fb749fb31631eea7a80a8d2d95045bc6"
MIB = 1024 * 1024


def bootstrap(home):
    path = Path(__file__).parent / "vendor" / "garage-bootstrap.py"
    data = path.read_bytes()
    identity = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if identity != BOOTSTRAP_BLOB:
        raise ValueError("bootstrap source binding mismatch")
    spec = importlib.util.spec_from_file_location("pinned_bootstrap", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ports():
    listeners = [socket.socket() for _ in range(2)]
    try:
        for listener in listeners:
            listener.bind(("127.0.0.1", 0))
        return [listener.getsockname()[1] for listener in listeners]
    finally:
        for listener in listeners:
            listener.close()


class Garage:
    def __init__(self, binary, home):
        self.binary, self.home = binary, home
        self.rpc, self.s3 = ports()
        self.config = home / "garage.toml"
        self.secret = home / "rpc.secret"
        self.secret.write_text(os.urandom(32).hex())
        self.secret.chmod(0o600)
        self.meta, self.data = home / "meta", home / "data"
        self.config.write_text(
            f'metadata_dir = "{self.meta}"\ndata_dir = "{self.data}"\n'
            'db_engine = "lmdb"\nmetadata_fsync = true\ndata_fsync = true\n'
            'replication_factor = 1\nconsistency_mode = "consistent"\n'
            f'rpc_bind_addr = "127.0.0.1:{self.rpc}"\nrpc_public_addr = "127.0.0.1:{self.rpc}"\n'
            f'rpc_secret_file = "{self.secret}"\n[s3_api]\ns3_region = "garage"\n'
            f'api_bind_addr = "127.0.0.1:{self.s3}"\n')
        self.process = None
        self.log = None

    def __call__(self, endpoint, payload=None):
        response = subprocess.run(
            [str(self.binary), "-c", str(self.config), "json-api", endpoint, "-"],
            input=json.dumps(payload), text=True, capture_output=True, timeout=10)
        if response.returncode:
            # Never expose an administration response containing synthetic keys.
            raise RuntimeError(f"Garage {endpoint} refused, exit {response.returncode}")
        return json.loads(response.stdout) if response.stdout.strip() else None

    def start(self):
        self.log = (self.home / "garage.log").open("ab")
        self.process = subprocess.Popen([str(self.binary), "-c", str(self.config), "server"],
                                        stdout=self.log, stderr=self.log)
        end = time.monotonic() + 20
        while time.monotonic() < end:
            if self.process.poll() is not None:
                raise RuntimeError("Garage exited during startup")
            try:
                return self("GetClusterStatus")
            except (RuntimeError, subprocess.TimeoutExpired):
                time.sleep(0.1)
        raise RuntimeError("Garage startup deadline")

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if self.log is not None:
            self.log.close()
            self.log = None


class S3:
    def __init__(self, module, endpoint, access, secret):
        self.module, self.endpoint = module, endpoint
        self.access, self.secret = access, secret

    def request(self, method, path, body=b"", headers=None):
        url = self.endpoint + "/" + path
        signed = self.module.sign_v4(
            method, url, headers or {}, body, self.access, self.secret, "garage",
            datetime.datetime.now(datetime.timezone.utc))
        signed.pop("host")
        request = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None,
                                         headers=signed, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = response.read(4 * MIB + 1)
                if len(result) > 4 * MIB:
                    raise ValueError("S3 response exceeds bound")
                return response.status, result
        except urllib.error.HTTPError as error:
            return error.code, error.read(4096)


def main():
    home = Path(os.environ["HOME"])
    binary, image = prepare_binary()
    module = bootstrap(home)
    garage = Garage(binary, home)
    report = {"passed": False, "proof": "garage-custody", "image": image,
              "bootstrapCommit": BOOTSTRAP_COMMIT, "bootstrapBlob": BOOTSTRAP_BLOB}
    try:
        garage.start()
        spec = {
            "layout": {"zone": "fixture", "capacity": 1024 * MIB},
            "buckets": [{"name": name, "max_size": MIB, "max_objects": 16,
                         "expire_days": 14, "abort_multipart_days": 1}
                        for name in ("artifact-a", "artifact-b", "artifact-c")],
            "keys": [
                {"name": "fixture-ops", "buckets": {name: ["read", "write", "owner"]
                                                    for name in ("artifact-a", "artifact-b", "artifact-c")}},
                {"name": "writer-a", "buckets": {"artifact-a": ["write"]}},
                {"name": "reader-a", "buckets": {"artifact-a": ["read"]}},
                {"name": "other-b", "buckets": {"artifact-b": ["read", "write"]}},
                {"name": "publisher-c", "buckets": {"artifact-c": ["read", "write"]}},
                {"name": "reader-c", "buckets": {"artifact-c": ["read"]}},
            ],
            "lifecycle_key": "fixture-ops",
        }
        endpoint = "http://127.0.0.1:" + str(garage.s3)
        factory = lambda access, secret: module.S3(endpoint, access, secret)
        module.converge(garage, spec, True, factory)
        assert not module.converge(garage, spec, True, factory)["changed"]
        report["bootstrapSecondConvergence"] = "unchanged"

        def client(name):
            key = next(k for k in garage("ListKeys") if k["name"] == name)
            info = garage("GetKeyInfo", {"id": key["id"], "showSecretKey": True})
            return S3(module, endpoint, key["id"], info["secretAccessKey"])

        writer, reader, other, ops = [client(name) for name in ("writer-a", "reader-a", "other-b", "fixture-ops")]
        producer = Path(tempfile.mkdtemp(prefix="producer-", dir=home))
        subprocess.run(["sh", "-c", 'printf "representative artifact\\n" > report.txt'], cwd=producer,
                       env={"HOME": str(producer), "TMPDIR": str(producer), "PATH": os.environ["PATH"]},
                       timeout=10, check=True)
        payload = (producer / "report.txt").read_bytes()
        identity = str(uuid.uuid4())
        sha = hashlib.sha256(payload).hexdigest()
        key = "artifact-a/v1/" + identity + "/objects/" + sha
        accepted_at = int(time.time())
        manifest = {"version": 1, "jobId": identity, "principal": "a", "createdAt": accepted_at,
                    "expiresAt": accepted_at + AGE,
                    "artifacts": [{"path": "report.txt", "sha256": sha, "size": len(payload)}]}
        manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
        manifest_path = "artifact-a/v1/" + identity + "/manifests/" + hashlib.sha256(manifest_bytes).hexdigest() + ".json"
        assert writer.request("PUT", key, payload)[0] == 200
        assert writer.request("GET", key)[0] == 403
        assert reader.request("PUT", key, b"wrong")[0] == 403
        assert other.request("GET", key)[0] == 403
        assert writer.request("PUT", "artifact-b/forbidden", payload)[0] == 403
        assert writer.request("PUT", manifest_path, manifest_bytes)[0] == 200
        # Confirm custody before destroying the only producer directory.
        assert reader.request("GET", key) == (200, payload)
        assert reader.request("GET", manifest_path) == (200, manifest_bytes)
        shutil.rmtree(producer)
        fresh = client("reader-a")
        retrieved = retrieve(fresh, "artifact-a", identity)
        assert retrieved == payload

        def refused(action, expected):
            try:
                action()
            except ValueError as error:
                assert str(error) == expected
            else:
                raise AssertionError("expected " + expected)

        refused(lambda: retrieve(fresh, "artifact-a", str(uuid.uuid4())), "manifest_missing")
        refused(lambda: retrieve(fresh, "artifact-a", identity, now=accepted_at + AGE + 1), "manifest_expired")
        assert writer.request("PUT", key, b"corrupt")[0] == 200
        refused(lambda: retrieve(fresh, "artifact-a", identity), "artifact_integrity")
        assert writer.request("PUT", key, payload)[0] == 200
        assert writer.request("PUT", manifest_path, b"{}")[0] == 200
        refused(lambda: retrieve(fresh, "artifact-a", identity), "manifest_integrity")
        assert writer.request("PUT", manifest_path, manifest_bytes)[0] == 200
        conflict = dict(manifest, createdAt=accepted_at - 1)
        conflict_bytes = json.dumps(conflict, sort_keys=True).encode()
        conflict_path = "artifact-a/v1/" + identity + "/manifests/" + hashlib.sha256(conflict_bytes).hexdigest() + ".json"
        assert writer.request("PUT", conflict_path, conflict_bytes)[0] == 200
        refused(lambda: retrieve(fresh, "artifact-a", identity), "manifest_conflict")
        assert ops.request("DELETE", conflict_path)[0] == 204
        # Valid content hashes must not disguise a wrong identity or caller path.
        assert ops.request("DELETE", manifest_path)[0] == 204
        for invalid, reason in [
            (dict(manifest, jobId=str(uuid.uuid4())), "manifest_binding"),
            (dict(manifest, principal="b"), "manifest_binding"),
            (dict(manifest, artifacts=[dict(manifest["artifacts"][0], path="../escape")]), "artifact_binding"),
        ]:
            invalid_bytes = json.dumps(invalid, sort_keys=True).encode()
            invalid_path = "artifact-a/v1/" + identity + "/manifests/" + hashlib.sha256(invalid_bytes).hexdigest() + ".json"
            assert writer.request("PUT", invalid_path, invalid_bytes)[0] == 200
            refused(lambda: retrieve(fresh, "artifact-a", identity), reason)
            assert ops.request("DELETE", invalid_path)[0] == 204
        assert writer.request("PUT", manifest_path, manifest_bytes)[0] == 200
        assert retrieve(fresh, "artifact-a", identity) == payload
        report["manifestIntegrityConflictAndExpiry"] = True
        report["custodyAfterProducerDeletion"] = {"jobId": identity, "sha256": sha, "size": len(retrieved)}
        report["crossPrincipalDenied"] = True

        # Measure actual conditional and lifecycle behavior; these are decision-A
        # inputs, not assertions that the production trust/retention boundary exists.
        conditional, _ = writer.request("PUT", key, b"replacement", {"If-None-Match": "*"})
        report["conditionalOverwriteStatus"] = conditional
        assert writer.request("PUT", key, payload)[0] == 200
        lifecycle_before = ops.request("GET", "artifact-a?lifecycle")
        assert lifecycle_before[0] == 200
        report["writerLifecycleDeleteStatus"] = writer.request("DELETE", "artifact-a?lifecycle")[0]
        # Restore the exact configured lifecycle using the trusted existing bootstrap.
        module.converge(garage, spec, True, factory)
        assert ops.request("GET", "artifact-a?lifecycle") == lifecycle_before
        quota, _ = writer.request("PUT", "artifact-a/too-large", b"x" * (2 * MIB))
        assert quota in (403, 413), f"quota refusal status {quota}"
        report["quotaRefusalStatus"] = quota
        assert reader.request("GET", "artifact-a/missing")[0] == 404

        # Multipart create/complete and an interrupted transfer. The latter
        # is removed by the trusted cleanup even after lifecycle deletion.
        multipart_path = "artifact-b/v1/" + identity + "/objects/" + sha
        status, body = other.request("POST", multipart_path + "?uploads")
        assert status == 200
        upload_id = ET.fromstring(body).findtext("{*}UploadId")
        upload_query = urllib.parse.quote(upload_id, safe="")
        assert other.request("PUT", multipart_path + "?partNumber=1&uploadId=" + upload_query, payload)[0] == 200
        # S3 completes using the MD5 part ETag for this one unencrypted part.
        part_etag = hashlib.md5(payload).hexdigest()
        completion = ('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"' +
                      part_etag + '"</ETag></Part></CompleteMultipartUpload>').encode()
        assert other.request("POST", multipart_path + "?uploadId=" + upload_query, completion)[0] == 200
        assert other.request("GET", multipart_path) == (200, payload)
        pending_path = "artifact-a/v1/" + identity + "/objects/" + "0" * 64
        status, body = writer.request("POST", pending_path + "?uploads")
        assert status == 200
        pending_id = ET.fromstring(body).findtext("{*}UploadId")
        pending_query = urllib.parse.quote(pending_id, safe="")
        part_status, _ = writer.request("PUT", pending_path + "?partNumber=1&uploadId=" + pending_query, b"x" * (2 * MIB))
        assert part_status in (200, 403, 413)
        report["multipartComplete"] = True
        report["oversizePendingPartStatus"] = part_status

        # A stopped, consistent metadata+data backup is restored into empty paths.
        before = garage("ListBuckets")
        garage.stop()
        try:
            cleanup(ops, "artifact-a", accepted_at + AGE + 60)
        except urllib.error.URLError:
            report["cleanerOutageRefused"] = True
        else:
            raise AssertionError("offline cleanup must not report success")
        backup = home / "backup"
        backup.mkdir()
        for name, path in (("meta", garage.meta), ("data", garage.data)):
            shutil.copytree(path, backup / name)
            shutil.rmtree(path)
            shutil.copytree(backup / name, path)
        garage.start()
        assert garage("ListBuckets") == before
        assert client("reader-a").request("GET", key) == (200, payload)
        assert client("other-b").request("GET", key)[0] == 403
        assert not module.converge(garage, spec, True, factory)["changed"]
        report["dataAndMetadataRestore"] = True
        # Writer removes the backend lifecycle again. Independent protected
        # age policy still removes all expired objects and abandoned uploads.
        assert writer.request("DELETE", "artifact-a?lifecycle")[0] == 204
        cleaned = cleanup(ops, "artifact-a", accepted_at + AGE + 60)
        assert cleaned["objects"] == 2 and cleaned["uploads"] == 1
        assert reader.request("GET", key)[0] == 404
        assert other.request("GET", multipart_path) == (200, payload)
        refused(lambda: retrieve(fresh, "artifact-a", identity), "manifest_missing")
        assert cleanup(ops, "artifact-a", accepted_at + AGE + 60) == {"objects": 0, "uploads": 0}
        report["trustedCleanupAfterLifecycleMutation"] = cleaned
        report["execClient"] = prove_exec_client(home, endpoint, client("publisher-c"), client("reader-c"), garage)
        report["passed"] = True
        report["decisionA"] = "open: protected cleanup deployment, pending-part physical bounds, dedicated mount and live SSH custody still require qualification"
    finally:
        garage.stop()
        Path("blob-custody-proof.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
