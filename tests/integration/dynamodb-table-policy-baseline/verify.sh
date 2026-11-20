#!/usr/bin/env bash
# A DynamoDB Table ResourcePolicy add and removal leave a drift baseline that
# matches the settled table, so drift stays clean and --revert plans nothing
# (go-to-k/cdkd#6604).
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
STACK="CdkdDynamoDBTablePolicyBaselineExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
TABLE_NAME=""
TABLE_ARN=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    :
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: run vp run build first" >&2; exit 1; }
if [ ! -d node_modules ]; then pnpm install --ignore-workspace --prefer-offline; fi
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" --only-show-errors
}
deploy_phase() { # CDKD_TEST_REMOVAL [CDKD_TEST_TAG]
  CDKD_TEST_REMOVAL="$1" CDKD_TEST_TAG="${2:-v1}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
}
# The one table's logical id, asserted unique (the stack declares one table).
table_id() {
  local ids
  ids=$(state_json | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DynamoDB::Table") | .key]') || return 1
  [ "$(jq 'length' <<<"${ids}")" = 1 ] || { echo "FAIL: expected one table record, got ${ids}" >&2; exit 1; }
  jq -r '.[0]' <<<"${ids}"
}
# Wait until the live table holds a policy ("present") or none ("absent").
# GetResourcePolicy lags each write by seconds, so poll.
check_live_policy() { # present|absent
  local out
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if out=$(aws dynamodb get-resource-policy --region "${REGION}" --resource-arn "${TABLE_ARN}" \
      --query Policy --output text 2>&1); then
      if [ "$1" = present ] && grep -q 'dynamodb:GetItem' <<<"${out}"; then
        echo "    OK: the live table holds the declared policy"
        return 0
      fi
    elif grep -qi 'PolicyNotFound' <<<"${out}"; then
      if [ "$1" = absent ]; then
        echo "    OK: the live table holds no policy"
        return 0
      fi
    else
      echo "FAIL: get-resource-policy failed: ${out}" >&2
      exit 1
    fi
    sleep 5
  done
  echo "FAIL: the live policy never became $1 (last answer: ${out})" >&2
  exit 1
}
# The deploy's own capture: the baseline names a policy exactly when declared.
check_baseline() { # present|absent
  local id recorded
  id=$(table_id) || exit 1
  recorded=$(state_json | jq -c --arg id "${id}" '.resources[$id].observedProperties.ResourcePolicy') || exit 1
  if [ "$1" = present ]; then
    grep -q 'dynamodb:GetItem' <<<"${recorded}" || { echo "FAIL: the baseline lacks the declared policy: ${recorded}" >&2; exit 1; }
  else
    [ "${recorded}" = null ] || { echo "FAIL: the baseline still holds a removed policy: ${recorded}" >&2; exit 1; }
  fi
  echo "    OK: the observed baseline policy is $1"
}
check_drift() { # phase label
  local report id
  id=$(table_id) || exit 1
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || {
    echo "FAIL: cdkd drift failed or reported drift after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  }
  if ! jq -e --arg stack "${STACK}" --arg id "${id}" '
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[] | select(.logicalId == $id)] | length) == 1 and
    ([$reports[0].drifted[] | select(.logicalId == $id)] | length) == 0 and
    ([$reports[0].notCompared[] | select(.logicalId == $id)] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: ${id} was not fully compared and drift-clean after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: the table is fully compared and drift-clean after $1"
}

cleanup
CLEANED_UP=0

echo "==> Create the table with a resource policy"
deploy_phase false
STATE=$(state_json)
TABLE_NAME=$(printf '%s' "${STATE}" | jq -r '.outputs.TableName')
TABLE_ARN=$(printf '%s' "${STATE}" | jq -r '.outputs.TableArn')
case "${TABLE_ARN}" in arn:aws*:dynamodb:*:table/?*) ;; *) echo "FAIL: no table ARN" >&2; exit 1 ;; esac
check_live_policy present
check_baseline present
check_drift "the create"

echo "==> Remove the resource policy: the baseline must not keep the deleted one (#6604)"
# Before the fix the capture read the policy DeleteResourcePolicy had just
# removed, so drift reported it and --revert re-granted it.
deploy_phase true
check_baseline absent
check_live_policy absent
check_drift "the removal"

echo "==> Declare the resource policy again: the baseline must hold it"
deploy_phase false
check_baseline present
check_live_policy present
check_drift "the re-add"

