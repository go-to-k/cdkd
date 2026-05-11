#!/usr/bin/env bash
# verify.sh — local-run-task multi-container integ test
#
# Fully local. Two busybox containers share a host-anonymous volume; the
# `app` container writes a file, the `tail-shim` container reads it after
# waiting on `dependsOn: { condition: 'START' }`.
#
#     bash tests/integration/local-run-task-multi-container/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

cleanup() {
  echo "==> Cleanup: stopping any leftover containers"
  docker ps --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Capture the run output so we can assert on the `[app]`-prefixed line.
OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"' EXIT

echo "==> Running multi-container task"
# Run synchronously so `cdkd local run-task` waits for the essential
# container to exit; logs land on stdout with [container-name] prefix.
${CDKD} local run-task CdkdLocalRunTaskMultiFixture/AppTask --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1

echo "==> Asserting [app] container logged 'hello from app'"
if ! grep -q '\[app\] hello from app' "${OUT_FILE}"; then
  echo "FAIL: expected '[app] hello from app' in run output"
  echo "----- run output -----"
  cat "${OUT_FILE}"
  echo "----------------------"
  exit 1
fi

echo ""
echo "==> Multi-container local-run-task test passed"
