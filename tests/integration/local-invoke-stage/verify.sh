#!/usr/bin/env bash
# verify.sh — local-invoke-stage integ test (issue go-to-k/cdkd#3953)
#
# `cdkd local invoke` and `cdkd local start-api` by a construct path in a
# stack under a NESTED CDK Stage.
# Fully local -- no AWS resources are deployed. The app holds a top-level
# stack plus `CdkdLocalInvokeStage/Inner/{Api,ApiV2}`; each handler returns
# its stack's marker, so a response proves WHICH stack the target resolved to.
# Before the fix the target's first segment (`CdkdLocalInvokeStage`) was
# looked up as a stack: the invoke refused with `Stack '...' not found`, and
# start-api (no `--stack`) selected no stack and refused to boot.
#
# Run via `/run-integ local-invoke-stage` (recommended) or directly:
#
#     bash tests/integration/local-invoke-stage/verify.sh
#
# Requires Docker. The script pulls the Node.js base image up front so the run
# is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3761

LOG_FILE="$(mktemp)"
SERVER_PID=""

# The one EXIT trap: stop the start-api server and sweep its containers.
cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for i in $(seq 1 120); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -0 "${SERVER_PID}" 2>/dev/null && kill -KILL "${SERVER_PID}" 2>/dev/null || true
  fi
  ORPHANS=$(docker ps --filter "name=cdkd-local-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "${ORPHANS}" | xargs docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- capture ---------------------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, `set -e` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone -- a log
# that ends at `[2/4] Invoking ...` with no error text (issue #3106's lane
# paid a re-run to learn a transient had hit; issue #3126 swept the shape).
# `capture` runs the command with its exit status captured EXPLICITLY. On a
# non-zero exit it prints the status, the last stdout line and the tail of
# the captured stderr, and emits NOTHING on stdout -- the assertion still
# runs and FAILS with its own text, and a response that happened to look
# right never passes a failed invoke (the old shape's one merit, kept). On
# success it emits the last stdout line. The stderr file is per call and
# removed here, so the EXIT trap chain carries no entry for it. Every
# fixture that uses this block carries it byte-for-byte (copy
# CANONICAL_CAPTURE_BLOCK from scripts/check-integ-capture-shape.ts); the
# fence is tests/unit/scripts/integ-verify-capture-shape.test.ts.
capture() {
  local out err rc=0
  err="$(mktemp)"
  out="$("$@" 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\n' "${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${err}" >&2
    rm -f "${err}"
    return 0
  fi
  rm -f "${err}"
  printf '%s\n' "${out}" | tail -1
}

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE}"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Each case: target -> the marker its stack's handler returns.
assert_marker() { # usage: assert_marker <step> <target> <expected marker>
  local result
  echo "==> [$1] Invoking $2"
  result=$(capture ${CDKD} local invoke "$2" --no-pull)
  echo "    response: ${result}"
  echo "${result}" | grep -qF "\"marker\":\"$3\"" || {
    echo "FAIL: $2 did not resolve to the '$3' stack (response: ${result})"
    exit 1
  }
}

# The nested Stage stack, by its full display path.
assert_marker 1/4 CdkdLocalInvokeStage/Inner/Api/Handler api
# Its sibling, whose display path `.../Api` is a STRING prefix of: the `/`
# boundary must keep `Api` from claiming it.
assert_marker 2/4 CdkdLocalInvokeStage/Inner/ApiV2/Handler api-v2
# The top-level stack still resolves beside the Stage.
assert_marker 3/4 CdkdLocalInvokeStageTop/Handler top

# start-api with NO --stack: the positional target alone must select the
# Stage stack (its display path is the target's longest prefix), and the
# Function URL filter must then keep only that stack's handler -- one server.
echo "==> [4/4] start-api CdkdLocalInvokeStage/Inner/Api/Handler (no --stack)"
${CDKD} local start-api CdkdLocalInvokeStage/Inner/Api/Handler \
  --port "${PORT}" --container-host 127.0.0.1 --no-pull >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
READY=0
for i in $(seq 1 60); do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  if grep -q "Server listening" "${LOG_FILE}" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: start-api did not come up for the Stage target. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
URL_PORT=$(grep -E 'Server listening on http://[^[:space:]]+' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
[[ -n "${URL_PORT}" ]] || {
  echo "FAIL: could not read the server port from the log"
  cat "${LOG_FILE}"
  exit 1
}
# Retried like local-start-api's `curl_assert`: the first request can land
# while the container is still cold-booting.
BODY=""
for i in $(seq 1 10); do
  BODY=$(curl -sf --max-time 60 "http://127.0.0.1:${URL_PORT}/") || BODY=""
  echo "${BODY}" | grep -qF '"marker":"api"' && break
  sleep 1
done
echo "    response: ${BODY}"
echo "${BODY}" | grep -qF '"marker":"api"' || {
  echo "FAIL: start-api did not serve the Api stack's handler (response: ${BODY}). Log:"
  cat "${LOG_FILE}"
  exit 1
}
# Counted AFTER the request, when every server has bound. The selection is
# what boots at all -- before the fix no stack matched and start-api refused --
# and the target filter keeps the one Function URL.
SERVERS=$(grep -c "Server listening" "${LOG_FILE}") || SERVERS=0
if [[ "${SERVERS}" -ne 1 ]]; then
  echo "FAIL: expected exactly one server (the Api stack's Function URL), got ${SERVERS}. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo ""
echo "==> All 4 local-invoke-stage tests passed"
