#!/usr/bin/env python3
"""Real Git data fixtures; no SSH, private keys, runtime or host services."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("trust_fetcher", str(
    ROOT / "chaldea-access-trust-fetch"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
fetcher = importlib.util.module_from_spec(spec)
loader.exec_module(fetcher)


class FetcherTest(unittest.TestCase):
    def setUp(self):
        scratch = Path(os.environ["TMPDIR"]).resolve()
        home = Path(os.environ["HOME"]).resolve()
        self.assertTrue(home.is_relative_to(scratch))
        self.assertNotEqual(home, Path("/home/igor"))
        self.temp = tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        remote = tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(remote.cleanup)
        self.remote = Path(remote.name) / "chaldea-trust.git"
        self.config = {"state": str(self.root), "node": "/synthetic/node",
                       "runtime": "/synthetic/runtime", "key": str(self.root / "key"),
                       "known_hosts": str(self.root / "known_hosts"),
                       "anchors": str(self.root / "anchors.json"),
                       "health": str(self.root / "clock.json"),
                       "output": str(self.root / "public.jws"),
                       "repository": fetcher.REMOTE, "bundle_path": fetcher.BUNDLE}
        for name in ("key", "known_hosts"):
            (self.root / name).write_text("metadata fixture only, never a key")
            (self.root / name).chmod(0o600)
        (self.root / "public.jws").write_text("previous")
        self.calls = []
        self.git_env = dict(os.environ, GIT_AUTHOR_NAME="fixture", GIT_COMMITTER_NAME="fixture",
                            GIT_AUTHOR_EMAIL="fixture@example.invalid",
                            GIT_COMMITTER_EMAIL="fixture@example.invalid",
                            GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
        self.cache = self.root / "git"
        self.real_run = subprocess.run
        self.real_run_git = fetcher.run_git
        self.real_fetch = False
        self.git("init", "--bare", str(self.cache))
        self.envelope = b"synthetic.envelope.fixture"
        self.install_fail = False
        self.commit()

    def git(self, *args, data=None, git_dir=None):
        return self.real_run(["/usr/bin/git", "--git-dir=" + str(git_dir or self.cache), *args],
                             input=data, env=self.git_env, check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def commit(self, mode="100644", path="bundle.jws", git_dir=None, ref=fetcher.REF):
        git = lambda *a, data=None: self.git(*a, data=data, git_dir=git_dir)  # noqa: E731
        git("read-tree", "--empty")
        blob = git("hash-object", "-w", "--stdin", data=self.envelope).decode().strip()
        git("update-index", "--add", "--cacheinfo", mode + "," + blob + "," + path)
        tree = git("write-tree").decode().strip()
        self.head = git("commit-tree", tree, data=b"fixture\n").decode().strip()
        git("update-ref", ref, self.head)

    def publish(self, envelope):
        """Commit a bundle to the local fixture remote that real fetches read."""
        if not self.remote.exists():
            self.git("init", "--bare", str(self.remote))
        self.envelope = envelope
        self.commit(git_dir=self.remote, ref="refs/heads/main")
        self.real_fetch = True

    def command(self, args, **kwargs):
        args = list(args)
        self.calls.append(args)
        if "fetch" in args:
            self.assertIn("ssh://git@github.com/iryzhkov/chaldea-trust.git", args)
            self.assertIn("+refs/heads/main:" + fetcher.REF, args)
            env = kwargs["env"]
            self.assertIn("IdentityAgent=none", env["GIT_SSH_COMMAND"])
            self.assertIn("-F /dev/null", env["GIT_SSH_COMMAND"])
            self.assertIn("StrictHostKeyChecking=yes", env["GIT_SSH_COMMAND"])
            self.assertIn("UserKnownHostsFile=" + self.config["known_hosts"], env["GIT_SSH_COMMAND"])
            self.assertIn("GlobalKnownHostsFile=/dev/null", env["GIT_SSH_COMMAND"])
            self.assertIn("UpdateHostKeys=no", env["GIT_SSH_COMMAND"])
            if not self.real_fetch:
                return b""
            # Same Git invocation, but from the local fixture instead of GitHub over SSH.
            args = [args[0], "-c", "protocol.file.allow=always", *args[1:]]
            args[args.index(fetcher.REMOTE)] = "file://" + str(self.remote)
        if args[0] == "/synthetic/node":
            if self.install_fail:
                raise subprocess.CalledProcessError(1, args)
            opts = dict(zip(args[3::2], args[4::2]))
            self.assertEqual(Path(opts["--bundle-file"]).read_bytes(), self.envelope)
            self.assertEqual(opts["--state-file"], str(self.root / "updater.sqlite"))
            Path(opts["--output"]).write_bytes(self.envelope)
            return subprocess.CompletedProcess(args, 0)
        self.assertEqual(args[0], "/usr/bin/git")
        self.assertNotIn("push", args)
        return self.real_run_git(args, **kwargs)

    @contextlib.contextmanager
    def patched(self):
        with mock.patch.object(fetcher, "trusted_runtime"), \
                mock.patch.object(fetcher, "run_git", side_effect=self.command), \
                mock.patch.object(fetcher.subprocess, "run", side_effect=self.command):
            yield

    def fetch(self):
        with self.patched():
            fetcher.fetch(self.config)

    def main(self):
        """Run the command entry point; return its exit status and stderr."""
        path = self.root / "updater.json"
        path.write_text(json.dumps(self.config))
        path.chmod(0o600)
        stderr = io.StringIO()
        umask = os.umask(0o022)
        os.umask(umask)
        self.addCleanup(os.umask, umask)
        with self.patched(), mock.patch.object(sys, "argv", ["fetch", str(path)]), \
                contextlib.redirect_stderr(stderr):
            status = fetcher.main()
        return status, stderr.getvalue()

    def lock(self, name, age):
        path = self.cache / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    def test_fetches_root_bundle_from_data_repo_then_calls_installer(self):
        self.fetch()
        self.assertEqual((self.root / "public.jws").read_bytes(), self.envelope)
        self.assertFalse((self.root / "candidate.jws").exists())
        self.assertFalse(any("checkout" in c or "push" in c for c in self.calls))

    def test_old_path_executable_and_symlink_refused_without_install(self):
        for mode, path in (("100644", "access-trust/bundle.jws"),
                           ("100755", "bundle.jws"), ("120000", "bundle.jws")):
            self.commit(mode, path)
            with self.assertRaisesRegex(ValueError, "nonregular"):
                self.fetch()
            self.assertEqual((self.root / "public.jws").read_text(), "previous")
        self.assertFalse(any(c[0] == "/synthetic/node" for c in self.calls))

    def test_failed_verification_preserves_previous_publication(self):
        self.install_fail = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.fetch()
        self.assertEqual((self.root / "public.jws").read_text(), "previous")
        self.assertFalse((self.root / "candidate.jws").exists())

    def test_legacy_repo_pin_refused_before_any_command(self):
        self.config["repository"] = "ssh://git@github.com/iryzhkov/chaldea-fleet-config.git"
        with self.assertRaisesRegex(ValueError, "transport pin"):
            self.fetch()
        self.assertEqual(self.calls, [])

    def test_real_shallow_fetch_installs_bundle(self):
        self.publish(b"first.envelope.fixture")
        self.fetch()
        self.assertEqual((self.root / "public.jws").read_bytes(), b"first.envelope.fixture")
        self.assertTrue((self.cache / "shallow").exists())

    def test_stale_locks_from_a_killed_git_are_recovered(self):
        self.publish(b"first.envelope.fixture")
        self.fetch()
        # What a SIGKILLed shallow fetch leaves behind: empty lock files.
        stale = [self.lock("shallow.lock", 3600),
                 self.lock("refs/heads/trust-source.lock", 3600)]
        outside = self.root / "candidate.lock"
        outside.write_bytes(b"")
        os.utime(outside, (0, 0))
        self.publish(b"second.envelope.fixture")
        status, stderr = self.main()
        self.assertEqual(status, 0, stderr)
        self.assertEqual((self.root / "public.jws").read_bytes(), b"second.envelope.fixture")
        for path in stale:
            self.assertFalse(path.exists())
        self.assertTrue(outside.exists())
        self.assertIn("removed stale transport cache lock(s): refs/heads/trust-source.lock, "
                      "shallow.lock", stderr)

    def test_fresh_lock_is_kept_and_git_stderr_is_reported(self):
        self.publish(b"first.envelope.fixture")
        self.fetch()
        fresh = self.lock("shallow.lock", 1)
        self.publish(b"second.envelope.fixture")
        status, stderr = self.main()
        self.assertEqual(status, 1)
        self.assertTrue(fresh.exists())
        self.assertEqual((self.root / "public.jws").read_bytes(), b"first.envelope.fixture")
        self.assertIn("chaldea trust: git fetch exited 128: ", stderr)
        self.assertIn("shallow.lock': File exists", stderr)
        self.assertTrue(stderr.endswith(
            "chaldea trust: update failed; cached signed expiry is unchanged\n"))
        self.assertNotIn("metadata fixture only", stderr)

    def test_stale_lock_symlink_is_not_followed(self):
        target = self.root / "key"
        link = self.cache / "packed-refs.lock"
        link.symlink_to(target)
        self.assertEqual(fetcher.clear_stale_locks(self.cache, now=time.time() + 3600), [])
        self.assertTrue(link.is_symlink())
        self.assertTrue(target.exists())

    def test_concurrent_update_is_refused_before_any_git(self):
        held = fetcher.lock_state(self.root)
        self.addCleanup(os.close, held)
        with self.assertRaisesRegex(RuntimeError, "state lock"):
            self.fetch()
        self.assertEqual(self.calls, [])

    def test_git_keeps_the_state_lock_after_the_fetcher_dies(self):
        ready = self.root / "ready"
        child = (
            "import importlib.machinery, importlib.util, sys\n"
            "loader = importlib.machinery.SourceFileLoader('f', sys.argv[1])\n"
            "f = importlib.util.module_from_spec(importlib.util.spec_from_loader('f', loader))\n"
            "loader.exec_module(f)\n"
            "lock = f.lock_state(sys.argv[2])\n"
            "f.run_git(['/bin/sh', '-c', ': > \"$0\"; exec sleep 3', sys.argv[3]],"
            " env={'PATH': '/usr/bin:/bin'}, pass_fds=(lock,))\n")
        fetcher_process = subprocess.Popen(
            [sys.executable, "-c", child, str(ROOT / "chaldea-access-trust-fetch"),
             str(self.root), str(ready)])
        self.addCleanup(fetcher_process.wait)
        deadline = time.monotonic() + 10
        while not ready.exists():
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        fetcher_process.kill()
        fetcher_process.wait()
        # The orphaned Git-like child still holds the inherited lock ...
        with self.assertRaisesRegex(RuntimeError, "state lock"):
            fetcher.lock_state(self.root)
        # ... and releases it when it exits.
        deadline = time.monotonic() + 10
        while True:
            try:
                os.close(fetcher.lock_state(self.root))
                break
            except RuntimeError:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.1)

    def test_git_ignoring_sigterm_is_killed_after_the_grace_period(self):
        started = time.monotonic()
        with mock.patch.object(fetcher, "GIT_TERM_GRACE", 0.5), \
                self.assertRaises(subprocess.TimeoutExpired):
            fetcher.run_git(["/bin/sh", "-c", "trap '' TERM; sleep 30"],
                            env=dict(os.environ), timeout=0.5)
        self.assertLess(time.monotonic() - started, 10)

    def test_git_stderr_is_sanitized(self):
        argv = ["/usr/bin/git", "-c", "gc.auto=0", "--git-dir=/state/git", "fetch", "--depth=1"]
        error = subprocess.CalledProcessError(
            128, argv, b"stdout is never reported",
            b"remote: one\nremote: two\r\nwarning: \x1b[31mred\nfatal: last\n")
        self.assertEqual(fetcher.describe(error),
                         "git fetch exited 128: remote: two | warning: ?[31mred | fatal: last")
        error.stderr = b"fatal: x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n"
        self.assertEqual(fetcher.describe(error), "git fetch exited 128: (stderr withheld)")
        installer = subprocess.CalledProcessError(1, ["/opt/node", "runtime"], b"x", b"secret")
        self.assertEqual(fetcher.describe(installer), "installer exited 1")
        self.assertEqual(fetcher.describe(OSError("/etc/chaldea-access-trust/deploy-key")),
                         "OSError")

    def test_git_timeout_terminates_gracefully_so_git_can_drop_its_locks(self):
        marker = self.root / "held.lock"
        script = 'trap \'rm -f "$0"; exit 143\' TERM; : > "$0"; echo started >&2; sleep 30 & wait'
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            fetcher.run_git(["/bin/sh", "-c", script, str(marker)], env=dict(os.environ),
                            timeout=1)
        self.assertLess(time.monotonic() - started, fetcher.GIT_TERM_GRACE)
        self.assertFalse(marker.exists())
        self.assertIn(b"started", caught.exception.stderr or b"")


if __name__ == "__main__":
    unittest.main()
