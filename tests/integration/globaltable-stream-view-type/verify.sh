#!/usr/bin/env bash
# verify.sh — issue #7000: changing a TableV2 (`AWS::DynamoDB::GlobalTable`)
# stream view type failed every deploy with "Table already has an enabled
# stream", because the provider sent the new view type to an enabled stream.
# CloudFormation disables the stream and enables the new one. Phases:
#   1. deploy NEW_IMAGE with a Lambda consumer -> the mapping reads the stream
#   2. NEW_AND_OLD_IMAGES                      -> a new stream arn, the
#      mapping moved onto it (issue #6999), state records it, drift clean
#   2b. Kinesis precision MILLISECOND -> MICROSECOND under --no-wait
#      (go-to-k/cdkd#7132) -> the deploy returns with the destination
#      UPDATING (ACTIVE is accepted and recorded: then 2c cannot reach the
#      pre-send wait)
#   2c. back to MILLISECOND at once, default wait -> succeeds (DynamoDB
#      refuses an update to a destination still UPDATING, so the update waits
#      for ACTIVE before it sends) and reads ACTIVE MILLISECOND
#   3. destroy                                 -> table, mapping, function,
#      Kinesis stream and state gone

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

STACK="CdkdGlobalTableStreamViewType"
TABLE="CdkdGlobalTableStreamViewType"
CONSUMER="cdkd-gt-stream-view-type-consumer"
KINESIS_STREAM="cdkd-gt-stream-view-type-7132"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${CONSUMER}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${KINESIS_STREAM}" --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REGION}"
aws kinesis wait stream-not-exists --stream-name "${KINESIS_STREAM}" --region "${REGION}"

view_type() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query 'Table.StreamSpecification.StreamViewType' --output text
}
stream_arn() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query 'Table.LatestStreamArn' --output text
}
# The consumer's mappings other than one Lambda is still deleting: a
# replacement creates the new mapping first and its old one lingers in
# `Deleting` for a while after the deploy returns.
esm_arns() {
  aws lambda list-event-source-mappings --function-name "${CONSUMER}" --region "${REGION}" \
    --query "EventSourceMappings[?State!='Deleting'].EventSourceArn" --output json | jq -r '.[]'
}
assert_esm_on() { # usage: assert_esm_on <stream arn> <phase>
  local arns=""
  for _ in $(seq 1 12); do
    arns="$(esm_arns)" || return 1
    [ "${arns}" = "$1" ] && break
    sleep 5
  done
  if [ "${arns}" != "$1" ]; then
    echo "FAIL: $2: the consumer's event source mapping reads '${arns}', expected exactly '$1'" >&2
    return 1
  fi
  echo "    OK: $2: the consumer's mapping reads ${1##*/stream/}"
}

echo "==> Phase 1: deploy a NEW_IMAGE stream with a consumer"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(view_type)" = "NEW_IMAGE" ] || { echo "FAIL: Phase 1: StreamViewType is '$(view_type)', expected NEW_IMAGE" >&2; exit 1; }
ARN_1="$(stream_arn)"
case "${ARN_1}" in
  arn:*:table/"${TABLE}"/stream/?*) ;;
  *) echo "FAIL: Phase 1: no LatestStreamArn (got '${ARN_1}')" >&2; exit 1 ;;
esac
assert_esm_on "${ARN_1}" "Phase 1" || exit 1

echo "==> Phase 2: change the view type to NEW_AND_OLD_IMAGES"
# Before #7000 this deploy failed: "Table already has an enabled stream".
CDKD_TEST_UPDATE=viewtype node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(view_type)" = "NEW_AND_OLD_IMAGES" ] || { echo "FAIL: Phase 2: StreamViewType is '$(view_type)', expected NEW_AND_OLD_IMAGES" >&2; exit 1; }
ARN_2="$(stream_arn)"
if [ -z "${ARN_2}" ] || [ "${ARN_2}" = "None" ] || [ "${ARN_2}" = "${ARN_1}" ]; then
  echo "FAIL: Phase 2: the view type change did not mint a new stream arn (before '${ARN_1}', after '${ARN_2}')" >&2
  exit 1
fi
assert_esm_on "${ARN_2}" "Phase 2" || exit 1
ESM_UUID="$(aws lambda list-event-source-mappings --function-name "${CONSUMER}" --region "${REGION}" \
  --query "EventSourceMappings[?State!='Deleting'].UUID" --output json | jq -r '.[0] // ""')"
[ -n "${ESM_UUID}" ] || { echo "FAIL: Phase 2: no live event source mapping UUID" >&2; exit 1; }
RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '[.resources[] | select(.resourceType == "AWS::DynamoDB::GlobalTable") | .attributes.StreamArn] | if length == 1 then .[0] else "" end')"
[ "${RECORDED}" = "${ARN_2}" ] || { echo "FAIL: Phase 2: state records StreamArn '${RECORDED}', expected '${ARN_2}'" >&2; exit 1; }
echo "    OK: state records the new stream arn"
DRIFT_RC=0
CDKD_TEST_UPDATE=viewtype node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" >"${LOG_DIR}/drift.log" 2>&1 || DRIFT_RC=$?
[ "${DRIFT_RC}" -eq 0 ] || { cat "${LOG_DIR}/drift.log" >&2; echo "FAIL: Phase 2: drift exited ${DRIFT_RC}, expected 0 (clean)" >&2; exit 1; }
echo "    OK: drift clean"

