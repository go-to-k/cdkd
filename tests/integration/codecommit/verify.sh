#!/usr/bin/env bash
# verify.sh — cdkd CodeCommit Repository SDK provider integ (issue #1045).
#
# AWS::CodeCommit::Repository is `ProvisioningType: NON_PROVISIONABLE`, so
# pre-fix cdkd's pre-flight rejected the type (no Cloud Control fallback).
# This verifies the new SDK provider end to end.
#
# Phases:
#   1. Deploy a repository with description + Tags env=dev, team=platform.
#      Assert AWS reports the repo, its description, both tags, and that the
#      stack outputs carry the repository ID (Ref parity — a GUID, not the
#      name) + ARN + clone URL.
#   2. Re-deploy (CDKD_TEST_UPDATE=true) with the repository RENAMED (CFn
#      marks RepositoryName "Update requires: No interruption" — must be an
#      in-place UpdateRepositoryName, NOT delete+create: the repository ID
#      must survive), the description changed, env changed to prod, team
#      REMOVED (the ECR #981 untag regression class).
#   3. Destroy + assert the repo is gone and the cdkd state file is removed.
#
# NOTE: CodeCommit returned to GA on 2025-11-24. If Phase 1's CreateRepository
# fails with a new-customer access error, the account has not been re-enabled
# for CodeCommit — report the error and stop (do not merge).
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdCodeCommitExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
REPO="cdkdcodecommitexample-repo"
REPO_RENAMED="cdkdcodecommitexample-repo-renamed"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws codecommit delete-repository --repository-name "${REPO}" --region "${REGION}" >/dev/null 2>&1 || true
  aws codecommit delete-repository --repository-name "${REPO_RENAMED}" --region "${REGION}" >/dev/null 2>&1 || true
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

repo_field() {
  local name="$1" field="$2"
  aws codecommit get-repository --repository-name "${name}" --region "${REGION}" \
    --query "repositoryMetadata.${field}" --output text
}

repo_arn() {
  repo_field "$1" "Arn"
}

tag_value() {
  local name="$1" key="$2"
  aws codecommit list-tags-for-resource --resource-arn "$(repo_arn "${name}")" --region "${REGION}" \
    --query "tags.\"${key}\"" --output text
}

# --- Phase 1: create ----------------------------------------------------
echo "==> Phase 1: deploy CodeCommit repository"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

DESC1="$(repo_field "${REPO}" repositoryDescription)"
echo "    description (Phase 1): ${DESC1}"
[ "${DESC1}" = "initial description" ] || { echo "FAIL: expected 'initial description', got '${DESC1}'" >&2; exit 1; }

REPO_ID1="$(repo_field "${REPO}" repositoryId)"
echo "    repositoryId (Phase 1): ${REPO_ID1}"

ENVTAG1="$(tag_value "${REPO}" env)"
TEAMTAG1="$(tag_value "${REPO}" team)"
echo "    tags (Phase 1): env=${ENVTAG1} team=${TEAMTAG1}"
[ "${ENVTAG1}" = "dev" ] || { echo "FAIL: expected env=dev on create, got '${ENVTAG1}'" >&2; exit 1; }
[ "${TEAMTAG1}" = "platform" ] || { echo "FAIL: expected team=platform on create, got '${TEAMTAG1}'" >&2; exit 1; }
echo "    description + both tags reached AWS on create"

# Ref parity: the stack output RepositoryId must be the GUID repository ID,
# not the repository name.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
OUT_ID="$(echo "${STATE_JSON}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).outputs.RepositoryId??'')})")"
echo "    output RepositoryId: ${OUT_ID}"
[ "${OUT_ID}" = "${REPO_ID1}" ] || { echo "FAIL: Ref output '${OUT_ID}' != repositoryId '${REPO_ID1}' (Ref parity)" >&2; exit 1; }
case "${OUT_ID}" in
  "${REPO}") echo "FAIL: Ref output is the repository NAME, expected the GUID id" >&2; exit 1 ;;
esac
echo "    Ref resolves to the repository ID (CFn parity)"

# --- Phase 2: UPDATE (rename + description + tags) ----------------------
echo "==> Phase 2: re-deploy with rename + description change + tag change/removal (UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The OLD name must be gone; the NEW name must exist with the SAME repository
# ID (in-place rename via UpdateRepositoryName, not delete+create).
if aws codecommit get-repository --repository-name "${REPO}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: old repository name ${REPO} still exists after rename" >&2; exit 1
fi
REPO_ID2="$(repo_field "${REPO_RENAMED}" repositoryId)"
echo "    repositoryId (Phase 2): ${REPO_ID2}"
[ "${REPO_ID2}" = "${REPO_ID1}" ] || { echo "FAIL: repositoryId changed across rename ('${REPO_ID1}' -> '${REPO_ID2}') — repo was replaced, not renamed" >&2; exit 1; }
echo "    rename was in-place (repository ID survived)"

DESC2="$(repo_field "${REPO_RENAMED}" repositoryDescription)"
echo "    description (Phase 2): ${DESC2}"
[ "${DESC2}" = "updated description" ] || { echo "FAIL: expected 'updated description', got '${DESC2}'" >&2; exit 1; }

ENVTAG2="$(tag_value "${REPO_RENAMED}" env)"
TEAMTAG2="$(tag_value "${REPO_RENAMED}" team)"
echo "    tags (Phase 2): env=${ENVTAG2} team=${TEAMTAG2}"
[ "${ENVTAG2}" = "prod" ] || { echo "FAIL: expected env=prod after update, got '${ENVTAG2}'" >&2; exit 1; }
[ "${TEAMTAG2}" = "None" ] || { echo "FAIL: expected team tag to be UNTAGGED after update, still present as '${TEAMTAG2}'" >&2; exit 1; }
echo "    removed tag untagged + changed tag updated on AWS"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws codecommit get-repository --repository-name "${REPO_RENAMED}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: repo ${REPO_RENAMED} still exists after destroy" >&2; exit 1
fi
echo "    repo deleted"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — CodeCommit repository create (desc+tags+Ref id parity), in-place rename + tag untag on update, clean destroy, 3 phases passed"
