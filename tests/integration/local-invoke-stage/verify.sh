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
# Steps 5-7 (issue go-to-k/cdkd#5175): two Stages whose `Api` stacks share the
# physical name `CdkdLocalInvokeStageShared`. Before that fix a target naming
# the shared name silently ran the FIRST Stage's handler, and start-api
# `--stack <shared name>` served only the first Stage.
# Step 8 (issue go-to-k/cdkd#5181): two top-level stacks with UNIQUE physical
# names reusing the construct ids `Handler` and `Api` (an HTTP API whose Stage
# variable and CORS origin carry the stack's marker, behind a cached Lambda
# authorizer allowing only `Bearer <marker>`), served together by
# `--stack 'CdkdLocalInvokeStageSvc*'`. Each HTTP API must answer from its own
# handler with its own Stage, CORS and authorizer verdict cache. Before #5177 one stack's Lambda, Stage
# or CORS served both; #5177 refused the union, so this step failed to boot.
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
assert_marker 1/8 CdkdLocalInvokeStage/Inner/Api/Handler api
# Its sibling, whose display path `.../Api` is a STRING prefix of: the `/`
# boundary must keep `Api` from claiming it.
assert_marker 2/8 CdkdLocalInvokeStage/Inner/ApiV2/Handler api-v2
# The top-level stack still resolves beside the Stage.
assert_marker 3/8 CdkdLocalInvokeStageTop/Handler top

# start-api with NO --stack: the positional target alone must select the
# Stage stack (its display path is the target's longest prefix), and the
# Function URL filter must then keep only that stack's handler -- one server.
echo "==> [4/8] start-api CdkdLocalInvokeStage/Inner/Api/Handler (no --stack)"
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

# Stop the step-4 server before the refusal steps reuse the log file.
kill -TERM "${SERVER_PID}" 2>/dev/null || true
for i in $(seq 1 120); do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  sleep 1
done
kill -0 "${SERVER_PID}" 2>/dev/null && kill -KILL "${SERVER_PID}" 2>/dev/null || true
# Cleared only once the server is gone, so the EXIT trap still owns a survivor.
for i in $(seq 1 10); do
  kill -0 "${SERVER_PID}" 2>/dev/null || { SERVER_PID=""; break; }
  sleep 1
done

SHARED=CdkdLocalInvokeStageShared
# Both clones named by their CDK paths, in whichever order the assembly lists them.
names_both() { # usage: names_both <file>
  grep -qF "${SHARED} (CdkdLocalInvokeStageBeta/Api)" "$1" \
    && grep -qF "${SHARED} (CdkdLocalInvokeStageProd/Api)" "$1"
}

# A target whose head is the shared physical name must be refused, naming both
# stacks by their CDK paths -- before #5175 it ran the Beta handler, rc 0.
echo "==> [5/8] local invoke ${SHARED}/Handler is refused as ambiguous"
RC=0
${CDKD} local invoke "${SHARED}/Handler" --no-pull >"${LOG_FILE}" 2>&1 || RC=$?
if [[ "${RC}" -eq 0 ]] || ! grep -qF "matched 2 stacks:" "${LOG_FILE}" \
  || ! names_both "${LOG_FILE}"; then
  echo "FAIL: ${SHARED}/Handler was not refused as ambiguous (rc=${RC}). Log:"
  cat "${LOG_FILE}"
  exit 1
fi

# Positive control: the Prod clone, named by its CDK path, runs Prod's handler.
assert_marker 6/8 CdkdLocalInvokeStageProd/Api/Handler prod

# start-api --stack <shared name> selects both clones, which it cannot serve
# together (it reads deployed state by stack name): it must refuse before any
# server binds -- before #5175 it served the Beta clone alone.
echo "==> [7/8] start-api --stack ${SHARED} is refused"
${CDKD} local start-api --stack "${SHARED}" \
  --port "${PORT}" --container-host 127.0.0.1 --no-pull >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 120); do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  grep -q "Server listening" "${LOG_FILE}" 2>/dev/null && break
  sleep 0.5
done
if grep -q "Server listening" "${LOG_FILE}" 2>/dev/null \
  || ! grep -qF "share the physical stack name ${SHARED}" "${LOG_FILE}" \
  || ! names_both "${LOG_FILE}"; then
  echo "FAIL: start-api --stack ${SHARED} was not refused for its shared stack name. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

# Stop the step-7 server (it should have exited on the refusal) before step 8
# reuses the log file.
if [[ -n "${SERVER_PID:-}" ]]; then
  kill -TERM "${SERVER_PID}" 2>/dev/null || true
  for i in $(seq 1 120); do
    kill -0 "${SERVER_PID}" 2>/dev/null || break
    sleep 1
  done
  kill -0 "${SERVER_PID}" 2>/dev/null && kill -KILL "${SERVER_PID}" 2>/dev/null || true
  for i in $(seq 1 10); do
    kill -0 "${SERVER_PID}" 2>/dev/null || { SERVER_PID=""; break; }
    sleep 1
  done
fi

