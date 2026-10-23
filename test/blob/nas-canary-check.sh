#!/bin/sh
# Selected checks only. No live NAS invocation or default suite attachment.
set -eu
umask 077
job_root=$(pwd -P)
case "$job_root" in /tmp|/tmp/*|/dev/shm|/dev/shm/*) exit 90;; esac
export HOME="$job_root/.nas-canary-check/home" TMPDIR="$job_root/.nas-canary-check/tmp"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.nas-canary-check/home"
test "$TMPDIR" = "$job_root/.nas-canary-check/tmp"
# Initialize failure evidence before setup/imports. Hash the actual job snapshot.
python3 -B - <<'PY'
import hashlib
import json
from pathlib import Path

artifact = Path("nas-canary-check.json")
report = {"passed": False, "proof": "new-canary-local-stand-ins", "nasProof": False,
          "sourceInputs": {"algorithm": "sha256", "files": {}}}
artifact.write_text(json.dumps(report, indent=2) + "\n")
for name in ("nas-canary-check.sh", "nas_canary_checks.py", "nas_canary.py",
             "garage.py", "image.py", "protocol.py", "exec_client.py", "retention.py",
             "vendor/garage-bootstrap.py", "NAS-CANARY.md"):
    path = Path("test/blob") / name
    report["sourceInputs"]["files"][str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
artifact.write_text(json.dumps(report, indent=2) + "\n")
PY
test ! -e "$job_root/.nas-canary-check"
test ! -L "$job_root/.nas-canary-check"
mkdir "$job_root/.nas-canary-check"
mkdir "$HOME" "$TMPDIR"
trap 'rm -rf "$job_root/.nas-canary-check"' EXIT
timeout 60s python3 -B test/blob/nas_canary_checks.py
