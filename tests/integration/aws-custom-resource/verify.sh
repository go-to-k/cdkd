#!/usr/bin/env bash
# verify.sh — cdkd AwsCustomResource (Custom::AWS) onCreate/onUpdate/onDelete.
#
# AwsCustomResource is the canonical "call an SDK API from a CR" pattern. This
# test exercises all three lifecycle hooks against a real SSM parameter:
#   - onCreate writes value v1-created
#   - onUpdate (CDKD_TEST_UPDATE=true) rewrites it to v2-updated, in place
#   - onDelete removes the parameter on destroy
#
# Phases:
#   1. Deploy baseline. Assert the SSM parameter == v1-created (onCreate ran).
#   2. Re-deploy with CDKD_TEST_UPDATE=true. Assert the parameter == v2-updated
#      (onUpdate fired — an in-place control-plane change, not a replacement).
#   3. Destroy + assert the parameter is GONE (onDelete ran) and state removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdAwsCustomResourceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_NAME="/cdkd-awscr/value"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

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
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (onCreate -> v1-created) ----------------
echo "==> Phase 1: deploy baseline"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VAL_P1="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "")"
if [ "${VAL_P1}" != "v1-created" ]; then
  echo "FAIL: expected SSM ${PARAM_NAME} == v1-created after onCreate, got '${VAL_P1}'" >&2
  exit 1
fi
echo "    OK: onCreate wrote ${PARAM_NAME} == v1-created"

# --- Phase 2: UPDATE (onUpdate -> v2-updated) ------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (onUpdate)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VAL_P2="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "")"
if [ "${VAL_P2}" != "v2-updated" ]; then
  echo "FAIL: expected SSM ${PARAM_NAME} == v2-updated after onUpdate, got '${VAL_P2}'" >&2
  exit 1
fi
echo "    OK: onUpdate rewrote ${PARAM_NAME} == v2-updated (in-place)"

# --- Phase 3: destroy (onDelete removes the parameter) ----------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${PARAM_NAME} still exists after destroy (onDelete did not run)" >&2
  exit 1
fi
echo "    OK: onDelete removed the parameter"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — AwsCustomResource onCreate/onUpdate/onDelete all fired, all 3 phases passed"
