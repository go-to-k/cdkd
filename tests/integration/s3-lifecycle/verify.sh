#!/usr/bin/env bash
# verify.sh — cdkd S3 lifecycle V1/V2 normalization integ.
#
# An S3 bucket whose lifecycle config MIXES a prefix-scoped rule (CFn top-level
# `Prefix`, the deprecated "V1" form) with a rule that has no prefix and no
# filter (an AbortIncompleteMultipartUpload-only rule). S3 rejects a single
# PutBucketLifecycleConfiguration that mixes V1 (top-level Prefix) and V2
# (Filter) rules ("Filter element can only be used in Lifecycle V2"). cdkd must
# normalize every rule to one form. Regression coverage for:
#   - CREATE with a V1 prefix rule + a scope-less rule (would fail pre-fix)
#   - an in-place UPDATE that shortens a transition + adds a Filter-based rule
#
# Phases:
#   1. Deploy; assert both rules reached AWS, none carries a top-level Prefix
#      (all normalized to V2 Filter form), and the archive rule's expiration=730.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (expiration 730 -> 365, GLACIER
#      transition 90 -> 60, + a new big-objects Filter rule). Assert the new
#      values reached AWS, there are 3 rules, and the bucket was NOT replaced.
#   3. Destroy; assert the bucket is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdS3LifecycleExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-lifecycle-test-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

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

# --- Phase 1: deploy baseline (prefix rule + abort-only rule) ----------
echo "==> Phase 1: deploy bucket with a V1 prefix rule + a scope-less abort rule"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RULE_COUNT_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(Rules)' --output text)"
if [ "${RULE_COUNT_P1}" != "2" ]; then
  echo "FAIL: expected 2 lifecycle rules after Phase 1, got ${RULE_COUNT_P1}" >&2
  exit 1
fi

# No rule may carry a top-level Prefix — all must be normalized to V2 Filter form
# (mixing V1 Prefix + V2 Filter is exactly what S3 rejects).
TOPLEVEL_PREFIXES="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Rules[?Prefix!=null] | length(@)' --output text)"
if [ "${TOPLEVEL_PREFIXES}" != "0" ]; then
  echo "FAIL: ${TOPLEVEL_PREFIXES} rule(s) carry a top-level Prefix (V1/V2 mix)" >&2
  exit 1
fi

ARCHIVE_PREFIX_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Filter.Prefix | [0]" --output text)"
EXP_P1="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Expiration.Days | [0]" --output text)"
if [ "${ARCHIVE_PREFIX_P1}" != "logs/" ] || [ "${EXP_P1}" != "730" ]; then
  echo "FAIL: expected archive Filter.Prefix=logs/ + Expiration.Days=730, got ${ARCHIVE_PREFIX_P1}/${EXP_P1}" >&2
  exit 1
fi
echo "    2 rules applied, all V2 Filter form (no top-level Prefix), archive expiration=730"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate | [0]" --output text)"
echo "    baseline bucket CreationDate=${CREATION_P1}"

# --- Phase 2: in-place UPDATE (expiration + transition + new Filter rule) ----
echo "==> Phase 2: re-deploy (expiration 730 -> 365, GLACIER 90 -> 60, + big-objects rule)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RULE_COUNT_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(Rules)' --output text)"
EXP_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='archive'].Expiration.Days | [0]" --output text)"
BIG_SIZE_P2="$(aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "Rules[?ID=='big-objects'].Filter.ObjectSizeGreaterThan | [0]" --output text)"
if [ "${RULE_COUNT_P2}" != "3" ] || [ "${EXP_P2}" != "365" ] || [ "${BIG_SIZE_P2}" != "1048576" ]; then
  echo "FAIL: expected 3 rules / archive exp=365 / big-objects size=1048576, got ${RULE_COUNT_P2}/${EXP_P2}/${BIG_SIZE_P2}" >&2
  exit 1
fi
echo "    3 rules, archive expiration=365, big-objects ObjectSizeGreaterThan=1048576"

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

echo "[verify] PASS — S3 lifecycle V1/V2 normalization CREATE + in-place UPDATE + destroy, all 3 phases passed"
