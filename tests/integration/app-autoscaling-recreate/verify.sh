#!/usr/bin/env bash
# verify.sh — an imported scalable target is recorded on Cloud Control, and a
# --recreate-via-cc-api of it is refused rather than losing its scaling policy
# (issue #4706).
#
# A scalable target has no SDK provider, so `cdkd import` reads it through
# Cloud Control. Deregistering a target deletes its scaling policies. Phases:
#   1. deploy -> one target-tracking policy on AWS.
#   2. THE IMPORT ARM: drop the state record, `cdkd import` the stack from the
#      recorded physical ids -> the target's record says provisionedBy=cc-api.
#      Before the fix every imported record said `sdk`.
#   3. `--recreate-via-cc-api <target>` is refused at pre-flight (already on
#      Cloud Control); the target's CreationTime and its policy are untouched.
#      Before the fix the recreate deregistered the target and the policy went
#      with it under a green deploy.
#   4. THE LEGACY-RECORD ARM: rewrite the target's record to `sdk`, what an
#      earlier `cdkd import` wrote, and ask again: still refused, since the
#      type has no SDK provider whatever its record says.
#   5. destroy + gone-probes.

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

STACK="CdkdAppAutoscalingRecreateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="${STACK}-table"
RESOURCE_ID="table/${TABLE_NAME}"
DIMENSION="dynamodb:table:ReadCapacityUnits"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The state record of one resource, by exact logical id. Hard-fails on no
# match: a guessed key would make every assertion read `null`.
record() { # usage: record <logical-id> <jq-expression-over-the-resource-object>
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}" | jq -e --arg k "$1" '.resources | has($k)' >/dev/null \
    || { echo "FAIL: no state resource with logical id $1" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

# The ARNs of the table's read-capacity scaling policies, sorted, one per line.
policy_arns() {
  aws application-autoscaling describe-scaling-policies \
    --service-namespace dynamodb --resource-id "${RESOURCE_ID}" --scalable-dimension "${DIMENSION}" \
    --region "${REGION}" --query 'ScalingPolicies[].PolicyARN' --output json | jq -r '.[]' | sort
}

# The scalable target's CreationTime: it moves only when the target is
# deregistered and registered again.
target_created() {
  aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --scalable-dimension "${DIMENSION}" \
    --region "${REGION}" --query 'ScalableTargets[0].CreationTime' --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # Every name below derives from STACK; an empty STACK would widen the
  # table name and resource id, so the guard refuses it.
  case "${STACK}" in
    CdkdAppAutoscalingRecreate?*)
      for name in $(aws application-autoscaling describe-scaling-policies \
          --service-namespace dynamodb --resource-id "${RESOURCE_ID}" --region "${REGION}" \
          --query 'ScalingPolicies[].PolicyName' --output text 2>/dev/null); do
        aws application-autoscaling delete-scaling-policy --service-namespace dynamodb \
          --resource-id "${RESOURCE_ID}" --scalable-dimension "${DIMENSION}" \
          --policy-name "${name}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      aws application-autoscaling deregister-scalable-target --service-namespace dynamodb \
        --resource-id "${RESOURCE_ID}" --scalable-dimension "${DIMENSION}" \
        --region "${REGION}" >/dev/null 2>&1 || true
      aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
      # The delete is asynchronous: a pre-run cleanup must not hand the next
      # deploy a name still DELETING.
      aws dynamodb wait table-not-exists --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
      ;;
    *) echo "    WARN: teardown sweep refused a stack scope outside CdkdAppAutoscalingRecreate*: '${STACK:-<empty>}'" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
logical_id_of() { # usage: logical_id_of <resource type>; exactly one match or FAIL
  local ids
  ids=$(jq -r --arg t "$1" '.Resources | to_entries[] | select(.value.Type == $t) | .key' "${TEMPLATE}")
  [ "$(printf '%s\n' "${ids}" | grep -c .)" = "1" ] || { echo "FAIL: expected one $1 in ${TEMPLATE}, got: ${ids:-none}" >&2; exit 1; }
  printf '%s' "${ids}"
}
TARGET_LID=$(logical_id_of AWS::ApplicationAutoScaling::ScalableTarget)
POLICY_LID=$(logical_id_of AWS::ApplicationAutoScaling::ScalingPolicy)
echo "==> Scalable target: ${TARGET_LID}; scaling policy: ${POLICY_LID}"