# --- go-to-k/cdkd#6609 slice E: the Tags baseline after an update's tag call ---
# ListTagsOfResource answered the previous tags for up to ~2.5 s after a
# TagResource (measured), and the deploy recorded that answer, so drift
# reported an untouched table and --revert put the old tag back.
# The user tags (aws: dropped) of the table baseline / the live table, as
# compact JSON sorted by key.
baseline_tags() {
  local id
  id=$(table_id) || exit 1
  state_json | jq -c --arg id "${id}" \
    '.resources[$id].observedProperties.Tags | map(select(.Key | startswith("aws:") | not)) | sort_by(.Key)'
}
live_tags() {
  aws dynamodb list-tags-of-resource --region "${REGION}" --resource-arn "${TABLE_ARN}" --output json \
    | jq -c '.Tags | map(select(.Key | startswith("aws:") | not)) | sort_by(.Key)'
}
# Waits until 3 reads in a row answer the user tag set $1.
await_live_tags() { # $1 = compact JSON, $2 = label
  local seen=0 got=""
  for _ in $(seq 1 30); do
    got=$(live_tags 2>/dev/null) || got="read-failed"
    if [ "${got}" = "$1" ]; then seen=$((seen + 1)); else seen=0; fi
    [ "${seen}" -ge 3 ] && return 0
    sleep 2
  done
  echo "FAIL: $2: the live tags never settled on $1 (last: ${got})" >&2
  exit 1
}
table_created() {
  aws dynamodb describe-table --region "${REGION}" --table-name "${TABLE_NAME}" \
    --query 'Table.CreationDateTime' --output text
}
TAGS_V2='[{"Key":"Lag6609e","Value":"v2"}]'

echo "==> Change the table tag: the baseline must hold the new value (#6609)"
CREATED_BEFORE=$(table_created)
[ -n "${CREATED_BEFORE}" ] && [ "${CREATED_BEFORE}" != None ] || { echo "FAIL: no CreationDateTime" >&2; exit 1; }
PHYS_BEFORE=$(state_json | jq -r --arg id "$(table_id)" '.resources[$id].physicalId')
deploy_phase false v2
# Every later synth (drift, --revert) sees the template this deploy applied.
export CDKD_TEST_TAG=v2
GOT=$(baseline_tags)
[ "${GOT}" = "${TAGS_V2}" ] || { echo "FAIL: the baseline Tags are ${GOT}, want ${TAGS_V2} (the pre-write tag recorded?)" >&2; exit 1; }
echo "    OK: the observed baseline Tags equal the declared ${TAGS_V2}"
await_live_tags "${TAGS_V2}" "after the tag change"
check_drift "the tag change"

echo "==> Tag the table out of band: drift reports Tags, drift --revert restores them in place (#6609)"
aws dynamodb tag-resource --region "${REGION}" --resource-arn "${TABLE_ARN}" \
  --tags Key=Lag6609e,Value=oob >/dev/null
await_live_tags '[{"Key":"Lag6609e","Value":"oob"}]' "after the out-of-band tag"
set +e
REVERT_DRIFT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)
set -e
REVERT_PATHS=$(jq -c --arg id "$(table_id)" '[.[].drifted[] | select(.logicalId == $id) | .changes[].path]' <<<"${REVERT_DRIFT}") || {
  echo "FAIL: could not parse cdkd drift --json" >&2
  printf '%s\n' "${REVERT_DRIFT}" >&2
  exit 1
}
case "${REVERT_PATHS}" in
  *Tags*) echo "    OK: drift reports the out-of-band tag (${REVERT_PATHS})" ;;
  *) echo "FAIL: drift did not report Tags on the table (paths: ${REVERT_PATHS})" >&2; printf '%s\n' "${REVERT_DRIFT}" >&2; exit 1 ;;
esac
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes || { echo "FAIL: cdkd drift --revert failed" >&2; exit 1; }
await_live_tags "${TAGS_V2}" "after drift --revert"
ARN_AFTER=$(aws dynamodb describe-table --region "${REGION}" --table-name "${TABLE_NAME}" --query 'Table.TableArn' --output text)
[ "${ARN_AFTER}" = "${TABLE_ARN}" ] || { echo "FAIL: the table ARN changed ${TABLE_ARN} -> ${ARN_AFTER}" >&2; exit 1; }
CREATED_AFTER=$(table_created)
[ "${CREATED_AFTER}" = "${CREATED_BEFORE}" ] || { echo "FAIL: CreationDateTime ${CREATED_BEFORE} -> ${CREATED_AFTER}: --revert replaced the table" >&2; exit 1; }
PHYS_AFTER=$(state_json | jq -r --arg id "$(table_id)" '.resources[$id].physicalId')
[ "${PHYS_AFTER}" = "${PHYS_BEFORE}" ] || { echo "FAIL: state physicalId ${PHYS_BEFORE} -> ${PHYS_AFTER}" >&2; exit 1; }
echo "    OK: --revert restored the tag on the same table (ARN, CreationDateTime and physicalId kept)"
check_drift "drift --revert"

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "table still exists" aws dynamodb describe-table --region "${REGION}" --table-name "${TABLE_NAME}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
trap - EXIT INT TERM
echo "[verify] PASS: a Table ResourcePolicy removal and re-add and a tag change left a settled baseline, drift --revert restored a tag in place, drift clean, clean destroy (#6604, #6609)"
