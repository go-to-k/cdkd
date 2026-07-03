#!/usr/bin/env bash
# verify.sh — cdkd Lambda EventInvokeConfig async-invoke UPDATE integ.
#
# Regression coverage for the bug where an async Lambda's EventInvokeConfig
# (onFailure destination + maxEventAge + retryAttempts) could be CREATEd but
# NOT UPDATEd. The type had no SDK provider, so it routed through Cloud
# Control, whose JSON-patch read-modify-write UPDATE picks up the AWS-injected
# empty `DestinationConfig.OnSuccess: {}` from the read handler and hard-fails
# model validation (`#/DestinationConfig/OnSuccess: required key [Destination]
# not found`) on every change to maxEventAge / retryAttempts. The fix adds an
# SDK provider whose create/update both PutFunctionEventInvokeConfig (a
# full-replace write, exactly what CloudFormation uses), sending only the
# configured OnFailure and never an empty OnSuccess.
#
# Phases:
#   1. Deploy (maxEventAge 2 min / retryAttempts 1 / onFailure -> DLQ). Assert
#      the async-invoke config reached AWS with MaxAge 120 / Retries 1 / the DLQ.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (maxEventAge 5 min / retryAttempts
#      2). Assert the UPDATE succeeds (this exact change was undeployable
#      pre-fix) and AWS now reports MaxAge 300 / Retries 2 / the same DLQ.
#   3. Destroy + assert the function is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaEventInvokeConfigUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-event-invoke-config-update-test-fn"
DLQ_NAME="cdkd-event-invoke-config-update-test-dlq"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # The EventInvokeConfig is deleted with the function; delete the function +
  # DLQ explicitly in case a partial run left them.
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  DLQ_URL="$(aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${DLQ_URL}" ] && [ "${DLQ_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${DLQ_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # The function's auto-created log group survives a function delete.
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

eic_field() {
  # $1 = jq query against get-function-event-invoke-config
  aws lambda get-function-event-invoke-config --function-name "${FN_NAME}" \
    --region "${REGION}" --query "$1" --output text
}

# --- Phase 1: deploy baseline (MaxAge 120 / Retries 1) ----------------
echo "==> Phase 1: deploy async Lambda (maxEventAge 2 min / retryAttempts 1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXAGE_P1="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_P1="$(eic_field 'MaximumRetryAttempts')"
ONFAIL_P1="$(eic_field 'DestinationConfig.OnFailure.Destination')"
echo "    Phase 1 async-invoke config: MaxAge=${MAXAGE_P1} Retries=${RETRIES_P1} OnFailure=${ONFAIL_P1}"
[ "${MAXAGE_P1}" = "120" ] || { echo "FAIL: expected MaxAge 120, got '${MAXAGE_P1}'" >&2; exit 1; }
[ "${RETRIES_P1}" = "1" ] || { echo "FAIL: expected Retries 1, got '${RETRIES_P1}'" >&2; exit 1; }
case "${ONFAIL_P1}" in
  *":${DLQ_NAME}") ;;
  *) echo "FAIL: expected OnFailure -> ${DLQ_NAME}, got '${ONFAIL_P1}'" >&2; exit 1 ;;
esac
echo "    Phase 1 config reached AWS"

# --- Phase 1.5: the EventInvokeConfig must NOT show phantom drift -----------
# CDK always synthesizes `Qualifier: '$LATEST'` into the EventInvokeConfig, so
# cdkd state stores it; the provider's readCurrentState must emit it back or
# `cdkd drift` reports a false positive on every base async Lambda. We assert
# only that the EventInvokeConfig resource is drift-clean (the assertion is
# scoped to this type — an unrelated drift false-positive elsewhere in the
# stack is out of scope for this fixture).
echo "==> Phase 1.5: EventInvokeConfig shows no drift"
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
if printf '%s' "${DRIFT_OUT}" | grep -q 'AWS::Lambda::EventInvokeConfig'; then
  echo "FAIL: cdkd drift reported phantom drift on the EventInvokeConfig:" >&2
  printf '%s\n' "${DRIFT_OUT}" | grep -A4 'EventInvokeConfig' >&2
  exit 1
fi
echo "    EventInvokeConfig is drift-clean"

# --- Phase 2: UPDATE (MaxAge 300 / Retries 2) — undeployable pre-fix ---
echo "==> Phase 2: re-deploy with maxEventAge 5 min / retryAttempts 2 (UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXAGE_P2="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_P2="$(eic_field 'MaximumRetryAttempts')"
ONFAIL_P2="$(eic_field 'DestinationConfig.OnFailure.Destination')"
echo "    Phase 2 async-invoke config: MaxAge=${MAXAGE_P2} Retries=${RETRIES_P2} OnFailure=${ONFAIL_P2}"
[ "${MAXAGE_P2}" = "300" ] || { echo "FAIL: expected MaxAge 300 after update, got '${MAXAGE_P2}'" >&2; exit 1; }
[ "${RETRIES_P2}" = "2" ] || { echo "FAIL: expected Retries 2 after update, got '${RETRIES_P2}'" >&2; exit 1; }
case "${ONFAIL_P2}" in
  *":${DLQ_NAME}") ;;
  *) echo "FAIL: expected OnFailure -> ${DLQ_NAME} preserved after update, got '${ONFAIL_P2}'" >&2; exit 1 ;;
esac
echo "    Phase 2 UPDATE reached AWS (the change that was undeployable pre-fix)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    function deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Lambda EventInvokeConfig deploy + UPDATE (maxEventAge/retryAttempts change) reach AWS via the SDK provider, all 3 phases passed"
