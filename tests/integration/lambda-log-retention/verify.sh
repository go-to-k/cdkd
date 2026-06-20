#!/usr/bin/env bash
# verify.sh — cdkd Lambda logRetention (Custom::LogRetention) deploy + UPDATE.
#
# `logRetention` synthesizes a Custom::LogRetention custom resource that creates
# the function's log group and sets its retention via a control-plane call. The
# existing `cache-streaming` fixture sets logRetention but never asserts the
# value and never exercises the UPDATE path. This test does both:
#
# Phases:
#   1. Deploy baseline (retention = 7 days). Assert the log group exists and its
#      retentionInDays == 7 (the Custom::LogRetention CR actually applied it).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (retention -> 14 days). Assert the
#      retention is now 14 — an in-place control-plane UPDATE, not a replacement.
#   3. Destroy + assert the function and the cdkd state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaLogRetentionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# Resolved after Phase 1 from the stack output.
FUNCTION_NAME=""
LOG_GROUP=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  sweep_log_groups
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

# --- Phase 1: deploy baseline (retention 7) ---------------------------
echo "==> Phase 1: deploy baseline (retention = 7 days)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FUNCTION_NAME="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
  | jq -r '.outputs.FunctionName')"
if [ -z "${FUNCTION_NAME}" ] || [ "${FUNCTION_NAME}" = "null" ]; then
  echo "FAIL: could not resolve FunctionName output after deploy" >&2
  exit 1
fi
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
echo "    function: ${FUNCTION_NAME}"

RETENTION_P1="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" \
  --region "${REGION}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP}'].retentionInDays | [0]" --output text)"
if [ "${RETENTION_P1}" != "7" ]; then
  echo "FAIL: expected log group retention 7 after Phase 1, got '${RETENTION_P1}'" >&2
  exit 1
fi
echo "    OK: ${LOG_GROUP} retentionInDays == 7 (Custom::LogRetention applied)"

# --- Phase 2: UPDATE retention 7 -> 14 (in-place) ---------------------
echo "==> Phase 2: re-deploy with retention -> 14 days (in-place UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RETENTION_P2="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" \
  --region "${REGION}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP}'].retentionInDays | [0]" --output text)"
if [ "${RETENTION_P2}" != "14" ]; then
  echo "FAIL: expected log group retention 14 after UPDATE, got '${RETENTION_P2}'" >&2
  exit 1
fi
echo "    OK: ${LOG_GROUP} retentionInDays == 14 (in-place control-plane UPDATE)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FUNCTION_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: function is gone"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

# The Custom::LogRetention CR does NOT delete the log group on stack delete
# (matches CloudFormation). Sweep it so the run is orphan-zero.
sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — Lambda logRetention applied (7) + in-place UPDATE (14), all 3 phases passed"
