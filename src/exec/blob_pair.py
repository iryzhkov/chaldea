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

# Legacy fixture bounds. Omitted limits keep exactly these per-tree values.
COPY_ENTRIES = 4096
COPY_ALLOCATED = 512 * 1024 * 1024
COPY_LOGICAL = 2 * 1024**4
COPY_ELAPSED_MS = 120000
COPY_CHUNK = 64 * 1024
# Finite global maxima for protected configured limits. Capacity is checked separately.
TREE_MAXIMA = {"maxEntries": 262144, "maxAllocatedBytes": 256 * 1024**3,
               "maxReadBytes": 256 * 1024**3, "maxLogicalBytes": 2 * 1024**4}
MAX_ELAPSED_MS = 6 * 3600 * 1000
# Conservative ext4 destination model (4 KiB-class blocks, no bigalloc). Every copied entry
# is charged a directory/inode allowance; every file its block-rounded read spans plus a
# worst-case extent tree. Sidecars are the private files the operator writes afterwards.
ENTRY_OVERHEAD = 8192
EXTENT_HEADER = 12
EXTENT_ENTRY = 12
INODE_EXTENTS = 4
SIDECAR_BYTES = 2 * 1024**2
SIDECAR_INODES = 64
MANIFEST_ROW = 512
MOUNTINFO = "/proc/self/mountinfo"
INPUT_KEYS = {"meta", "data", "backup", "metadataOwner", "dataOwner", "minFreeBytes", "minFreeInodes"}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def ceil_div(value, unit):
    return -(-value // unit)


def canonical(value):
    return json.dumps(value, sort_keys=True).encode()


def legacy_limits() -> dict:
    tree = {"maxEntries": COPY_ENTRIES, "maxAllocatedBytes": COPY_ALLOCATED,
            "maxReadBytes": COPY_ALLOCATED, "maxLogicalBytes": COPY_LOGICAL}
    return {"maxElapsedMs": COPY_ELAPSED_MS, "meta": dict(tree), "data": dict(tree)}


def bounded(value, maximum, minimum=1):
    # type() excludes bool; JSON floats, NaN and infinity are never int.
    return type(value) is int and minimum <= value <= maximum


def checked_limits(value: "dict | None") -> dict:
    """Validate protected per-tree limits. Omitted limits keep the legacy fixture bounds."""
    if value is None:
        return legacy_limits()
    require(type(value) is dict and set(value) == {"maxElapsedMs", "meta", "data"}, "limits")
    require(bounded(value["maxElapsedMs"], MAX_ELAPSED_MS), "limits")
    for name in ("meta", "data"):
        tree = value[name]
        require(type(tree) is dict and set(tree) == set(TREE_MAXIMA), "limits")
        require(all(bounded(tree[key], maximum) for key, maximum in TREE_MAXIMA.items()), "limits")
    return value


def manifest_limit(limits):
    return 4096 + MANIFEST_ROW * (limits["meta"]["maxEntries"] + limits["data"]["maxEntries"])


def copy_limits(tree):
    """Inventory bounds for our own copy. Chunk-granular writes may allocate more than
    the source, never more than twice the bound read bytes plus one chunk per entry."""
    return {**tree, "maxAllocatedBytes": 2 * tree["maxReadBytes"] + tree["maxEntries"] * COPY_CHUNK}


def spans(descriptor, size, remaining):
    """Yield the chunk-aligned ranges the copy reads, using seeks only and no data reads."""
    offset = 0
    while offset < size:
        try:
            start = os.lseek(descriptor, offset, os.SEEK_DATA)
            end = os.lseek(descriptor, start, os.SEEK_HOLE)
        except OSError as error:
            if error.errno == errno.ENXIO:
                return
            require(error.errno in (errno.EINVAL, errno.ENOTSUP), "sparse_seek_failed")
            # Unsupported sparse seek is safe only within the remaining read bound.
            require(size - offset <= remaining(), "sparse_seek_required")
            start, end = offset, size
        require(offset <= start < end <= size, "sparse_extent")
        stop = min(size, ceil_div(end, COPY_CHUNK) * COPY_CHUNK)
        yield start // COPY_CHUNK * COPY_CHUNK, stop
        offset = stop


def sparse_file(source, target, budget, *, limit=None, deadline=None):
    """Hash fixed nonzero chunks and logical size, retaining holes on disk."""
    limit = COPY_ALLOCATED if limit is None else limit
    descriptor = source.fileno()
    size = os.fstat(descriptor).st_size
    digest = hashlib.sha256(str(size).encode() + b"\0")
    for position, stop in spans(descriptor, size, lambda: limit - budget[0]):
        while position < stop:
            amount = min(COPY_CHUNK, stop - position)
            budget[0] += amount
            require(budget[0] <= limit, "copy_read_bound")
            require(deadline is None or time.monotonic() < deadline, "elapsed")
            # Positional reads never depend on the file offset moved by the sparse seeks.
            block = b""
            while len(block) < amount:
                part = os.pread(descriptor, amount - len(block), position + len(block))
                require(part, "copy_short_read")
                block += part
            if any(block):
                digest.update(position.to_bytes(8, "big"))
                digest.update(hashlib.sha256(block).digest())
                if target is not None:
                    target.seek(position)
                    target.write(block)
            position += amount
    if target is not None:
        target.truncate(size)
        target.flush()
        os.fsync(target.fileno())
    return digest.hexdigest()


def mount_records():
    with open(MOUNTINFO, "rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, "mount inventory bound")
    records = []
    # Only newline separates records; the kernel escapes newline but not carriage return.
    for line in raw.split(b"\n"):
        if not line:
            continue
        left, right = line.split(b" - ", 1)
        # The kernel escapes space, tab, newline and backslash as ONE backslash plus octal.
        # Fields are separated by single spaces; any other whitespace belongs to a field.
        target = re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m[1], 8)]), left.split(b" ")[4])
        records.append((Path(os.fsdecode(target)), right.split(b" ")[0].decode()))
    return records


