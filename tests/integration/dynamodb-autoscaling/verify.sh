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
#   3. Re-deploy with CDKD_TEST_RENAME=true (go-to-k/cdkd#4701): the table
#      rename replaces it and both ScalableTargets under new ids. Each
#      ScalingPolicy holds its target in ScalingTargetId, create-only AND
#      write-only in the schema, so it must be REPLACED onto the new target
#      (pre-fix it was planned as an in-place update of a policy AWS deletes
#      with the old target).
#   4. Destroy; assert the ScalableTargets are deregistered and the state file
#      is gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
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

cd "$(dirname "$0")"

STACK="CdkdDynamodbAutoscalingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-autoscaling-test-table"
RESOURCE_ID="table/${TABLE_NAME}"
# Phase 3 (go-to-k/cdkd#4701) renames the table.
TABLE_NAME_B="cdkd-autoscaling-test-table-b"
RESOURCE_ID_B="table/${TABLE_NAME_B}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

deregister_targets() {
  for rid in "${RESOURCE_ID}" "${RESOURCE_ID_B}"; do
    for dim in dynamodb:table:ReadCapacityUnits dynamodb:table:WriteCapacityUnits; do
      aws application-autoscaling deregister-scalable-target \
        --service-namespace dynamodb --resource-id "${rid}" \
        --scalable-dimension "${dim}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  rm -f "${P3_LOG:-}"
  deregister_targets
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws dynamodb delete-table --table-name "${TABLE_NAME_B}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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
env -u CDKD_TEST_UPDATE -u CDKD_TEST_RENAME node "${LOCAL_DIST}" deploy "${STACK}" \
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
env -u CDKD_TEST_RENAME CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
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

# --- Phase 3: rename the table, replacing both ScalableTargets (#4701) -----
# The rename replaces the table (create-only TableName) and each
# ScalableTarget (create-only ResourceId) under a new id. Each ScalingPolicy
# holds its target in ScalingTargetId, which the live schema lists create-only
# AND write-only; the schema fallback left a write-only create-only property
# out, so the policy was planned as an in-place UPDATE. AWS deletes a target's
# policies when it deregisters it, so the policy must be REPLACED onto the new
# target. --force-stateful-recreation: the table replacement is a stateful one.
echo "==> Phase 3: re-deploy renaming the table (replaces both ScalableTargets, #4701)"
# The ScalingPolicy records as "<physicalId> <table/... segment of the
# recorded ScalingTargetId>", sorted. The target's id is a '|'-joined compound,
# so the table is read as one exact segment, whatever the segment order.
state_policies() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '
    [.resources[] | select(.resourceType == "AWS::ApplicationAutoScaling::ScalingPolicy")
      | "\(.physicalId) \((.properties.ScalingTargetId // "") | split("|")
          | map(select(startswith("table/"))) | .[0] // "<absent>")"] | sort | .[]'
}
policies_on() { # usage: policies_on <records> <table/...>; how many records hold it
  printf '%s\n' "$1" | awk -v rid="$2" '$2 == rid { n++ } END { print n + 0 }'
}
P3_OLD_POLICIES="$(state_policies)"
if [ "$(policies_on "${P3_OLD_POLICIES}" "${RESOURCE_ID}")" != "2" ]; then
  echo "FAIL: #4701 premise: state does not record 2 ScalingPolicies on ${RESOURCE_ID}:" >&2
  printf '%s\n' "${P3_OLD_POLICIES}" >&2
  exit 1
fi
P3_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_RENAME=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force-stateful-recreation --yes >"${P3_LOG}" 2>&1
P3_RC=$?
set -e
P3_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${P3_LOG}")"
rm -f "${P3_LOG}"
P3_LOG=""
printf '%s\n' "${P3_PLAIN}" | sed 's/^/  /'
# Pre-fix, this is the first assertion to go red: each policy is planned as an
# in-place update, so no policy is replaced through ScalingTargetId.
P3_REPLACED="$(grep -cE 'Replacing [A-Za-z0-9]+ \(AWS::ApplicationAutoScaling::ScalingPolicy\) - immutable properties changed: ScalingTargetId' <<<"${P3_PLAIN}" || true)"
if [ "${P3_REPLACED}" != "2" ]; then
  echo "FAIL: #4701: expected both ScalingPolicies replaced through ScalingTargetId, saw ${P3_REPLACED} (output above)" >&2
  exit 1
fi
if grep -iE 'HandlerErrorCode: NotFound|ObjectNotFoundException|No scaling policy found' <<<"${P3_PLAIN}" >/dev/null; then
  echo "FAIL: #4701: the rename deploy hit NotFound (output above) -- a policy was updated after AWS deleted it" >&2
  exit 1
fi
if [ "${P3_RC}" -ne 0 ]; then
  echo "FAIL: #4701: the rename deploy exited ${P3_RC} (output above)" >&2
  exit 1
fi
for rid_and_count in "${RESOURCE_ID_B}:2" "${RESOURCE_ID}:0"; do
  rid="${rid_and_count%:*}"
  want="${rid_and_count##*:}"
  got="$(aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb --resource-ids "${rid}" --region "${REGION}" \
    --query 'length(ScalableTargets)' --output text)"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: #4701: expected ${want} ScalableTargets on ${rid} after the rename, got ${got}" >&2
    exit 1
  fi
  got="$(aws application-autoscaling describe-scaling-policies \
    --service-namespace dynamodb --resource-id "${rid}" --region "${REGION}" \
    --query "length(ScalingPolicies[?PolicyType=='TargetTrackingScaling'])" --output text)"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: #4701: expected ${want} TargetTracking ScalingPolicies on ${rid} after the rename, got ${got}" >&2
    exit 1
  fi
done
# State must record two NEW policies, each holding its target on the new table:
# a record on the old id names a policy AWS deleted with the old target.
P3_NEW_POLICIES="$(state_policies)"
if [ "$(policies_on "${P3_NEW_POLICIES}" "${RESOURCE_ID_B}")" != "2" ]; then
  echo "FAIL: #4701: state does not record both ScalingPolicies on ${RESOURCE_ID_B}:" >&2
  printf '%s\n' "${P3_NEW_POLICIES}" >&2
  exit 1
fi
while read -r old_id _; do
  if printf '%s\n' "${P3_NEW_POLICIES}" | grep -qF "${old_id} "; then
    echo "FAIL: #4701: state still records the deleted policy ${old_id}" >&2
    exit 1
  fi
done <<<"${P3_OLD_POLICIES}"
# Each recorded policy ARN exists on AWS, on the new table.
LIVE_ARNS="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb --resource-id "${RESOURCE_ID_B}" --region "${REGION}" \
  --query 'ScalingPolicies[].PolicyARN' --output text)"
while read -r new_id _; do
  arn="${new_id%%|*}"
  if ! grep -qF -- "${arn}" <<<"${LIVE_ARNS}"; then
    echo "FAIL: #4701: recorded policy ${arn} is not on ${RESOURCE_ID_B} (live: ${LIVE_ARNS})" >&2
    exit 1
  fi
done <<<"${P3_NEW_POLICIES}"
echo "    both ScalingPolicies replaced onto the new ScalableTargets (${RESOURCE_ID_B}), no NotFound"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Deregistering a ScalableTarget is synchronous; after destroy none should remain.
TARGETS_GONE="$(aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" "${RESOURCE_ID_B}" --region "${REGION}" \
  --query 'length(ScalableTargets)' --output text)"
if [ "${TARGETS_GONE}" != "0" ]; then
  echo "FAIL: ${TARGETS_GONE} ScalableTarget(s) still registered after destroy" >&2
  exit 1
fi
echo "    all ScalableTargets deregistered"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB Application Auto Scaling CC-API create + in-place MaxCapacity UPDATE + rename replacing both ScalingPolicies (#4701) + destroy, all 4 phases passed"
