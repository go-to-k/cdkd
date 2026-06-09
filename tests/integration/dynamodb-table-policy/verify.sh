#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB Table ResourcePolicy / KinesisStreamSpecification
# / ContributorInsightsSpecification backfill integ test (issue #609).
#
# Asserts that a DynamoDB table whose template sets ResourcePolicy,
# KinesisStreamSpecification, and ContributorInsightsSpecification has all
# three reach AWS after `cdkd deploy` (each was a silent-drop before the
# #609 backfill), then asserts the destroy path cleans up the table, the
# Kinesis stream, and the cdkd state file.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbTablePolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-table-policy-test-table"
STREAM_NAME="cdkd-table-policy-test-stream"
EXPECTED_CI_MODE="ACCESSED_AND_THROTTLED_KEYS"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

TABLE=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table' --output json 2>/dev/null)
TABLE_ARN=$(echo "${TABLE}" | jq -r '.TableArn')
EXPECTED_STREAM_ARN=$(aws kinesis describe-stream \
  --stream-name "${STREAM_NAME}" --region "${REGION}" \
  --query 'StreamDescription.StreamARN' --output text 2>/dev/null)

# --- Assertion 1: ResourcePolicy reached AWS --------------------------
# GetResourcePolicy returns the attached policy document as a JSON string.
# Seeing a non-empty policy with our dynamodb:GetItem action proves the
# silent-drop is closed.
POLICY=$(aws dynamodb get-resource-policy \
  --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query 'Policy' --output text 2>/dev/null || echo "")
if [ -z "${POLICY}" ] || [ "${POLICY}" = "None" ]; then
  echo "FAIL: no ResourcePolicy attached to ${TABLE_NAME} (silent-drop NOT closed)" >&2
  exit 1
fi
HAS_GETITEM=$(echo "${POLICY}" | jq -r '
  [.Statement[]?.Action] | flatten | map(select(. == "dynamodb:GetItem")) | length > 0
')
if [ "${HAS_GETITEM}" != "true" ]; then
  echo "FAIL: ResourcePolicy does not contain the templated dynamodb:GetItem action" >&2
  echo "${POLICY}" | jq .
  exit 1
fi
echo "    OK: ResourcePolicy with dynamodb:GetItem reached AWS (silent-drop CLOSED by #609)"

# --- Assertion 2: KinesisStreamSpecification reached AWS --------------
# DescribeKinesisStreamingDestination lists the active destination(s).
KDS=$(aws dynamodb describe-kinesis-streaming-destination \
  --table-name "${TABLE_NAME}" --region "${REGION}" --output json 2>/dev/null)
ACTUAL_STREAM_ARN=$(echo "${KDS}" | jq -r '
  [.KinesisDataStreamDestinations[]? | select(.DestinationStatus == "ACTIVE" or .DestinationStatus == "ENABLING")][0]
  | if has("StreamArn") then .StreamArn else "null" end
')
if [ "${ACTUAL_STREAM_ARN}" = "null" ] || [ -z "${ACTUAL_STREAM_ARN}" ]; then
  echo "FAIL: no ACTIVE/ENABLING Kinesis streaming destination on ${TABLE_NAME} (silent-drop NOT closed)" >&2
  echo "${KDS}" | jq .
  exit 1
fi
if [ "${ACTUAL_STREAM_ARN}" != "${EXPECTED_STREAM_ARN}" ]; then
  echo "FAIL: Kinesis destination StreamArn is '${ACTUAL_STREAM_ARN}', expected '${EXPECTED_STREAM_ARN}'" >&2
  exit 1
fi
echo "    OK: KinesisStreamSpecification.StreamArn reached AWS (silent-drop CLOSED by #609)"

# --- Assertion 3: ContributorInsightsSpecification reached AWS --------
# DescribeContributorInsights returns the status + mode. ENABLING is a
# valid transient terminal-bound state shortly after deploy.
CI=$(aws dynamodb describe-contributor-insights \
  --table-name "${TABLE_NAME}" --region "${REGION}" --output json 2>/dev/null)
CI_STATUS=$(echo "${CI}" | jq -r 'if has("ContributorInsightsStatus") then .ContributorInsightsStatus else "null" end')
if [ "${CI_STATUS}" != "ENABLED" ] && [ "${CI_STATUS}" != "ENABLING" ]; then
  echo "FAIL: ContributorInsightsStatus is '${CI_STATUS}', expected ENABLED/ENABLING (silent-drop NOT closed)" >&2
  echo "${CI}" | jq .
  exit 1
fi
echo "    OK: ContributorInsightsSpecification.Enabled reached AWS (status=${CI_STATUS}, silent-drop CLOSED by #609)"

CI_MODE=$(echo "${CI}" | jq -r 'if has("ContributorInsightsMode") then .ContributorInsightsMode else "null" end')
if [ "${CI_MODE}" != "${EXPECTED_CI_MODE}" ]; then
  echo "FAIL: ContributorInsightsMode is '${CI_MODE}', expected '${EXPECTED_CI_MODE}'" >&2
  echo "${CI}" | jq .
  exit 1
fi
echo "    OK: ContributorInsightsSpecification.Mode == ${EXPECTED_CI_MODE} on AWS"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# DynamoDB DeleteTable is async: poll until truly gone.
TABLE_GONE=""
for _ in $(seq 1 24); do
  if ! aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB table is gone"

# Kinesis DeleteStream is async too.
STREAM_GONE=""
for _ in $(seq 1 24); do
  if ! aws kinesis describe-stream --stream-name "${STREAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    STREAM_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${STREAM_GONE}" ]; then
  echo "FAIL: Kinesis stream ${STREAM_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: Kinesis stream is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-table-policy test passed (ResourcePolicy + KinesisStreamSpecification + ContributorInsightsSpecification backfill closed + clean destroy)"
