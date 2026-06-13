#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the cross-region state bucket support
# (PR #60 state backend + issue #803 LockManager).
#
# The point of this test is the cross-region PRECONDITION, not the fixture's
# resources: the state bucket must live in a DIFFERENT region from the CLI's
# base region. Pre-#803 the state backend tolerated that (PR #60) but the
# LockManager did not — every lock acquisition failed with S3's 301
# PermanentRedirect ("must be addressed using the specified endpoint").
#
# Flow:
#   1. install + build cdkd (root) + install fixture deps
#   2. create a TEMPORARY state bucket in ${BUCKET_REGION} (us-west-2)
#   3. cdkd deploy with AWS_REGION=${BASE_REGION} (us-east-1) — exercises
#      lock acquire + state write + lock release against the cross-region
#      bucket (pre-#803 this failed at lock acquisition)
#   4. assert state.json exists in the bucket and lock.json was released
#   5. cdkd state ls lists the stack
#   6. cdkd destroy — exercises the lock path again + state delete
#   7. assert state is gone and the deployed SSM parameter is gone
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
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 4: assert state written + lock released in the cross-region bucket"
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: state.json not found at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: lock.json still present at s3://${STATE_BUCKET}/${LOCK_KEY} — lock was not released"
  exit 1
fi
echo "[verify] step 4 ok: state present, lock released"

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

echo "[verify] step 6: cdkd destroy (exercises the lock path again)"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 7: assert state gone + SSM parameter gone"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${BUCKET_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: state.json still present after destroy"
  exit 1
fi
if aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${BASE_REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: SSM parameter ${SSM_PARAM_NAME} still exists after destroy"
  exit 1
fi
echo "[verify] step 7 ok"

echo "[verify] step 8: remove temporary state bucket"
aws s3 rb "s3://${STATE_BUCKET}" --region "${BUCKET_REGION}" --force

trap - EXIT
echo "[verify] PASS"
