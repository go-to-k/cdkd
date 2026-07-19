#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the cross-region state bucket support
# (PR #60 state backend + issue #803 LockManager + issue #819 exports index).
#
# The point of this test is the cross-region PRECONDITION, not the fixture's
# resources: the state bucket must live in a DIFFERENT region from the CLI's
# base region. Pre-#803 the state backend tolerated that (PR #60) but the
# LockManager did not — every lock acquisition failed with S3's 301
# PermanentRedirect ("must be addressed using the specified endpoint").
# Pre-#819 the exports index store had the SAME unfixed bug: its index
# write (deploy) / remove (destroy) hit the 301 too, surfacing as
# "Exports index ... failed (non-retryable): ... must be addressed using
# the specified endpoint; continuing without index update" — non-fatal, so
# the run still passed while the cross-region index was silently never
# maintained. The fixture's exported Output makes the index non-empty so
# that path actually runs, and this script greps deploy + destroy output to
# assert the 301 warning is GONE.
#
# Flow:
#   1. install + build cdkd (root) + install fixture deps
#   2. create a TEMPORARY state bucket in ${BUCKET_REGION} (us-west-2)
#   3. cdkd deploy with AWS_REGION=${BASE_REGION} (us-east-1) — exercises
#      lock acquire + state write + lock release + exports index write
#      against the cross-region bucket (pre-#803 this failed at lock
#      acquisition; pre-#819 the index write hit the 301)
#   4. assert state.json + exports index exist in the bucket and lock.json
#      was released; assert deploy output carries NO exports-index 301 warning
#   5. cdkd state ls lists the stack
#   6. cdkd destroy — exercises the lock path + state delete + exports index
#      remove (pre-#819 the index remove hit the 301)
#   7. assert state is gone, the SSM parameter is gone, and destroy output
#      carries NO exports-index 301 warning
#   8. delete the temporary bucket (also attempted on failure via trap)
#
# BSD/macOS-portable: no grep -P, no date -d.
set -euo pipefail

BASE_REGION="${AWS_REGION:-us-east-1}"
BUCKET_REGION="${BUCKET_REGION:-us-west-2}"
if [ "${BASE_REGION}" = "${BUCKET_REGION}" ]; then
  # The whole point is region mismatch; flip the bucket region if the
  # caller's base region happens to be us-west-2.
  BUCKET_REGION="us-east-1"
fi
export AWS_REGION="${BASE_REGION}"

STACK="CdkdCrossRegionStateBucketExample"
SSM_PARAM_NAME="${STACK}-marker"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/cross-region-state-bucket"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# Temporary, uniquely-named bucket so parallel/aborted runs never collide.
STATE_BUCKET="cdkd-crossregion-it-${ACCOUNT_ID}-$(date +%s)"
STATE_KEY="cdkd/${STACK}/${BASE_REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${BASE_REGION}/lock.json"
INDEX_KEY="cdkd/_index/${BASE_REGION}/exports.json"

# The exports-index 301 warning string the fix removes (issue #819). cdkd
# logs it as: "Exports index <op> failed (non-retryable): The bucket you are
# attempting to access must be addressed using the specified endpoint ...".
# A plain fixed-string grep keeps this BSD/macOS-portable (no grep -P).
assert_no_exports_index_301() {
  local label="$1"
  local out="$2"
  if echo "${out}" | grep -F -q "Exports index" \
    && echo "${out}" | grep -F -q "must be addressed using the specified endpoint"; then
    echo "[verify] FAIL: ${label} output carries the exports-index 301 PermanentRedirect warning (issue #819 regression):"
    echo "${out}" | grep -F "Exports index" | sed 's/^/  /'
    return 1
  fi
}

