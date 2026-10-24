#!/usr/bin/env python3
"""Finite stopped-pair copier. Caller MUST hold the exact service stopped.
Sparse hashing/copy is reused from the accepted NAS stopped-restore helper.
No rotation or deletion: previous and partial pairs remain operator-owned.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

COPY_ENTRIES = 4096
COPY_ALLOCATED = 512 * 1024 * 1024
COPY_LOGICAL = 2 * 1024**4
COPY_CHUNK = 64 * 1024


def require(value, reason):
    if not value:
        raise ValueError(reason)


def sparse_file(source, target, budget, *, limit=None, deadline=None):
    """Hash fixed nonzero chunks and logical size, retaining holes on disk."""
    limit = COPY_ALLOCATED if limit is None else limit
    size = os.fstat(source.fileno()).st_size
    digest = hashlib.sha256(str(size).encode() + b"\0")
    offset = 0
    while offset < size:
        try:
            start = os.lseek(source.fileno(), offset, os.SEEK_DATA)
            end = os.lseek(source.fileno(), start, os.SEEK_HOLE)
        except OSError as error:
            if error.errno == errno.ENXIO:
                break
            require(error.errno in (errno.EINVAL, errno.ENOTSUP), "sparse_seek_failed")
            # Unsupported sparse seek is safe only within the remaining read bound.
            require(size - offset <= limit - budget[0], "sparse_seek_required")
            start, end = offset, size
        require(offset <= start < end <= size, "sparse_extent")
        position = start // COPY_CHUNK * COPY_CHUNK
        while position < end:
            amount = min(COPY_CHUNK, size - position)
            budget[0] += amount
            require(budget[0] <= limit, "copy_read_bound")
            require(deadline is None or time.monotonic() < deadline, "elapsed")
            source.seek(position)
            block = source.read(amount)
            require(len(block) == amount, "copy_short_read")
            if any(block):
                digest.update(position.to_bytes(8, "big"))
                digest.update(hashlib.sha256(block).digest())
                if target is not None:
                    target.seek(position)
                    target.write(block)
            position += amount
        offset = position
    if target is not None:
        target.truncate(size)
        target.flush()
        os.fsync(target.fileno())
    return digest.hexdigest()



def inventory(path, expected_owner, deadline):
    root = path.lstat()
    require(stat.S_ISDIR(root.st_mode), "directory required")
    # Refuse nested mounts, including same-device bind mounts.
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        raw = line.split(" - ")[0].split()[4]
        mount = Path(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), raw))
        require(path not in mount.parents, "nested mount")
    entries, allocated, logical = [], 0, 0
    for base, dirs, files in os.walk(path, followlinks=False, onerror=lambda _: require(False, "unreadable")):
        dirs.sort()
        for entry in [Path(base)] + [Path(base) / name for name in sorted(files)]:
            require(time.monotonic() < deadline, "elapsed")
            value = entry.lstat()
            require(value.st_dev == root.st_dev and
                    (value.st_uid, value.st_gid) == tuple(expected_owner) and
                    not value.st_mode & 0o077 and
                    (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode) and value.st_nlink == 1),
                    "unsafe entry")
            allocated += value.st_blocks * 512
            logical += value.st_size if stat.S_ISREG(value.st_mode) else 0
            entries.append((entry, value))
            require(len(entries) <= COPY_ENTRIES and allocated <= COPY_ALLOCATED
                    and logical <= COPY_LOGICAL, "tree limit")
        # Inspect directory leaves before os.walk can descend through links or submounts.
        for name in dirs:
            value = (Path(base) / name).lstat()
            require(stat.S_ISDIR(value.st_mode) and value.st_dev == root.st_dev, "submount or link")
    return entries


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def tree(path, rows, destination, deadline):
    result, budget = [], [0]
    if destination is not None:
        destination.mkdir(mode=0o700)
    for entry, value in rows:
        require(time.monotonic() < deadline and stamp(entry.lstat()) == stamp(value), "changed or elapsed")
        relative = entry.relative_to(path)
        output = None if destination is None else destination / relative
        row = {"path": str(relative), "mode": stat.S_IMODE(value.st_mode),
               "directory": stat.S_ISDIR(value.st_mode)}
        if row["directory"]:
            if output is not None and relative != Path("."):
                output.mkdir(mode=row["mode"])
        else:
            row["size"] = value.st_size
            descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as source:
                require(stamp(os.fstat(source.fileno())) == stamp(value), "source changed")
                if output is None:
                    row["sha256"] = sparse_file(source, None, budget, deadline=deadline)
                else:
                    with output.open("xb") as target:
                        row["sha256"] = sparse_file(source, target, budget, deadline=deadline)
                    output.chmod(row["mode"])
                require(stamp(entry.lstat()) == stamp(value), "source changed")
        result.append(row)
    if destination is not None:
        for row in reversed(result):
            if row["directory"]:
                descriptor = os.open(destination / row["path"], os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    return result


def verify(target):
    deadline = time.monotonic() + 120
    fd = os.open(target / "pair.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        value = os.fstat(stream.fileno())
        require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1
                and value.st_size <= 2 * 1024**2, "manifest bound")
        raw = stream.read(2 * 1024**2 + 1)
    require(len(raw) <= 2 * 1024**2, "manifest bound")
    pair = json.loads(raw)
    for name in ("meta", "data"):
        path = target / name
        actual = tree(path, inventory(path, (os.geteuid(), os.getegid()), deadline), None, deadline)
        require(actual == pair["trees"][name], "pair changed")
    return hashlib.sha256(raw).hexdigest()


def backup(config):
    deadline = time.monotonic() + 120
    paths = [Path(config[name]) for name in ("meta", "data", "backup")]
    for path in paths:
        require(path.is_absolute() and ".." not in path.parts, "canonical path")
        for part in (*reversed(path.parents), path):
            require(not part.is_symlink(), "symlink")
    meta, data, target = paths
    require(not any(a == b or a in b.parents or b in a.parents
                    for a, b in ((meta, data), (meta, target), (data, target))), "overlap")
    require(not target.exists(), "destination exists")
    # Mount identity comes from the every-start preflight. Backups must remain local.
    rows = Path("/proc/self/mountinfo").read_text().splitlines()
    mounts = [(Path(line.split(" - ")[0].split()[4]), line.split(" - ")[1].split()[0]) for line in rows]
    def filesystem(path):
        return max((row for row in mounts if row[0] == path or row[0] in path.parents),
                   key=lambda row: len(row[0].parts))[1]
    require(filesystem(target.parent) in ("ext4", "xfs", "btrfs"), "local backup required")
    parent = target.parent.lstat()
    require(parent.st_uid == os.geteuid() and not parent.st_mode & 0o077, "private backup parent")
    sources = [(meta, config["metadataOwner"]), (data, config["dataOwner"])]
    inventories = [inventory(path, owner, deadline) for path, owner in sources]
    # Reserve worst-case bounded copy, directory overhead, and configured shared free space.
    available = os.statvfs(target.parent)
    require(available.f_bavail * available.f_frsize >= 2 * COPY_ALLOCATED + config["minFreeBytes"]
            and available.f_favail >= 2 * COPY_ENTRIES + config["minFreeInodes"], "headroom")
    target.mkdir(mode=0o700)
    manifests = {}
    for name, (path, owner), before in zip(("meta", "data"), sources, inventories):
        manifests[name] = tree(path, before, target / name, deadline)
        require([stamp(s) for _, s in inventory(path, owner, deadline)] ==
                [stamp(s) for _, s in before], "inventory changed")
        copied = target / name
        actual = tree(copied, inventory(copied, (os.geteuid(), os.getegid()), deadline), None, deadline)
        require(actual == manifests[name], "backup mismatch")
    raw = json.dumps({"version": 1, "trees": manifests}, sort_keys=True).encode()
    require(len(raw) <= 2 * 1024**2, "manifest bound")
    with (target / "pair.json").open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return hashlib.sha256(raw).hexdigest()


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(65537)
        require(len(raw) <= 65536, "input bound")
        config = json.loads(raw)
        print(json.dumps({"pairSHA256": verify(Path(config["verify"])) if "verify" in config else backup(config)}))
    except Exception:
        print("stopped pair refused; preserve originals and partial destination", file=sys.stderr)
        sys.exit(2)
