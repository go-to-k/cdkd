#!/usr/bin/env bash
# verify.sh — cdkd S3 -> Lambda event notification functional integ.
#
# A clean deploy is NOT proof the notification works: the existing
# `event-driven` fixture deploys an addEventNotification but never fires it.
# This test puts an object into the bucket and asserts the Lambda actually ran
# by checking it recorded the object key into DynamoDB — exercising the full
# S3 -> Custom::S3BucketNotifications -> Lambda::Permission -> Lambda chain.
#
# Phases:
#   1. Deploy. Assert the bucket carries a Lambda NotificationConfiguration
#      (the Custom::S3BucketNotifications CR actually PUT it).
#   2. Functional: put an object, then poll the DynamoDB table until the key
#      appears (proves the notification delivered + the handler ran + the
#      grant worked end-to-end).
#   3. Destroy + assert the bucket, table and state file are all gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdS3EventNotificationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-s3evt-events"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after we know the account id (bucket name embeds it).
BUCKET_NAME=""

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
  if [ -n "${BUCKET_NAME}" ]; then
    aws s3 rb "s3://${BUCKET_NAME}" --force >/dev/null 2>&1 || true
  fi
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

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-s3evt-${ACCOUNT_ID}-${REGION}"

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

# The Custom::S3BucketNotifications CR must have PUT a Lambda notification.
NOTIFY_COUNT="$(aws s3api get-bucket-notification-configuration \
  --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(LambdaFunctionConfigurations || `[]`)' --output text)"
if [ "${NOTIFY_COUNT}" = "0" ] || [ "${NOTIFY_COUNT}" = "None" ]; then
  echo "FAIL: bucket ${BUCKET_NAME} has no Lambda notification configuration after deploy" >&2
  exit 1
fi
echo "    OK: bucket carries ${NOTIFY_COUNT} Lambda notification configuration(s)"

# --- Phase 2: functional — put object, prove the Lambda fired ---------
echo "==> Phase 2: put an object and assert the notification fired"
PROBE_KEY="probe-$(date -u +%Y%m%dT%H%M%SZ).txt"
echo "cdkd s3 event notification probe" > /tmp/cdkd-s3evt-probe.txt
aws s3 cp /tmp/cdkd-s3evt-probe.txt "s3://${BUCKET_NAME}/${PROBE_KEY}" --region "${REGION}" >/dev/null

RECORDED=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  RECORDED="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
    --key "{\"key\":{\"S\":\"${PROBE_KEY}\"}}" \
    --query 'Item.key.S' --output text 2>/dev/null || echo "")"
  if [ "${RECORDED}" = "${PROBE_KEY}" ]; then
    break
  fi
  echo "    waiting for notification to fire (attempt ${i})..."
  sleep 3 || true
done
if [ "${RECORDED}" != "${PROBE_KEY}" ]; then
  echo "FAIL: Lambda did not record key '${PROBE_KEY}' in ${TABLE_NAME} (notification never fired)" >&2
  exit 1
fi
echo "    OK: notification fired — Lambda recorded '${PROBE_KEY}' in DynamoDB"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: bucket ${BUCKET_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: bucket is gone"

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

# Lambda auto-creates /aws/lambda/* log groups on invoke; they are not
# stack-managed (CFn leaves them too). Sweep them so the run is orphan-zero.
sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — S3 -> Lambda notification fired end-to-end, all 3 phases passed"
