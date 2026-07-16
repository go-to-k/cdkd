#!/usr/bin/env bash
# verify.sh - deploy-time asset-storage auto-create integ (issue #1007).
#
# Proves the first `cdkd deploy` into an un-opted-in region auto-creates the
# per-region cdkd asset storage — no `cdkd bootstrap --region <r>` needed:
#
#   Guard:   the target region must have neither the CDK bootstrap SSM
#            parameter nor the CDK bootstrap asset bucket, and no cdkd
#            bootstrap marker (pre-run cleanup removes one if present).
#   Phase 1: deploy with --yes and NO prior bootstrap -> the auto-create
#            info line + bucket/repo/marker creation appear in the deploy
#            output; no legacy `cdk gc` notice; Lambda Code.S3Bucket points
#            at cdkd-owned storage and the asset object exists there;
#            destroy cleanly.
#   Phase 2: full storage cleanup, then deploy with --no-auto-asset-storage
#            -> stays legacy (gc notice present, no auto-create line, no
#            marker written). In this cdk-bootstrap-free region the legacy
#            publish then fails (the CDK bootstrap bucket does not exist) —
#            the expected outcome; assert the failure is the legacy publish,
#            not the auto-create path.
#   Phase 3: deploy with --skip-assets -> auto-create must NOT fire (no
#            info line, no marker) — it would rewrite already-published
#            legacy references to a freshly created empty bucket.
#   Cleanup: stack state/resources + asset storage + marker + log groups.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
# Optional:
#   CDKD_AUTO_CREATE_REGION - target region (default ca-central-1)

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdAssetAutoCreateStack"
REGION="${CDKD_AUTO_CREATE_REGION:-ca-central-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ASSET_BUCKET="cdkd-assets-${ACCOUNT_ID}-${REGION}"
CONTAINER_REPO="cdkd-container-assets-${ACCOUNT_ID}-${REGION}"
CDK_SSM_PARAM="/cdk-bootstrap/hnb659fds/version"

cleanup() {
  echo "==> Cleanup: dropping stack state/resources + asset storage + marker"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
  fi
  # Canonical per-region cdkd asset storage on the dedicated test account —
  # objects are content-addressed and re-publishable, so force-remove.
  aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
    --region "${REGION}" --force >/dev/null 2>&1 || true
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null |
    tr '\t' '\n' | while read -r lg; do
      [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
  set -eu
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Guard: the region must be genuinely cdk-bootstrap-free ----------------
if aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${CDK_SSM_PARAM} exists in ${REGION} — the legacy-failure leg of this test" >&2
  echo "      would be vacuous. Pick another region via CDKD_AUTO_CREATE_REGION." >&2
  exit 1
fi
if aws s3api head-bucket --bucket "cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}" >/dev/null 2>&1; then
  echo "FAIL: CDK bootstrap asset bucket exists in ${REGION} — pick another region." >&2
  exit 1
fi
echo "    OK: ${REGION} is cdk-bootstrap-free"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

GC_NOTICE="may garbage-collect"
AUTO_CREATE_LINE="Creating cdkd asset storage for region '${REGION}'"

# --- Phase 1: first deploy auto-creates the asset storage -------------------
echo "==> Phase 1: deploy with NO prior bootstrap (auto-create expected)"
if ! DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1); then
  echo "FAIL: deploy failed. Output tail:" >&2
  echo "${DEPLOY_OUT}" | tail -15 >&2
  exit 1
fi
echo "${DEPLOY_OUT}" | tail -3

if ! echo "${DEPLOY_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: deploy output lacks the auto-create info line" >&2
  exit 1
fi
if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: auto-create deploy still printed the legacy 'cdk gc' notice" >&2
  exit 1
fi
MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: marker missing/unexpected after auto-create: ${MARKER}" >&2
  exit 1
fi
CODE_BUCKET=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
  jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Bucket')
if [ "${CODE_BUCKET}" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: Lambda Code.S3Bucket is '${CODE_BUCKET}', expected '${ASSET_BUCKET}'" >&2
  exit 1
fi
OBJ_COUNT=$(aws s3api list-objects-v2 --bucket "${ASSET_BUCKET}" --region "${REGION}" \
  --query 'length(Contents || `[]`)' --output text)
case "${OBJ_COUNT}" in
  '' | *[!0-9]*)
    echo "FAIL: could not count asset objects (got '${OBJ_COUNT}')" >&2
    exit 1
    ;;
esac
if [ "${OBJ_COUNT}" -lt 1 ]; then
  echo "FAIL: no asset objects in ${ASSET_BUCKET}" >&2
  exit 1
fi
echo "    OK: auto-create line present, no gc notice, marker + Code.S3Bucket + ${OBJ_COUNT} object(s)"

echo "==> Phase 1 destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still present after destroy" >&2
  exit 1
fi
echo "    OK: destroy clean"

# --- Phase 2: --no-auto-asset-storage stays legacy ---------------------------
echo "==> Phase 2: cleanup storage, deploy with --no-auto-asset-storage (legacy expected)"
cleanup

set +e
OPTOUT_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-auto-asset-storage \
  --yes 2>&1)
