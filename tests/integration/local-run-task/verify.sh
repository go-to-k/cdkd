#!/usr/bin/env bash
# verify.sh — local-run-task integ test
#
# Fully local: no AWS resources are deployed. Exercises `cdkd local
# run-task` end-to-end against Docker + the AWS-published
# `amazon-ecs-local-container-endpoints` sidecar + a single nginx
# container exposing port 80 → 18080 on the host.
#
# Run via `/run-integ local-run-task` (recommended) or directly:
#
#     bash tests/integration/local-run-task/verify.sh
#
# Requires Docker. The script pulls the sidecar + nginx images up front
# so the run is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"

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
docker pull "${NGINX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

echo "==> [1/2] Starting task via --detach"
${CDKD} local run-task CdkdLocalRunTaskFixture/NginxTask --detach --no-pull --container-host 127.0.0.1

echo "==> [2/2] Curling http://127.0.0.1:18080/"
# Give nginx ~5s to listen.
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ || true)
echo "    HTTP code: ${HTTP_CODE}"
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: expected 200, got ${HTTP_CODE}"
  exit 1
fi

echo ""
echo "==> All local-run-task tests passed"
