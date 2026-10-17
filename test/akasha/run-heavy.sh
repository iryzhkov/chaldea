#!/bin/sh
set -eu
job_scratch="$PWD/.akasha-job"
mkdir -p "$job_scratch/home" "$job_scratch/tmp"
export HOME="$job_scratch/home" TMPDIR="$job_scratch/tmp" CHALDEA_TEST_SCRATCH="$job_scratch/tmp"
curl -fLsS --retry 3 https://github.com/nats-io/nats-server/releases/download/v2.15.1/nats-server-v2.15.1-linux-amd64.tar.gz -o "$job_scratch/nats.tar.gz"
printf '%s  %s\n' bf5edc7b1ce98e885c368cb43a886eb148dc5d0551d99f3cf6141fb5e1954c70 "$job_scratch/nats.tar.gz" | sha256sum -c -
tar --no-same-owner -xzf "$job_scratch/nats.tar.gz" -C "$job_scratch"
export NATS_SERVER="$job_scratch/nats-server-v2.15.1-linux-amd64/nats-server"
export AKASHA_RESULTS="$job_scratch/results.json"
curl -fLsS --retry 3 https://nodejs.org/dist/v26.10.0/node-v26.10.0-linux-x64.tar.xz -o "$job_scratch/node.tar.xz"
printf '%s  %s\n' ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022 "$job_scratch/node.tar.xz" | sha256sum -c -
tar --no-same-owner -xJf "$job_scratch/node.tar.xz" -C "$job_scratch"
export PATH="$job_scratch/node-v26.10.0-linux-x64/bin:$PATH"
node --version
npm ci
npm run typecheck
node --test test/akasha/*.test.ts
if [ "${AKASHA_PERFORMANCE_ONLY:-0}" = 1 ]; then
  node test/akasha/performance.ts
  AKASHA_CONNECTION_ONLY=1 node test/akasha/real-nats.ts
else
  node test/akasha/real-nats.ts
fi
