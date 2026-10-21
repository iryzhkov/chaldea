#!/bin/sh
set -eu
umask 077
job_root=$(pwd -P)
job_scratch="$job_root/.message-job"
export HOME="$job_scratch/home" TMPDIR="$job_scratch/tmp" CHALDEA_TEST_SCRATCH="$job_scratch/tests"
unset XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR SSH_AUTH_SOCK
test "$HOME" = "$job_root/.message-job/home"
test "$TMPDIR" = "$job_root/.message-job/tmp"
case "$HOME" in /home/igor|/root|/tmp/*) exit 90;; esac
mkdir -p "$HOME" "$TMPDIR" "$CHALDEA_TEST_SCRATCH"
trap 'rm -rf "$job_scratch"' EXIT
printf '%s\n' '{"passed":false}' > message-transport-proof.json
curl -fLsS --retry 3 https://github.com/nats-io/nats-server/releases/download/v2.15.1/nats-server-v2.15.1-linux-amd64.tar.gz -o "$job_scratch/nats.tar.gz"
printf '%s  %s\n' bf5edc7b1ce98e885c368cb43a886eb148dc5d0551d99f3cf6141fb5e1954c70 "$job_scratch/nats.tar.gz" | sha256sum -c -
tar --no-same-owner -xzf "$job_scratch/nats.tar.gz" -C "$job_scratch"
export NATS_SERVER="$job_scratch/nats-server-v2.15.1-linux-amd64/nats-server"
sh scripts/ci/install-t3 "$job_scratch/t3"
export CHALDEA_T3_BIN="$job_scratch/t3/t3"
npm ci --silent
npm run typecheck
if [ "${MESSAGE_CHECK_ONLY:-0}" = 1 ]; then exit 0; fi
export MESSAGE_CERT_DIR="$job_scratch/tls"
mkdir -p "$MESSAGE_CERT_DIR"
for certificate in trusted untrusted; do
  openssl req -config /dev/null -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
    -keyout "$MESSAGE_CERT_DIR/$certificate.key" -out "$MESSAGE_CERT_DIR/$certificate.crt" 2>"$MESSAGE_CERT_DIR/$certificate.log"
done
export NODE_EXTRA_CA_CERTS="$MESSAGE_CERT_DIR/trusted.crt"
node --test test/unit/message*.test.ts test/message/nats.test.ts test/message/transport.test.ts
if [ "${MESSAGE_FULL:-0}" = 1 ]; then
  npm test
  npm run exec:check
  npm run exec:test
  node --test test/exec/fallback.e2e.ts test/exec/queue.e2e.ts
  npm run host:build -- nats-source-check "$job_scratch/host-artifacts"
fi
