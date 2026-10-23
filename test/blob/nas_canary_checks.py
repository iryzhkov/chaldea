"""Selected stand-in checks for the new canary. No NAS, registry or Garage server."""
import contextlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, ClassVar
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse
import xml.etree.ElementTree as ET

import nas_canary as canary
from garage import Garage

RESTORE_MEASUREMENTS = {}


class LocalChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def args(self):
        cache = self.root / ".cache"
        cache.mkdir(mode=0o700)
        local = cache / "garage-canary-test"
        return SimpleNamespace(local_run=str(local), nas_run=str(canary.MOUNT / local.name),
                               expected_data_owner="977:988")

    def test_paths_reject_relative_traversal_and_config_injection(self):
        for path in ("relative", "/safe/../escape", "/safe//extra", '/safe/"bad', "/safe/line\nbreak"):
            with self.subTest(path=path), self.assertRaises(canary.Refusal):
                canary.plain_path(path)

    def test_symlink_ancestor_refused(self):
        (self.root / "link").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(canary.Refusal, "symlink_path"):
            canary.no_links(self.root / "link/new")

    def test_mountinfo_selects_longest_mount_and_unescapes(self):
        rows = ("1 0 0:1 / / rw - ext4 /dev/local rw\n"
                "2 1 0:2 / /mnt/nas/ml rw - nfs " + canary.SOURCE + " rw,vers=3,soft,sec=sys\n"
                "3 2 0:3 / /mnt/nas/ml/nested rw - tmpfs tmpfs rw\n")
        with patch.object(Path, "read_text", return_value=rows):
            self.assertEqual(canary.mount_for(Path("/mnt/nas/ml/new"))["type"], "nfs")
            self.assertEqual(canary.mount_for(Path("/mnt/nas/ml/nested/new"))["type"], "tmpfs")

    def test_wrong_source_type_mountpoint_and_options_refused(self):
        good = {"target": str(canary.MOUNT), "source": canary.SOURCE, "type": "nfs",
                "options": ["rw", "vers=3", "soft", "sec=sys"]}
        variants = [dict(good, source="other:/export"), dict(good, type="nfs4"),
                    dict(good, target="/mnt/nas"), dict(good, options=["rw", "vers=3", "hard", "sec=sys"]),
                    dict(good, options=["rw", "vers=3", "soft", "sec=krb5"])]
        for row in variants:
            with self.subTest(row=row), patch.object(canary, "mount_for", return_value=row):
                with self.assertRaisesRegex(canary.Refusal, "unexpected_nfs_mount"):
                    canary.nas_mount(canary.MOUNT / "new")

    def test_root_refused_before_filesystem_setup(self):
        args = self.args()
        with patch.object(canary.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(canary.Refusal, "nonroot_identity_required"):
                canary.preflight(args)
        self.assertFalse(Path(args.local_run).exists())

    def preflight_context(self, args):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for name in ("geteuid", "getegid", "getuid", "getgid"):
            stack.enter_context(patch.object(canary.os, name, return_value=1000))
        stack.enter_context(patch.object(canary, "owner", return_value=(1000, 1000)))
        stack.enter_context(patch.object(canary.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(self.root))))
        stack.enter_context(patch.object(canary, "mount_for", return_value={"type": "ext4"}))
        stack.enter_context(patch.dict(os.environ, {"HOME": args.local_run + "/.blob-image/home",
                                                   "TMPDIR": args.local_run + "/.blob-image/tmp"}))
        for key in ("SUDO_UID", "SUDO_GID"):
            stack.enter_context(patch.dict(os.environ))
            os.environ.pop(key, None)
        return stack

    def test_local_preflight_accepts_distinct_mapping_without_touching_nas(self):
        args = self.args()
        self.preflight_context(args)
        with patch.object(canary, "nas_mount", side_effect=AssertionError("premature NAS access")):
            result = canary.preflight(args)
        self.assertEqual(result[-2:], ((1000, 1000), (977, 988)))
        self.assertFalse(Path(args.local_run).exists())

    def test_local_collisions_unsafe_home_mapping_and_nondisk_refused(self):
        args = self.args()
        self.preflight_context(args)
        with patch.dict(os.environ, {"HOME": "/home/igor"}):
            with self.assertRaisesRegex(canary.Refusal, "asserted_scratch"):
                canary.preflight(args)
        with patch.object(canary, "mount_for", return_value={"type": "tmpfs"}):
            with self.assertRaisesRegex(canary.Refusal, "local_disk_required"):
                canary.preflight(args)
        args.expected_data_owner = "0:988"
        with self.assertRaisesRegex(canary.Refusal, "invalid_data_owner"):
            canary.preflight(args)
        args.expected_data_owner = "977:988"
        Path(args.local_run).mkdir()
        with self.assertRaisesRegex(canary.Refusal, "namespace_collision"):
            canary.preflight(args)

    def test_cleanup_refuses_replaced_namespace_symlink_hardlink_and_wrong_owner(self):
        data = self.root / "data"
        data.mkdir()
        identity = canary.fingerprint(data)
        expected = canary.owner(data)
        outside = self.root / "outside"
        outside.write_bytes(b"preserve")
        (data / "link").symlink_to(outside)
        with self.assertRaisesRegex(canary.Refusal, "unsafe_cleanup_entry"):
            canary.remove_owned(data, identity, expected)
        (data / "link").unlink()
        os.link(outside, data / "hard")
        with self.assertRaisesRegex(canary.Refusal, "unsafe_cleanup_entry"):
            canary.remove_owned(data, identity, expected)
        (data / "hard").unlink()
        with self.assertRaisesRegex(canary.Refusal, "unsafe_cleanup_entry"):
            canary.remove_owned(data, identity, (999999, 999999))
        with self.assertRaisesRegex(canary.Refusal, "namespace_changed"):
            canary.remove_owned(data, (identity[0], identity[1] + 1), expected)
        self.assertEqual(outside.read_bytes(), b"preserve")

    def test_cleanup_removes_only_private_tree(self):
        data = self.root / "data"
        data.mkdir()
        (data / "file").write_bytes(b"x")
        outside = self.root / "keep"
        outside.write_bytes(b"preserve")
        canary.remove_owned(data, canary.fingerprint(data), canary.owner(data))
        self.assertFalse(data.exists())
        self.assertEqual(outside.read_bytes(), b"preserve")

    def test_garage_config_seam_preserves_default(self):
        for name, override in (("default", None), ("separate", self.root / "nas-data")):
            home = self.root / name
            home.mkdir()
            garage = Garage(Path("/unused"), home, data_dir=override)
            self.assertEqual(garage.meta, home / "meta")
            self.assertEqual(garage.data, home / "data" if override is None else override)
            config = garage.config.read_text()
            self.assertIn('data_dir = "' + str(garage.data) + '"', config)
            self.assertIn('api_bind_addr = "127.0.0.1:', config)


