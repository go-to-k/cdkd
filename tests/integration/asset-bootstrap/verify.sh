#!/usr/bin/env bash
# verify.sh - cdkd asset-bootstrap integ (issue #1002 PR 1).
#
# End-to-end verification of cdkd-owned asset storage bootstrap + deploy-time
# asset-mode detection:
#
#   Phase 1: deploy WITHOUT a bootstrap marker -> legacy mode: the one-line
#            `cdk gc` hazard notice appears, deploy succeeds as before.
#   Phase 2: `cdkd bootstrap` -> asset bucket (AES-256, public-access block,
#            deny-external policy, NO versioning) + IMMUTABLE-tag ECR repo +
#            marker `cdkd-bootstrap/{region}.json` written to the state
#            bucket; `state info --json` lists the region.
#   Phase 3: deploy WITH the marker -> cdkd-assets mode: no gc notice,
#            existence verification passes, deploy still succeeds
#            (PR 1 is detection-only; publish destinations unchanged).
#   Phase 4: delete the ECR repo, deploy -> hard error naming the repo and
#            the re-bootstrap fix (never a silent legacy fallback).
#   Cleanup: destroy the stack, delete marker + asset bucket + repo so the
#            account is left exactly as found.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdAssetBootstrapStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ASSET_BUCKET="cdkd-assets-${ACCOUNT_ID}-${REGION}"
CONTAINER_REPO="cdkd-container-assets-${ACCOUNT_ID}-${REGION}"

cleanup() {
  echo "==> Cleanup: dropping stack state/resources + asset storage + marker"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET:-}" \
      --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
  fi
  # The PR-1 asset bucket is never written to (redirection is PR 2), so a
  # plain delete-bucket suffices; --force also clears any future objects.
  aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
    --region "${REGION}" --force >/dev/null 2>&1 || true
  # Lambda deploys leave no log group here (the function is never invoked),
  # but sweep defensively per the fixture template.
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

GC_NOTICE="may garbage-collect"

# --- Phase 1: deploy WITHOUT marker (legacy mode) -------------------------
echo "==> Phase 1: deploy without marker (legacy mode expected)"
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3

if ! echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: legacy-mode deploy did not print the 'cdk gc' hazard info line" >&2
  exit 1
fi
NOTICE_COUNT=$(echo "${DEPLOY_OUT}" | grep -cF "${GC_NOTICE}")
if [ "${NOTICE_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 gc-hazard info line, got ${NOTICE_COUNT}" >&2
  exit 1
fi
echo "    OK: legacy mode printed the gc-hazard notice exactly once"

# --- Phase 2: bootstrap (asset storage + marker) ---------------------------
echo "==> Phase 2: cdkd bootstrap (creates asset bucket + ECR repo + marker)"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}"

MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)
if [ -z "${MARKER}" ]; then
  echo "FAIL: bootstrap marker missing at s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  exit 1
fi
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.containerRepo')" != "${CONTAINER_REPO}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.assetSupportVersion')" != "1" ]; then
  echo "FAIL: marker body unexpected: ${MARKER}" >&2
  exit 1
fi
echo "    OK: marker present with expected assetBucket/containerRepo/version"

ENC=$(aws s3api get-bucket-encryption --bucket "${ASSET_BUCKET}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text)
if [ "${ENC}" != "AES256" ]; then
  echo "FAIL: asset bucket encryption is '${ENC}', expected AES256" >&2
  exit 1
fi
VERSIONING=$(aws s3api get-bucket-versioning --bucket "${ASSET_BUCKET}" --query 'Status' --output text)
if [ "${VERSIONING}" != "None" ] && [ -n "${VERSIONING}" ] && [ "${VERSIONING}" != "null" ]; then
  echo "FAIL: asset bucket versioning is '${VERSIONING}', expected disabled" >&2
  exit 1
fi
if ! aws s3api get-bucket-policy --bucket "${ASSET_BUCKET}" --query 'Policy' --output text | grep -q 'DenyExternalAccess'; then
  echo "FAIL: asset bucket policy lacks DenyExternalAccess" >&2
  exit 1
fi
PAB=$(aws s3api get-public-access-block --bucket "${ASSET_BUCKET}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicPolicy' --output text)
if [ "${PAB}" != "True" ]; then
  echo "FAIL: asset bucket public access block not enabled (BlockPublicPolicy=${PAB})" >&2
  exit 1
fi
MUTABILITY=$(aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" \
  --region "${REGION}" --query 'repositories[0].imageTagMutability' --output text)
if [ "${MUTABILITY}" != "IMMUTABLE" ]; then
  echo "FAIL: container repo imageTagMutability is '${MUTABILITY}', expected IMMUTABLE" >&2
  exit 1
fi
echo "    OK: asset bucket (AES256, no versioning, PAB, deny-external) + repo (IMMUTABLE)"

INFO=$(node "${LOCAL_DIST}" state info --state-bucket "${STATE_BUCKET}" --json)
if [ "$(echo "${INFO}" | jq -r --arg r "${REGION}" '[.assetStorage[] | select(.region == $r)] | length')" != "1" ]; then
  echo "FAIL: state info --json does not list ${REGION} in assetStorage: ${INFO}" >&2
  exit 1
fi
echo "    OK: state info --json lists ${REGION} in assetStorage"

# --- Phase 2b: bootstrap idempotency (re-run, no --force) ------------------
echo "==> Phase 2b: re-run bootstrap (idempotent)"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null
echo "    OK: re-run bootstrap succeeded"

# --- Phase 3: deploy WITH marker (cdkd-assets mode) -------------------------
echo "==> Phase 3: deploy with marker (cdkd-assets mode expected)"
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3

if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: cdkd-assets mode deploy still printed the legacy gc-hazard line" >&2
  exit 1
fi
echo "    OK: cdkd-assets mode deploy succeeded with no legacy notice"

# --- Phase 4: marker present but repo deleted -> hard error ------------------
echo "==> Phase 4: delete container repo, expect deploy hard error"
aws ecr delete-repository --repository-name "${CONTAINER_REPO}" --region "${REGION}" --force >/dev/null

set +e
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: deploy succeeded although the container repo named by the marker is deleted" >&2
  exit 1
fi
if ! echo "${DEPLOY_OUT}" | grep -qF "${CONTAINER_REPO}"; then
  echo "FAIL: hard error does not name the missing repo. Output tail:" >&2
  echo "${DEPLOY_OUT}" | tail -5 >&2
  exit 1
fi
if ! echo "${DEPLOY_OUT}" | grep -qF "cdkd bootstrap"; then
  echo "FAIL: hard error does not point at the 'cdkd bootstrap' fix" >&2
  exit 1
fi
echo "    OK: deploy hard-errored naming the missing repo + re-bootstrap fix"

# --- Phase 5: destroy -------------------------------------------------------
echo "==> Phase 5: destroy (state-driven, unaffected by asset mode)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> asset-bootstrap test passed (legacy notice, bootstrap resources+marker, cdkd-assets detection, deleted-resource hard error, clean destroy)"
