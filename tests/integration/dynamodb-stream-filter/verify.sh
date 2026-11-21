#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB stream -> Lambda (DynamoEventSource w/ FilterCriteria).
#
# A daily CDK pattern: `fn.addEventSource(new DynamoEventSource(table, {
# filters, bisectBatchOnError, reportBatchItemFailures }))`. The synthesized
# AWS::Lambda::EventSourceMapping carries FilterCriteria, BisectBatchOnFunctionError
# and FunctionResponseTypes — cdkd must forward them to CreateEventSourceMapping.
#
# Phases:
#   1. Deploy. Read the ESM back via get-event-source-mapping and assert the
#      filter pattern, bisect flag and response types all reached AWS.
#      It also declares an on-failure destination (an SQS DLQ): assert it
#      reached AWS.
#   2. Redeploy with CDKD_TEST_UPDATE=true, which removes the on-failure
#      destination: assert AWS no longer holds one (issue #6777 — cdkd sent
#      `DestinationConfig: {}`, which Lambda ignores, so the destination stayed
#      live while state recorded none; CloudFormation clears it).
#   3. Change BatchSize out of band, then `cdkd drift --revert`: assert it
#      succeeds and BatchSize is back (issue #6777 — the destination-less
#      mapping reads back `DestinationConfig: {"OnFailure": {}}`, the revert
#      sent that back, and Lambda refused the whole update).
#   4. Destroy + assert the table, the queue, the ESM and the state file are gone.
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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

STACK="CdkdDynamodbStreamFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-ddb-stream-filter"
DLQ_NAME="cdkd-ddb-stream-filter-dlq"
# Phase 3's revert log and identity snapshots; removed by cleanup().
REVERT_LOG="${TMPDIR:-/tmp}/cdkd-6777-revert.$$.log"
REVERT_IDS_BEFORE="${TMPDIR:-/tmp}/cdkd-6777-ids-before.$$.tsv"
REVERT_IDS_AFTER="${TMPDIR:-/tmp}/cdkd-6777-ids-after.$$.tsv"

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
  rm -f "${REVERT_LOG}" "${REVERT_IDS_BEFORE}" "${REVERT_IDS_AFTER}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  DLQ_URL_SWEEP="$(aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${DLQ_URL_SWEEP}" ] && [ "${DLQ_URL_SWEEP}" != "None" ]; then
    aws sqs delete-queue --queue-url "${DLQ_URL_SWEEP}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  sweep_log_groups
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FN_NAME="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.FunctionName')"
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve FunctionName output after deploy" >&2
  exit 1
fi

# --- Resolve the event source mapping ---------------------------------
ESM_UUID="$(aws lambda list-event-source-mappings --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'EventSourceMappings[0].UUID' --output text)"
if [ -z "${ESM_UUID}" ] || [ "${ESM_UUID}" = "None" ]; then
  echo "FAIL: function ${FN_NAME} has no event source mapping after deploy" >&2
  exit 1
fi
ESM="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}")"

# --- Assertion 1: FilterCriteria reached AWS --------------------------
PATTERN="$(echo "${ESM}" | jq -r '.FilterCriteria.Filters[0].Pattern // empty')"
if [ -z "${PATTERN}" ]; then
  echo "FAIL: ESM has no FilterCriteria.Filters[].Pattern on AWS" >&2
  echo "      raw ESM: ${ESM}" >&2
  exit 1
fi
EVENT_NAME="$(echo "${PATTERN}" | jq -c '.eventName')"
if [ "${EVENT_NAME}" != '["INSERT"]' ]; then
  echo "FAIL: FilterCriteria pattern eventName is '${EVENT_NAME}', expected '[\"INSERT\"]'" >&2
  echo "      raw pattern: ${PATTERN}" >&2
  exit 1
fi
echo "    OK: FilterCriteria pattern {eventName:[INSERT]} reached AWS"

# --- Assertion 2: BisectBatchOnFunctionError reached AWS --------------
BISECT="$(echo "${ESM}" | jq -r '.BisectBatchOnFunctionError')"
if [ "${BISECT}" != "true" ]; then
  echo "FAIL: ESM BisectBatchOnFunctionError is '${BISECT}', expected 'true'" >&2
  exit 1
fi
echo "    OK: BisectBatchOnFunctionError == true on AWS"

# --- Assertion 3: FunctionResponseTypes (reportBatchItemFailures) -----
RESP_TYPES="$(echo "${ESM}" | jq -c '.FunctionResponseTypes')"
if [ "${RESP_TYPES}" != '["ReportBatchItemFailures"]' ]; then
  echo "FAIL: ESM FunctionResponseTypes is '${RESP_TYPES}', expected '[\"ReportBatchItemFailures\"]'" >&2
  exit 1
fi
echo "    OK: FunctionResponseTypes == [ReportBatchItemFailures] on AWS"

# --- Assertion 4: the on-failure destination reached AWS (issue #6777) -
DLQ_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.DlqArn')"
if [ -z "${DLQ_ARN}" ] || [ "${DLQ_ARN}" = "null" ]; then
  echo "FAIL: could not resolve DlqArn output after deploy" >&2
  exit 1
fi
DEST="$(echo "${ESM}" | jq -r '.DestinationConfig.OnFailure.Destination // empty')"
if [ "${DEST}" != "${DLQ_ARN}" ]; then
  echo "FAIL: ESM on-failure destination is '${DEST}', expected '${DLQ_ARN}'" >&2
  exit 1
fi
echo "    OK: on-failure destination == the DLQ on AWS"

