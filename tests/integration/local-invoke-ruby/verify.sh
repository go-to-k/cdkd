#!/usr/bin/env bash
# verify.sh — local-invoke Ruby integ test (issue #248)
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkd local invoke` end-to-end against
# Docker + the AWS Lambda Ruby base image, which bundles the Runtime
# Interface Emulator (RIE).
#
# Run via `/run-integ local-invoke-ruby` (recommended) or directly:
#
#     bash tests/integration/local-invoke-ruby/verify.sh
#
# Requires Docker. The script pulls the base image up front so the run
# is self-sufficient (no special-case skill change needed).

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/ruby:3.3"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Test 1 — asset-backed Ruby Lambda echoes event + env var
echo "==> [1/4] Invoking EchoHandler with default empty event"
RESULT_1=$(${CDKD} local invoke CdkdLocalInvokeRubyFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -Eq '"greeting": *"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/4] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(${CDKD} local invoke CdkdLocalInvokeRubyFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -Eq '"key": *"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/4] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
# Use a wildcard Parameters block so the test doesn't break if the L1
# logical ID changes (mirrors the Python integ).
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKD} local invoke CdkdLocalInvokeRubyFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -Eq '"greeting": *"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — inline (Code.fromInline) Ruby Lambda
echo "==> [4/4] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${INLINE_EVENT}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_4=$(${CDKD} local invoke CdkdLocalInvokeRubyFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -Eq '"hi": *"there"' || {
  echo "FAIL: expected inlineEcho with hi=there, got: ${RESULT_4}"
  exit 1
}

echo ""
echo "==> All 4 local-invoke Ruby tests passed"
