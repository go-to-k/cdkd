#!/usr/bin/env bash
#
# Real-AWS check for go-to-k/cdkd#7011: a deploy replaces a Lambda
# EventSourceMapping (its SQS queue is renamed) and then fails, so the
# automatic rollback deletes the NEW mapping while it is still `Creating`.
# Before the fix Lambda refused that delete with `ResourceInUseException`,
# state kept the new mapping (on the queue the rollback deleted), the old
# mapping fell out of state, and the next deploy collided with
# `ResourceConflictException`.
#
# What this asserts:
#   1. v1 deploys (queue q1 + function + mapping).
#   2. v2 + failure: the deploy exits non-zero, the rollback prints no
#      `Rollback failed`, the function has exactly ONE mapping, on q1, and it
#      is the one state records; q2 is gone.
#   3. v1 redeploys cleanly (no collision).
#   4. destroy leaves no function, queue, mapping or state.
set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

STACK="CdkdEsmReplacementRollback"
Q1="${STACK}-q1"
Q2="${STACK}-q2"
FAILING="${STACK}-failing"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/esm-replacement-rollback"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

# The consumer function's physical name, from state.
function_name() {
  local st
  st="$(read_state)" || return 1
  jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId' <<<"${st}"
}

cleanup() {
  rc=$?
  (
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      fn="$(function_name 2>/dev/null)"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
      if [ -n "${fn}" ]; then
        for u in $(aws lambda list-event-source-mappings --function-name "${fn}" --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
          aws lambda delete-event-source-mapping --uuid "${u}" --region "${REGION}" >/dev/null 2>&1 || true
        done
        aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1 || true
      fi
    fi
    for q in "${Q1}" "${Q2}" "${FAILING}"; do
      u="$(aws sqs get-queue-url --queue-name "${q}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null || true)"
      if [ -n "${u}" ] && [ "${u}" != "None" ]; then
        aws sqs delete-queue --queue-url "${u}" --region "${REGION}" >/dev/null 2>&1 || true
      fi
    done
  fi
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  rm -rf "${LOG_DIR}"
  )
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

echo "[verify] step 1: deploy v1 (queue q1)"
ESM_ROLLBACK_QUEUE=1 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --require-approval never
FN="$(function_name)"
if [ -z "${FN}" ]; then
  echo "[verify] FAIL: no AWS::Lambda::Function in state after the v1 deploy"
  exit 1
fi
Q1_ARN="arn:aws:sqs:${REGION}:$(aws sts get-caller-identity --query Account --output text):${Q1}"

echo "[verify] step 2: deploy v2 (queue q2, mapping replaced) with the failure injected (expect FAILURE)"
set +e
ESM_ROLLBACK_QUEUE=2 ESM_ROLLBACK_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --require-approval never > "${LOG_DIR}/fail.log" 2>&1
RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fail.log"
if [ "${RC}" -eq 0 ]; then
  echo "[verify] FAIL: the deploy with the failure injected exited 0"
  exit 1
fi
# Sentinel: the arm under test must have run (the mapping replacement was reversed).
if ! grep -q 'Reversing replacement of .*AWS::Lambda::EventSourceMapping' "${LOG_DIR}/fail.log"; then
  echo "[verify] FAIL: the rollback did not reverse the mapping replacement — the fixture no longer reaches #7011's path"
  exit 1
fi
if grep -q 'Rollback failed for' "${LOG_DIR}/fail.log"; then
  echo "[verify] FAIL: an operation of the rollback failed (#7011: ResourceInUseException deleting the new mapping)"
  exit 1
fi

MAPPINGS="$(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" --query 'EventSourceMappings[].[UUID,EventSourceArn]' --output text)"
echo "[verify]   mappings after rollback:"
echo "${MAPPINGS}" | sed 's/^/    /'
COUNT="$(grep -c . <<<"${MAPPINGS}" || true)"
if [ "${COUNT}" != "1" ]; then
  echo "[verify] FAIL: expected exactly 1 mapping on the function after the rollback, found ${COUNT}"
  exit 1
fi
LIVE_UUID="$(awk '{print $1}' <<<"${MAPPINGS}")"
LIVE_SRC="$(awk '{print $2}' <<<"${MAPPINGS}")"
if [ "${LIVE_SRC}" != "${Q1_ARN}" ]; then
  echo "[verify] FAIL: the surviving mapping reads ${LIVE_SRC}, expected the restored queue ${Q1_ARN}"
  exit 1
fi
ST="$(read_state)"
STATE_UUID="$(jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .value.physicalId' <<<"${ST}")"
if [ "${STATE_UUID}" != "${LIVE_UUID}" ]; then
  echo "[verify] FAIL: state records mapping ${STATE_UUID}, AWS holds ${LIVE_UUID}"
  exit 1
fi
assert_gone "queue ${Q2} survived the rollback" aws sqs get-queue-url --queue-name "${Q2}" --region "${REGION}"
echo "[verify] step 2 ok: one mapping, on ${Q1}, recorded in state; ${Q2} gone"

echo "[verify] step 3: redeploy v1 (must not collide)"
ESM_ROLLBACK_QUEUE=1 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --require-approval never
echo "[verify] step 3 ok"

echo "[verify] step 4: destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "state.json survived destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "function ${FN} survived destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
assert_gone "mapping ${LIVE_UUID} survived destroy" aws lambda get-event-source-mapping --uuid "${LIVE_UUID}" --region "${REGION}"
assert_gone "queue ${Q1} survived destroy" aws sqs get-queue-url --queue-name "${Q1}" --region "${REGION}"
echo "[verify] step 4 ok: destroy clean"

aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo "[verify] PASS"
