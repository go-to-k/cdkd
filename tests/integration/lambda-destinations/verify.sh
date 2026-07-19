#!/usr/bin/env bash
# verify.sh — cdkd Lambda async destinations (EventInvokeConfig) integ.
#
# AWS::Lambda::EventInvokeConfig has NO SDK provider in cdkd, so it routes via
# Cloud Control. It carries a write-only DestinationConfig (OnSuccess/OnFailure)
# that Cloud Control read handlers cannot return. The regression this pins: an
# in-place UPDATE that changes MaximumRetryAttempts must still re-include the
# write-only DestinationConfig in the patch, or the destinations get silently
# dropped (write-only-properties.ts re-include; issue #809).
#
# Phases:
#   1. Deploy baseline (retryAttempts=2). Assert the EventInvokeConfig reached
#      AWS with MaximumRetryAttempts=2, MaximumEventAgeInSeconds=300, and BOTH
#      OnSuccess + OnFailure destinations wired; assert it routed via cc-api.
#      Functional: async-invoke the function with a success payload and confirm
#      the onSuccess record lands in the success SQS queue (condition=Success).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (retryAttempts 2 -> 1). Assert the
#      change reached AWS (MaximumRetryAttempts=1) AND that BOTH destinations
#      SURVIVED the patch (the write-only re-include regression).
#   3. Destroy + assert the EventInvokeConfig/function are gone, the cdkd state
#      file is removed, and Lambda log groups are swept.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaDestinationsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-lambda-dest-fn"
SUCCESS_Q="cdkd-lambda-dest-success"
FAILURE_Q="cdkd-lambda-dest-failure"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${FN_NAME}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

delete_queue_by_name() {
  local name="$1"
  local url
  url="$(aws sqs get-queue-url --queue-name "${name}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -n "${url}" ] && [ "${url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  delete_queue_by_name "${SUCCESS_Q}"
  delete_queue_by_name "${FAILURE_Q}"
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (retryAttempts=2) -----------------------
echo "==> Phase 1: deploy baseline (retryAttempts=2)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

eic() {
  aws lambda get-function-event-invoke-config --function-name "${FN_NAME}" \
    --region "${REGION}" --query "$1" --output text 2>/dev/null
}

RETRY_P1="$(eic 'MaximumRetryAttempts')"
if [ "${RETRY_P1}" != "2" ]; then
  echo "FAIL: expected MaximumRetryAttempts=2 after Phase 1, got '${RETRY_P1}'" >&2
  exit 1
fi
AGE_P1="$(eic 'MaximumEventAgeInSeconds')"
if [ "${AGE_P1}" != "300" ]; then
  echo "FAIL: expected MaximumEventAgeInSeconds=300, got '${AGE_P1}'" >&2
  exit 1
fi
SUCC_DEST_P1="$(eic 'DestinationConfig.OnSuccess.Destination')"
FAIL_DEST_P1="$(eic 'DestinationConfig.OnFailure.Destination')"
if [[ "${SUCC_DEST_P1}" != *":${SUCCESS_Q}" ]]; then
  echo "FAIL: OnSuccess destination not wired to ${SUCCESS_Q} (got '${SUCC_DEST_P1}')" >&2
  exit 1
fi
if [[ "${FAIL_DEST_P1}" != *":${FAILURE_Q}" ]]; then
  echo "FAIL: OnFailure destination not wired to ${FAILURE_Q} (got '${FAIL_DEST_P1}')" >&2
  exit 1
fi
echo "    EventInvokeConfig: retries=2, maxAge=300, OnSuccess+OnFailure wired"

# Assert it routed via Cloud Control (no SDK provider for this type).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::Lambda::EventInvokeConfig");process.stdout.write((r[k]&&r[k].provisionedBy)||"")})')"
if [ "${PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: expected EventInvokeConfig provisionedBy=cc-api, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    EventInvokeConfig routed via Cloud Control (provisionedBy=cc-api)"

# Functional: async-invoke success path -> onSuccess record in success queue.
echo "==> Phase 1 functional: async invoke -> onSuccess SQS delivery"
SUCCESS_URL="$(aws sqs get-queue-url --queue-name "${SUCCESS_Q}" --region "${REGION}" \
  --query 'QueueUrl' --output text)"
aws lambda invoke --function-name "${FN_NAME}" --invocation-type Event \
  --payload '{"hello":"world"}' --cli-binary-format raw-in-base64-out \
  --region "${REGION}" /tmp/cdkd-lambda-dest-out.json >/dev/null
DELIVERED=""
for i in 1 2 3 4 5 6 7 8; do
  BODY="$(aws sqs receive-message --queue-url "${SUCCESS_URL}" --wait-time-seconds 5 \
    --region "${REGION}" --query 'Messages[0].Body' --output text 2>/dev/null || true)"
  if [ -n "${BODY}" ] && [ "${BODY}" != "None" ]; then
    COND="$(printf '%s' "${BODY}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).requestContext.condition||"")}catch(e){process.stdout.write("")}})')"
    if [ "${COND}" = "Success" ]; then DELIVERED="yes"; break; fi
  fi
  echo "    poll ${i}: no onSuccess record yet"
done
if [ "${DELIVERED}" != "yes" ]; then
  echo "FAIL: onSuccess destination did not receive a Success record" >&2
  exit 1
fi
echo "    onSuccess record delivered (condition=Success)"

# --- Phase 2: UPDATE retryAttempts 2 -> 1 (in-place) ------------------
echo "==> Phase 2: re-deploy with retryAttempts=1 (in-place UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RETRY_P2="$(eic 'MaximumRetryAttempts')"
if [ "${RETRY_P2}" != "1" ]; then
  echo "FAIL: expected MaximumRetryAttempts=1 after Phase 2, got '${RETRY_P2}'" >&2
  exit 1
fi
echo "    MaximumRetryAttempts updated 2 -> 1 (reached AWS)"

# The write-only DestinationConfig MUST survive the patch.
SUCC_DEST_P2="$(eic 'DestinationConfig.OnSuccess.Destination')"
FAIL_DEST_P2="$(eic 'DestinationConfig.OnFailure.Destination')"
if [[ "${SUCC_DEST_P2}" != *":${SUCCESS_Q}" ]]; then
  echo "FAIL: OnSuccess destination DROPPED by the UPDATE patch (got '${SUCC_DEST_P2}')" >&2
  exit 1
fi
if [[ "${FAIL_DEST_P2}" != *":${FAILURE_Q}" ]]; then
  echo "FAIL: OnFailure destination DROPPED by the UPDATE patch (got '${FAIL_DEST_P2}')" >&2
  exit 1
fi
echo "    write-only DestinationConfig SURVIVED the in-place UPDATE patch"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    function (and its EventInvokeConfig) deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

sweep_log_groups

echo "[verify] PASS — Lambda EventInvokeConfig CREATE + functional onSuccess + in-place UPDATE (write-only DestinationConfig preserved) + destroy, all 3 phases passed"