echo "[verify] base-region=${BASE_REGION} bucket-region=${BUCKET_REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # Best-effort: destroy the stack if cdkd state still exists.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    # Direct AWS cleanup in case destroy itself is what broke.
    echo "[verify] cleanup: delete SSM parameter ${SSM_PARAM_NAME} (ignore NotFound)"
    aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${BASE_REGION}" >/dev/null 2>&1 || true
  fi
  # Always remove the temporary state bucket (success path reaches here too
  # after the explicit step-8 removal; rb on a gone bucket is a no-op error).
  if aws s3api head-bucket --bucket "${STATE_BUCKET}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: remove temporary state bucket ${STATE_BUCKET}"
    aws s3 rb "s3://${STATE_BUCKET}" --region "${BUCKET_REGION}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: create temporary state bucket in ${BUCKET_REGION}"
if [ "${BUCKET_REGION}" = "us-east-1" ]; then
  # us-east-1 rejects an explicit LocationConstraint.
  aws s3api create-bucket --bucket "${STATE_BUCKET}" --region "${BUCKET_REGION}"
else
  aws s3api create-bucket --bucket "${STATE_BUCKET}" --region "${BUCKET_REGION}" \
    --create-bucket-configuration "LocationConstraint=${BUCKET_REGION}"
fi

echo "[verify] step 3: cdkd deploy (AWS_REGION=${BASE_REGION}, bucket in ${BUCKET_REGION})"
# Pre-#803 this failed with: "Failed to acquire lock ... The bucket you are
# attempting to access must be addressed using the specified endpoint."
# Pre-#819 it succeeded but logged the exports-index 301 warning.
# Capture combined output so we can grep it for the 301 warning (verbose
# surfaces the index write path).
DEPLOY_OUT="$(${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1)"
echo "${DEPLOY_OUT}"

echo "[verify] step 4: assert state + exports index written, lock released, no 301 warning"
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: state.json not found at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: lock.json still present at s3://${STATE_BUCKET}/${LOCK_KEY} — lock was not released"
  exit 1
fi
# Issue #819: the exports index file must have been written to the
# cross-region bucket (pre-fix the write hit the 301 and was skipped).
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INDEX_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: exports index not found at s3://${STATE_BUCKET}/${INDEX_KEY} (issue #819 — index write skipped on cross-region bucket?)"
  exit 1
fi
# Issue #819: the deploy output must NOT carry the exports-index 301 warning.
assert_no_exports_index_301 "deploy" "${DEPLOY_OUT}"
echo "[verify] step 4 ok: state + exports index present, lock released, no 301 warning"

echo "[verify] step 4b: assert the deployed SSM parameter exists in ${BASE_REGION}"
if ! aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${BASE_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: SSM parameter ${SSM_PARAM_NAME} not found in ${BASE_REGION}"
  exit 1
fi
echo "[verify] step 4b ok"

echo "[verify] step 5: cdkd state ls lists the stack"
STATE_LS_OUT="$(${CLI} state ls --state-bucket "${STATE_BUCKET}" 2>&1)"
if ! echo "${STATE_LS_OUT}" | grep -F -q "${STACK}"; then
  echo "[verify] FAIL: 'cdkd state ls' did not list ${STACK}:"
  echo "${STATE_LS_OUT}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 5 ok"

echo "[verify] step 6: cdkd destroy (exercises the lock path + exports index remove)"
# Pre-#819 destroy logged: "Exports index remove failed (non-retryable): ...
# must be addressed using the specified endpoint; continuing without index
# update". Capture output so step 7 can assert the warning is gone.
DESTROY_OUT="$(${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force --verbose 2>&1)"
echo "${DESTROY_OUT}"

echo "[verify] step 7: assert state gone + SSM parameter gone + no 301 warning"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: state.json still present after destroy"
  exit 1
fi
if aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${BASE_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: SSM parameter ${SSM_PARAM_NAME} still exists after destroy"
  exit 1
fi
# Issue #819: the destroy output must NOT carry the exports-index 301 warning.
assert_no_exports_index_301 "destroy" "${DESTROY_OUT}"
echo "[verify] step 7 ok"

echo "[verify] step 8: remove temporary state bucket"
aws s3 rb "s3://${STATE_BUCKET}" --region "${BUCKET_REGION}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
