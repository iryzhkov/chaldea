
"""Managed DATA contracts. Local disk only; UID/GID/mount observations are mocked.
No NFS, sudo, credentials or service. Real mode/link/content/FD changes are exercised."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("managed_pair", ROOT / "src/exec/blob_pair.py")
pair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pair)


class ManagedPairTests(unittest.TestCase):
    def setUp(self):
        home = Path(os.environ["HOME"])
        assert home == Path(os.environ["BLOB_TEST_HOME"]) and home.is_relative_to(Path(os.environ["TMPDIR"]))
        temp = tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name in ("meta", "data", "backups"):
            (self.root / name).mkdir(mode=0o700)
        self.target = self.root / "backups/pair"
        (self.root / "data").chmod(0o770)
        (self.root / "meta/db").write_bytes(b"metadata")
        (self.root / "meta/db").chmod(0o600)
        (self.root / "data/block").write_bytes(b"replaceable")
        (self.root / "data/block").chmod(0o660)
        self.storage = {
            "enabled": True, "operating_contract": "operator_budget_v1",
            "metadata": {"path": str(self.root)},
            "data": {"path": str(self.root / "data"), "acceptance_mode": "operational_budget",
                     "mount": {"fstype": "nfs4"},
                     "operational_budget": {"bytes": 2_000_000_000_000, "risk_acceptance": "fixture"},
                     "identity_mapping": {"owner_uid": 977, "owner_gid": 988, "evidence": "fixture"},
                     "access_profile": {"name": "managed_nfs_data_v1",
                                        "acceptance_reference": "jocasta:" + "0"*32 + "@1"}}}
        self.config = {"meta": str(self.root / "meta"), "data": str(self.root / "data"),
                       "backup": str(self.target), "metadataOwner": [1000, 1000],
                       "dataOwner": [977, 988], "minFreeBytes": 0, "minFreeInodes": 0}
        self.refresh()
        self.owner_override = {}
        original_lstat, original_fstat, original_scandir = Path.lstat, os.fstat, os.scandir
        def observation(path, value):
            values = {k: getattr(value, k) for k in dir(value) if k.startswith("st_")}
            owner = (977, 988) if path == self.root/"data" or self.root/"data" in path.parents else (
                     (1000, 1000) if path == self.root/"meta" or self.root/"meta" in path.parents else (0, 0))
            owner = self.owner_override.get(path, owner)
            values.update(st_uid=owner[0], st_gid=owner[1])
            return types.SimpleNamespace(**values)
        def fstat(fd):
            return observation(Path(os.readlink("/proc/self/fd/" + str(fd))), original_fstat(fd))
        class Scan:
            def __init__(self, path): self.stream = original_scandir(path)
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def __iter__(self): return self
            def __next__(self):
                item = next(self.stream)
                return types.SimpleNamespace(path=item.path, stat=lambda **kw: observation(Path(item.path), item.stat(**kw)))
        for mock in (patch.object(os, "scandir", Scan), patch.object(Path, "lstat", lambda p: observation(p, original_lstat(p))),
                     patch.object(os, "fstat", fstat), patch.object(os, "geteuid", return_value=0),
                     patch.object(os, "getegid", return_value=0),
                     patch.object(pair, "mount_records", return_value=[(Path("/"), "ext4")])):
            mock.start()
            self.addCleanup(mock.stop)

    def refresh(self):
        self.config["storage"] = json.dumps(self.storage)
        self.config["storageSHA256"] = hashlib.sha256(self.config["storage"].encode()).hexdigest()

    def verify(self):
        return pair.main(json.dumps({"verify": str(self.target), "storage": self.config["storage"],
                                    "storageSHA256": self.config["storageSHA256"]}).encode())

    def rewrite(self, value):
        (self.target/"pair.json").write_bytes(pair.canonical(value))

    def test_copy_normalizes_modes_and_verifies_historical_provenance(self):
        digest = pair.backup(self.config)
        self.assertEqual(self.verify(), digest)
        value = json.loads((self.target/"pair.json").read_bytes())
        self.assertEqual(value["version"], 3)
        self.assertEqual(value["source"]["data"][0]["sourceMode"], 0o770)
        self.assertEqual(value["source"]["data"][1]["sourceMode"], 0o660)
        self.assertEqual(value["trees"]["data"][0]["mode"], 0o700)
        self.assertEqual(value["trees"]["data"][1]["mode"], 0o600)
        self.assertNotEqual(value["source"]["data"][1]["stamp"][1], (self.target/"data/block").lstat().st_ino)
        self.assertEqual(stat.S_IMODE((self.target/"pair.json").stat().st_mode), 0o600)
        # Later source mutations do not change an immutable historical pair.
        (self.root/"data/block").chmod(0o600)
        self.assertEqual(self.verify(), digest)
        with self.assertRaises(ValueError):
            pair.verify(self.target, pair.legacy_limits())

    def test_stable_private_and_group_modes_both_admitted(self):
        (self.root/"data").chmod(0o700)
        (self.root/"data/block").chmod(0o600)
        self.assertEqual(self.verify_after_backup(), 64)

    def verify_after_backup(self):
        digest = pair.backup(self.config)
        self.assertEqual(self.verify(), digest)
        return len(digest)

    def test_unknown_profile_keys_contract_and_mapping_refuse_before_destination(self):
        for mutate in (
            lambda s: s["data"]["access_profile"].update(name="unknown"),
            lambda s: s["data"]["access_profile"].update(extra=True),
            lambda s: s["data"].update(access_proflie={}),
            lambda s: s.pop("operating_contract"),
            lambda s: s["data"].pop("identity_mapping"),
            lambda s: s["data"]["identity_mapping"].update(owner_uid=1000),
            lambda s: s["data"].update(acceptance_mode="physical_cap"),
            lambda s: s["data"].update(path=str(self.root/"wrong-data")),
            lambda s: s["metadata"].update(path=str(self.root/"wrong-meta")),
            lambda s: s["data"]["access_profile"].update(acceptance_reference="latest"),
        ):
            original = copy.deepcopy(self.storage)
            mutate(self.storage); self.refresh()
            with self.assertRaises((ValueError, KeyError)):
                pair.backup(self.config)
            self.assertFalse(self.target.exists())
            self.storage = original; self.refresh()

    def test_source_modes_special_bits_links_owner_and_bounds_refuse(self):
        for mode in (0o640, 0o666, 0o4600, 0o2600):
            (self.root/"data/block").chmod(mode)
            with self.assertRaises(ValueError):
                pair.backup(self.config)
            self.assertFalse(self.target.exists())
        (self.root/"data/block").chmod(0o660)
        os.link(self.root/"data/block", self.root/"data/link")
        with self.assertRaises(ValueError): pair.backup(self.config)
        (self.root/"data/link").unlink()
        self.owner_override[self.root/"data/block"] = (1000, 1000)
        with self.assertRaises(ValueError): pair.backup(self.config)
        self.owner_override.clear()
        self.config["limits"] = pair.legacy_limits()
        self.config["limits"]["data"]["maxEntries"] = 1
        with self.assertRaises(ValueError): pair.backup(self.config)

    def test_copy_epoch_changes_fail_closed_and_preserve_last_good_and_partial(self):
        good = pair.backup(self.config)
        original = pair.sparse_file
        for mutation in ("mode", "ctime", "content", "identity", "path"):
            self.target = self.root/("backups/partial-" + mutation)
            self.config["backup"] = str(self.target)
            changed = False
            def drift(source, target, budget, **kwargs):
                nonlocal changed
                result = original(source, target, budget, **kwargs)
                p = self.root/"data/block"
                if not changed and os.fstat(source.fileno()).st_uid == 977:
                    changed = True
                    if mutation == "mode": p.chmod(0o600)
                    elif mutation == "ctime": p.chmod(stat.S_IMODE(p.stat().st_mode))
                    elif mutation == "content": p.write_bytes(b"substitute")
                    elif mutation == "identity":
                        p.unlink(); p.write_bytes(b"replaceable"); p.chmod(0o660)
                    else: (self.root/"data/extra").write_bytes(b"extra")
                return result
            with patch.object(pair, "sparse_file", drift), self.assertRaises(ValueError):
                pair.backup(self.config)
            self.assertTrue(self.target.exists())
            self.assertFalse((self.target/"pair.json").exists())
            self.assertTrue((self.target/"meta/db").exists())
            (self.root/"data/block").write_bytes(b"replaceable")
            (self.root/"data/block").chmod(0o660)
            if (self.root/"data/extra").exists(): (self.root/"data/extra").unlink()
        self.target = self.root/"backups/pair"
        self.assertEqual(self.verify(), good)

    def test_manifest_profile_limits_provenance_and_private_custody_tamper_refuse(self):
        pair.backup(self.config)
        original = json.loads((self.target/"pair.json").read_bytes())
        for mutate in (
            lambda v: v.update(version=4), lambda v: v.update(version=True),
            lambda v: v["profile"].update(name="unknown"),
            lambda v: v["profile"].update(effectiveProfileSHA256="0"*64),
            lambda v: v["profile"].update(sourceStorageSHA256="0"*64),
            lambda v: v["limits"]["data"].update(maxEntries=1),
            lambda v: v["source"]["data"][1].update(sourceMode=0o666),
            lambda v: v["source"]["data"][1]["stamp"].__setitem__(3, 1000),
            lambda v: v["source"]["data"][1]["stamp"].__setitem__(5, 2),
        ):
            value = copy.deepcopy(original); mutate(value); self.rewrite(value)
            with self.assertRaises(ValueError): self.verify()
        self.rewrite(original)
        for name, mode, restore in (("data/block", 0o660, 0o600), ("data", 0o770, 0o700),
                                    ("pair.json", 0o640, 0o600)):
            (self.target/name).chmod(mode)
            with self.assertRaises(ValueError): self.verify()
            (self.target/name).chmod(restore)
        self.owner_override[self.target/"data/block"] = (1000, 1000)
        with self.assertRaises(ValueError): self.verify()
        self.owner_override.clear()
        self.config["storageSHA256"] = "a"*64
        with self.assertRaises(ValueError): self.verify()



    def test_packet_adapter_verifies_v3_and_uses_new_destination_identities(self):
        spec = importlib.util.spec_from_file_location("recovery", ROOT / "test/fixtures/blob-recovery/representation.py")
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        digest = pair.backup(self.config)
        admitted = adapter.verified_pair(pair, self.target, pair.legacy_limits(),
                                        self.config["storage"].encode(), self.config["storageSHA256"], digest)
        # Real fixture destination identity differs from original and immutable copy.
        restored = self.root/"restored"
        restored.mkdir(mode=0o700)
        (restored/"block").write_bytes(b"replaceable")
        (restored/"block").chmod(0o660)
        # This local-only fixture maps restored uid/gid observations to the fixed NAS mapping.
        inv = pair.inventory
        def mapped(path, owner, deadline, limits=None, **kwargs):
            rows = inv(path, (0, 0), deadline, limits, **kwargs) if path == restored else inv(path, owner, deadline, limits, **kwargs)
            if path == restored:
                return [(p, types.SimpleNamespace(**{**vars(s), "st_uid": 977, "st_gid": 988})) for p, s in rows]
            return rows
        # Stamp equality still uses real inode/mode/time; owner projection is fixture-only.
        stamp = pair.stamp
        def stamped(value):
            result = list(stamp(value))
            if result[1] in {restored.stat().st_ino, (restored/"block").stat().st_ino}:
                result[3:5] = [977, 988]
            return tuple(result)
        with patch.object(pair, "inventory", mapped), patch.object(pair, "stamp", stamped):
            receipt = adapter.restored_tree(pair, admitted, "data", restored, pair.legacy_limits(), time.monotonic()+10, 512*1024**2)
            self.assertEqual(receipt["observations"][1]["requestedMode"], 0o600)
            self.assertEqual(receipt["observations"][1]["observedMode"], 0o660)
            (restored/"block").write_bytes(b"wrong")
            with self.assertRaises(ValueError):
                adapter.restored_tree(pair, admitted, "data", restored, pair.legacy_limits(), time.monotonic()+10, 512*1024**2)
        self.assertTrue(restored.exists())  # Consumer does not erase failed partial state.



    def test_packet_derivation_preserves_profile_budgets_and_rejects_undisclosed_differences(self):
        spec = importlib.util.spec_from_file_location("recovery", ROOT / "test/fixtures/blob-recovery/representation.py")
        adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)
        spec = importlib.util.spec_from_file_location("producer", ROOT / "test/fixtures/blob-headroom/garage-storage-preflight.py")
        producer = importlib.util.module_from_spec(spec); spec.loader.exec_module(producer)
        source = copy.deepcopy(self.storage)
        source.update(uid=1000, gid=1000, host="fixture", data_fsync=True, metadata_fsync=True)
        source["data"]["mount"].update(target=str(self.root), source="fixture:/ml",
                                      fsroot="/", options=["rw", "soft"])
        source["metadata"].update(path=str(self.root/"local/objectstore"), acceptance_mode="operational_budget",
            operational_budget={"bytes": 16*1024**3, "risk_acceptance": "fixture"},
            mount={"target": str(self.root), "source": "/dev/fixture", "fstype": "ext4",
                   "fsroot": "/", "options": ["rw"]})
        source["qualifications"] = {"configuration": producer.digest(source),
                                   **{g: None for g in producer.DURABILITY_GATES}}
        restored = copy.deepcopy(source)
        restored["data"]["path"] = str(self.root/"newdata")
        restored["metadata"]["path"] = str(self.root/"newmeta")
        restored["qualifications"]["configuration"] = producer.digest(restored)
        source_raw = json.dumps(source).encode()
        source_sha = hashlib.sha256(source_raw).hexdigest()
        def check(value):
            raw = json.dumps(value).encode()
            return adapter.derived_configuration(pair, producer, source_raw, raw, source_sha,
                hashlib.sha256(raw).hexdigest(), str(self.root/"newmeta"), str(self.root/"newdata"))
        receipt = check(restored)
        self.assertNotEqual(receipt["sourceStorageSHA256"], receipt["restoredStorageSHA256"])
        self.assertEqual(receipt["sourceEffectiveProfileSHA256"], receipt["restoredEffectiveProfileSHA256"])
        for mutate in (lambda c: c["data"]["operational_budget"].update(bytes=1),
                       lambda c: c.update(data_fsync=False),
                       lambda c: c["qualifications"].update(full_volume="invented"),
                       lambda c: c["data"]["identity_mapping"].update(owner_uid=1000)):
            value = copy.deepcopy(restored); mutate(value)
            with self.assertRaises(ValueError): check(value)

    def test_private_version2_known_pair_canonical_bytes_and_adapter_dispatch(self):
        # Fixed historical representation, with no source stamps or managed fields.
        golden = b'{"limits": {"data": {"maxAllocatedBytes": 536870912, "maxEntries": 4096, "maxLogicalBytes": 2199023255552, "maxReadBytes": 536870912}, "maxElapsedMs": 120000, "meta": {"maxAllocatedBytes": 536870912, "maxEntries": 4096, "maxLogicalBytes": 2199023255552, "maxReadBytes": 536870912}}, "trees": {"data": [{"directory": true, "mode": 448, "path": "."}], "meta": [{"directory": true, "mode": 448, "path": "."}]}, "version": 2}'
        self.target.mkdir(mode=0o700)
        for name in ("meta", "data"): (self.target/name).mkdir(mode=0o700)
        (self.target/"pair.json").write_bytes(golden)
        (self.target/"pair.json").chmod(0o600)
        expected = hashlib.sha256(golden).hexdigest()
        self.assertEqual(pair.verify(self.target, pair.legacy_limits()), expected)
        spec = importlib.util.spec_from_file_location("recovery", ROOT / "test/fixtures/blob-recovery/representation.py")
        adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)
        self.assertEqual(adapter.verified_pair(pair, self.target, pair.legacy_limits(), b"", "", expected)["version"], 2)
        self.assertEqual((self.target/"pair.json").read_bytes(), golden)



class RecoveryManifestReadTests(unittest.TestCase):
    """Initial dispatch uses real local descriptors; downstream verifiers are spies.
    Existing ManagedPairTests separately exercise unchanged actual v2/v3 verification."""

    def setUp(self):
        home = Path(os.environ["HOME"])
        assert home == Path(os.environ["BLOB_TEST_HOME"]) and home.is_relative_to(Path(os.environ["TMPDIR"]))
        temp = tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.manifest = self.root / "pair.json"
        spec = importlib.util.spec_from_file_location("recovery_read", ROOT / "test/fixtures/blob-recovery/representation.py")
        self.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.adapter)
        self.limits = pair.legacy_limits()
        self.raw = pair.canonical({"version": 2, "trees": {"meta": [], "data": []}})
        self.manifest.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.consumer = types.SimpleNamespace(
            checked_path=pair.checked_path, checked_limits=pair.checked_limits,
            manifest_limit=pair.manifest_limit, stamp=pair.stamp,
            verify=Mock(return_value=self.digest), verify_managed=Mock(return_value=self.digest),
            managed_profile=Mock(return_value={"fixture": True}))

    def call(self):
        return self.adapter.verified_pair(self.consumer, self.root, self.limits, b"{}", "fixture", self.digest)

    def assert_no_dispatch(self):
        self.consumer.verify.assert_not_called()
        self.consumer.verify_managed.assert_not_called()
        self.consumer.managed_profile.assert_not_called()

    def test_manifest_open_flags_bounded_read_and_v2_v3_dispatch(self):
        original_open, original_close, original_fdopen, original_fstat = os.open, os.close, os.fdopen, os.fstat
        opened, closed, reads = [], [], []
        def opening(path, flags, *args, **kwargs):
            self.assertEqual(flags, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            fd = original_open(path, flags, *args, **kwargs); opened.append(fd); return fd
        def closing(fd):
            closed.append(fd); return original_close(fd)
        class Reader:
            def __init__(self, fd, *args, **kwargs): self.stream = original_fdopen(fd, *args, **kwargs)
            def __enter__(self): return self
            def __exit__(self, *args): self.stream.close()
            def read(self, count):
                reads.append(count); return self.stream.read(count)
        for version in (2, 3):
            self.raw = pair.canonical({"version": version, "trees": {"meta": [], "data": []}})
            self.digest = hashlib.sha256(self.raw).hexdigest()
            self.manifest.write_bytes(self.raw)
            self.consumer.verify.return_value = self.consumer.verify_managed.return_value = self.digest
            with patch.object(os, "open", opening), patch.object(os, "close", closing), patch.object(os, "fdopen", Reader):
                self.assertEqual(self.call()["version"], version)
            with self.assertRaises(OSError): original_fstat(opened[-1])
        self.assertEqual(opened, closed)
        self.assertEqual(reads, [pair.manifest_limit(self.limits, True) + 1] * 2)
        self.consumer.verify.assert_called_once_with(self.root, self.limits)
        self.consumer.verify_managed.assert_called_once_with(self.root, self.limits, {"fixture": True})

    def test_fifo_without_writer_refuses_with_bounded_child_timeout(self):
        self.manifest.unlink(); os.mkfifo(self.manifest, 0o600)
        # A regression to blocking open must fail this test within 3 seconds, not hang CI.
        program = """import importlib.util, pathlib, sys
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value
pair = module("pair", sys.argv[1])
adapter = module("adapter", sys.argv[2])
def forbidden(*args): raise AssertionError("verifier reached for FIFO")
pair.verify = pair.verify_managed = forbidden
try:
    adapter.verified_pair(pair, pathlib.Path(sys.argv[3]), pair.legacy_limits(), b"", "", "0"*64)