def inventory(path, expected_owner, deadline, limits=None):
    limits = legacy_limits()["meta"] if limits is None else limits
    root = path.lstat()
    require(stat.S_ISDIR(root.st_mode), "directory required")
    # Include same-device bind mounts in the refusal, not only different devices.
    for mount, _kind in mount_records():
        require(path not in mount.parents, "nested mount")
    entries, pending, allocated, logical = [], [path], 0, 0

    def admit(entry, value):
        nonlocal allocated, logical
        require(time.monotonic() < deadline and len(entries) < limits["maxEntries"], "entry or elapsed bound")
        require(value.st_dev == root.st_dev and
                (value.st_uid, value.st_gid) == tuple(expected_owner) and
                not value.st_mode & 0o077 and
                (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode) and value.st_nlink == 1),
                "unsafe entry")
        allocated += value.st_blocks * 512
        logical += value.st_size if stat.S_ISREG(value.st_mode) else 0
        require(allocated <= limits["maxAllocatedBytes"] and logical <= limits["maxLogicalBytes"], "tree limit")
        entries.append((entry, value))

    admit(path, root)
    while pending:
        directory = pending.pop()
        # scandir yields one entry at a time; never materialize an unbounded directory.
        with os.scandir(directory) as stream:
            for item in stream:
                require(time.monotonic() < deadline and len(entries) < limits["maxEntries"], "entry or elapsed bound")
                entry, value = Path(item.path), item.stat(follow_symlinks=False)
                admit(entry, value)
                if stat.S_ISDIR(value.st_mode):
                    pending.append(entry)
    # The complete inventory is now bounded; parents sort before their children.
    return sorted(entries, key=lambda row: str(row[0]))


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def extent_blocks(extents, unit):
    """Worst-case ext4 extent-tree blocks (leaves and every index level) for one file whose
    data may fragment into one extent per filesystem block. The copy writes each file once in
    ascending order, so ext4 appends and fills every node but the last; charging nodes as
    only half full doubles that. The inode itself holds the first four entries."""
    per_node = (unit - EXTENT_HEADER) // EXTENT_ENTRY // 2
    total, level = 0, extents
    while level > INODE_EXTENTS:
        level = ceil_div(level, per_node)
        total += level
    return total


def measure(rows, limits, deadline, unit):
    """Return the exact bytes the copy will read and conservative ext4 destination bytes
    for this inventory, from sparse seeks alone. Nothing is read or created."""
    read, required = 0, 0
    for entry, value in rows:
        required += ENTRY_OVERHEAD
        if not stat.S_ISREG(value.st_mode):
            continue
        descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        blocks = 0
        try:
            require(stamp(os.fstat(descriptor)) == stamp(value), "source changed")
            for start, stop in spans(descriptor, value.st_size, lambda: limits["maxReadBytes"] - read):
                require(time.monotonic() < deadline, "elapsed")
                read += stop - start
                require(read <= limits["maxReadBytes"], "copy_read_bound")
                # Only read chunks are written; their zero chunks and all holes stay holes.
                blocks += ceil_div(stop - start, unit)
        finally:
            os.close(descriptor)
        required += (blocks + extent_blocks(blocks, unit)) * unit
    return read, required


def requirement(inventories, measured, limits, unit):
    """Destination bytes and inodes for both trees, the manifest and operator sidecars."""
    entries = sum(len(rows) for rows in inventories)
    manifest = ceil_div(manifest_limit(limits), unit) * unit
    return (sum(required for _read, required in measured) + manifest + SIDECAR_BYTES,
            entries + SIDECAR_INODES)


def tree(path, rows, destination, deadline, read_limit=None):
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
                    row["sha256"] = sparse_file(source, None, budget, limit=read_limit, deadline=deadline)
                else:
                    with output.open("xb") as target:
                        row["sha256"] = sparse_file(source, target, budget, limit=read_limit, deadline=deadline)
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


def checked_path(value):
    require(type(value) is str, "canonical path")
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and str(path) == value, "canonical path")
    for part in (*reversed(path.parents), path):
        require(not part.is_symlink(), "symlink")
    return path


