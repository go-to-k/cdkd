#!/usr/bin/env bash
# verify.sh — cdkd S3 Object Lock default-retention integ.
#
# An S3 bucket with Object Lock enabled and a default GOVERNANCE retention rule.
# cdkd's S3 provider applies it via PutObjectLockConfiguration and reads it back
# via GetObjectLockConfiguration. Regression coverage for:
#   - CREATE with ObjectLockEnabled + default retention (GOVERNANCE, 1 day)
#   - an in-place retention UPDATE (Days 1 -> 5) that must NOT replace the bucket
#
# Phases:
#   1. Deploy; assert ObjectLockEnabled + GOVERNANCE retention Days=1.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (Days 1 -> 5). Assert the new value
#      reached AWS and the bucket was not replaced (same CreationDate).
#   3. Destroy; assert the bucket is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdS3ObjectLockExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-objectlock-test-${ACCOUNT_ID}"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws s3api delete-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (GOVERNANCE, 1 day) ---------------------
echo "==> Phase 1: deploy bucket with Object Lock + default retention 1 day"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P1="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text)"
DAYS_P1="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text)"
if [ "${MODE_P1}" != "GOVERNANCE" ] || [ "${DAYS_P1}" != "1" ]; then
  echo "FAIL: expected GOVERNANCE/1 after Phase 1, got ${MODE_P1}/${DAYS_P1}" >&2
  exit 1
fi
echo "    Object Lock active: GOVERNANCE, ${DAYS_P1} day"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
echo "    baseline bucket CreationDate=${CREATION_P1}"

# --- Phase 2: raise retention 1 -> 5 days (in-place) ------------------
echo "==> Phase 2: re-deploy raising default retention 1 -> 5 days"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

DAYS_P2="$(aws s3api get-object-lock-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text)"
if [ "${DAYS_P2}" != "5" ]; then
  echo "FAIL: expected retention Days=5 after Phase 2, got ${DAYS_P2}" >&2
  exit 1
fi
echo "    retention raised to ${DAYS_P2} days"

# The bucket must be the SAME bucket (no replacement): CreationDate unchanged.
CREATION_P2="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: bucket was REPLACED (CreationDate ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    bucket identity preserved (CreationDate unchanged) — no replacement"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: bucket ${BUCKET_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    bucket deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — S3 Object Lock CREATE + in-place retention UPDATE + destroy, all 3 phases passed"