echo "==> Phase 1: Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ARNS1=$(policy_arns)
[ "$(printf '%s\n' "${ARNS1}" | grep -c .)" = "1" ] || { echo "FAIL: phase 1: expected 1 scaling policy on ${RESOURCE_ID}, got: ${ARNS1:-none}" >&2; exit 1; }
TARGET_ID=$(record "${TARGET_LID}" '.physicalId')
[ "${TARGET_ID}" = "${RESOURCE_ID}|${DIMENSION}|dynamodb" ] || { echo "FAIL: the target's physical id is ${TARGET_ID}, expected ${RESOURCE_ID}|${DIMENSION}|dynamodb" >&2; exit 1; }
LAYER_DEPLOYED=$(record "${TARGET_LID}" '.provisionedBy')
[ "${LAYER_DEPLOYED}" = "cc-api" ] || { echo "FAIL: premise: a deploy recorded the target provisionedBy=${LAYER_DEPLOYED}, expected cc-api" >&2; exit 1; }
CREATED1=$(target_created)
[ -n "${CREATED1}" ] && [ "${CREATED1}" != "None" ] || { echo "FAIL: no CreationTime for the scalable target" >&2; exit 1; }
echo "    OK: target ${TARGET_ID} on Cloud Control, one policy ${ARNS1}"

echo "==> Phase 2: THE IMPORT ARM -- import the stack into a fresh state record"
MAPPING=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -c '.resources | with_entries(.value = .value.physicalId)')
[ "$(printf '%s' "${MAPPING}" | jq 'length')" -ge 3 ] || { echo "FAIL: expected at least 3 recorded resources to re-import, got ${MAPPING}" >&2; exit 1; }
aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
# `cdkd import` takes no region flag; the region reaches it through AWS_REGION.
AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource-mapping-inline "${MAPPING}" --yes
[ "$(record "${TARGET_LID}" '.physicalId')" = "${TARGET_ID}" ] || { echo "FAIL: the import recorded another id for the target" >&2; exit 1; }
LAYER_IMPORTED=$(record "${TARGET_LID}" '.provisionedBy')
[ "${LAYER_IMPORTED}" = "cc-api" ] || { echo "FAIL: cdkd import recorded the scalable target provisionedBy=${LAYER_IMPORTED}, expected cc-api: it was read through Cloud Control (issue #4706)" >&2; exit 1; }
[ "$(record "${POLICY_LID}" '.provisionedBy')" = "cc-api" ] || { echo "FAIL: cdkd import did not record the scaling policy on cc-api" >&2; exit 1; }
echo "    OK: the imported target and policy are recorded on Cloud Control"

# A `--recreate-via-cc-api` of the target must be refused at pre-flight, before
# anything changes: the target keeps its CreationTime and its policy.
expect_recreate_refused() { # usage: expect_recreate_refused <why>
  local out rc
  set +e
  out=$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${TARGET_LID}" --yes 2>&1)
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ]; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: --recreate-via-cc-api of the scalable target ($1) was not refused (issue #4706)" >&2
    exit 1
  fi
  grep -q 'ALREADY sticky on Cloud Control API' <<<"${out}" || {
    printf '%s\n' "${out}" >&2
    echo "FAIL: the deploy ($1) failed, but not with the already-on-Cloud-Control refusal" >&2
    exit 1
  }
  [ "$(target_created)" = "${CREATED1}" ] || { echo "FAIL: the refused recreate ($1) re-registered the target" >&2; exit 1; }
  [ "$(policy_arns)" = "${ARNS1}" ] || { echo "FAIL: the refused recreate ($1) changed the scaling policies: $(policy_arns)" >&2; exit 1; }
}

echo "==> Phase 3: --recreate-via-cc-api of the imported target is refused"
expect_recreate_refused "imported record"
echo "    OK: refused before anything changed; target and policy intact"

echo "==> Phase 4: ...and refused from a record saying sdk, as an earlier cdkd import wrote it"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq --arg k "${TARGET_LID}" '.resources[$k].provisionedBy = "sdk"' \
  | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --content-type application/json >/dev/null
[ "$(record "${TARGET_LID}" '.provisionedBy')" = "sdk" ] || { echo "FAIL: could not write the legacy record" >&2; exit 1; }
expect_recreate_refused "legacy sdk record"
echo "    OK: a type with no SDK provider is refused whatever its record says"

echo "==> Phase 5: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
TARGETS_LEFT=$(aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb --resource-ids "${RESOURCE_ID}" --region "${REGION}" \
  --query 'length(ScalableTargets)' --output text)
[ "${TARGETS_LEFT}" = "0" ] || { echo "FAIL: ${TARGETS_LEFT} scalable target(s) still registered after destroy" >&2; exit 1; }
POLICIES_LEFT=$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb --resource-id "${RESOURCE_ID}" --region "${REGION}" \
  --query 'length(ScalingPolicies)' --output text)
[ "${POLICIES_LEFT}" = "0" ] || { echo "FAIL: ${POLICIES_LEFT} scaling polic(ies) left after destroy" >&2; exit 1; }
# DeleteTable returns while the table is DELETING; wait for it to go.
aws dynamodb wait table-not-exists --table-name "${TABLE_NAME}" --region "${REGION}"
assert_gone "DynamoDB table ${TABLE_NAME} survived destroy" \
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — app-autoscaling-recreate (an imported scalable target is recorded on Cloud Control and its recreate is refused, policy intact)"