# Two uniquely named stacks reusing `Handler` and `Api`: served together, each
# HTTP API answers from its OWN handler, Stage variable and CORS origin.
echo "==> [8/8] start-api --stack 'CdkdLocalInvokeStageSvc*' serves each stack's own API"
${CDKD} local start-api --stack 'CdkdLocalInvokeStageSvc*' \
  --port "${PORT}" --container-host 127.0.0.1 --no-pull >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!
# Four servers: each stack's Function URL and HTTP API.
READY=0
for i in $(seq 1 120); do
  kill -0 "${SERVER_PID}" 2>/dev/null || break
  if [[ "$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null || true)" -ge 4 ]]; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: start-api did not bring up the four servers of the two Svc stacks. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
# `|| true`: no match must reach the FAIL below with the log, not stop the
# script under `set -e` with no text.
API_PORTS=$(grep -F '(HTTP API v2))' "${LOG_FILE}" | grep -E 'Server listening on http://' \
  | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' || true)
if [[ "$(printf '%s\n' "${API_PORTS}" | grep -c '[0-9]')" -ne 2 ]]; then
  echo "FAIL: expected two HTTP API servers, got: ${API_PORTS}. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
SEEN=""
for P in ${API_PORTS}; do
  # Each API's authorizer allows only its own stack's token, and caches the
  # verdict for 300 s. Try svc-a's token first: on the second API it must be
  # REFUSED by that API's own authorizer, never answered from the verdict the
  # first API cached for the same token.
  MARKER=""
  BODY=""
  for TOKEN in svc-a svc-b; do
    BODY=""
    for i in $(seq 1 10); do
      CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
        -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${P}/" || true)
      [[ "${CODE}" == 200 || "${CODE}" == 401 || "${CODE}" == 403 ]] && break
      sleep 1
    done
    [[ "${CODE}" == 200 ]] || continue
    BODY=$(curl -sf --max-time 60 -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${P}/" || true)
    echo "    port ${P} (token ${TOKEN}): ${BODY}"
    # An allowed token must be the answering stack's own.
    echo "${BODY}" | grep -qF "\"marker\":\"${TOKEN}\"" || {
      echo "FAIL: the HTTP API on port ${P} let token ${TOKEN} through but answered ${BODY} --"
      echo "  another stack's cached authorizer verdict was reused. Log:"
      cat "${LOG_FILE}"
      exit 1
    }
    MARKER="${TOKEN}"
    break
  done
  if [[ -z "${MARKER}" ]]; then
    echo "FAIL: the HTTP API on port ${P} allowed neither Svc token (last status ${CODE}). Log:"
    cat "${LOG_FILE}"
    exit 1
  fi
  # The Stage variable is the route's own stack's.
  echo "${BODY}" | grep -qF "\"stageVar\":\"${MARKER}\"" || {
    echo "FAIL: the ${MARKER} API on port ${P} was served another stack's Stage (response: ${BODY})"
    exit 1
  }
  OTHER=svc-a
  [[ "${MARKER}" == svc-a ]] && OTHER=svc-b
  # The other stack's token is refused here, in either port order: an Allow
  # the other API's authorizer cached for it must not answer this API.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
    -H "Authorization: Bearer ${OTHER}" "http://127.0.0.1:${P}/" || true)
  if [[ "${CODE}" != 401 && "${CODE}" != 403 ]]; then
    echo "FAIL: the ${MARKER} API on port ${P} answered token ${OTHER} with ${CODE}, not 401/403 --"
    echo "  another stack's cached authorizer verdict was reused. Log:"
    cat "${LOG_FILE}"
    exit 1
  fi
  # CORS: its own stack's origin is allowed, the other stack's is not.
  # `-f`, and each response must carry its status line: a failed request
  # leaves no headers, which would read as "the other origin was refused".
  OWN_HDRS=$(curl -sf -o /dev/null -D - --max-time 60 -H "Origin: https://${MARKER}.example" \
    -H "Authorization: Bearer ${MARKER}" "http://127.0.0.1:${P}/" || true)
  OTHER_HDRS=$(curl -sf -o /dev/null -D - --max-time 60 -H "Origin: https://${OTHER}.example" \
    -H "Authorization: Bearer ${MARKER}" "http://127.0.0.1:${P}/" || true)
  if ! echo "${OWN_HDRS}" | grep -qE '^HTTP/[0-9.]+ 200' \
    || ! echo "${OTHER_HDRS}" | grep -qE '^HTTP/[0-9.]+ 200' \
    || ! echo "${OWN_HDRS}" | grep -qiF "access-control-allow-origin: https://${MARKER}.example" \
    || echo "${OTHER_HDRS}" | grep -qiF "access-control-allow-origin: https://${OTHER}.example"; then
    echo "FAIL: the ${MARKER} API on port ${P} was not served its own stack's CORS."
    echo "  own-origin headers: ${OWN_HDRS}"
    echo "  other-origin headers: ${OTHER_HDRS}"
    exit 1
  fi
  SEEN="${SEEN} ${MARKER}"
done
# One API per stack: both handlers answered, neither twice.
if [[ "$(echo "${SEEN}" | tr ' ' '\n' | sort | tr -d '\n')" != "svc-asvc-b" ]]; then
  echo "FAIL: the two HTTP APIs answered from${SEEN}, not one from each Svc stack. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo ""
echo "==> All 8 local-invoke-stage tests passed"