class CustodyStandIn:
    objects: dict[str, bytes] = {}
    clients: list[str] = []
    producer = Path(".")
    fail_put = False
    fresh_failure: ClassVar[str | None] = None
    fresh_checks: ClassVar[list[Callable[[], None]]] = []

    def __init__(self, _module, _endpoint, access, _secret):
        self.access = access
        self.clients.append(access)
        if access == "reader-a" and self.clients.count(access) == 2:
            if self.producer.exists():
                raise AssertionError("producer still exists in fresh client context")
            for check in self.fresh_checks:
                check()
            if self.fresh_failure == "creation":
                raise RuntimeError("scratch-only-synthetic-do-not-output")

    def request(self, method, path, body=b""):
        if self.access == "reader-a" and self.clients.count(self.access) == 2 and self.fresh_failure == "retrieval":
            return 503, b"scratch-only-synthetic-do-not-output"
        if self.access == "other-b" or method == "GET" and self.access == "writer-a" or (
                method == "PUT" and self.access == "reader-a"):
            return 403, b""
        if method == "PUT":
            if self.fail_put:
                return 503, b""
            self.objects[path] = body
            return 200, b""
        if "?" in path:
            bucket, query = path.split("?", 1)
            prefix = urllib.parse.parse_qs(query)["prefix"][0]
            root = ET.Element("ListBucketResult")
            ET.SubElement(root, "IsTruncated").text = "false"
            for key in sorted(self.objects):
                if key.startswith(bucket + "/" + prefix):
                    row = ET.SubElement(root, "Contents")
                    ET.SubElement(row, "Key").text = key[len(bucket) + 1:]
            return 200, ET.tostring(root)
        return (200, self.objects[path]) if path in self.objects else (404, b"")