def verify(target, limits):
    """Rehash a stored pair under its exact recorded limits. Changed limits refuse."""
    deadline = time.monotonic() + limits["maxElapsedMs"] / 1000
    cap = manifest_limit(limits)
    fd = os.open(target / "pair.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        value = os.fstat(stream.fileno())
        require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_size <= cap, "manifest bound")
        raw = stream.read(cap + 1)
    require(len(raw) <= cap, "manifest bound")
    pair = json.loads(raw)
    require(type(pair) is dict and canonical(pair.get("limits")) == canonical(limits), "pair limits")
    trees = {}
    for name in ("meta", "data"):
        path = target / name
        rows = inventory(path, (os.geteuid(), os.getegid()), deadline, copy_limits(limits[name]))
        trees[name] = tree(path, rows, None, deadline, limits[name]["maxReadBytes"])
    # Only the exact canonical bytes this helper writes are accepted; nothing is trusted.
    require(raw == canonical({"version": 2, "limits": limits, "trees": trees}), "pair changed")
    return hashlib.sha256(raw).hexdigest()


def backup(config):
    require(set(config) in (INPUT_KEYS, INPUT_KEYS | {"limits"}), "input")
    limits = checked_limits(config.get("limits"))
    deadline = time.monotonic() + limits["maxElapsedMs"] / 1000
    for key in ("minFreeBytes", "minFreeInodes"):
        require(bounded(config[key], 2**62, 0), "reserve")
    owners = []
    for key in ("metadataOwner", "dataOwner"):
        value = config[key]
        require(type(value) is list and len(value) == 2 and all(bounded(v, 2**32 - 2, 0) for v in value), "owner")
        owners.append(tuple(value))
    meta, data, target = paths = [checked_path(config[name]) for name in ("meta", "data", "backup")]
    require(not any(a == b or a in b.parents or b in a.parents
                    for a, b in ((meta, data), (meta, target), (data, target))), "overlap")
    require(not target.exists(), "destination exists")
    # Mount identity comes from the every-start preflight. Backups must remain local.
    mounts = mount_records()
    def filesystem(path):
        return max((row for row in mounts if row[0] == path or row[0] in path.parents),
                   key=lambda row: len(row[0].parts))[1]
    # The destination capacity model below is derived for ext4 only.
    require(filesystem(target.parent) == "ext4", "local ext4 backup required")
    parent = target.parent.lstat()
    require(parent.st_dev == meta.lstat().st_dev, "backup must share local metadata filesystem")
    require(parent.st_uid == os.geteuid() and not parent.st_mode & 0o077, "private backup parent")
    sources = [(meta, owners[0], limits["meta"]), (data, owners[1], limits["data"])]
    inventories = [inventory(path, owner, deadline, bound) for path, owner, bound in sources]
    unit = os.statvfs(target.parent).f_frsize
    require(type(unit) is int and 512 <= unit <= COPY_CHUNK and COPY_CHUNK % unit == 0, "block size")
    measured = [measure(rows, bound, deadline, unit) for rows, (_p, _o, bound) in zip(inventories, sources)]
    required_bytes, required_inodes = requirement(inventories, measured, limits, unit)
    # Point-in-time admission against CURRENT space. Older pairs already consume it and
    # are never deleted to pass; shared consumers may still fill the disk afterwards.
    available = os.statvfs(target.parent)
    require(available.f_frsize == unit and
            available.f_bavail * unit >= required_bytes + config["minFreeBytes"] and
            available.f_favail >= required_inodes + config["minFreeInodes"], "headroom")
    target.mkdir(mode=0o700)
    manifests = {}
    for name, (path, owner, bound), before, (read, required) in zip(("meta", "data"), sources, inventories, measured):
        # The copy may read no more than measured; a changed extent map refuses.
        manifests[name] = tree(path, before, target / name, deadline, read)
        require([stamp(s) for _, s in inventory(path, owner, deadline, bound)] ==
                [stamp(s) for _, s in before], "inventory changed")
        copied = target / name
        rows = inventory(copied, (os.geteuid(), os.getegid()), deadline, copy_limits(bound))
        require(sum(value.st_blocks * 512 for _, value in rows) <= required, "capacity estimate exceeded")
        actual = tree(copied, rows, None, deadline, read)
        require(canonical(actual) == canonical(manifests[name]), "backup mismatch")
    raw = canonical({"version": 2, "limits": limits, "trees": manifests})
    require(len(raw) <= manifest_limit(limits), "manifest bound")
    with (target / "pair.json").open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    for directory in (target, target.parent):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return hashlib.sha256(raw).hexdigest()


def main(raw):
    require(len(raw) <= 65536, "input bound")
    config = json.loads(raw)
    require(type(config) is dict, "input")
    if "verify" not in config:
        return backup(config)
    require(set(config) <= {"verify", "limits"}, "input")
    return verify(checked_path(config["verify"]), checked_limits(config.get("limits")))


if __name__ == "__main__":
    try:
        print(json.dumps({"pairSHA256": main(sys.stdin.buffer.read(65537))}))
    except Exception:
        print("stopped pair refused; preserve originals and partial destination", file=sys.stderr)
        sys.exit(2)