except ValueError as error:
    assert str(error) == "manifest bound", str(error)
else:
    raise AssertionError("FIFO accepted")
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", program,
                                 str(ROOT/"src/exec/blob_pair.py"),
                                 str(ROOT/"test/fixtures/blob-recovery/representation.py"), str(self.root)],
                                capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_symlink_directory_multilink_and_oversize_refuse_before_read(self):
        original_open, original_fstat = os.open, os.fstat
        opened = []
        def opening(path, flags, *args, **kwargs):
            fd = original_open(path, flags, *args, **kwargs); opened.append(fd); return fd
        for kind in ("symlink", "directory", "multilink", "oversize"):
            with self.subTest(kind=kind):
                self.manifest.unlink()
                if kind == "symlink":
                    other = self.root/"other"; other.write_bytes(self.raw); self.manifest.symlink_to(other)
                elif kind == "directory": self.manifest.mkdir()
                else:
                    self.manifest.write_bytes(self.raw)
                    if kind == "multilink": os.link(self.manifest, self.root/"hardlink")
                    else:
                        with self.manifest.open("r+b") as stream:
                            stream.truncate(pair.manifest_limit(self.limits, True) + 1)
                with patch.object(os, "open", opening), patch.object(os, "fdopen", side_effect=AssertionError("unsafe read")):
                    with self.assertRaises((OSError, ValueError)): self.call()
                for fd in opened:
                    with self.assertRaises(OSError): original_fstat(fd)
                self.assert_no_dispatch()
                if kind == "directory": self.manifest.rmdir(); self.manifest.write_bytes(self.raw)

    def test_fd_path_and_ancestry_drift_refuse_before_or_after_verifier(self):
        original_fstat = os.fstat
        for phase in ("before-read", "after-read", "after-verifier", "fd", "ancestry"):
            with self.subTest(phase=phase):
                self.manifest.write_bytes(self.raw)
                changed = False
                original_lstat = Path.lstat
                calls = 0
                def value_at_path(path):
                    nonlocal changed
                    if phase == "before-read" and path == self.manifest and not changed:
                        changed = True
                        self.manifest.rename(self.root/"retained-before")
                        self.manifest.write_bytes(self.raw)
                    return original_lstat(path)
                def drift_fd(fd):
                    nonlocal calls
                    value = original_fstat(fd); calls += 1
                    if phase == "fd" and calls == 2:
                        fields = {k: getattr(value, k) for k in dir(value) if k.startswith("st_")}
                        fields["st_ctime_ns"] += 1
                        return types.SimpleNamespace(**fields)
                    return value
                original_fdopen = os.fdopen
                class Reader:
                    def __init__(self, fd, *args, **kwargs): self.stream = original_fdopen(fd, *args, **kwargs)
                    def __enter__(self): return self
                    def __exit__(self, *args): self.stream.close()
                    def read(inner, count):
                        raw = inner.stream.read(count)
                        if phase == "after-read":
                            self.manifest.rename(self.root/"retained-after")
                            self.manifest.write_bytes(raw)
                        return raw
                def verified(*args):
                    if phase == "after-verifier":
                        self.manifest.rename(self.root/"retained-handoff")
                        self.manifest.write_bytes(self.raw)
                    return self.digest
                checked = self.consumer.checked_path
                self.consumer.verify.reset_mock()
                self.consumer.verify.side_effect = verified
                path_calls = 0
                def ancestry(path):
                    nonlocal path_calls
                    path_calls += 1
                    if phase == "ancestry" and path_calls == 2: raise ValueError("symlink")
                    return pair.checked_path(path)
                self.consumer.checked_path = ancestry
                with patch.object(Path, "lstat", value_at_path), patch.object(os, "fstat", drift_fd), patch.object(os, "fdopen", Reader):
                    with self.assertRaises(ValueError): self.call()
                self.assertEqual(self.consumer.verify.call_count, 1 if phase == "after-verifier" else 0)
                self.consumer.checked_path = checked
                self.consumer.verify.side_effect = None

    def test_hash_shape_version_and_verifier_failures_close_fd(self):
        original_open, original_fstat = os.open, os.fstat
        opened = []
        def opening(path, flags, *args, **kwargs):
            fd = original_open(path, flags, *args, **kwargs); opened.append(fd); return fd
        for value in (None, [], 1, {}, {"version": 2, "trees": []},
                      {"version": 2, "trees": {"meta": []}}, {"version": 4, "trees": {"meta": [], "data": []}}):
            self.manifest.write_bytes(pair.canonical(value))
            self.digest = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
            with patch.object(os, "open", opening), self.assertRaises(ValueError): self.call()
            self.assert_no_dispatch()
            with self.assertRaises(OSError): original_fstat(opened[-1])
        self.manifest.write_bytes(self.raw); self.digest = "0"*64
        with patch.object(os, "open", opening), self.assertRaises(ValueError): self.call()
        self.assert_no_dispatch()
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.consumer.verify.side_effect = ValueError("verifier refused")
        with patch.object(os, "open", opening), self.assertRaises(ValueError): self.call()
        for fd in opened:
            with self.assertRaises(OSError): original_fstat(fd)


if __name__ == "__main__":
    unittest.main()