class CustodyChecks(LocalChecks):
    @staticmethod
    def standin(root):
        CustodyStandIn.objects, CustodyStandIn.clients = {}, []
        CustodyStandIn.producer = root / "producer"
        CustodyStandIn.fail_put = False
        CustodyStandIn.fresh_failure = None
        CustodyStandIn.fresh_checks = []
        names = ["writer-a", "reader-a", "other-b"]
        def api(endpoint, _payload=None):
            if endpoint == "ListKeys":
                return [{"name": name, "id": name} for name in names]
            return {"secretAccessKey": "scratch-only-synthetic"}
        garage = SimpleNamespace(s3=12345)
        class API:
            s3 = garage.s3
            def __call__(self, *args):
                return api(*args)
        module = SimpleNamespace(converge=lambda *args: None, S3=object)
        return API(), module

    def test_custody_uses_uuid_protocol_and_deletes_only_after_verification(self):
        garage, module = self.standin(self.root)
        with patch.object(canary, "S3", CustodyStandIn):
            report = canary.custody(garage, module, self.root, lambda _progress: None)
        self.assertTrue(report["freshClientByUUID"])
        self.assertEqual(len(CustodyStandIn.objects), 2)
        self.assertFalse((self.root / "producer").exists())

    def test_failed_upload_preserves_producer(self):
        garage, module = self.standin(self.root)
        CustodyStandIn.fail_put = True
        with patch.object(canary, "S3", CustodyStandIn):
            with self.assertRaisesRegex(canary.Refusal, "artifact_put"):
                canary.custody(garage, module, self.root, lambda _progress: None)
        self.assertEqual((self.root / "producer/report.txt").read_bytes(), canary.PAYLOAD)