# --- Phases 2b-2c: Kinesis precision updates settle (go-to-k/cdkd#7132) -----
# UpdateKinesisStreamingDestination leaves the destination UPDATING for
# minutes (CloudFormation's update took ~137 s, measured), and DynamoDB
# refuses another update until it is ACTIVE. 2b deploys under --no-wait, which
# skips the post-update wait, so it returns with the destination UPDATING;
# 2c, sent the moment 2b returns under the default wait, must then wait for
# ACTIVE BEFORE it sends (waitForKinesisUpdatable runs under --no-wait too),
# succeed, and read ACTIVE with its precision right after it returns (the
# post-update wait).
kinesis_destination() { # -> "<status>|<precision>" of the one destination
  local out
  out=$(aws dynamodb describe-kinesis-streaming-destination --table-name "${TABLE}" --region "${REGION}" \
    --query 'KinesisDataStreamDestinations[*].[DestinationStatus, ApproximateCreationDateTimePrecision]' \
    --output text) || return 1
  printf '%s' "${out}" | tr '\t' '|'
}
P2B_BEFORE="$(kinesis_destination)" || { echo "FAIL: Phase 2b: describe-kinesis-streaming-destination failed" >&2; exit 1; }
[ "${P2B_BEFORE}" = "ACTIVE|MILLISECOND" ] || { echo "FAIL: Phase 2b premise: the destination reads '${P2B_BEFORE}', expected ACTIVE|MILLISECOND" >&2; exit 1; }
echo "==> Phase 2b: Kinesis precision MILLISECOND -> MICROSECOND under --no-wait (go-to-k/cdkd#7132)"
CDKD_TEST_UPDATE=viewtype,micro node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --no-wait --yes
P2B_AFTER="$(kinesis_destination)" || { echo "FAIL: Phase 2b: describe-kinesis-streaming-destination failed" >&2; exit 1; }
case "${P2B_AFTER}" in
  UPDATING\|*)
    echo "    OK: Phase 2b: the --no-wait deploy returned with the destination '${P2B_AFTER}'; 2c is sent while it is UPDATING" ;;
  "ACTIVE|MICROSECOND")
    echo "    NOTE: Phase 2b: the destination already read ACTIVE|MICROSECOND right after the --no-wait deploy; 2c does NOT exercise the pre-send wait this run" ;;
  *)
    echo "FAIL: Phase 2b: right after the --no-wait deploy the destination reads '${P2B_AFTER}', expected UPDATING|<any> or ACTIVE|MICROSECOND" >&2
    exit 1 ;;
esac
echo "==> Phase 2c: back to MILLISECOND at once, default wait (go-to-k/cdkd#7132)"
CDKD_TEST_UPDATE=viewtype,micro,back node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P2C_AFTER="$(kinesis_destination)" || { echo "FAIL: Phase 2c: describe-kinesis-streaming-destination failed" >&2; exit 1; }
[ "${P2C_AFTER}" = "ACTIVE|MILLISECOND" ] || { echo "FAIL: Phase 2c: right after the deploy returned the destination reads '${P2C_AFTER}', expected ACTIVE|MILLISECOND" >&2; exit 1; }
echo "    OK: Phase 2c: the immediate second update succeeded and read ACTIVE|MILLISECOND"

echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=viewtype,micro,back node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REGION}"
assert_gone "table ${TABLE} remains" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
assert_gone "function ${CONSUMER} remains" aws lambda get-function --function-name "${CONSUMER}" --region "${REGION}"
MAPPING_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}"; then
    MAPPING_GONE=1
    break
  fi
  sleep 5
done
[ -n "${MAPPING_GONE}" ] || { echo "FAIL: event source mapping ${ESM_UUID} still exists ~2 min after destroy" >&2; exit 1; }
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# Kinesis deletes asynchronously: DELETING right after the destroy is a delete
# in progress, anything else a leak.
if ! gone_probe aws kinesis describe-stream-summary --stream-name "${KINESIS_STREAM}" --region "${REGION}"; then
  KINESIS_STATUS="$(aws kinesis describe-stream-summary --stream-name "${KINESIS_STREAM}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>&1)" || KINESIS_STATUS="<describe failed: ${KINESIS_STATUS}>"
  [ "${KINESIS_STATUS}" = "DELETING" ] || { echo "FAIL: Kinesis stream ${KINESIS_STREAM} is '${KINESIS_STATUS}' after destroy, expected gone or DELETING" >&2; exit 1; }
fi
echo "    OK: table, mapping, function, Kinesis stream and state gone"
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo ""
echo "==> globaltable-stream-view-type test passed"
