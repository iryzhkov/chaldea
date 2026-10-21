#!/bin/sh
set -eu
umask 077
job_root=$(pwd -P)
job_scratch="$job_root/.davinci-job"
export HOME="$job_scratch/home" TMPDIR="$job_scratch/tmp" CHALDEA_TEST_SCRATCH="$job_scratch/tests"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.davinci-job/home"
test "$TMPDIR" = "$job_root/.davinci-job/tmp"
case "$HOME" in /home/igor|/root|/tmp/*) exit 90;; esac
mkdir -p "$HOME" "$TMPDIR" "$CHALDEA_TEST_SCRATCH"
trap 'rm -rf "$job_scratch"' EXIT
printf '%s\n' '{"proof":"signed-occurrence","passed":false}' > davinci-proof.json
printf '%s\n' '{"proof":"signed-occurrence","passed":false}' > davinci-restarted.json
curl -fLsS --retry 3 https://github.com/nats-io/nats-server/releases/download/v2.15.1/nats-server-v2.15.1-linux-amd64.tar.gz -o "$job_scratch/nats.tar.gz"
printf '%s  %s\n' bf5edc7b1ce98e885c368cb43a886eb148dc5d0551d99f3cf6141fb5e1954c70 "$job_scratch/nats.tar.gz" | sha256sum -c -
tar --no-same-owner -xzf "$job_scratch/nats.tar.gz" -C "$job_scratch"
export NATS_SERVER="$job_scratch/nats-server-v2.15.1-linux-amd64/nats-server"
sh scripts/ci/install-t3 "$job_scratch/t3"
export CHALDEA_T3_BIN="$job_scratch/t3/t3"
npm ci --silent --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000
npm run typecheck
node --test test/unit/session*.test.ts
node --test test/davinci/admission.test.ts
