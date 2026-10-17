"""Private recovery data outside the guest mounts; no argv, environment or snapshot."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time

PROTOCOL = json.loads(Path(__file__).with_name("exec-protocol.json").read_text())
LIMITS = PROTOCOL["limits"]
LOG_CAP = LIMITS["maxOutput"]
ARTIFACT_CAP = LIMITS["maxArtifact"]
RESERVE = LOG_CAP + ARTIFACT_CAP + 256 * 1024
JOB_ID = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def job_id(value):
    if not isinstance(value, str) or not JOB_ID.fullmatch(value):
        raise ValueError("invalid job id")
    return value


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise ValueError("recovery directory must be a directory, not a symlink")
    path.chmod(0o700)


def open_private(path, flags):
    return os.fdopen(os.open(path, flags | os.O_NOFOLLOW, 0o600), "w+b")


@contextmanager
def store_lock(root):
    private_dir(root / ".retained")
    with open_private(root / ".retention.lock", os.O_RDWR | os.O_CREAT) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield root / ".retained"


def write_metadata(path, value):
    with open_private(path / "metadata.new", os.O_RDWR | os.O_CREAT | os.O_TRUNC) as out:
        out.write(json.dumps(value, separators=(",", ":")).encode())
        out.flush()
        os.fsync(out.fileno())
    os.replace(path / "metadata.new", path / "metadata.json")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prune_locked(store, config, now, incoming=0):
    cap = min(int(config.get("retention_cap_bytes", LIMITS["maxRetainedBytes"])),
              LIMITS["maxRetainedBytes"])
    rows = []
    for path in store.iterdir():
        if not JOB_ID.fullmatch(path.name) or not stat.S_ISDIR(path.lstat().st_mode):
            raise ValueError("invalid recovery store entry")
        lock = open_private(path / "lock", os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            rows.append((path, None, now, RESERVE))
            continue
        try:
            meta = json.loads((path / "metadata.json").read_text())
            when = meta.get("ended", meta["started"])
        except (OSError, ValueError, KeyError):
            when = path.stat().st_mtime
        size = sum(p.lstat().st_size for p in path.iterdir())
        if when < now - LIMITS["retentionSeconds"]:
            shutil.rmtree(path)
            lock.close()
        else:
            rows.append((path, lock, when, size))
    try:
        total = sum(row[3] for row in rows)
        count = len(rows)
        for path, lock, _when, size in sorted(rows, key=lambda row: row[2]):
            if total + incoming <= cap and count + bool(incoming) <= 1000:
                break
            if lock is None:
                continue
            shutil.rmtree(path)
            total -= size
            count -= 1
        if total + incoming > cap or count + bool(incoming) > 1000:
            raise ValueError("recovery store full; active recovery data protected")
    finally:
        for _path, lock, _when, _size in rows:
            if lock:
                lock.close()


def prune(root, config, now=None):
    if not (root / ".retained").exists():
        return
    with store_lock(root) as store:
        prune_locked(store, config, time.time() if now is None else now)


class RetainedJob:
    def __init__(self, root, request, config, now=None):
        self.request = request
        self.meta = {"version": PROTOCOL["fetchVersion"], "jobId": job_id(request["jobId"]),
                     "started": time.time() if now is None else now, "outcome": "uncertain",
                     "exitCode": None, "artifacts": [], "artifactErrors": [], "logTruncated": False}
        self.bytes = 0
        with store_lock(root) as store:
            prune_locked(store, config, self.meta["started"], RESERVE)
            self.path = store / request["jobId"]
            self.path.mkdir(mode=0o700)
            self.lock = open_private(self.path / "lock", os.O_RDWR | os.O_CREAT | os.O_EXCL)
            fcntl.flock(self.lock, fcntl.LOCK_EX)
            self.log = open_private(self.path / "output.log", os.O_RDWR | os.O_CREAT | os.O_EXCL)
            write_metadata(self.path, self.meta)

    def output(self, kind, data):
        # Only job output enters this log, never host diagnostics or protocol input.
        if kind not in ("O", "S"):
            return
        value = (b"\n[stdout]\n" if kind == "O" else b"\n[stderr]\n") + data
        remaining = max(0, LOG_CAP - self.bytes)
        self.log.write(value[:remaining])
        self.log.flush()
        self.bytes += min(len(value), remaining)
        self.meta["logTruncated"] |= len(value) > remaining

    def finish(self, workspace, artifact_file, outcome, code=None, now=None):
        self.meta.update(outcome=outcome, exitCode=code, ended=time.time() if now is None else now)
        total = 0
        for index, name in enumerate(self.request["artifacts"]):
            target = self.path / ("artifact-" + str(index))
            try:
                with artifact_file(workspace, name) as source:
                    size = os.fstat(source.fileno()).st_size
                    if total + size > ARTIFACT_CAP:
                        self.meta["artifactErrors"].append({"path": name, "reason": "aggregate cap"})
                        continue
                    with open_private(target, os.O_RDWR | os.O_CREAT | os.O_EXCL) as out:
                        remaining = size
                        while remaining:
                            data = source.read(min(remaining, LIMITS["chunk"]))
                            if not data:
                                raise ValueError("artifact changed")
                            out.write(data)
                            remaining -= len(data)
                        out.flush()
                        os.fsync(out.fileno())
                    total += size
                    self.meta["artifacts"].append({"path": name, "size": size, "index": index})
            except (OSError, ValueError):
                target.unlink(missing_ok=True)
                self.meta["artifactErrors"].append({"path": name, "reason": "unavailable regular file"})
        self.log.flush()
        os.fsync(self.log.fileno())
        write_metadata(self.path, self.meta)

    def close(self, keep):
        self.log.close()
        with store_lock(self.path.parent.parent):
            if not keep:
                shutil.rmtree(self.path)
            self.lock.close()


@contextmanager
def fetch(root, request, config):
    if (not isinstance(request, dict) or request.get("version") != PROTOCOL["fetchVersion"]):
        raise ValueError("unsupported exec fetch protocol")
    name = job_id(request.get("jobId"))
    prune(root, config)
    with store_lock(root) as store:
        path = store / name
        if not path.exists():
            raise ValueError("job recovery not found or expired (three-day retention)")
        lock = open_private(path / "lock", os.O_RDWR)
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise ValueError("job recovery is still being finalized; fetch later") from None
    try:
        meta = json.loads((path / "metadata.json").read_text())
        if "ended" not in meta:
            raise ValueError("job recovery incomplete after host interruption")
        yield path, meta
    finally:
        lock.close()
