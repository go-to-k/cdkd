#!/usr/bin/env bash
# verify.sh — cdkd ECR ImageScanningConfiguration casing integ.
#
# Regression coverage for the bug where the ECR CFn property
# `ImageScanningConfiguration: { ScanOnPush: true }` (PascalCase) was forwarded
# to the AWS SDK verbatim (cast `as ImageScanningConfiguration`), but the SDK
# input is camelCase (`{ scanOnPush }`) — so the unknown `ScanOnPush` key was
# ignored and scanOnPush silently reset to false. `imageScanOnPush: true` never
# reached AWS. (Same casing trap silently dropped a KMS repo's KmsKey.)
#
# Phases:
#   1. Deploy with imageScanOnPush=true. Assert AWS reports scanOnPush=true.
#   2. Re-deploy (CDKD_TEST_UPDATE=true) with imageScanOnPush=false. Assert AWS
#      now reports scanOnPush=false (the update path maps casing too).
#   3. Destroy + assert the repo is gone and the cdkd state file is removed.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEcrScanningExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
REPO="cdkdecrscanningexample-repo"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ecr delete-repository --repository-name "${REPO}" --force --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup

scan_on_push() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query 'repositories[0].imageScanningConfiguration.scanOnPush' --output text
}

# --- Phase 1: deploy with scanOnPush=true -----------------------------
echo "==> Phase 1: deploy ECR repo with imageScanOnPush=true"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SOP1="$(scan_on_push)"
echo "    scanOnPush (Phase 1): ${SOP1}"
[ "${SOP1}" = "True" ] || { echo "FAIL: expected scanOnPush=true to reach AWS, got '${SOP1}'" >&2; exit 1; }
echo "    scanOnPush=true reached AWS"

# --- Phase 2: UPDATE scanOnPush=false ---------------------------------
echo "==> Phase 2: re-deploy with imageScanOnPush=false (UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SOP2="$(scan_on_push)"
echo "    scanOnPush (Phase 2): ${SOP2}"
[ "${SOP2}" = "False" ] || { echo "FAIL: expected scanOnPush=false after update, got '${SOP2}'" >&2; exit 1; }
echo "    scanOnPush=false reached AWS"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: repo ${REPO} still exists after destroy" >&2; exit 1
fi
echo "    repo deleted"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — ECR scanOnPush reaches AWS on create + update (CFn->SDK casing), 3 phases passed"