class LifecycleChecks(LocalChecks):
    def invoke(self, *, fail_stage=None, wrong_mapping=False, fresh_failure=None):
        local = self.root / "garage-canary-test"
        data = self.root / "nas" / local.name
        data.parent.mkdir()
        home, temp = local / ".blob-image/home", local / ".blob-image/tmp"
        actual_owner = canary.owner(self.root)
        mapped = (999999, 999999) if wrong_mapping else actual_owner
        args = SimpleNamespace()
        captured = io.StringIO()
        stopped = []
        custody_api, custody_module = CustodyChecks.standin(self.root)
        CustodyStandIn.producer = home / "producer"
        CustodyStandIn.fresh_failure = fresh_failure

        def check_persisted_custody():
            saved = json.loads((local / "report.json").read_text())["custody"]
            self.assertTrue(saved["custodyBeforeProducerDeletion"])
            self.assertTrue(saved["producerDeleted"])
            self.assertFalse(saved["freshClientByUUID"])
            self.assertEqual(saved["phase"], "fresh-client-creation")
            self.assertEqual(saved["uploadedObjects"], 2)

        CustodyStandIn.fresh_checks = [check_persisted_custody]
        class FakeGarage:
            s3 = custody_api.s3
            process = SimpleNamespace(pid=os.getpid())
            def __init__(self, _binary, _home, *, data_dir):
                if data_dir != data:
                    raise AssertionError("wrong data dir")
                (home / "meta").mkdir()
                (home / "meta/state").write_bytes(b"retained metadata")
            def __call__(self, *args):
                return custody_api(*args)
            def start(self):
                if fail_stage == "start":
                    raise RuntimeError("scratch-only-synthetic-do-not-output")
            def stop(self):
                stopped.append(True)
                if fail_stage == "stop":
                    raise RuntimeError("scratch-only-synthetic-do-not-output")
                self.process = None
        def mount(path):
            # The initial failure artifact must precede even NAS preflight.
            initial = json.loads((local / "report.json").read_text())
            self.assertFalse(initial["passed"])
            if fail_stage == "mount":
                raise canary.Refusal("unexpected_nfs_mount")
            return {"standIn": True}
        remove_owned = canary.remove_owned

        def checked_remove(path, identity, expected_owner):
            if path == home / "producer":
                saved = json.loads((local / "report.json").read_text())["custody"]
                self.assertEqual(saved["phase"], "producer-deletion")
                self.assertTrue(saved["custodyBeforeProducerDeletion"])
                self.assertFalse(saved["producerDeleted"])
                self.assertTrue(path.exists())
                self.assertEqual(saved["uploadedObjects"], 2)
            remove_owned(path, identity, expected_owner)

        original_cwd, original_umask = Path.cwd(), os.umask(0o077)
        self.addCleanup(os.umask, original_umask)
        self.addCleanup(os.chdir, original_cwd)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(canary, "preflight", return_value=(
                local, data, home, temp, actual_owner, mapped)))
            stack.enter_context(patch.object(canary, "nas_mount", side_effect=mount))
            stack.enter_context(patch.object(canary, "MOUNT", data.parent))
            stack.enter_context(patch.object(canary, "prepare_binary", return_value=(home / "garage", {"standIn": True})))
            stack.enter_context(patch.object(canary, "Garage", FakeGarage))
            stack.enter_context(patch.object(canary, "remove_owned", side_effect=checked_remove))
            stack.enter_context(patch.object(canary, "bootstrap", return_value=custody_module))
            def prove(*_args):
                if fail_stage == "custody":
                    raise RuntimeError("scratch-only-synthetic-do-not-output")
                if fail_stage == "home-replaced":
                    home.rename(home.with_name("original-home"))
                    home.mkdir()
                    (home / "replacement").write_bytes(b"preserve replacement")
                _args[-1]({"standIn": True})
            if fresh_failure:
                stack.enter_context(patch.object(canary, "S3", CustodyStandIn))
            else:
                stack.enter_context(patch.object(canary, "custody", side_effect=prove))
            stack.enter_context(contextlib.redirect_stdout(captured))
            status = canary.run(args)
        output = captured.getvalue()
        self.assertNotIn("scratch-only-synthetic", output)
        report = json.loads(output)
        self.assertEqual(json.loads((local / "report.json").read_text()), report)
        return status, report, data, home, stopped

    def test_success_stops_and_cleans_owned_namespaces(self):
        status, report, data, home, stopped = self.invoke()
        self.assertEqual(status, 0)
        self.assertTrue(report["passed"])
        self.assertFalse(data.exists())
        self.assertFalse(home.exists())
        self.assertTrue(stopped)

    def test_setup_failure_has_artifact_and_no_data(self):
        status, report, data, _home, stopped = self.invoke(fail_stage="mount")
        self.assertEqual(status, 1)
        self.assertEqual(report["stage"], "nas-preflight")
        self.assertFalse(data.exists())
        self.assertFalse(stopped)

    def test_wrong_mapping_preserves_new_directory_without_starting(self):
        status, report, data, _home, stopped = self.invoke(wrong_mapping=True)
        self.assertEqual(status, 1)
        self.assertEqual(report["refusal"], "data_ownership_mapping")
        self.assertTrue(data.exists())
        self.assertFalse(stopped)

    def test_start_and_custody_failures_stop_and_preserve(self):
        for stage in ("start", "custody"):
            with self.subTest(stage=stage):
                # invoke consumes its namespace, so use a separate owned subdir.
                prior = self.root
                self.root = prior / stage
                self.root.mkdir()
                status, report, data, home, stopped = self.invoke(fail_stage=stage)
                self.root = prior
                self.assertEqual(status, 1)
                self.assertTrue(report["processStopped"])
                self.assertTrue(data.exists() and home.exists())
                self.assertTrue(stopped)

    def test_uncertain_stop_preserves_originals_and_never_passes(self):
        status, report, data, home, stopped = self.invoke(fail_stage="stop")
        self.assertEqual(status, 1)
        self.assertFalse(report["passed"])
        self.assertFalse(report["processStopped"])
        self.assertTrue(data.exists() and home.exists())
        self.assertTrue(stopped)

    def test_failed_fresh_client_preserves_recovery_report_objects_and_metadata(self):
        for failure in ("creation", "retrieval"):
            with self.subTest(failure=failure):
                prior = self.root
                self.root = prior / failure
                self.root.mkdir()
                status, report, data, home, stopped = self.invoke(fresh_failure=failure)
                self.root = prior
                self.assertEqual(status, 1)
                self.assertFalse(report["passed"])
                self.assertTrue(report["processStopped"])
                custody = report["custody"]
                self.assertTrue(custody["custodyBeforeProducerDeletion"])
                self.assertTrue(custody["producerDeleted"])
                self.assertFalse(custody["freshClientByUUID"])
                self.assertEqual(custody["phase"], "fresh-client-" + failure)
                self.assertEqual(custody["bytes"], len(canary.PAYLOAD))
                self.assertEqual(custody["sha256"], canary.hashlib.sha256(canary.PAYLOAD).hexdigest())
                self.assertEqual(str(canary.uuid.UUID(custody["jobId"])), custody["jobId"])
                self.assertFalse((home / "producer").exists())
                self.assertEqual((home / "meta/state").read_bytes(), b"retained metadata")
                self.assertTrue(data.exists() and stopped)
                self.assertEqual(len(CustodyStandIn.objects), 2)
                self.assertTrue(all("/" + custody["jobId"] + "/" in key
                                    for key in CustodyStandIn.objects))
                # The same UUID still recovers the sole artifact after the failure.
                CustodyStandIn.fresh_failure = None
                CustodyStandIn.fresh_checks = []
                reader = CustodyStandIn(None, None, "reader-a", "scratch-only-synthetic")
                self.assertEqual(canary.retrieve(reader, "artifact-a", custody["jobId"]), canary.PAYLOAD)

    def test_replaced_private_home_refuses_cleanup_using_creation_identity(self):
        status, report, data, home, stopped = self.invoke(fail_stage="home-replaced")
        self.assertEqual(status, 1)
        self.assertFalse(report["passed"])
        self.assertEqual(report["refusal"], "namespace_changed")
        self.assertTrue(stopped and data.exists())
        self.assertNotEqual(tuple(report["privateHomeIdentity"]), canary.fingerprint(home))
        self.assertEqual((home / "replacement").read_bytes(), b"preserve replacement")
        self.assertEqual((home.with_name("original-home") / "meta/state").read_bytes(),
                         b"retained metadata")

    def test_redacted_logs_contain_no_raw_lines(self):
        (self.root / "garage.log").write_bytes(b"ERROR secretAccessKey=synthetic-private\nWARN other\n")
        result = canary.redacted_log(self.root)
        self.assertEqual(result["errorMarkers"], 1)
        self.assertNotIn("synthetic-private", json.dumps(result))



