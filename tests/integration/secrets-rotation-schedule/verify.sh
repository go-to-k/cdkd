#!/usr/bin/env bash
# verify.sh — cdkd Secrets Manager RotationSchedule (CC-API) integ.
#
# A Secrets Manager secret with an automatic rotation schedule backed by a
# rotation Lambda. AWS::SecretsManager::RotationSchedule has no dedicated cdkd
# SDK provider, so it routes through the Cloud Control API fallback. Regression
# coverage for the CC-API create/destroy of a RotationSchedule that references
# both the Secret and the Lambda.
#
# CREATE + DESTROY only (no UPDATE phase) — see the stack docstring: CDK does
# not emit RotateImmediatelyOnUpdate (AWS defaults it true), so the no-op
# rotation Lambda leaves the auto-triggered initial rotation incomplete and any
# rule UPDATE is rejected by AWS ("A previous rotation isn't complete") exactly
# as CloudFormation would. Testing a rule UPDATE would need a real 4-step
# rotation Lambda + polling; out of scope.
#
# Phases:
#   1. Deploy; assert rotation is enabled on the secret, the RotationLambdaARN
#      points at the stack's rotation function, and the schedule is 30 days.
#   2. Destroy; assert the secret is gone (or scheduled for deletion) and the
#      state file is removed; sweep the rotation Lambda's log group.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSecretsRotationScheduleExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SECRET_NAME="${STACK}-secret"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups --region "${REGION}" \
    --log-group-name-prefix "/aws/lambda/${STACK}" \
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
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy + assert rotation configured ---------------------
echo "==> Phase 1: deploy secret + rotation schedule"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ROTATION_ENABLED="$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
  --query 'RotationEnabled' --output text)"
if [ "${ROTATION_ENABLED}" != "True" ]; then
  echo "FAIL: expected RotationEnabled=True, got '${ROTATION_ENABLED}'" >&2
  exit 1
fi

LAMBDA_ARN="$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
  --query 'RotationLambdaARN' --output text)"
case "${LAMBDA_ARN}" in
  *":function:${STACK}-RotationFn"*) ;;
  *) echo "FAIL: RotationLambdaARN does not point at the stack rotation fn: '${LAMBDA_ARN}'" >&2; exit 1 ;;
esac

ROTATION_DAYS="$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
  --query 'RotationRules.AutomaticallyAfterDays' --output text)"
if [ "${ROTATION_DAYS}" != "30" ]; then
  echo "FAIL: expected rotation interval 30 days, got '${ROTATION_DAYS}'" >&2
  exit 1
fi
echo "    rotation enabled, lambda=${LAMBDA_ARN}, interval=30 days"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# The secret must be gone (ResourceNotFound) or scheduled for deletion.
DELETED_DATE="$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
  --query 'DeletedDate' --output text 2>/dev/null || echo "GONE")"
if [ "${DELETED_DATE}" = "None" ]; then
  echo "FAIL: secret ${SECRET_NAME} still live (not deleted/scheduled) after destroy" >&2
  exit 1
fi
echo "    secret deleted (state: ${DELETED_DATE})"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

sweep_log_groups
echo "    rotation lambda log group swept"

echo "[verify] PASS — Secrets Manager RotationSchedule CC-API create + destroy passed"
