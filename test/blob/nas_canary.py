"""Explicit single-host NAS experiment. Never imported by a default test runner."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import time
import urllib.request
import uuid
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src/exec"))
from blob_pair import sparse_file as copy_sparse

from garage import BOOTSTRAP_BLOB, BOOTSTRAP_COMMIT, Garage, S3, bootstrap
from image import IMAGE, prepare_binary
from protocol import AGE, retrieve

MOUNT = Path("/mnt/nas/ml")
SOURCE = "192.168.40.40:/var/nfs/shared/machine_learning"
LOCAL_TYPES = {"ext4", "xfs", "btrfs", "zfs"}
PAYLOAD = b"representative NAS custody artifact\n"
MAX_SECONDS = 300


class Refusal(ValueError):
    """Only fixed, credential-free reason codes may use this exception."""


def require(value, reason):
    if not value:
        raise Refusal(reason)


def plain_path(value):
    path = Path(value)
    require(path.is_absolute() and str(path) == value and
            re.fullmatch(r"/[A-Za-z0-9_./-]+", value) and ".." not in path.parts,
            "unsafe_path")
    return path


def no_links(path):
    for part in (*reversed(path.parents), path):
        require(not part.is_symlink(), "symlink_path")


def mount_for(path):
    # mountinfo escapes whitespace and backslashes with octal sequences.
    def unescape(value):
        return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)
    rows = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        left, right = line.split(" - ", 1)
        fields, extra = left.split(), right.split()
        target = Path(unescape(fields[4]))
        if path == target or target in path.parents:
            rows.append({"target": str(target), "source": unescape(extra[1]),
                         "type": extra[0], "options": sorted(set(
                             fields[5].split(",") + extra[2].split(",")))})
    require(bool(rows), "mount_missing")
    return max(rows, key=lambda row: len(Path(row["target"]).parts))


def nas_mount(path):
    row = mount_for(path)
    require(row["target"] == str(MOUNT) and row["source"] == SOURCE and
            row["type"] == "nfs" and
            {"rw", "vers=3", "soft", "sec=sys"} <= set(row["options"]),
            "unexpected_nfs_mount")
    no_links(path)
    return row


def fingerprint(path):
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode), "directory_required")
    return value.st_dev, value.st_ino


def owner(path):
    value = path.lstat()
    return value.st_uid, value.st_gid


def unreadable_tree(_error):
    raise Refusal("tree_unreadable")


def checked_tree(path, identity, expected_owner):
    no_links(path)
    require(fingerprint(path) == identity, "namespace_changed")
    count, allocated = 0, 0
    mount = mount_for(path)
    for root, dirs, files in os.walk(path, followlinks=False, onerror=unreadable_tree):
        for entry in [Path(root)] + [Path(root) / name for name in dirs + files]:
            value = entry.lstat()
            require(mount_for(entry) == mount, "cleanup_submount")
            require(value.st_dev == identity[0] and
                    (value.st_uid, value.st_gid) == expected_owner and
                    (stat.S_ISDIR(value.st_mode) or
                     stat.S_ISREG(value.st_mode) and value.st_nlink == 1),
                    "unsafe_cleanup_entry")
            count += 1
            allocated += value.st_blocks * 512
            require(count <= 4096 and allocated <= 512 * 1024 * 1024,
                    "cleanup_inspection_bound")


def remove_owned(path, identity, expected_owner):
    checked_tree(path, identity, expected_owner)
    require(shutil.rmtree.avoids_symlink_attacks, "safe_rmtree_unavailable")
    # Only a freshly created private namespace, never MOUNT or its parents.
    shutil.rmtree(path)


def preflight(args):
    uid, gid = os.geteuid(), os.getegid()
    require(uid != 0 and gid != 0 and os.getuid() == uid and os.getgid() == gid,
            "nonroot_identity_required")
    require(not os.environ.get("SUDO_UID") and not os.environ.get("SUDO_GID"),
            "sudo_environment")
    local, data = plain_path(args.local_run), plain_path(args.nas_run)
    require(local.name.startswith("garage-canary-") and
            data.name == local.name and data.parent == MOUNT, "namespace_required")
    no_links(local)
    require(not local.exists(), "namespace_collision")
    home, temp = local / ".blob-image/home", local / ".blob-image/tmp"
    require(os.environ.get("HOME") == str(home) and
            os.environ.get("TMPDIR") == str(temp), "asserted_scratch_environment_required")
    require(local.parent == Path(pwd.getpwuid(uid).pw_dir) / ".cache" and
            local.parent.is_dir() and
            owner(local.parent) == (uid, gid) and
            local.parent.stat().st_mode & 0o022 == 0, "owned_disk_scratch_required")
    require(mount_for(local.parent)["type"] in LOCAL_TYPES, "local_disk_required")
    require(os.access(local.parent, os.W_OK | os.X_OK), "scratch_permission")
    mapped = tuple(int(part) for part in args.expected_data_owner.split(":"))
    require(len(mapped) == 2 and all(0 < part < 2**32 - 1 for part in mapped),
            "invalid_data_owner")
    return local, data, home, temp, (uid, gid), mapped


def custody(garage, module, home, save_progress):
    endpoint = "http://127.0.0.1:" + str(garage.s3)
    spec = {
        "layout": {"zone": "nas-canary", "capacity": 1024 * 1024 * 1024},
        "buckets": [{"name": name, "max_size": 1024 * 1024, "max_objects": 4,
                     "expire_days": 14, "abort_multipart_days": 1}
                    for name in ("artifact-a", "artifact-b")],
        "keys": [
            {"name": "canary-ops", "buckets": {name: ["read", "write", "owner"]
                                               for name in ("artifact-a", "artifact-b")}},
            {"name": "writer-a", "buckets": {"artifact-a": ["write"]}},
            {"name": "reader-a", "buckets": {"artifact-a": ["read"]}},
            {"name": "other-b", "buckets": {"artifact-b": ["read", "write"]}},
        ],
        "lifecycle_key": "canary-ops",
    }
    module.converge(garage, spec, True, lambda access, secret: module.S3(endpoint, access, secret))

    def client(name):
        key = next(key for key in garage("ListKeys") if key["name"] == name)
        info = garage("GetKeyInfo", {"id": key["id"], "showSecretKey": True})
        return S3(module, endpoint, key["id"], info["secretAccessKey"])

    writer, reader, other = (client(name) for name in ("writer-a", "reader-a", "other-b"))
    producer = home / "producer"
    producer.mkdir(mode=0o700)
    producer_id = fingerprint(producer)
    subprocess.run(["sh", "-c", 'printf "representative NAS custody artifact\\n" > report.txt'],
                   cwd=producer, env={"HOME": str(producer), "TMPDIR": str(producer),
                                      "PATH": os.environ["PATH"]}, check=True, timeout=5)
    payload = (producer / "report.txt").read_bytes()
    require(payload == PAYLOAD, "producer_payload")
    job = str(uuid.uuid4())
    sha = hashlib.sha256(payload).hexdigest()
    prefix = "artifact-a/v1/" + job + "/"
    key = prefix + "objects/" + sha
    created = int(time.time())
    manifest = {"version": 1, "jobId": job, "principal": "a", "createdAt": created,
                "expiresAt": created + AGE,
                "artifacts": [{"path": "report.txt", "sha256": sha, "size": len(payload)}]}
    body = json.dumps(manifest, sort_keys=True).encode()
    manifest_key = prefix + "manifests/" + hashlib.sha256(body).hexdigest() + ".json"
    progress = {"jobId": job, "sha256": sha, "bytes": len(payload),
                "objects": 2, "uploadedObjects": 0,
                "manifestKey": manifest_key, "manifestSHA256": hashlib.sha256(body).hexdigest(),
                "custodyBeforeProducerDeletion": False, "producerDeleted": False,
                "freshClientByUUID": False, "selectedPrincipalDenials": False}

    def record(phase, **updates):
        progress.update(phase=phase, **updates)
        save_progress(dict(progress))

    record("artifact-upload")
    require(writer.request("PUT", key, payload)[0] == 200, "artifact_put")
    record("manifest-upload", uploadedObjects=1)
    require(writer.request("PUT", manifest_key, body)[0] == 200, "manifest_put")
    record("principal-denials", uploadedObjects=2)
    require(writer.request("GET", key)[0] == 403 and
            reader.request("PUT", key, b"denied")[0] == 403 and
            other.request("GET", key)[0] == 403, "principal_denial")
    record("custody-verification", selectedPrincipalDenials=True)
    # Persist verified custody and the UUID before deleting the sole producer.
    require(retrieve(reader, "artifact-a", job) == payload, "custody_before_delete")
    record("producer-deletion", custodyBeforeProducerDeletion=True)
    remove_owned(producer, producer_id, owner(home))
    record("fresh-client-creation", producerDeleted=True)
    fresh = client("reader-a")
    record("fresh-client-retrieval")
    require(retrieve(fresh, "artifact-a", job) == payload, "fresh_client_retrieval")
    record("complete", freshClientByUUID=True)
    return progress


# Bounds apply per stopped tree and per read/copy pass, not to the filesystem.
COPY_ENTRIES = 4096
COPY_ALLOCATED = 512 * 1024 * 1024
COPY_LOGICAL = 2 * 1024**4
COPY_CHUNK = 64 * 1024


def stop_owned(garage):
    process = garage.process
    garage.stop()  # Popen handle only; terminate, wait, kill and wait.
    require(garage.process is None and
            (process is None or process.poll() is not None), "stop_unconfirmed")


def file_stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def sparse_file(source, target, budget):
    try:
        return copy_sparse(source, target, budget, limit=COPY_ALLOCATED)
    except ValueError as error:
        raise Refusal(str(error)) from error


def stopped_tree(path, identity, expected_owner, *, nas, destination=None, created=None):
    """Inspect/copy only this trusted private stopped tree, never follow links."""
    checked_tree(path, identity, expected_owner)
    row = nas_mount(path) if nas else mount_for(path)
    require(nas or row["type"] in LOCAL_TYPES, "local_disk_required")
    entries, logical, allocated, budget = [], 0, 0, [0]
    # Complete inspection precedes creation of a copy.
    for root, dirs, files in os.walk(path, followlinks=False, onerror=unreadable_tree):
        dirs.sort()
        for entry in [Path(root)] + [Path(root) / name for name in sorted(files)]:
            value = entry.lstat()
            require(mount_for(entry) == row, "copy_submount")
            mode = stat.S_IMODE(value.st_mode)
            require(mode & 0o077 == 0 and mode & 0o400, "copy_private_mode")
            logical += value.st_size if stat.S_ISREG(value.st_mode) else 0
            allocated += value.st_blocks * 512
            entries.append((entry, value, mode))
            require(len(entries) <= COPY_ENTRIES and allocated <= COPY_ALLOCATED and
                    logical <= COPY_LOGICAL, "copy_tree_bound")
    if destination is not None:
        no_links(destination)
        require(not destination.exists(), "restore_destination_exists")
        destination.mkdir(mode=0o700)
        assert created is not None
        created(destination)  # Record identity immediately, including partial copies.
    manifest = []
    for entry, value, mode in entries:
        relative = entry.relative_to(path)
        output = destination / relative if destination is not None else None
        record = {"path": str(relative), "mode": mode, "directory": stat.S_ISDIR(value.st_mode)}
        if record["directory"]:
            if output is not None and relative != Path("."):
                output.mkdir(mode=mode)
        else:
            record["size"] = value.st_size
            with entry.open("rb") as source:
                require(file_stamp(os.fstat(source.fileno())) == file_stamp(value), "copy_source_changed")
                if output is None:
                    record["sha256"] = sparse_file(source, None, budget)
                else:
                    with output.open("xb") as target:
                        record["sha256"] = sparse_file(source, target, budget)
                    output.chmod(mode)
                require(file_stamp(entry.lstat()) == file_stamp(value), "copy_source_changed")
        manifest.append(record)
    checked_tree(path, identity, expected_owner)
    if destination is not None:
        for record in reversed(manifest):
            if record["directory"]:
                descriptor = os.open(destination / record["path"], os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    return manifest


def restore_client(garage, module, name):
    key = next(key for key in garage("ListKeys") if key["name"] == name)
    info = garage("GetKeyInfo", {"id": key["id"], "showSecretKey": True})
    return S3(module, "http://127.0.0.1:" + str(garage.s3), key["id"], info["secretAccessKey"])


def stopped_restore(garage, module, binary, local, data, home, local_owner, mapped,
                    report, save, state):
    """Same stopped pair as garage.py, with originals retained and metadata local."""
    proof = report["restore"] = {"stage": "before-stop", "verified": False,
                                "originalsRetained": True}
    backup, restored_home = local / "stopped-backup", local / "restored-home"
    restored_data = data.with_name(data.name + "-restored")
    require(restored_data.parent == MOUNT and restored_data != data, "namespace_required")
    proof.update(backupPath=str(backup), homePath=str(restored_home),
                 dataPath=str(restored_data), jobId=report["custody"]["jobId"])
    def phase(name):
        proof["stage"] = name
        save()
    def remember(path, expected_owner, nas=False):
        identity = fingerprint(path)
        state["roots"].append((path, identity, expected_owner, nas))
        proof.setdefault("roots", []).append({"path": str(path), "identity": list(identity),
                                             "owner": list(expected_owner), "nas": nas,
                                             "observedOwner": list(owner(path)),
                                             "mode": stat.S_IMODE(path.stat().st_mode)})
        save()
        require(nas_mount(path) if nas else mount_for(path) == mount_for(local), "copy_submount")
        require(owner(path) == expected_owner and
                stat.S_IMODE(path.stat().st_mode) == 0o700, "restore_root_owner_mode")
    for path in (backup, restored_home, restored_data):
        no_links(path)
        require(not path.exists(), "restore_destination_exists")
    nas_mount(restored_data)
    require(mount_for(home) == mount_for(local) == mount_for(garage.meta), "copy_submount")
    before = garage("ListBuckets")
    keys = garage("ListKeys")
    phase("stopping-original")
    stop_owned(garage)
    report["processStopped"] = True
    phase("backup")
    backup.mkdir(mode=0o700)
    remember(backup, local_owner)
    pair = {}
    def save_pair(complete=False):
        body = json.dumps({"complete": complete, "jobId": proof["jobId"], "trees": pair},
                          sort_keys=True).encode()
        with (backup / "pair.json").open("wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        proof["pairManifestSHA256"] = hashlib.sha256(body).hexdigest()
        proof["pairComplete"] = complete
        save()
    save_pair()
    for name, source, expected, nas in (
            ("meta", garage.meta, local_owner, False), ("data", data, mapped, True)):
        phase("backup-" + name)
        target = backup / name
        pair[name] = stopped_tree(source, fingerprint(source), expected, nas=nas,
                                 destination=target, created=lambda p: remember(p, local_owner))
        require(stopped_tree(target, fingerprint(target), local_owner, nas=False) == pair[name],
                "backup_pair_mismatch")
        save_pair()
    # The durable node identity and synthetic S3 keys are in meta. Preserve the
    # existing RPC secret too, locally, without introducing a credential protocol.
    secret = garage.secret
    require(owner(secret) == local_owner and secret.lstat().st_nlink == 1 and
            stat.S_ISREG(secret.lstat().st_mode) and
            stat.S_IMODE(secret.stat().st_mode) == 0o600, "rpc_secret_mode")
    no_links(secret)
    require(secret.stat().st_size == 64, "rpc_secret_format")
    rpc = secret.read_bytes()
    require(len(rpc) == 64 and re.fullmatch(b"[0-9a-f]{64}", rpc), "rpc_secret_format")
    with (backup / "rpc.secret").open("xb") as stream:
        stream.write(rpc)
        stream.flush()
        os.fsync(stream.fileno())
    save_pair(complete=True)
    phase("pair-verified")
    # A fresh local HOME/config/log, a fresh NAS DATA child. No source deletion.
    restored_home.mkdir(mode=0o700)
    remember(restored_home, local_owner)
    restored = state["garage"] = Garage(binary, restored_home, data_dir=restored_data)
    restored.secret.write_bytes((backup / "rpc.secret").read_bytes())
    for name, target, expected, nas in (
            ("meta", restored.meta, local_owner, False), ("data", restored_data, mapped, True)):
        phase("restore-" + name)
        require(stopped_tree(backup / name, fingerprint(backup / name), local_owner, nas=False,
                             destination=target,
                             created=lambda p, e=expected, n=nas: remember(p, e, n)) == pair[name],
                "restore_pair_mismatch")
        require(stopped_tree(target, fingerprint(target), expected, nas=nas) == pair[name],
                "restore_pair_mismatch")
    phase("starting-restored")
    restored.start()
    process = restored.process
    if process is None:
        raise Refusal("owned_process_missing")
    proof["pid"] = process.pid
    proof["processStartTicks"] = Path(f"/proc/{process.pid}/stat").read_text().rsplit(
        ")", 1)[1].split()[19]
    phase("restored-custody")
    require(restored("ListBuckets") == before and restored("ListKeys") == keys, "restored_state")
    job = report["custody"]["jobId"]
    reader = restore_client(restored, module, "reader-a")
    require(retrieve(reader, "artifact-a", job) == PAYLOAD, "restored_uuid_bytes")
    key = "artifact-a/v1/" + job + "/objects/" + report["custody"]["sha256"]
    require(restore_client(restored, module, "other-b").request("GET", key)[0] == 403 and
            restore_client(restored, module, "writer-a").request("GET", key)[0] == 403 and
            reader.request("PUT", key, b"denied")[0] == 403, "restored_principal_denial")
    # Compare the exact original content-addressed manifest as well as UUID bytes.
    manifest_prefix = "artifact-a/v1/" + job + "/manifests/"
    require(report["custody"]["manifestKey"].startswith(manifest_prefix), "manifest_binding")
    status, body = reader.request("GET", report["custody"]["manifestKey"])
    require(status == 200 and hashlib.sha256(body).hexdigest() ==
            report["custody"]["manifestSHA256"], "restored_manifest")
    proof.update(verified=True, bucketStateEqual=True, keyStateEqual=True,
                 sameUUIDBytes=True, sameManifest=True, selectedPrincipalDenials=True)
    phase("stopping-restored")
    stop_owned(restored)
    proof["processStopped"] = True
    proof["logs"] = redacted_log(restored_home)
    phase("verified")


def redacted_log(home):
    # No raw log lines or arbitrary exception messages leave private scratch.
    path = home / "garage.log"
    if not path.exists():
        return {"present": False}
    with path.open("rb") as stream:
        data = stream.read(1024 * 1024 + 1)
    return {"present": True, "sampleBytes": min(len(data), 1024 * 1024),
            "truncated": len(data) > 1024 * 1024,
            "errorMarkers": data[:1024 * 1024].count(b"ERROR"),
            "warningMarkers": data[:1024 * 1024].count(b"WARN"),
            "rawLinesOmitted": True}


def deadline(_signum, _frame):
    raise TimeoutError("canary_deadline")


def run(args):
    report = {"passed": False, "proof": "direct-nas-garage-canary",
              "stage": "preflight", "cleanup": "nothing-created",
              "productionEnabled": False, "hardCapProven": False,
              "stableStorageProven": False, "imageDigest": IMAGE,
              "bootstrapCommit": BOOTSTRAP_COMMIT, "bootstrapBlob": BOOTSTRAP_BLOB}
    restore_mode = getattr(args, "stopped_restore", False)
    restore_state = {"garage": None, "roots": []}
    garage, report_path = None, None
    local = data = home = None
    local_id = data_id = home_id = temp_id = image_id = None
    previous = signal.signal(signal.SIGALRM, deadline)
    old_int = signal.signal(signal.SIGTERM, deadline)
    signal.alarm(MAX_SECONDS)
    try:
        local, data, home, temp, local_owner, mapped = preflight(args)
        os.umask(0o077)
        local.mkdir(mode=0o700)  # Exclusive creation, no exist_ok.
        local_id = fingerprint(local)
        report_path = local / "report.json"
        report["cleanup"] = "preserve-on-failure"
        report["localIdentity"] = list(local_id)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        report.update(localRun=str(local), nasRun=str(data),
                      processIdentity=list(local_owner), expectedDataOwner=list(mapped),
                      metadataPath=str(home / "meta"), localMount=mount_for(local.parent),
                      bounds={"payloadBytes": len(PAYLOAD), "custodyObjects": 2,
                              "deadlineSeconds": MAX_SECONDS})
        report["stage"] = "nas-preflight"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        report["mount"] = nas_mount(data)
        require(not data.exists(), "namespace_collision")
        require(os.access(MOUNT, os.W_OK | os.X_OK), "nas_permission")
        report["stage"] = "scratch-setup"
        home.mkdir(parents=True, mode=0o700)
        home_id = fingerprint(home)
        image_id = fingerprint(home.parent)
        report["imageRootIdentity"] = list(image_id)
        report["privateHomeIdentity"] = list(home_id)
        temp.mkdir(mode=0o700)
        temp_id = fingerprint(temp)
        report["tempIdentity"] = list(temp_id)
        require(owner(home) == local_owner and owner(temp) == local_owner, "scratch_owner")
        for name in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
                     "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"):
            os.environ.pop(name, None)
        # No ambient HTTP proxy gets a loopback request or synthetic credentials.
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        nas_mount(data)
        data.mkdir(mode=0o700)
        data_id = fingerprint(data)
        report["dataIdentity"] = list(data_id)
        report["observedDataOwner"] = list(owner(data))
        require(owner(data) == mapped and stat.S_IMODE(data.stat().st_mode) == 0o700,
                "data_ownership_mapping")
        require(os.access(data, os.R_OK | os.W_OK | os.X_OK), "mapped_data_permission")
        # NEW namespace only; no chown/chmod of the mounted shared root.
        probe = data / "permission-probe"
        with probe.open("xb") as stream:
            stream.write(b"canary")
            stream.flush()
            os.fsync(stream.fileno())
        require(owner(probe) == mapped and probe.read_bytes() == b"canary",
                "file_ownership_mapping")
        probe.unlink()
        report["stage"] = "pinned-executable"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        # The existing verifier asserts this cwd/HOME and verifies every digest.
        os.chdir(local)
        binary, image = prepare_binary()
        report["image"] = image
        garage = Garage(binary, home, data_dir=data)
        report["stage"] = "garage-start"
        garage.start()
        process = garage.process
        if process is None:
            raise Refusal("owned_process_missing")
        report["pid"] = process.pid
        report["processStartTicks"] = Path(f"/proc/{process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        report["stage"] = "custody"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        def save_custody(progress):
            report["custody"] = progress
            require(fingerprint(local) == local_id, "local_namespace_changed")
            report_path.write_text(json.dumps(report, indent=2) + "\n")

        module = bootstrap(home)
        custody(garage, module, home, save_custody)
        if restore_mode:
            report["stage"] = "stopped-restore"
            def save_restore():
                require(fingerprint(local) == local_id and fingerprint(home) == home_id and
                        fingerprint(data) == data_id, "namespace_changed")
                report_path.write_text(json.dumps(report, indent=2) + "\n")
            stopped_restore(garage, module, binary, local, data, home, local_owner, mapped,
                            report, save_restore, restore_state)
        report["stage"] = "stopping"
        garage.stop()
        report["processStopped"] = True
        report["logs"] = redacted_log(home)
        report["stage"] = "cleanup"
        require(fingerprint(home) == home_id, "namespace_changed")
        if restore_mode:
            require(report["restore"]["verified"], "restored_custody_required")
            # Inspect every cleanup root before deleting any original or copy.
            for path, identity, expected, nas in restore_state["roots"]:
                if nas:
                    nas_mount(path)
                checked_tree(path, identity, expected)
            checked_tree(data, data_id, mapped)
            checked_tree(home, home_id, local_owner)
            checked_tree(temp, temp_id, local_owner)
            require(fingerprint(home.parent) == image_id, "namespace_changed")
            report["restore"]["cleanup"] = "removing-verified-trees"
            report_path.write_text(json.dumps(report, indent=2) + "\n")
        nas_mount(data)
        remove_owned(data, data_id, mapped)
        report["nasRemoved"] = True
        if restore_mode:
            report["restore"]["originalsRetained"] = False
            report_path.write_text(json.dumps(report, indent=2) + "\n")
        remove_owned(home, home_id, local_owner)
        if restore_mode:
            # Child roots were fingerprinted too. Remove parent trees only once.
            roots = restore_state["roots"]
            for path, identity, expected, nas in roots:
                if any(other in path.parents for other, *_ in roots):
                    continue
                if nas:
                    nas_mount(path)
                remove_owned(path, identity, expected)
            report["restore"]["cleanup"] = "owned-restore-and-backup-removed"
            report["restore"]["originalsRetained"] = False
        require(fingerprint(temp) == temp_id and fingerprint(home.parent) == image_id,
                "namespace_changed")
        temp.rmdir()
        home.parent.rmdir()
        report["cleanup"] = "owned-data-and-private-scratch-removed-report-retained"
        report["stage"] = "complete"
        report["passed"] = True
    except BaseException as error:
        # Class only: command output, URLs, config and exception text may hold keys.
        report["failureClass"] = type(error).__name__
        if isinstance(error, Refusal):
            report["refusal"] = str(error)
    finally:
        signal.alarm(45 if restore_mode else 30)
        # Each exact handle gets its own stop attempt even if the other fails.
        restored = restore_state["garage"]
        if restored is not None:
            try:
                if restored.process is not None:
                    report["restore"]["pid"] = restored.process.pid
                    try:
                        report["restore"]["processStartTicks"] = Path(
                            f"/proc/{restored.process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
                    except OSError:
                        report["restore"]["processStartTicksUnavailable"] = True
                stop_owned(restored)
                report["restore"]["processStopped"] = True
            except BaseException as error:
                report["passed"] = False
                report["restore"]["processStopped"] = False
                report["restore"]["stopFailureClass"] = type(error).__name__
        try:
            if garage is not None:
                if garage.process is not None:
                    report["pid"] = garage.process.pid
                    try:
                        report["processStartTicks"] = Path(f"/proc/{garage.process.pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
                    except OSError:
                        report["processStartTicksUnavailable"] = True
                if restore_mode:
                    stop_owned(garage)
                else:
                    garage.stop()
                report["processStopped"] = True
            if home is not None and home.exists():
                report["logs"] = redacted_log(home)
        except BaseException as error:
            report["passed"] = False
            report["processStopped"] = False
            report["stopFailureClass"] = type(error).__name__
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
            signal.signal(signal.SIGTERM, old_int)
        if report_path is not None:
            try:
                require(fingerprint(local) == local_id, "local_namespace_changed")
                report_path.write_text(json.dumps(report, indent=2) + "\n")
            except BaseException:
                report["passed"] = False
                report["reportWriteFailed"] = True
        print(json.dumps(report, sort_keys=True))
    return 0 if report["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-disposable-nas-canary", action="store_true", required=True)
    parser.add_argument("--stopped-restore", action="store_true",
                        help="also prove stopped local-metadata/NAS-data restore into fresh paths")
    parser.add_argument("--local-run", required=True)
    parser.add_argument("--nas-run", required=True)
    parser.add_argument("--expected-data-owner", required=True, help="explicit observed UID:GID, e.g. 977:988")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