class RestoreCopyChecks(LocalChecks):
    def tree(self):
        path = self.root / "tree"
        path.mkdir(mode=0o700)
        (path / "file").write_bytes(b"known bytes")
        (path / "file").chmod(0o600)
        return path

    def inspect(self, path, **kwargs):
        with patch.object(canary, "mount_for", return_value={"type": "ext4", "target": "/"}):
            return canary.stopped_tree(path, canary.fingerprint(path), canary.owner(path),
                                       nas=False, **kwargs)

    def test_sparse_lmdb_copy_preserves_holes_size_and_bytes(self):
        source = self.tree()
        sparse = source / "lmdb"
        with sparse.open("wb") as stream:
            stream.write(b"node identity")
            stream.seek(1024**3 - 32)
            stream.write(b"durable tail")
        sparse.chmod(0o600)
        copied = self.root / "copy"
        identities = []
        with patch.object(canary, "COPY_ALLOCATED", 1024 * 1024):
            manifest = self.inspect(source, destination=copied, created=lambda p: identities.append(canary.fingerprint(p)))
            self.assertEqual(manifest, self.inspect(copied))
        self.assertEqual(sparse.stat().st_size, (copied / "lmdb").stat().st_size)
        self.assertLess((copied / "lmdb").stat().st_blocks * 512, 1024 * 1024)
        with (copied / "lmdb").open("rb") as stream:
            self.assertEqual(stream.read(13), b"node identity")
            stream.seek(1024**3 - 32)
            self.assertEqual(stream.read(), b"durable tail")
        self.assertEqual(identities, [canary.fingerprint(copied)])
        RESTORE_MEASUREMENTS.update(sparseLogicalBytes=sparse.stat().st_size,
                                    sparseCopiedAllocatedBytes=(copied / "lmdb").stat().st_blocks * 512,
                                    sparseReadLimitBytes=1024 * 1024)

    def test_copy_refuses_symlinks_hardlinks_owner_mode_submount_and_bounds(self):
        source = self.tree()
        target = self.root / "absent"
        for kind in ("symlink", "hardlink", "owner", "mode", "submount", "entries", "allocated", "logical"):
            with self.subTest(kind=kind), contextlib.ExitStack() as stack:
                if kind == "symlink":
                    (source / "bad").symlink_to(source / "file")
                if kind == "hardlink":
                    os.link(source / "file", source / "bad")
                if kind == "owner":
                    stack.enter_context(patch.object(canary, "checked_tree", wraps=canary.checked_tree))
                    with self.assertRaises(canary.Refusal):
                        canary.stopped_tree(source, canary.fingerprint(source), (999999, 999999), nas=False)
                    continue
                if kind == "mode":
                    (source / "file").chmod(0o644)
                for name, value in (("entries", "COPY_ENTRIES"), ("allocated", "COPY_ALLOCATED"),
                                    ("logical", "COPY_LOGICAL")):
                    if kind == name:
                        stack.enter_context(patch.object(canary, value, 1))
                if kind == "submount":
                    stack.enter_context(patch.object(canary, "mount_for", side_effect=lambda p: {
                        "type": "ext4", "target": str(p) if p.name == "file" else "/"}))
                    with self.assertRaisesRegex(canary.Refusal, "submount"):
                        canary.stopped_tree(source, canary.fingerprint(source), canary.owner(source), nas=False)
                else:
                    with self.assertRaises(canary.Refusal):
                        self.inspect(source, destination=target, created=lambda _p: None)
                self.assertFalse(target.exists())
                if kind in ("symlink", "hardlink"):
                    (source / "bad").unlink()
                (source / "file").chmod(0o600)

    def test_unreadable_tree_is_refused_without_a_partial_copy(self):
        source = self.tree()
        target = self.root / "absent"
        def unreadable(_path, **kwargs):
            kwargs["onerror"](PermissionError("unreadable"))
        with patch.object(canary.os, "walk", side_effect=unreadable):
            with self.assertRaisesRegex(canary.Refusal, "tree_unreadable"):
                self.inspect(source, destination=target, created=lambda _p: None)
        self.assertFalse(target.exists())

    def test_existing_destination_and_sparse_seek_fallback_are_bounded(self):
        source = self.tree()
        target = self.root / "existing"
        target.mkdir()
        with self.assertRaisesRegex(canary.Refusal, "restore_destination_exists"):
            self.inspect(source, destination=target, created=lambda _p: None)
        import errno
        with patch.object(canary.os, "lseek", side_effect=OSError(errno.EINVAL, "unsupported")):
            self.assertTrue(self.inspect(source))
            with (source / "file").open("wb") as stream:
                stream.truncate(canary.COPY_ALLOCATED + 1)
            with self.assertRaisesRegex(canary.Refusal, "sparse_seek_required"):
                self.inspect(source)


