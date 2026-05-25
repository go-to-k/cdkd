#!/usr/bin/env bash
# verify.sh — local-run-task-awsvpc integ test (issue #594, deferred
# item (3) of #579 — unblocked by #461).
#
# Fully local: no AWS resources are deployed. Exercises `cdkd local
# run-task` against a TaskDefinition declaring `NetworkMode: awsvpc`.
#
# Before #461 cdkd hard-rejected `awsvpc` at resolver time with
# `EcsTaskResolutionError`; after #461 it ACCEPTS the task and maps
# `awsvpc` to a docker bridge network with a startup warn (docker cannot
# emulate ENI-per-task — see docs/design/461-awsvpc-decision.md).
#
# Asserts:
#   - `cdkd local run-task` ACCEPTS the awsvpc task (the CLI does not
#     exit non-zero with EcsTaskResolutionError),
#   - the `NetworkMode 'awsvpc' is mapped to docker bridge locally` warn
#     appears in the output,
#   - the busybox container boots and serves its HELLO_AWSVPC payload on
#     the bridge fallback (host port 18080),
#   - cleanup leaves no orphan containers or networks.
#
# Run via `/run-integ local-run-task-awsvpc` (recommended) or directly:
#
#     bash tests/integration/local-run-task-awsvpc/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Starting awsvpc task via --detach (output captured)"
${CDKD} local run-task CdkdLocalRunTaskAwsvpcFixture/AwsvpcTask \
  --detach --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1
echo "----- run-task output -----"
cat "${OUT_FILE}"
echo "---------------------------"

# Acceptance: --detach exited 0 (set -e would have aborted otherwise) and
# the resolver did NOT raise EcsTaskResolutionError.
if grep -q "EcsTaskResolutionError" "${OUT_FILE}"; then
  echo "FAIL: awsvpc task was rejected with EcsTaskResolutionError (expected acceptance post-#461)"
  exit 1
fi
echo "    OK: awsvpc task accepted (no EcsTaskResolutionError)"

# awsvpc -> bridge warn must be surfaced so users aren't surprised by the
# missing ENI-per-task isolation.
echo "==> Asserting awsvpc -> bridge warn in output"
if ! grep -q "is mapped to docker bridge locally" "${OUT_FILE}"; then
  echo "FAIL: output is missing the 'NetworkMode awsvpc is mapped to docker bridge locally' warn"
  exit 1
fi
echo "    OK: awsvpc -> bridge warn present"

echo "==> Asserting the awsvpc container is running"
TASK_ID=""
for _ in $(seq 1 30); do
  TASK_ID=$(docker ps --filter "name=cdkd-local-cdkd-local-run-task-awsvpc-web-" --format '{{.ID}}' | head -1)
  if [[ -n "${TASK_ID}" ]]; then break; fi
  sleep 1
done
if [[ -z "${TASK_ID}" ]]; then
  echo "FAIL: awsvpc container did not appear in docker ps within 30s"
  docker ps -a --filter "name=cdkd-local-"
  exit 1
fi
echo "    container: ${TASK_ID}"

echo "==> Curling http://127.0.0.1:18080/ (bridge-fallback host-port publish)"
RESPONSE=""
for _ in $(seq 1 30); do
  RESPONSE=$(curl -s --max-time 3 http://127.0.0.1:18080/ || true)
  if grep -q "HELLO_AWSVPC" <<<"${RESPONSE}"; then break; fi
  sleep 1
done
if ! grep -q "HELLO_AWSVPC" <<<"${RESPONSE}"; then
  echo "FAIL: curl http://127.0.0.1:18080/ did not return HELLO_AWSVPC"
  echo "----- last response -----"
  echo "${RESPONSE}"
  echo "-------------------------"
  exit 1
fi
echo "    OK: awsvpc container served HELLO_AWSVPC on the bridge fallback"

echo "==> Tearing down (docker rm -f + network rm)"
cleanup

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after cleanup"
  docker ps -a --filter "name=cdkd-local-"
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after cleanup"
  docker network ls --filter "name=cdkd-local-task-"
  exit 1
fi

echo ""
echo "==> local-run-task-awsvpc test passed (awsvpc accepted + bridge fallback + clean teardown)"
