#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB TTL AttributeName-change actionable-error integ.
#
# Asserts that cdkd's DynamoDBTableProvider.update guard rejects an impossible
# TTL AttributeName change (ttlA -> ttlB) in a single deploy with a clear,
# actionable error BEFORE issuing the doomed UpdateTimeToLive call — instead of
# letting the opaque raw AWS error ("TimeToLive is active on a different
# AttributeName") bubble up.
#
# Phase 1   deploy with TTL enabled on `ttlA`              -> succeeds; AWS
#           DescribeTimeToLive shows AttributeName=ttlA, ENABLED/ENABLING.
# Phase 2   re-deploy (CDKD_TEST_UPDATE=true) requesting   -> MUST FAIL with the
#           TTL on `ttlB`                                      actionable message;
#           AWS TTL must still be on `ttlA` (guard fired before any API call).
# Phase 3   destroy                                        -> table + state gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbTtlAttrChangeExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-ttl-attr-change-test"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
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

# Poll DescribeTimeToLive until the status settles, then echo the AttributeName.
ttl_attribute() {
  aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'TimeToLiveDescription.AttributeName' --output text 2>/dev/null || echo ""
}
ttl_status() {
  aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo ""
}

# --- Phase 1: deploy TTL on ttlA --------------------------------------
echo "==> Phase 1: deploy (TTL enabled on ttlA)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# TTL enable is async; wait for it to land on ttlA.
TTL_OK=""
for _ in $(seq 1 24); do
  ST=$(ttl_status); ATTR=$(ttl_attribute)
  if { [ "${ST}" = "ENABLED" ] || [ "${ST}" = "ENABLING" ]; } && [ "${ATTR}" = "ttlA" ]; then
    TTL_OK=1
    break
  fi
  sleep 5
done
if [ -z "${TTL_OK}" ]; then
  echo "FAIL: TTL did not settle to AttributeName=ttlA (status=$(ttl_status) attr=$(ttl_attribute)) after deploy" >&2
  exit 1
fi
echo "    OK: TTL enabled on ttlA ($(ttl_status))"

# --- Phase 2: re-deploy requesting ttlB -> must FAIL with the guard ----
echo "==> Phase 2: re-deploy requesting TTL on ttlB (expected actionable failure)"
DEPLOY_OUT="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DEPLOY_OUT}" 2>&1
DEPLOY_RC=$?
set -e

if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the ttlA->ttlB TTL AttributeName change deploy SUCCEEDED — the guard did not fire" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi

if ! grep -q "cannot change the TimeToLive AttributeName from 'ttlA' to 'ttlB'" "${DEPLOY_OUT}"; then
  echo "FAIL: deploy failed but NOT with the actionable TTL-attribute-change message" >&2
  echo "----- deploy output -----" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi
# The remediation hint must be present too (two-deploy guidance).
if ! grep -q "two deploys" "${DEPLOY_OUT}"; then
  echo "FAIL: actionable message present but missing the two-deploy remediation hint" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi
rm -f "${DEPLOY_OUT}"
echo "    OK: deploy rejected the TTL AttributeName change with the actionable error (rc=${DEPLOY_RC})"

# --- Phase 2b: AWS TTL must still be on ttlA (guard fired pre-API) -----
ATTR_AFTER=$(ttl_attribute)
if [ "${ATTR_AFTER}" != "ttlA" ]; then
  echo "FAIL: after the rejected deploy, AWS TTL AttributeName is '${ATTR_AFTER}', expected unchanged 'ttlA'" >&2
  exit 1
fi
echo "    OK: AWS TTL still on ttlA — no partial UpdateTimeToLive happened"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

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

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-ttl-attr-change test passed (TTL AttributeName change rejected with actionable error; AWS TTL unchanged; clean destroy)"
