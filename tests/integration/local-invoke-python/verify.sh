#!/usr/bin/env bash
# verify.sh — local-invoke Python integ test (PR 4 of #224)
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkd local invoke` end-to-end against
# Docker + the AWS Lambda Python base image, which bundles the Runtime
# Interface Emulator (RIE).
#
# Run via `/run-integ local-invoke-python` (recommended) or directly:
#
#     bash tests/integration/local-invoke-python/verify.sh
#
# Requires Docker. The script pulls the base image up front so the run
# is self-sufficient (no special-case skill change needed).

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/python:3.12"

# --- capture ---------------------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, `set -e` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone -- a log
# that ends at `[2/4] Invoking ...` with no error text (issue #3106's lane
# paid a re-run to learn a transient had hit; issue #3126 swept the shape).
# `capture` runs the command with its exit status captured EXPLICITLY, prints
# the status and the tail of the captured stderr on a non-zero exit, and
# still emits the last stdout line so the assertion runs, FAILS, and prints
# its own diagnostic -- with the evidence in the log. The stderr file is per
# call and removed here, so the EXIT trap chain carries no entry for it.
# Every local-* fixture carries this block byte-for-byte; the fence is
# tests/unit/scripts/integ-verify-capture-shape.test.ts.
capture() {
  local out err rc=0
  err="$(mktemp)"
  out="$("$@" 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${err}" >&2
  fi
  rm -f "${err}"
  printf '%s\n' "${out}" | tail -1
}
echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Test 1 — asset-backed Python Lambda echoes event + env var
echo "==> [1/4] Invoking EchoHandler with default empty event"
RESULT_1=$(capture ${CDKD} local invoke CdkdLocalInvokePythonFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting": "hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/4] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKD} local invoke CdkdLocalInvokePythonFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key": "value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/4] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
# Use a wildcard Parameters block so the test doesn't break if the L1
# logical ID changes (mirrors the Node.js integ).
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(capture ${CDKD} local invoke CdkdLocalInvokePythonFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting": "overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — inline (Code.fromInline) Python Lambda
echo "==> [4/4] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${INLINE_EVENT}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_4=$(capture ${CDKD} local invoke CdkdLocalInvokePythonFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q '"hi": "there"' || {
  echo "FAIL: expected inlineEcho with hi=there, got: ${RESULT_4}"
  exit 1
}

echo ""
echo "==> All 4 local-invoke Python tests passed"
