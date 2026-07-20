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
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
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

STACK="CdkdS3ObjectLockExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-objectlock-test-${ACCOUNT_ID}"

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

assert_gone "bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    bucket deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 Object Lock CREATE + in-place retention UPDATE + destroy, all 3 phases passed"
