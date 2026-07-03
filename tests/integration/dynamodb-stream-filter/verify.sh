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
#   2. Destroy + assert the table, the ESM and the state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbStreamFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-ddb-stream-filter"

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
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

TBL_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "GONE")"
if [ "${TBL_STATUS}" != "GONE" ] && [ "${TBL_STATUS}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${TBL_STATUS}) after destroy" >&2
  exit 1
fi
echo "    OK: table deleted (status: ${TBL_STATUS})"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — DynamoDB stream FilterCriteria/bisect/responseTypes reached AWS, clean destroy"
