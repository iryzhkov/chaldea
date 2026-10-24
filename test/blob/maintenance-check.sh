#!/bin/sh
set -eu
umask 077
root=$(pwd -P)
scratch="$root/.cache/blob-maintenance-check"
test ! -e "$scratch"
export TMPDIR="$scratch" HOME="$scratch/home"
export BLOB_TEST_HOME="$HOME"
test "$HOME" = "$root/.cache/blob-maintenance-check/home"
test "$TMPDIR" = "$root/.cache/blob-maintenance-check"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
mkdir -p "$HOME"
trap 'rm -rf "$scratch"' EXIT
npm ci --ignore-scripts --silent --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000
npm run exec:check
node --test test/exec/blob-maintenance.test.ts test/exec/blob-cleanup.test.ts test/exec/blob.test.ts
python3 -B test/blob/maintenance_pair.py
PYTHONPATH=test/blob python3 -B -m unittest nas_canary_checks.RestoreCopyChecks
