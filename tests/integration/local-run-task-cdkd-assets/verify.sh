#!/usr/bin/env bash
#
# End-to-end real-Docker validation for `cdkd local run-task` classifying a
# custom-bootstrap-qualifier container-assets image URI as a CDK asset
# (issue #1002 PR 3).
#
# Why this exists: the two ECS container-image classification sites in
# `src/local/ecs-task-resolver.ts` used to match only the hardcoded literal
# `cdk-hnb659fds-container-assets-`. An account bootstrapped with a custom
# `cdk bootstrap --qualifier <q>` synthesizes its `ContainerImage.fromAsset`
# ECS images as `cdk-<q>-container-assets-...`, which the resolver did NOT
# recognize — so it fell through to a (broken) ECR pull instead of resolving
# the image back to the on-disk cdk.out build. PR 3 generalizes the match to
# `cdk-[a-z0-9]+-container-assets-` (any qualifier) and also adds the
# cdkd-owned `cdkd-container-assets-` shape (unit-tested; not reachable through
# run-task's synth-based image source, which stays unrewritten by design §7.1 —
# so this integ live-tests the reachable custom-qualifier half).
#
# The fixture (bin/app.ts) pins the bootstrap qualifier to `myqual99`, so the
# single `fromAsset` container synthesizes as
# `cdk-myqual99-container-assets-<acct>-<region>:<hash>`. On the PRE-fix binary
# `cdkd local run-task` would attempt an ECR pull of that non-existent repo and
# FAIL; on the fixed binary it classifies the URI as a CDK asset, builds the
# image from cdk.out, runs the container, and the marker below appears in the
# container logs.
#
# No AWS deploy is required — the asset builds and runs entirely against local
# Docker (the ECS metadata sidecar uses the host's AWS credentials). There is
# therefore no cdkd state to destroy; cleanup is a pure local-Docker sweep.
#
# Run via `/run-integ local-run-task-cdkd-assets` (recommended) or directly:
#
#     bash tests/integration/local-run-task-cdkd-assets/verify.sh
#
# Requires Docker AND AWS credentials (the metadata sidecar reads them).

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalRunTaskCdkdAssetsFixture"
TASK_PATH="${STACK}/AssetTask"
MARKER="CDKD_CUSTOM_QUALIFIER_ASSET_OK"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_BASE="public.ecr.aws/docker/library/busybox:1.36"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-run-task-cdkd-assets"
CDKD="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (no AWS deploy — local Docker only)"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pre-pulling sidecar + asset base image"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_BASE}"

# Cleanup trap: sweep cdkd-local containers + task networks on every exit path.
# No cdkd state / AWS resources are ever created, so there is nothing to destroy.
cleanup() {
  rc=$?
  set +e
  echo "[verify] cleanup (exit ${rc}) — tearing down local Docker"
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 2: cdkd local run-task ${TASK_PATH} (custom-qualifier fromAsset image)"
# --detach so the one-shot container is left in place for a docker-logs read.
# No --from-state / --state-bucket: the classification happens on the synth
# template, and the asset builds from cdk.out.
RUN_OUT="$(${CDKD} local run-task "${TASK_PATH}" --detach --container-host 127.0.0.1 2>&1)"
echo "${RUN_OUT}" | sed 's/^/[verify]   run-task> /'

# On the PRE-fix binary, run-task would have classified the image as a plain
# ECR URI and failed the pull before ever creating a container. Guard against a
# false pass by explicitly rejecting the ECR-pull error signature.
if echo "${RUN_OUT}" | grep -qiE "not an ECR URI|ECR pull|is not in the local docker cache|pull .* failed"; then
  echo "[verify] FAIL: run-task attempted an ECR pull instead of building the custom-qualifier asset"
  exit 1
fi

echo "[verify] step 3: locate the built asset container + assert its marker"
sleep 3
CID="$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}} {{.Names}}' | grep -i printer | awk '{print $1}' | head -n 1)"
[ -n "${CID}" ] || { echo "[verify] FAIL: no cdkd-local printer container was created (asset was not built + run)"; exit 1; }

LOGS="$(docker logs "${CID}" 2>&1)"
echo "${LOGS}" | sed 's/^/[verify]   container> /'
if ! echo "${LOGS}" | grep -qF "${MARKER}"; then
  echo "[verify] FAIL: expected marker '${MARKER}' in the container logs — asset build / run did not complete"
  exit 1
fi

echo ""
echo "[verify] All checks passed: cdkd local run-task classified the custom-qualifier"
echo "[verify] container-assets image URI as a CDK asset, built it from cdk.out, and ran it."
