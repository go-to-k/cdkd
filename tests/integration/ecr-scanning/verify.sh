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
# ALSO covers issue #981: ECRProvider.update() applied Tags changes with
# TagResourceCommand only (additive), so a tag removed from the template
# survived on AWS. The fix untags removed keys via UntagResourceCommand.
#
# Phases:
#   1. Deploy with imageScanOnPush=true + Tags env=dev, team=platform. Assert
#      AWS reports scanOnPush=true and both tags are present.
#   2. Re-deploy (CDKD_TEST_UPDATE=true) with imageScanOnPush=false, env changed
#      to prod, team REMOVED. Assert scanOnPush=false, env=prod, team untagged,
#      and exactly one user tag remains.
#   3. Destroy + assert the repo is gone and the cdkd state file is removed.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEcrScanningExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
REPO="cdkdecrscanningexample-repo"
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
  aws ecr delete-repository --repository-name "${REPO}" --force --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# Read a single tag's value via list-tags-for-resource. Emits the value or
# 'NONE' when the key is absent (JMESPath `[?Key==...] | [0].Value` -> null ->
# printed as literal "None" by --output text; we normalize to NONE for the
# comparison).
repo_arn() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query 'repositories[0].repositoryArn' --output text
}
tag_value() {
  local key="$1"
  aws ecr list-tags-for-resource --resource-arn "$(repo_arn)" --region "${REGION}" \
    --query "tags[?Key=='${key}'] | [0].Value" --output text
}
# Count of user tags (excludes AWS-managed aws:* tags, which ECR does not add
# for a cdkd deploy). Guard the JMESPath length() against a null tags field so
# an empty list does not abort the script under set -e.
user_tag_count() {
  aws ecr list-tags-for-resource --resource-arn "$(repo_arn)" --region "${REGION}" \
    --query "length(tags[?!starts_with(Key, 'aws:')] || \`[]\`)" --output text
}

# --- Phase 1: deploy with scanOnPush=true -----------------------------
echo "==> Phase 1: deploy ECR repo with imageScanOnPush=true"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SOP1="$(scan_on_push)"
echo "    scanOnPush (Phase 1): ${SOP1}"
[ "${SOP1}" = "True" ] || { echo "FAIL: expected scanOnPush=true to reach AWS, got '${SOP1}'" >&2; exit 1; }
echo "    scanOnPush=true reached AWS"

# EncryptionConfiguration KMS path (the KmsKey was silently dropped pre-fix).
ENC1="$(aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
  --query 'repositories[0].encryptionConfiguration.encryptionType' --output text)"
echo "    encryptionType (Phase 1): ${ENC1}"
[ "${ENC1}" = "KMS" ] || { echo "FAIL: expected encryptionType=KMS to reach AWS, got '${ENC1}'" >&2; exit 1; }
KMSKEY1="$(aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
  --query 'repositories[0].encryptionConfiguration.kmsKey' --output text)"
case "${KMSKEY1}" in
  arn:aws:kms:*) ;;
  *) echo "FAIL: expected a KMS key ARN in encryptionConfiguration.kmsKey, got '${KMSKEY1}'" >&2; exit 1 ;;
esac
echo "    encryptionType=KMS + kmsKey reached AWS"

# Tags on create: env=dev, team=platform.
ENVTAG1="$(tag_value env)"
TEAMTAG1="$(tag_value team)"
echo "    tags (Phase 1): env=${ENVTAG1} team=${TEAMTAG1}"
[ "${ENVTAG1}" = "dev" ] || { echo "FAIL: expected env=dev on create, got '${ENVTAG1}'" >&2; exit 1; }
[ "${TEAMTAG1}" = "platform" ] || { echo "FAIL: expected team=platform on create, got '${TEAMTAG1}'" >&2; exit 1; }
echo "    both tags reached AWS on create"

# --- Phase 2: UPDATE scanOnPush=false ---------------------------------
echo "==> Phase 2: re-deploy with imageScanOnPush=false (UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SOP2="$(scan_on_push)"
echo "    scanOnPush (Phase 2): ${SOP2}"
[ "${SOP2}" = "False" ] || { echo "FAIL: expected scanOnPush=false after update, got '${SOP2}'" >&2; exit 1; }
echo "    scanOnPush=false reached AWS"

# Tags after update: env changed dev->prod, team REMOVED. Pre-fix (issue #981)
# update() called TagResourceCommand only, so `team` survived on AWS.
ENVTAG2="$(tag_value env)"
TEAMTAG2="$(tag_value team)"
UTC2="$(user_tag_count)"
echo "    tags (Phase 2): env=${ENVTAG2} team=${TEAMTAG2} user_tag_count=${UTC2}"
[ "${ENVTAG2}" = "prod" ] || { echo "FAIL: expected env=prod after update, got '${ENVTAG2}'" >&2; exit 1; }
[ "${TEAMTAG2}" = "None" ] || { echo "FAIL: expected team tag to be UNTAGGED after update, still present as '${TEAMTAG2}'" >&2; exit 1; }
[ "${UTC2}" = "1" ] || { echo "FAIL: expected exactly 1 user tag after update (env only), got '${UTC2}'" >&2; exit 1; }
echo "    removed tag untagged + changed tag updated on AWS"

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

echo "[verify] PASS — ECR scanOnPush (CFn->SDK casing) + tag add/change/untag on update reach AWS, 3 phases passed"
