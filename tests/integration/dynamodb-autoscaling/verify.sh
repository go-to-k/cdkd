#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB + Application Auto Scaling integ.
#
# A provisioned DynamoDB table with read + write Application Auto Scaling. The
# ScalableTarget / ScalingPolicy types have no dedicated cdkd SDK provider, so
# they route through the Cloud Control API fallback. Regression coverage for:
#   - CREATE of all four autoscaling resources (2 ScalableTargets + 2 policies)
#   - the ScalingPolicy -> ScalableTarget compound-id Ref resolving correctly
#   - an in-place MaxCapacity UPDATE (10 -> 20) that must NOT replace the table
#
# Phases:
#   1. Deploy baseline; assert both ScalableTargets (min5/max10) and both
#      TargetTracking ScalingPolicies (70%) exist in Application Auto Scaling.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (MaxCapacity 10 -> 20). Assert the
#      change reached AWS on both dimensions AND the table was not replaced
#      (CreationDateTime unchanged).
#   3. Destroy; assert the ScalableTargets are deregistered and the state file
#      is gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbAutoscalingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-autoscaling-test-table"
RESOURCE_ID="table/${TABLE_NAME}"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

deregister_targets() {
  for dim in dynamodb:table:ReadCapacityUnits dynamodb:table:WriteCapacityUnits; do
    aws application-autoscaling deregister-scalable-target \
      --service-namespace dynamodb --resource-id "${RESOURCE_ID}" \
      --scalable-dimension "${dim}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  deregister_targets
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (MaxCapacity 10) ------------------------
echo "==> Phase 1: deploy baseline (read+write autoscaling, min5/max10)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Both ScalableTargets must exist with min 5 / max 10.
TARGETS_P1="$(aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --region "${REGION}" \
  --query 'length(ScalableTargets)' --output text)"
if [ "${TARGETS_P1}" != "2" ]; then
  echo "FAIL: expected 2 ScalableTargets after Phase 1, got ${TARGETS_P1}" >&2
  exit 1
fi
for dim in ReadCapacityUnits WriteCapacityUnits; do
  MAXC="$(aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --region "${REGION}" \
    --query "ScalableTargets[?ScalableDimension=='dynamodb:table:${dim}'].MaxCapacity | [0]" --output text)"
  if [ "${MAXC}" != "10" ]; then
    echo "FAIL: ${dim} MaxCapacity expected 10 after Phase 1, got ${MAXC}" >&2
    exit 1
  fi
done
echo "    both ScalableTargets present (min5/max10)"

# Both TargetTracking ScalingPolicies must exist at 70%.
POLICIES_P1="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb --resource-id "${RESOURCE_ID}" --region "${REGION}" \
  --query "length(ScalingPolicies[?PolicyType=='TargetTrackingScaling'])" --output text)"
if [ "${POLICIES_P1}" != "2" ]; then
  echo "FAIL: expected 2 TargetTracking ScalingPolicies, got ${POLICIES_P1}" >&2
  exit 1
fi
echo "    both TargetTracking ScalingPolicies present (compound-id Ref resolved)"

CREATION_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
echo "    baseline table CreationDateTime=${CREATION_P1}"

# --- Phase 2: raise MaxCapacity 10 -> 20 (in-place CC-API patch) -------
echo "==> Phase 2: re-deploy raising MaxCapacity 10 -> 20"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for dim in ReadCapacityUnits WriteCapacityUnits; do
  MAXC="$(aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --region "${REGION}" \
    --query "ScalableTargets[?ScalableDimension=='dynamodb:table:${dim}'].MaxCapacity | [0]" --output text)"
  if [ "${MAXC}" != "20" ]; then
    echo "FAIL: ${dim} MaxCapacity expected 20 after Phase 2, got ${MAXC}" >&2
    exit 1
  fi
done
echo "    MaxCapacity raised to 20 on both dimensions"

# The table must be the SAME table (the autoscaling UPDATE must not ripple into
# a table replacement): CreationDateTime unchanged.
CREATION_P2="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: table was REPLACED (CreationDateTime ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    table identity preserved (CreationDateTime unchanged) — no replacement"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Deregistering a ScalableTarget is synchronous; after destroy none should remain.
TARGETS_GONE="$(aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --region "${REGION}" \
  --query 'length(ScalableTargets)' --output text 2>/dev/null || echo "0")"
if [ "${TARGETS_GONE}" != "0" ]; then
  echo "FAIL: ${TARGETS_GONE} ScalableTarget(s) still registered after destroy" >&2
  exit 1
fi
echo "    all ScalableTargets deregistered"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB Application Auto Scaling CC-API create + in-place MaxCapacity UPDATE + destroy, all 3 phases passed"
