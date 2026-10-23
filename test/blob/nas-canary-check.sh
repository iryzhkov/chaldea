#!/bin/sh
# Selected checks only. No live NAS invocation or default suite attachment.
set -eu
umask 077
job_root=$(pwd -P)
printf '%s\n' '{"passed":false,"proof":"new-canary-local-stand-ins","nasProof":false}' > nas-canary-check.json
case "$job_root" in /tmp|/tmp/*|/dev/shm|/dev/shm/*) exit 90;; esac
export HOME="$job_root/.nas-canary-check/home" TMPDIR="$job_root/.nas-canary-check/tmp"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.nas-canary-check/home"
test "$TMPDIR" = "$job_root/.nas-canary-check/tmp"
test ! -e "$job_root/.nas-canary-check"
test ! -L "$job_root/.nas-canary-check"
mkdir "$job_root/.nas-canary-check"
mkdir "$HOME" "$TMPDIR"
trap 'rm -rf "$job_root/.nas-canary-check"' EXIT
timeout 60s python3 -B test/blob/nas_canary_checks.py
