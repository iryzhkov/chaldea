"""Local bounded copy contracts. No NAS, real keys, or system services."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("pair", Path(__file__).resolve().parents[2] / "src/exec/blob_pair.py")
assert SPEC is not None and SPEC.loader is not None
pair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pair)


class PairTests(unittest.TestCase):
    def setUp(self):
        home = Path(os.environ["HOME"])
        assert home == Path(os.environ["BLOB_TEST_HOME"])
        assert home.is_relative_to(Path(os.environ["TMPDIR"]))
        self.tmp = tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
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


if __name__ == "__main__":
    unittest.main()