OPTOUT_RC=$?
set -e
echo "${OPTOUT_OUT}" | tail -3

if echo "${OPTOUT_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: --no-auto-asset-storage deploy still printed the auto-create line" >&2
  exit 1
fi
if ! echo "${OPTOUT_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: --no-auto-asset-storage deploy did not print the legacy gc notice" >&2
  exit 1
fi
if aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - >/dev/null 2>&1; then
  echo "FAIL: bootstrap marker was written despite --no-auto-asset-storage" >&2
  exit 1
fi
# In a cdk-bootstrap-free region the legacy publish has no bucket to target,
# so the deploy is EXPECTED to fail — at the publish step, not before.
if [ "${OPTOUT_RC}" -eq 0 ]; then
  echo "FAIL: legacy deploy unexpectedly succeeded in a cdk-bootstrap-free region" >&2
  exit 1
fi
if ! echo "${OPTOUT_OUT}" | grep -q "asset-publish"; then
  echo "FAIL: opt-out deploy failed somewhere other than the legacy asset publish. Output tail:" >&2
  echo "${OPTOUT_OUT}" | tail -10 >&2
  exit 1
fi
echo "    OK: opt-out stayed legacy (gc notice, no marker) and failed only at the legacy publish"

# --- Phase 3: --skip-assets never auto-creates -------------------------------
# Reviewer catch on PR 1008: auto-create under --skip-assets would rewrite
# already-published legacy references to a freshly created EMPTY bucket.
echo "==> Phase 3: deploy with --skip-assets (no auto-create expected)"
set +e
SKIP_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}"   --state-bucket "${STATE_BUCKET}"   --region "${REGION}"   --skip-assets   --yes 2>&1)
SKIP_RC=$?
set -e
echo "${SKIP_OUT}" | tail -3

if echo "${SKIP_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: --skip-assets deploy auto-created asset storage" >&2
  exit 1
fi
if aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - >/dev/null 2>&1; then
  echo "FAIL: bootstrap marker was written under --skip-assets" >&2
  exit 1
fi
# The deploy itself fails downstream (nothing was ever published in this
# fresh region) — the assertion here is only that auto-create did NOT fire.
if [ "${SKIP_RC}" -eq 0 ]; then
  echo "FAIL: --skip-assets deploy unexpectedly succeeded with never-published assets" >&2
  exit 1
fi
echo "    OK: --skip-assets stayed legacy (no auto-create line, no marker)"

# --- Still no CDK bootstrap anywhere ----------------------------------------
if aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${CDK_SSM_PARAM} appeared in ${REGION} during the test" >&2
  exit 1
fi

echo "PASS: asset-storage auto-create + opt-out verified in ${REGION}"
