#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt read-only attribute shapes on SDK providers
# (go-to-k/cdkd#6238).
#
# One stack publishes, as Outputs, five read-only attributes that resolved to
# the resource's physical id before the fix: ASG AutoScalingGroupARN, WAFv2
# WebACL Capacity, AppSync ApiKey ApiKeyId, S3Tables Table WarehouseLocation /
# VersionToken. Asserts:
#   1. the deploy succeeds under --strict-getatt (any physical-id fallback
#      fails it), and each Output in state has CloudFormation's shape, matched
#      against the live resource;
#   2. an UPDATE (a second web ACL rule, ASG MaxSize 0 -> 1) keeps every
#      physical id, and the recorded Capacity follows the live one upward;
#   3. a no-op `cdkd diff --fail` exits 0 after it;
#   4. destroy removes everything, state included.

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
cd "$(dirname "$0")"

# The AppSync API key's id IS the credential, and state records it (physical
# id, attributes, the KeyApiKeyId Output); the bucket is versioned, so every
# prior version of state.json / journal / deployments keeps it (issue #2096).
. ../s3-versions.sh

STACK=CdkdGetAttSdkAttrShapes
REGION="${AWS_REGION:-us-east-1}"
API_NAME=cdkd-getatt-sdk-attr-shapes-api
TABLE_BUCKET=cdkd-getatt-sdk-attr-shapes
LOCAL_DIST="${PWD}/../../../dist/cli.js"

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    # NONCURRENT only: this also runs before the run and from the failure
    # traps, where a live state.json may be the only record of what stands.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

read_state() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"; }
output() { read_state | jq -r --arg k "$1" '.outputs[$k] // ""'; }
physical_ids() { read_state | jq -cS '[.resources | to_entries[] | {(.key): .value.physicalId}] | add'; }
acl_live_capacity() {
  local arn="$1" rest id name
  rest="${arn#*:regional/webacl/}"
  name="${rest%%/*}"
  id="${rest#*/}"
  aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" --name "${name}" --id "${id}" \
    --query 'WebACL.Capacity' --output text
}

# Every Output, matched against the live resource. The key id is a credential,
# so it is compared, never printed.
assert_shapes() {
  local asg_name asg_arn live_arn capacity live_capacity api_id key_id live_keys
  local table_arn warehouse token live_warehouse live_token
  asg_name="$(output AsgName)" || return 1
  asg_arn="$(output AsgArn)" || return 1
  live_arn="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --auto-scaling-group-names "${asg_name}" --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text)" || return 1
  case "${asg_arn}" in
    arn:aws*:autoscaling:"${REGION}":*:autoScalingGroup:*:autoScalingGroupName/"${asg_name}") ;;
    *) echo "FAIL: AsgArn '${asg_arn}' is not the ASG's ARN (the pre-#6238 value was the group name '${asg_name}')" >&2; return 1 ;;
  esac
  [ "${asg_arn}" = "${live_arn}" ] || { echo "FAIL: AsgArn '${asg_arn}' differs from the live ARN '${live_arn}'" >&2; return 1; }

  capacity="$(output AclCapacity)" || return 1
  live_capacity="$(acl_live_capacity "$(output AclArn)")" || return 1
  grep -qE '^[1-9][0-9]*$' <<<"${capacity}" || { echo "FAIL: AclCapacity '${capacity}' is not a positive integer (the pre-#6238 value was the web ACL ARN)" >&2; return 1; }
  [ "${capacity}" = "${live_capacity}" ] || { echo "FAIL: AclCapacity ${capacity} differs from the live capacity ${live_capacity}" >&2; return 1; }

  api_id="$(output ApiId)" || return 1
  key_id="$(output KeyApiKeyId)" || return 1
  live_keys="$(aws appsync list-api-keys --api-id "${api_id}" --region "${REGION}" --query 'apiKeys[].id' --output text)" || return 1
  case "${key_id}" in
    *'|'*|'') echo "FAIL: KeyApiKeyId is empty or a composite physical id (the pre-#6238 value was '<apiId>|<key>')" >&2; return 1 ;;
  esac
  [ "${key_id}" = "${live_keys}" ] || { echo "FAIL: KeyApiKeyId is not the API's only key id" >&2; return 1; }

  table_arn="$(output TableArn)" || return 1
  warehouse="$(output TableWarehouseLocation)" || return 1
  token="$(output TableVersionToken)" || return 1
  live_warehouse="$(aws s3tables get-table --table-arn "${table_arn}" --region "${REGION}" --query 'warehouseLocation' --output text)" || return 1
  live_token="$(aws s3tables get-table --table-arn "${table_arn}" --region "${REGION}" --query 'versionToken' --output text)" || return 1
  case "${warehouse}" in
    s3://?*) ;;
    *) echo "FAIL: TableWarehouseLocation '${warehouse}' is not an s3:// location (the pre-#6238 value was the composite physical id)" >&2; return 1 ;;
  esac
  [ "${warehouse}" = "${live_warehouse}" ] || { echo "FAIL: TableWarehouseLocation '${warehouse}' differs from the live '${live_warehouse}'" >&2; return 1; }
  [ "${token}" = "${live_token}" ] || { echo "FAIL: TableVersionToken '${token}' differs from the live '${live_token}'" >&2; return 1; }
  printf '%s' "${capacity}"
}