# UpdateEventSourceMapping refuses a call (ResourceInUseException) while the
# mapping is still Creating / Updating from the previous one: wait for it.
wait_esm_enabled() { # $1 = label
  local state=""
  for _ in $(seq 1 60); do
    if ! state="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
      --query State --output text)"; then
      echo "FAIL: could not read the State of ESM ${ESM_UUID} ($1)" >&2
      exit 1
    fi
    [ "${state}" = "Enabled" ] && return 0
    sleep 5
  done
  echo "FAIL: ESM ${ESM_UUID} is '${state}', not Enabled, after 5 min ($1)" >&2
  exit 1
}

# --- Phase 2: remove the on-failure destination (issue #6777) ---------
echo "==> Phase 2: redeploy without the on-failure destination"
wait_esm_enabled "before the Phase 2 deploy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Not replaced: the original mapping still answers, and it is the only one.
if ! aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" >/dev/null; then
  echo "FAIL: removing the destination replaced the ESM (${ESM_UUID} no longer answers)" >&2
  exit 1
fi
ESM_COUNT_2="$(aws lambda list-event-source-mappings --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'length(EventSourceMappings)' --output text)"
if [ "${ESM_COUNT_2}" != "1" ]; then
  echo "FAIL: expected exactly 1 ESM on ${FN_NAME} after removing the destination, got ${ESM_COUNT_2}" >&2
  exit 1
fi
wait_esm_enabled "after the Phase 2 deploy"
DEST_2="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
  | jq -r '.DestinationConfig.OnFailure.Destination // empty')"
if [ -n "${DEST_2}" ]; then
  echo "FAIL (issue #6777): the on-failure destination was removed from the template but AWS still holds '${DEST_2}'" >&2
  exit 1
fi
echo "    OK: the removed on-failure destination is cleared on AWS"

# --- Phase 3: out-of-band BatchSize change, restored by drift --revert -
echo "==> Phase 3: out-of-band BatchSize change, then drift --revert"
aws lambda update-event-source-mapping --uuid "${ESM_UUID}" --batch-size 50 \
  --region "${REGION}" >/dev/null
wait_esm_enabled "after the out-of-band change"
OOB_BATCH="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
  --query BatchSize --output text)"
if [ "${OOB_BATCH}" != "50" ]; then
  echo "FAIL: the out-of-band BatchSize change did not land (BatchSize ${OOB_BATCH})" >&2
  exit 1
fi
ESM_STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
ESM_LID="$(printf '%s' "${ESM_STATE_JSON}" \
  | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .key] | if length == 1 then .[0] else "" end')"
if [ -z "${ESM_LID}" ]; then
  echo "FAIL: the state record does not hold exactly one AWS::Lambda::EventSourceMapping" >&2
  exit 1
fi
# The revert must restore the READ-BACK shape, or this phase does not exercise
# the #6777 desired-bag half.
OBSERVED_DEST="$(printf '%s' "${ESM_STATE_JSON}" | jq -c --arg l "${ESM_LID}" '.resources[$l].observedProperties.DestinationConfig')"
if [ "${OBSERVED_DEST}" != '{"OnFailure":{}}' ]; then
  echo "FAIL (issue #6777): ${ESM_LID} observedProperties.DestinationConfig is '${OBSERVED_DEST}', expected '{\"OnFailure\":{}}' -- the revert below would not send the read-back shape" >&2
  exit 1
fi
# The out-of-band change is drift on the mapping, and on nothing else.
DRIFT_RC=0
DRIFT_JSON_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || DRIFT_RC=$?
DRIFTED_LIDS="$(printf '%s' "${DRIFT_JSON_OUT}" | jq -r '[.[].drifted[].logicalId] | sort | join(" ")' 2>/dev/null || echo "?")"
if [ "${DRIFTED_LIDS}" != "${ESM_LID}" ]; then
  echo "FAIL (issue #6777): expected only ${ESM_LID} drifted before the revert, got '${DRIFTED_LIDS}' (rc=${DRIFT_RC}). Report: ${DRIFT_JSON_OUT}" >&2
  exit 1
fi
echo "    OK: baseline DestinationConfig == {\"OnFailure\":{}}; only ${ESM_LID} drifted"
revert_identity_snapshot "${REVERT_IDS_BEFORE}" "${STACK}" "${ESM_LID}" || exit 1
# The rc is not this arm's subject (drift has no per-resource filter); the
# mapping's live BatchSize below is.
REVERT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --revert --yes 2>&1 | tee "${REVERT_LOG}" || REVERT_RC=$?
revert_identity_verify "${REVERT_IDS_BEFORE}" "${REVERT_IDS_AFTER}" 1 "${REVERT_LOG}" || exit 1
echo "    drift --revert rc=${REVERT_RC}"
wait_esm_enabled "after drift --revert"
REVERTED_BATCH="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
  --query BatchSize --output text)"
if [ "${REVERTED_BATCH}" != "10" ]; then
  echo "FAIL (issue #6777): drift --revert left BatchSize at ${REVERTED_BATCH}, expected 10 (revert rc=${REVERT_RC}; its output is above)" >&2
  exit 1
fi
echo "    OK: drift --revert restored BatchSize 10 on the destination-less mapping"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
  TBL_STATUS="GONE"
elif ! TBL_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1)"; then
  # TOCTOU: the table can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${TBL_STATUS}" \
    && TBL_STATUS="GONE" \
    || { echo "FAIL: describe-table requery undetermined: ${TBL_STATUS}" >&2; exit 1; }
fi
if [ "${TBL_STATUS}" != "GONE" ] && [ "${TBL_STATUS}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${TBL_STATUS}) after destroy" >&2
  exit 1
fi
echo "    OK: table deleted (status: ${TBL_STATUS})"

assert_gone "queue ${DLQ_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}"
echo "    OK: DLQ deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — DynamoDB stream FilterCriteria/bisect/responseTypes/destination reached AWS, the removed destination cleared, drift --revert restored BatchSize, clean destroy"
