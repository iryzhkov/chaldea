"""Local bounded copy contracts. No NAS, real keys, or system services."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("pair", Path(__file__).resolve().parents[2] / "src/exec/blob_pair.py")
assert SPEC is not None and SPEC.loader is not None
pair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pair)
DOCS = Path(__file__).resolve().parents[2] / "docs/blob-maintenance.md"


def proposal():
    """The documented first-operation proposal, so docs and contracts cannot drift."""
    block = DOCS.read_text().split("```json\n", 1)[1].split("\n```", 1)[0]
    return json.loads(block)["backupLimits"]


def scratch(case):
    home = Path(os.environ["HOME"])
    assert home == Path(os.environ["BLOB_TEST_HOME"])
    assert home.is_relative_to(Path(os.environ["TMPDIR"]))
    tmp = tempfile.TemporaryDirectory(dir=home)
    case.addCleanup(tmp.cleanup)
    return Path(tmp.name)


class PairTests(unittest.TestCase):
    def setUp(self):
        self.root = scratch(self)
        self.source = self.root / "source"
        self.source.mkdir(mode=0o700)
        self.file = self.source / "file"
        self.file.write_bytes(b"identity")
        self.file.chmod(0o600)
        self.owner = (os.geteuid(), os.getegid())

    def rows(self):
        return pair.inventory(self.source, self.owner, time.monotonic() + 10)

    def test_sparse_pair_copy_and_verified_tamper_refusal(self):
        with self.file.open("r+b") as stream:
            stream.seek(1024**3)
            stream.write(b"tail")
        dest = self.root / "copy"
        expected = pair.tree(self.source, self.rows(), dest, time.monotonic() + 10)
        actual = pair.tree(dest, pair.inventory(dest, self.owner, time.monotonic() + 10), None, time.monotonic() + 10)
        self.assertEqual(expected, actual)
        self.assertLess((dest / "file").stat().st_blocks * 512, 1024**2)
        (dest / "file").write_bytes(b"changed")
        self.assertNotEqual(expected, pair.tree(dest, pair.inventory(dest, self.owner, time.monotonic() + 10), None, time.monotonic() + 10))

    def test_links_modes_owners_deadline_and_bounds_refuse(self):
        for change in ("symlink", "hardlink", "mode", "owner", "entries", "bytes", "deadline"):
            with self.subTest(change=change):
                if change == "symlink":
                    (self.source / "link").symlink_to(self.file)
                    with self.assertRaises(ValueError): self.rows()
                    (self.source / "link").unlink()
                elif change == "hardlink":
                    os.link(self.file, self.source / "link")
                    with self.assertRaises(ValueError): self.rows()
                    (self.source / "link").unlink()
                elif change == "mode":
                    self.file.chmod(0o644)
                    with self.assertRaises(ValueError): self.rows()
                    self.file.chmod(0o600)
                elif change == "owner":
                    with self.assertRaises(ValueError):
                        pair.inventory(self.source, (123456, 123456), time.monotonic() + 10)
                elif change == "deadline":
                    with self.assertRaises(ValueError):
                        pair.inventory(self.source, self.owner, 0)
                else:
                    with patch.object(pair, "COPY_ENTRIES" if change == "entries" else "COPY_ALLOCATED", 1):
                        with self.assertRaises(ValueError): self.rows()


    def test_large_directory_is_refused_while_enumerating(self):
        file = self.file
        class Flood:
            seen = 0
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def __iter__(self): return self
            def __next__(self):
                self.seen += 1
                if self.seen > pair.COPY_ENTRIES:
                    raise AssertionError("unbounded enumeration")
                return type("Entry", (), {
                    "path": str(file),
                    "stat": lambda self, **_: file.lstat(),
                })()
        stream = Flood()
        with patch.object(pair.os, "scandir", return_value=stream):
            with self.assertRaisesRegex(ValueError, "entry or elapsed bound"):
                self.rows()
        self.assertEqual(stream.seen, pair.COPY_ENTRIES)

    def test_nested_same_device_mount_is_refused_before_enumeration(self):
        with patch.object(pair, "mount_records", return_value=[(self.source / "nested", "ext4")]):
            with self.assertRaisesRegex(ValueError, "nested mount"):
                self.rows()

    def test_stale_inventory_and_destination_collision_refuse(self):
        rows = self.rows()
        self.file.write_bytes(b"new state")
        with self.assertRaises(ValueError):
            pair.tree(self.source, rows, None, time.monotonic() + 10)
        with self.assertRaises(FileExistsError):
            pair.tree(self.source, self.rows(), self.source, time.monotonic() + 10)

    def test_kernel_escaped_mount_names_refuse_nested_mounts(self):
        # The escape sits in an ANCESTOR of the mount point, so only a correct one-backslash
        # unescape finds the nesting; the former two-backslash pattern missed it.
        source = self.root / "src dir\\tab\tx"
        source.mkdir(mode=0o700)
        escaped = str(source / "nested").replace("\\", "\\134").replace(" ", "\\040").replace("\t", "\\011")
        mountinfo = self.root / "mountinfo"
        # The kernel does not escape carriage return; it must not split a record.
        mountinfo.write_bytes(b"22 1 8:1 / / rw - ext4 /dev/sda1 rw\n"
                              b"37 22 0:33 / /odd\rname rw - tmpfs tmpfs rw\n" +
                              f"36 22 0:32 / {escaped} rw,relatime shared:1 - tmpfs tmpfs rw\n".encode())
        with patch.object(pair, "MOUNTINFO", str(mountinfo)):
            self.assertEqual(pair.mount_records(), [(Path("/"), "ext4"), (Path("/odd\rname"), "tmpfs"),
                                                    (source / "nested", "tmpfs")])
            with self.assertRaisesRegex(ValueError, "nested mount"):
                pair.inventory(source, self.owner, time.monotonic() + 10)
            mountinfo.write_text("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n")
            self.assertEqual(len(pair.inventory(source, self.owner, time.monotonic() + 10)), 1)


class LimitTests(unittest.TestCase):
    def test_documented_proposal_and_untrusted_limit_values(self):
        limits = proposal()
        self.assertEqual(pair.checked_limits(limits), proposal())
        self.assertEqual(limits["data"]["maxLogicalBytes"], 64 * 1024**3)
        self.assertEqual(limits["meta"]["maxAllocatedBytes"], 16 * 1024**3)
        legacy = pair.checked_limits(None)
        self.assertEqual(legacy["data"], {"maxEntries": 4096, "maxAllocatedBytes": 512 * 1024**2,
                                          "maxReadBytes": 512 * 1024**2, "maxLogicalBytes": 2 * 1024**4})
        self.assertEqual(legacy["maxElapsedMs"], 120000)
        mutations = [
            ("maxElapsedMs", True), ("maxElapsedMs", 0), ("maxElapsedMs", 1.5), ("maxElapsedMs", -1),
            ("maxElapsedMs", pair.MAX_ELAPSED_MS + 1), ("maxElapsedMs", float("nan")),
            ("data.maxReadBytes", float("inf")), ("data.maxReadBytes", "1"), ("data.maxReadBytes", None),
            ("meta.maxEntries", 262145), ("data.maxLogicalBytes", 2 * 1024**4 + 1),
            ("data.maxAllocatedBytes", 256 * 1024**3 + 1), ("data.maxEntries", False),
            ("extra", 1), ("meta.extra", 1), ("data", [1]), ("meta", None),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                limits = proposal()
                target, _, field = key.rpartition(".")
                (limits[target] if target else limits)[field] = value
                with self.assertRaises(ValueError):
                    pair.checked_limits(limits)
        for name in ("meta", "data.maxReadBytes"):
            limits = proposal()
            target, _, field = name.rpartition(".")
            del (limits[target] if target else limits)[field]
            with self.assertRaises(ValueError):
                pair.checked_limits(limits)


class CapacityTests(unittest.TestCase):
    """Measured-fit admission with injected statvfs; a sparse 3 GiB file stays tiny on disk."""

    def setUp(self):
        self.root = scratch(self)
        self.owner = [os.geteuid(), os.getegid()]
        for name in ("meta", "data", "backups", "data/ab", "data/ab/cd"):
            (self.root / name).mkdir(mode=0o700)
        with (self.root / "meta/data.mdb").open("wb") as stream:
            stream.write(b"page")
            stream.seek(3 * 1024**3)
            stream.write(b"tail")
        (self.root / "data/ab/cd/block").write_bytes(os.urandom(100000))
        for name in ("meta/data.mdb", "data/ab/cd/block"):
            (self.root / name).chmod(0o600)
        self.limits = proposal()
        self.target = self.root / "backups" / "pair"
        self.input = {"meta": str(self.root / "meta"), "data": str(self.root / "data"),
                      "backup": str(self.target), "metadataOwner": self.owner, "dataOwner": self.owner,
                      "minFreeBytes": 2 * 1024**3, "minFreeInodes": 4096, "limits": self.limits}
        mounts = patch.object(pair, "mount_records", return_value=[(Path("/"), "ext4")])
        mounts.start()
        self.addCleanup(mounts.stop)

    def required(self):
        rows, measured = [], []
        for name in ("meta", "data"):
            rows.append(pair.inventory(self.root / name, self.owner, time.monotonic() + 10, self.limits[name]))
            measured.append(pair.measure(rows[-1], self.limits[name], time.monotonic() + 10, 4096))
        return measured, pair.requirement(rows, measured, self.limits, 4096)

    def statvfs(self, spare_bytes=0, spare_inodes=0):
        _measured, (need, inodes) = self.required()
        self.assertEqual(need % 4096, 0)
        return types.SimpleNamespace(f_frsize=4096, f_bavail=(need + 2 * 1024**3) // 4096 + spare_bytes,
                                     f_favail=inodes + 4096 + spare_inodes)

    def test_measured_fit_boundary_small_tree_under_large_limits(self):
        measured, (need, _inodes) = self.required()
        # Sparse 3 GiB metadata reads two chunks; a small tree is never charged 2x the 80 GiB maxima.
        self.assertLessEqual(measured[0][0], 2 * pair.COPY_CHUNK)
        self.assertLess(need, 128 * 1024**2)
        for spare in ({"spare_bytes": -1}, {"spare_inodes": -1}):
            with self.subTest(**spare), patch.object(pair.os, "statvfs", return_value=self.statvfs(**spare)):
                with self.assertRaisesRegex(ValueError, "headroom"):
                    pair.backup(self.input)
                self.assertFalse(self.target.exists())
        with patch.object(pair.os, "statvfs", return_value=self.statvfs()):
            digest = pair.backup(self.input)
        self.assertEqual(pair.verify(self.target, self.limits), digest)
        self.assertLess((self.target / "meta/data.mdb").stat().st_blocks * 512, 1024**2)

    def test_fragmented_extent_tree_is_charged_before_creation(self):
        self.assertEqual([pair.extent_blocks(n, 4096) for n in (0, 4, 5, 170, 171)], [0, 0, 1, 1, 2])
        # 64 GiB of 4 KiB blocks, one extent each: even FULL 340-entry nodes need 49345 leaves
        # plus 146 index blocks. The charge assumes half-full nodes, so it is at least double.
        blocks = 64 * 1024**3 // 4096
        full = pair.ceil_div(blocks, 340) + pair.ceil_div(pair.ceil_div(blocks, 340), 340)
        self.assertEqual(full, 49345 + 146)
        self.assertGreaterEqual(pair.extent_blocks(blocks, 4096), 2 * full)
        rows = pair.inventory(self.root / "data", self.owner, time.monotonic() + 10, self.limits["data"])
        files = [row for row in rows if row[0].name == "block"]
        with patch.object(pair, "spans", lambda *_: iter([(0, 64 * 1024**3)])):
            read, required = pair.measure(files, self.limits["data"], time.monotonic() + 10, 4096)
        self.assertEqual(read, 64 * 1024**3)
        self.assertGreaterEqual(required, pair.ENTRY_OVERHEAD + (blocks + 2 * full) * 4096)

    def test_unsupported_sparse_seek_refuses_before_destination_without_reading(self):
        self.input["limits"]["meta"]["maxReadBytes"] = 1024**3
        unsupported = OSError(errno.EINVAL, "unsupported")
        with patch.object(pair.os, "lseek", side_effect=unsupported), \
                patch.object(pair.os, "pread", side_effect=AssertionError("zeros read")):
            with self.assertRaisesRegex(ValueError, "sparse_seek_required"):
                pair.backup(self.input)
        self.assertFalse(self.target.exists())

    def test_elapsed_after_admission_preserves_partial_destination(self):
        value, real, late = self.statvfs(), time.monotonic, []
        def statvfs(_path):
            late.append(True)  # The second call is the admission check just before creation.
            return value
        with patch.object(pair.os, "statvfs", statvfs), \
                patch.object(pair.time, "monotonic", lambda: real() + (10**9 if len(late) >= 2 else 0)):
            with self.assertRaisesRegex(ValueError, "changed or elapsed"):
                pair.backup(self.input)
        self.assertTrue((self.target / "meta").is_dir())
        self.assertFalse((self.target / "pair.json").exists())

    def test_verify_refuses_changed_limits_old_versions_forgery_and_mutation(self):
        with patch.object(pair.os, "statvfs", return_value=self.statvfs()):
            digest = pair.backup(self.input)
        manifest = self.target / "pair.json"
        original = manifest.read_bytes()
        changed = proposal()
        changed["maxElapsedMs"] += 1
        for limits in (changed, pair.checked_limits(None)):
            with self.assertRaisesRegex(ValueError, "pair limits"):
                pair.verify(self.target, limits)
        trees = json.loads(original)["trees"]
        for forged in (pair.canonical({"version": 1, "trees": trees}),
                       original.replace(b'"directory": false', b'"directory": 0', 1),
                       original.replace(b'"version": 2', b'"version": 2.0')):
            with self.subTest(forged=forged[:40]):
                manifest.write_bytes(forged)
                with self.assertRaises(ValueError):
                    pair.verify(self.target, self.limits)
        manifest.write_bytes(original)
        self.assertEqual(pair.verify(self.target, self.limits), digest)
        with (self.target / "data/ab/cd/block").open("r+b") as stream:
            stream.write(b"x")
        with self.assertRaisesRegex(ValueError, "pair changed"):
            pair.verify(self.target, self.limits)

    def test_unknown_input_fields_refuse(self):
        for raw in ({**self.input, "extra": 1}, {"verify": str(self.target), "extra": 1},
                    {"verify": str(self.target) + "/"}, {k: v for k, v in self.input.items() if k != "dataOwner"}):
            with self.subTest(raw=sorted(raw)):
                with self.assertRaises((ValueError, KeyError)):
                    pair.main(json.dumps(raw).encode())
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
