#!/usr/bin/env python3
"""Rootless real-SSH chaldea exec acceptance against this role, using scratch only."""
import argparse
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time

from jinja2 import Environment, StrictUndefined
import yaml

ROLE = Path(__file__).resolve().parents[1]


def run(argv, **kwargs):
    return subprocess.run([str(a) for a in argv], check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chaldea", required=True, type=Path, help="iryzhkov/chaldea checkout")
    parser.add_argument("--tree", required=True, type=Path, help="scratch toolchain installation")
    parser.add_argument("--versions", required=True, type=Path, help="JSON mapping of tool to installed version; supplied by fleet configuration")
    args = parser.parse_args()
    scratch_root = Path(os.environ["TMPDIR"])
    assert scratch_root.is_absolute() and str(scratch_root) != "/tmp"
    assert os.getuid() != 0, "run unprivileged; no real host enrollment"
    selected = json.loads(args.versions.read_text())
    with tempfile.TemporaryDirectory(prefix="tc-", dir=scratch_root) as temporary:
        scratch = Path(temporary)
        work, jobs = scratch / "work", scratch / "jobs"
        work.mkdir()
        jobs.mkdir()
        run(["git", "init", "-q", work])
        for name in ("host", "client"):
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", scratch / name])
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = scratch / "server.json"
        config.write_text(json.dumps({"state_root": str(jobs), "require_mount": False,
                                     "toolchain_root": str(args.tree.resolve()),
                                     "toolchain_defaults": selected}))
        user = pwd.getpwuid(os.getuid()).pw_name
        values = {
            "chaldea_job_host_port": port, "chaldea_job_host_user": user,
            "chaldea_job_host_listen": ["127.0.0.1"],
            "chaldea_job_host_pid_file": str(scratch / "sshd.pid"),
            "chaldea_job_host_host_key": str(scratch / "host"),
            "chaldea_job_host_authorized_keys": str(scratch / "authorized_keys"),
            "chaldea_job_host_log_level": "VERBOSE",
            "chaldea_job_host_slots": 1,
            "chaldea_job_host_command": f"/usr/bin/python3 -I {ROLE}/chaldea-job-server --config {config}",
            "chaldea_job_host_sources": [{"ip": "127.0.0.1",
                                         "public_key": (scratch / "client.pub").read_text().strip()}],
        }
        templates = Environment(undefined=StrictUndefined)
        for src, dest in (("chaldea-job-sshd.conf.j2", "sshd.conf"), ("authorized_keys.j2", "authorized_keys")):
            (scratch / dest).write_text(templates.from_string((ROLE / "tests/fixtures" / src).read_text()).render(**values))
        (scratch / "known_hosts").write_text(f"[127.0.0.1]:{port} " + (scratch / "host.pub").read_text())
        ssh_config = scratch / "ssh.conf"
        ssh_config.write_text(f"""Host chaldea-job-test
  HostName 127.0.0.1
  Port {port}
  User {user}
  IdentityFile {scratch}/client
  IdentitiesOnly yes
  IdentityAgent none
  StrictHostKeyChecking yes
  UserKnownHostsFile {scratch}/known_hosts
  ControlMaster no
""")
        (work / "package.json").write_text(json.dumps({
            "name": "job-toolchains-smoke", "version": "1.0.0",
            "scripts": {"build": "node build.js"}}))
        (work / "package-lock.json").write_text(json.dumps({
            "name": "job-toolchains-smoke", "version": "1.0.0", "lockfileVersion": 3,
            "packages": {"": {"name": "job-toolchains-smoke", "version": "1.0.0"}}}))
        (work / "build.js").write_text("require('node:fs').writeFileSync('result', 'npm-build-ok');\n")
        (work / "hello.go").write_text('package main\nimport "fmt"\nfunc main() { fmt.Println("go-build-ok") }\n')
        (work / "Cargo.toml").write_text('[package]\nname="job-smoke"\nversion="0.1.0"\nedition="2024"\n[[bin]]\nname="job-smoke"\npath="main.rs"\n')
        (work / "main.rs").write_text('fn main() { println!("cargo-build-ok"); }\n')
        with tarfile.open(work / "owned.tar", "w") as archive:
            info = tarfile.TarInfo("extracted")
            info.uid = info.gid = 12345
            info.size = 7
            archive.addfile(info, io.BytesIO(b"tar-ok\n"))
        script = """set -eu
node --version
go version
rustc --version
cargo --version
cc --version
uv --version
node -e "try { require('fs').writeFileSync(require('path').join(require('path').dirname(process.execPath),'should-not-exist'),'x'); process.exit(1); } catch (e) { if(e.code !== 'EROFS') throw e; console.log('readonly-tools-ok'); }"
npm ci --no-audit --no-fund
npm run build
cat result
go build -o hello hello.go
./hello
cargo build --offline
./target/debug/job-smoke
cargo new --vcs none --bin tiny-cargo
cargo build --offline --manifest-path tiny-cargo/Cargo.toml
./tiny-cargo/target/debug/tiny-cargo
python3 - <<'PY'
import errno
from pathlib import Path
assert not any(Path(p).exists() for p in ("/etc/shadow", "/etc/sudoers", "/root/.ssh", "/home/igor/.ssh"))
if Path("/etc/alternatives").exists():
    try:
        Path("/etc/alternatives/chaldea-write-probe").write_text("forbidden")
    except OSError as error:
        assert error.errno == errno.EROFS, error
    else:
        raise AssertionError("alternatives is writable")
print("alternatives-isolation-ok")
PY
uv venv --python /usr/bin/python3 --no-managed-python .venv
mkdir extracted-dir refused-dir
if env -u TAR_OPTIONS tar xf owned.tar -C refused-dir 2>/dev/null; then
  echo "negative control: tar unexpectedly preserved foreign ownership" >&2
  exit 1
fi
tar xf owned.tar -C extracted-dir
cat extracted-dir/extracted
python3 -c 'import os,pathlib; assert all(os.environ[k].startswith("/home/job/") for k in ("npm_config_cache","CARGO_HOME","GOPATH","GOMODCACHE","GOCACHE","UV_CACHE_DIR")); print("private-caches-ok")'
"""
        (work / "smoke.sh").write_text(script)
        environment = {**os.environ, "CHALDEA_STATE_DIR": str(scratch / "state"),
                       "CHALDEA_SSH_CONFIG": str(ssh_config)}
        sshd = shutil.which("sshd")
        assert sshd is not None
        run([sshd, "-t", "-f", scratch / "sshd.conf"])
        with (scratch / "sshd.log").open("w+") as log:
            daemon = subprocess.Popen([sshd, "-D", "-e", "-f", str(scratch / "sshd.conf")], stderr=log)
            try:
                for _ in range(100):
                    if daemon.poll() is not None:
                        raise RuntimeError("sshd failed: " + (scratch / "sshd.log").read_text())
                    with socket.socket() as probe:
                        if probe.connect_ex(("127.0.0.1", port)) == 0:
                            break
                    time.sleep(0.05)
                result = run(["node", args.chaldea / "bin/chaldea", "exec", "--host", "test",
                              "--", "sh", "smoke.sh"], cwd=work, env=environment,
                             capture_output=True, timeout=120)
                print(result.stdout)
                print(result.stderr)
                assert all(token in result.stdout for token in
                           ("v" + selected["node"], "go" + selected["go"],
                            "cargo " + selected["rust"], "uv " + selected["uv"],
                            "npm-build-ok", "go-build-ok", "cargo-build-ok", "Hello, world!",
                            "alternatives-isolation-ok", "tar-ok", "private-caches-ok", "readonly-tools-ok"))
                assert not [p for p in jobs.iterdir() if p.name != "admission.lock"], "workspace/caches survived"
                print("exec-toolchains-ok; workspace and caches removed")
            except subprocess.CalledProcessError as error:
                print(error.stdout or "")
                print(error.stderr or "")
                raise
            finally:
                daemon.terminate()
                daemon.wait(timeout=5)


if __name__ == "__main__":
    main()
