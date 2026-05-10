#!/usr/bin/env bash
# verify.sh — local-invoke container-Lambda integ test (PR 5 of #224)
#
# Like `tests/integration/local-invoke/verify.sh` this is fully local —
# no AWS resources are deployed. We synthesize a CDK app whose only
# Lambda is a `lambda.DockerImageFunction` (Code.ImageUri) and exercise
# the local-build path of `cdkd local invoke` end-to-end.
#
# Run via `/run-integ local-invoke-container` (recommended) or directly:
#
#     bash tests/integration/local-invoke-container/verify.sh
#
# Requires Docker. The build pulls the AWS Lambda Node.js base image
# (~600MB) the first time.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Test 1 — container-Lambda default empty event
# Uses --no-pull so docker build's --pull flag is not set (this is the
# default; --no-pull on the container-Lambda local-build path is
# documented as a no-op in CLI help — it still skips the public-base
# image's `docker pull` from the ZIP path which we did up front).
echo "==> [1/3] Invoking EchoHandler (container) with default empty event"
RESULT_1=$(${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"fromContainer":true' || {
  echo "FAIL: expected fromContainer=true in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/3] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/3] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

echo ""
echo "==> All 3 local-invoke container-Lambda tests passed"