echo "==> 1. Deploy (--strict-getatt)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --strict-getatt --yes
CAPACITY_1="$(assert_shapes)"
echo "    OK: all five Outputs carry CloudFormation's shape and match the live resources"
IDS="$(physical_ids)"

echo "==> 2. UPDATE (second web ACL rule, ASG MaxSize 0 -> 1)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --strict-getatt --yes
[ "$(physical_ids)" = "${IDS}" ] || { echo "FAIL: physical ids changed (replacement): ${IDS} -> $(physical_ids)" >&2; exit 1; }
CAPACITY_2="$(assert_shapes)"
[ "${CAPACITY_2}" -gt "${CAPACITY_1}" ] || { echo "FAIL: AclCapacity ${CAPACITY_2} did not grow past ${CAPACITY_1} after adding a rule (stale pre-update read)" >&2; exit 1; }
MAX="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "$(output AsgName)" --query 'AutoScalingGroups[0].MaxSize' --output text)"
[ "${MAX}" = "1" ] || { echo "FAIL: ASG MaxSize is ${MAX} after the update, expected 1" >&2; exit 1; }
echo "    OK: updated in place; Capacity ${CAPACITY_1} -> ${CAPACITY_2} follows the live web ACL"

echo "==> 3. No-op diff"
rc=0
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail >/dev/null 2>&1 || rc=$?
[ "${rc}" = "0" ] || { echo "FAIL: cdkd diff --fail exited ${rc} after the update (expected 0, no changes)" >&2; exit 1; }
echo "    OK: no changes"

ASG_NAME="$(output AsgName)"
ACL_ARN="$(output AclArn)"
API_ID="$(output ApiId)"
TABLE_BUCKET_ARN="$(read_state | jq -r '.resources.TableBucket.physicalId')"

echo "==> 4. Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
LEFT="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" --auto-scaling-group-names "${ASG_NAME}" --query 'AutoScalingGroups[].AutoScalingGroupName' --output text)"
[ -z "${LEFT}" ] || { echo "FAIL: ASG remains: ${LEFT}" >&2; exit 1; }
REST="${ACL_ARN#*:regional/webacl/}"
assert_gone "web ACL remains" aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" --name "${REST%%/*}" --id "${REST#*/}"
assert_gone "GraphQL API ${API_NAME} remains" aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}"
assert_gone "table bucket ${TABLE_BUCKET} remains" aws s3tables get-table-bucket --table-bucket-arn "${TABLE_BUCKET_ARN}" --region "${REGION}"
echo "    OK: ASG, web ACL, GraphQL API, table bucket and state gone"

trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "getatt-sdk-attr-shapes state teardown"
echo ""
echo "==> getatt-sdk-attr-shapes test passed"
