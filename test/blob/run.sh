#!/bin/sh
set -eu
umask 077
job_root=$(pwd -P)
export HOME="$job_root/.blob-image/home" TMPDIR="$job_root/.blob-image/tmp"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.blob-image/home"
test "$TMPDIR" = "$job_root/.blob-image/tmp"
case "$HOME" in /home/igor|/root|/tmp/*) exit 90;; esac
test ! -e "$job_root/.blob-image"
mkdir -p "$HOME" "$TMPDIR"
trap 'rm -rf "$job_root/.blob-image"' EXIT
printf '%s\n' '{"passed":false,"proof":"garage-custody"}' > blob-custody-proof.json
python3 -B test/blob/garage.py