class RestoreChecks(LocalChecks):
    def invoke_restore(self, failure=None):
        local = self.root / "garage-canary-restore"
        data = self.root / "nas" / local.name
        data.parent.mkdir(mode=0o700)
        home, temp = local / ".blob-image/home", local / ".blob-image/tmp"
        restored_data = data.with_name(data.name + "-restored")
        actual = canary.owner(self.root)
        events, instances, copies = [], [], []
        _, module = CustodyChecks.standin(home)
        convergences = []
        def converge(*_args):
            convergences.append(True)
            self.assertEqual(len(convergences), 1, "restore must never bootstrap")
        module.converge = converge
        names = ("writer-a", "reader-a", "other-b")
        class Process:
            pid = os.getpid()
            stopped = False
            def poll(self):
                return 0 if self.stopped else None
        class FakeGarage(Garage):
            def __init__(self, binary, new_home, **kwargs):
                super().__init__(binary, new_home, **kwargs)
                instances.append(self)
            def __call__(self, endpoint, _payload=None):
                if endpoint == "ListBuckets":
                    return json.loads((self.meta / "buckets").read_text())
                if endpoint == "ListKeys":
                    return json.loads((self.meta / "keys").read_text())
                return {"secretAccessKey": "scratch-only-synthetic"}
            def start(self):
                is_restore = self.home != home
                self.process = Process()
                if not is_restore:
                    self.meta.mkdir(mode=0o700)
                    (self.meta / "buckets").write_text(json.dumps([{"id": "durable-bucket", "name": "artifact-a"}]))
                    (self.meta / "keys").write_text(json.dumps([{"name": n, "id": n} for n in names]))
                    (self.meta / "node-id").write_bytes(b"durable node identity")
                    if failure == "collision":
                        restored_data.mkdir(mode=0o700)
                        (restored_data / "keep").write_bytes(b"unowned collision")
                else:
                    events.append("restored-start")
                    self_outer.assertTrue(data.exists() and (home / "meta").exists())
                    self_outer.assertEqual((self.meta / "node-id").read_bytes(), b"durable node identity")
                    self_outer.assertEqual(self.secret.read_bytes(), instances[0].secret.read_bytes())
                    if failure == "start":
                        raise RuntimeError("scratch-only-synthetic-do-not-output")
                    objects = json.loads((self.data / "objects").read_text())
                    CustodyStandIn.objects = {k: bytes.fromhex(v) for k, v in objects.items()}
                    if failure == "bytes":
                        key = next(k for k in CustodyStandIn.objects if "/objects/" in k)
                        CustodyStandIn.objects[key] = b"corrupt"
                    if failure == "state":
                        (self.meta / "buckets").write_text("[]")
            def stop(self):
                if self.process is not None:
                    events.append("original-stop" if self.home == home else "restored-stop")
                    if (failure == "stop" and self.home == home or
                            failure == "restored-stop" and self.home != home):
                        raise RuntimeError("scratch-only-synthetic-do-not-output")
                    if self.home == home:
                        (self.data / "objects").write_text(json.dumps({
                            k: v.hex() for k, v in CustodyStandIn.objects.items()}))
                    self.process.stopped = True
                    self.process = None
        self_outer = self
        original_tree, original_remove = canary.stopped_tree, canary.remove_owned
        def tree(path, *args, **kwargs):
            self.assertIsNone(instances[0].process, "all copying follows confirmed stop")
            if kwargs.get("destination") is not None:
                copies.append(str(path))
                events.append("copy")
                if failure == "copy":
                    raise canary.Refusal("injected_copy_failure")
            result = original_tree(path, *args, **kwargs)
            if failure == "pair-mismatch" and kwargs.get("destination") == local / "restored-home/meta":
                (local / "restored-home/meta/node-id").write_bytes(b"wrong durable identity")
            return result
        def remove(path, *args):
            if path != home / "producer":
                saved = json.loads((local / "report.json").read_text())
                self.assertTrue(saved["restore"]["verified"])
                self.assertTrue(saved["restore"]["sameUUIDBytes"])
                self.assertTrue(all(item.process is None for item in instances))
                if failure == "cleanup":
                    events.append("cleanup-attempt")
                    raise canary.Refusal("injected_cleanup_refusal")
                events.append("cleanup")
            return original_remove(path, *args)
        original_owner = canary.owner
        def observed_owner(path):
            return (999999, 999999) if failure == "mapped" and path == restored_data else original_owner(path)
        original_request = CustodyStandIn.request
        def request(client, method, path, body=b""):
            if failure == "denial" and len(instances) == 2 and client.access == "other-b":
                return 200, canary.PAYLOAD
            return original_request(client, method, path, body)
        captured = io.StringIO()
        cwd, mask = Path.cwd(), os.umask(0o077)
        self.addCleanup(os.chdir, cwd)
        self.addCleanup(os.umask, mask)
        with contextlib.ExitStack() as stack:
            for name, value in {
                "preflight": lambda _a: (local, data, home, temp, actual, actual),
                "nas_mount": lambda p: {"type": "nfs", "target": str(data.parent)},
                "mount_for": lambda p: {"type": "nfs", "target": str(data.parent)} if data.parent in p.parents
                                      else {"type": "ext4", "target": "/"},
                "prepare_binary": lambda: (home / "garage", {"standIn": True}),
                "bootstrap": lambda _h: module, "Garage": FakeGarage, "S3": CustodyStandIn,
                "stopped_tree": tree, "remove_owned": remove, "MOUNT": data.parent, "owner": observed_owner,
            }.items():
                stack.enter_context(patch.object(canary, name, value))
            stack.enter_context(patch.object(CustodyStandIn, "request", request))
            stack.enter_context(contextlib.redirect_stdout(captured))
            status = canary.run(SimpleNamespace(stopped_restore=True))
        output = captured.getvalue()
        self.assertNotIn("scratch-only-synthetic", output)
        report = json.loads(output)
        self.assertEqual(report, json.loads((local / "report.json").read_text()))
        return status, report, local, data, home, restored_data, events, copies, instances

    def test_stopped_pair_restores_uuid_manifest_state_denials_then_cleans(self):
        status, report, local, data, home, restored, events, copies, instances = self.invoke_restore()
        self.assertEqual(status, 0, report)
        self.assertTrue(report["passed"] and report["restore"]["verified"])
        self.assertEqual(report["custody"]["jobId"], report["restore"]["jobId"])
        self.assertEqual(len(copies), 4)
        self.assertLess(events.index("original-stop"), events.index("copy"))
        self.assertLess(events.index("restored-stop"), events.index("cleanup"))
        self.assertFalse(any(p.exists() for p in (data, home, restored, local / "stopped-backup",
                                                  local / "restored-home")))
        self.assertTrue(all(g.process is None for g in instances))

    def test_stop_copy_start_byte_state_denial_failures_preserve_recoverable_pair(self):
        for failure in ("stop", "copy", "start", "bytes", "state", "denial", "collision",
                        "mapped", "pair-mismatch", "restored-stop", "cleanup"):
            with self.subTest(failure=failure):
                prior = self.root
                self.root = prior / failure
                self.root.mkdir(mode=0o700)
                status, report, local, data, home, restored, events, copies, instances = self.invoke_restore(failure)
                self.root = prior
                self.assertEqual(status, 1)
                self.assertFalse(report["passed"])
                self.assertEqual(report["restore"]["verified"], failure in ("restored-stop", "cleanup"))
                self.assertTrue(data.exists() and (home / "meta").exists())
                self.assertEqual(report["restore"]["jobId"], report["custody"]["jobId"])
                self.assertNotIn("cleanup", events)
                if failure == "stop":
                    self.assertEqual(copies, [])
                    self.assertFalse(report["processStopped"])
                elif failure == "restored-stop":
                    self.assertFalse(report["restore"]["processStopped"])
                    self.assertTrue(report["processStopped"])
                    self.assertIn("pid", report["restore"])
                    self.assertIn("processStartTicks", report["restore"])
                else:
                    self.assertTrue(all(g.process is None for g in instances))
                if failure == "collision":
                    self.assertEqual((restored / "keep").read_bytes(), b"unowned collision")
                if failure in ("start", "bytes", "state", "denial", "mapped", "pair-mismatch",
                               "restored-stop", "cleanup"):
                    self.assertTrue((local / "stopped-backup/pair.json").exists())
                    self.assertTrue(report["restore"]["pairManifestSHA256"])
                    self.assertTrue((local / "stopped-backup/data").exists())
        RESTORE_MEASUREMENTS["injectedFailureCases"] = 11


