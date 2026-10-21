#!/bin/sh
set -eu
umask 077
job_root=$(pwd -P)
scratch="$job_root/.blob-retention-tests"
test ! -e "$scratch"
export HOME="$scratch/home" TMPDIR="$scratch/tmp"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.blob-retention-tests/home"
test "$TMPDIR" = "$job_root/.blob-retention-tests/tmp"
case "$HOME" in /home/igor|/root|/tmp/*) exit 90;; esac
mkdir -p "$HOME" "$TMPDIR"
trap 'rm -rf "$scratch"' EXIT
printf '%s\n' '{"passed":false,"proof":"garage-custody"}' > blob-custody-proof.json
npm ci --ignore-scripts --silent --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000
npm run exec:check
if node --test --test-reporter=tap test/exec/blob-cleanup.test.ts test/exec/blob.test.ts > blob-retention-contracts.tap; then
  cat blob-retention-contracts.tap
else
  cat blob-retention-contracts.tap
  exit 1
fi
sh test/blob/run.sh
