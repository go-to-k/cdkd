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
# ALSO covers issue #1392: ImageTagMutabilityExclusionFilters was declared in
# handledProperties but sent on NO API call — omitted from CreateRepository and
# from update's PutImageTagMutability — so the exclusions silently vanished
# while the property-coverage pre-flight passed on the false handled claim. The
# member names diverge as well (CFn ImageTagMutabilityExclusionFilterType /
# ...Value vs SDK filterType / filter). The update gate also fired on
# ImageTagMutability alone, so a filters-ONLY edit never reached AWS.
#
# Phases:
#   1. Deploy with imageScanOnPush=true + Tags env=dev, team=platform +
#      IMMUTABLE_WITH_EXCLUSION with one exclusion filter (dev-*). Assert AWS
#      reports scanOnPush=true, both tags, and the filter.
#   2. Re-deploy (CDKD_TEST_UPDATE=true) with imageScanOnPush=false, env changed
#      to prod, team REMOVED, and the exclusion filters changed to two DIFFERENT
#      patterns with imageTagMutability UNCHANGED. Assert scanOnPush=false,
#      env=prod, team untagged, exactly one user tag remains, and the new
#      filters reached AWS (the filters-only update path).
#   3. Destroy + assert the repo is gone and the cdkd state file is removed.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ecr delete-repository --repository-name "${REPO}" --force --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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

tag_mutability() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query 'repositories[0].imageTagMutability' --output text
}

# The exclusion filter PATTERNS, sorted and space-joined. AWS does not preserve
# the submitted order of list-valued members on readback, so both sides of the
# comparison are sorted (the null-list coalesce keeps an empty list from
# aborting the script under set -e).
exclusion_filter_patterns() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query "join(' ', sort(repositories[0].imageTagMutabilityExclusionFilters[].filter || \`[]\`))" \
    --output text
}

# The filter types, sorted and space-joined (one entry per filter, no dedupe) —
# proves the diverging member name (CFn ImageTagMutabilityExclusionFilterType ->
# SDK filterType) reached AWS rather than arriving as an empty object.
exclusion_filter_types() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query "join(' ', sort(repositories[0].imageTagMutabilityExclusionFilters[].filterType || \`[]\`))" \
    --output text
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

# ImageTagMutabilityExclusionFilters on create (issue #1392). Pre-fix the
# property never reached CreateRepository at all.
MUT1="$(tag_mutability)"
FILTERS1="$(exclusion_filter_patterns)"
FTYPES1="$(exclusion_filter_types)"
echo "    mutability (Phase 1): ${MUT1} filters=[${FILTERS1}] types=[${FTYPES1}]"
[ "${MUT1}" = "IMMUTABLE_WITH_EXCLUSION" ] || { echo "FAIL: expected imageTagMutability=IMMUTABLE_WITH_EXCLUSION, got '${MUT1}'" >&2; exit 1; }
[ "${FILTERS1}" = "dev-*" ] || { echo "FAIL: expected exclusion filter 'dev-*' on create, got '${FILTERS1}'" >&2; exit 1; }
[ "${FTYPES1}" = "WILDCARD" ] || { echo "FAIL: expected filterType WILDCARD on create, got '${FTYPES1}'" >&2; exit 1; }
echo "    exclusion filters reached AWS on create"

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

# Filters-ONLY update (issue #1392): imageTagMutability is identical across
# both phases, so pre-fix the PutImageTagMutability call never fired and the
# Phase 1 filter survived on AWS.
MUT2="$(tag_mutability)"
FILTERS2="$(exclusion_filter_patterns)"
FTYPES2="$(exclusion_filter_types)"
echo "    mutability (Phase 2): ${MUT2} filters=[${FILTERS2}] types=[${FTYPES2}]"
[ "${MUT2}" = "IMMUTABLE_WITH_EXCLUSION" ] || { echo "FAIL: expected imageTagMutability to stay IMMUTABLE_WITH_EXCLUSION, got '${MUT2}'" >&2; exit 1; }
[ "${FILTERS2}" = "hotfix-* release-v*" ] || { echo "FAIL: expected the changed exclusion filters 'hotfix-* release-v*' after a filters-only update, got '${FILTERS2}'" >&2; exit 1; }
# One entry per filter (no dedupe), so both mapped entries must carry the type.
[ "${FTYPES2}" = "WILDCARD WILDCARD" ] || { echo "FAIL: expected both filters to carry filterType WILDCARD after update, got '${FTYPES2}'" >&2; exit 1; }
echo "    filters-only update reached AWS"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "repo ${REPO} still exists after destroy" aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}"
echo "    repo deleted"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ECR scanOnPush (CFn->SDK casing) + tag add/change/untag on update + ImageTagMutabilityExclusionFilters on create and on a filters-only update reach AWS, 3 phases passed"