if __name__ == "__main__":
    job = Path.cwd()
    assert Path(os.environ["HOME"]) == job / ".nas-canary-check/home"
    assert Path(os.environ["TMPDIR"]) == job / ".nas-canary-check/tmp"
    assert not str(job).startswith("/tmp/")
    suite = unittest.TestSuite()
    import sys
    classes = (RestoreCopyChecks, RestoreChecks) if "--restore-only" in sys.argv else (
        LocalChecks, CustodyChecks, LifecycleChecks, RestoreCopyChecks, RestoreChecks)
    for cls in classes:
        # Inherited checks need only run once.
        suite.addTests(cls(name) for name in cls.__dict__ if name.startswith("test_"))
    if "--restore-only" in sys.argv:
        suite.addTest(LocalChecks("test_garage_config_seam_preserves_default"))
        suite.addTest(CustodyChecks("test_custody_uses_uuid_protocol_and_deletes_only_after_verification"))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    artifact = Path("nas-canary-check.json")
    report = json.loads(artifact.read_text())
    report.update(passed=result.wasSuccessful(), checks=result.testsRun,
                  selection="restore-only" if "--restore-only" in sys.argv else "all-stand-ins",
                  restoreMeasurements=RESTORE_MEASUREMENTS, imageAcquisitionRerun=False)
    artifact.write_text(json.dumps(report, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
