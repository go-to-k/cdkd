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
#   3. Issue #6631, the repository policy's drift arm (both phases declare one
#      `CdkdIntegPull` statement):
#      3a. the post-write capture recorded `RepositoryPolicyText` in the
#          repository's observedProperties, and no `EmptyOnDelete`;
#      3b. `cdkd drift` reports neither key on the untouched repository;
#      3c. an action added to the policy out of band reports under
#          `RepositoryPolicyText`;
#      3d. `cdkd drift --revert` restores the declared actions in place (the
#          state physicalId and the AWS ARN + createdAt unchanged, and the
#          revert output names no replacement), and drift no longer reports
#          the key;
#      3e. with the repository's observedProperties stripped (the template-only
#          baseline), drift reports neither key;
#      3f. the policy deleted out of band reports under `RepositoryPolicyText`
#          on that baseline.
#   4. Destroy + assert the repo is gone and the cdkd state file is removed.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

STACK="CdkdEcrScanningExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
REPO="cdkdecrscanningexample-repo"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
WORK_DIR=""

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
  if [ -n "${WORK_DIR:-}" ]; then rm -rf "${WORK_DIR}"; fi
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
WORK_DIR="$(mktemp -d)"

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

# The sorted, space-joined actions of the `CdkdIntegPull` statement in the
# repository's live policy.
policy_actions() {
  aws ecr get-repository-policy --repository-name "${REPO}" --region "${REGION}" \
    --query policyText --output text |
    jq -r '[.Statement | if type == "array" then .[] else . end | select(.Sid == "CdkdIntegPull")
      | .Action | if type == "array" then .[] else . end] | sort | join(" ")'
}

# The repository's logical id, read from the state record (one ECR repository).
repo_logical_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - |
    jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ECR::Repository") | .key]
      | if length == 1 then .[0] else error("expected one repository record, got \(length)") end'
}

# The repository's identity in cdkd state (physicalId) and on AWS (ARN plus
# creation time, which a delete + re-create under the same name changes).
state_physical_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg lid "${REPO_LID}" '.resources[$lid].physicalId // empty'
}
aws_repo_identity() {
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" \
    --query 'repositories[0].[repositoryArn, createdAt]' --output text
}

# True for "<ecr repository ARN><TAB><non-empty, non-None createdAt>".
valid_identity() {
  local arn="${1%%$'\t'*}" created="${1#*$'\t'}"
  [[ "${arn}" == arn:aws*:ecr:*:repository/"${REPO}" ]] && [ "${created}" != "$1" ] &&
    [ -n "${created}" ] && [ "${created}" != "None" ]
}

# `cdkd drift --json` into a file; echoes the exit code.
run_drift() { # usage: run_drift <json file>
  local rc
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --json >"$1" 2>"$1.err"
  rc=$?
  set -e
  echo "${rc}"
}

# The repository's drifted paths in a `drift --json` file, one per line.
repo_drift_paths() { # usage: repo_drift_paths <json file>
  jq -r --arg lid "${REPO_LID}" \
    '[.[] | .drifted[]? | select(.logicalId == $lid) | .changes[]? | .path] | unique | .[]' "$1"
}

# FAIL unless drift exited 0 or 1 with a non-empty JSON array listing the
# repository once under clean / drifted, never notCompared; prints the repository's drifted paths.
read_repo_paths() { # usage: read_repo_paths <label> <json file> <rc>
  local paths
  if [ "$3" != "0" ] && [ "$3" != "1" ]; then
    echo "FAIL: $1: drift exited $3, expected 0 or 1" >&2
    cat "$2" "$2.err" >&2
    exit 1
  fi
  if ! jq -e 'type == "array" and length > 0' "$2" >/dev/null 2>&1; then
    echo "FAIL: $1: drift --json did not print a non-empty array (rc $3)" >&2
    cat "$2" "$2.err" >&2
    exit 1
  fi
  if ! jq -e --arg lid "${REPO_LID}" \
    '([.[] | (.clean[]?, .drifted[]?) | select(.logicalId == $lid)] | length == 1)
      and ([.[] | .notCompared[]? | select(.logicalId == $lid)] | length == 0)' "$2" >/dev/null; then
    echo "FAIL: $1: ${REPO_LID} is not listed once under clean / drifted (not compared?)" >&2
    cat "$2" "$2.err" >&2
    exit 1
  fi
  paths="$(repo_drift_paths "$2")" || {
    echo "FAIL: $1: drift --json is not readable (rc $3)" >&2
    cat "$2" "$2.err" >&2
    exit 1
  }
  printf '%s' "${paths}"
}

# FAIL when a path under RepositoryPolicyText or EmptyOnDelete is among the
# repository's drifted paths. Other paths are this issue's out of scope: NOTE.
assert_no_policy_keys() { # usage: assert_no_policy_keys <label> <paths>
  local hits others
  hits="$(grep -E '^(RepositoryPolicyText|EmptyOnDelete)(\.|$)' <<<"$2" || true)"
  others="$(grep -vE '^(RepositoryPolicyText|EmptyOnDelete)(\.|$)' <<<"$2" || true)"
  if [ -n "${others}" ]; then
    echo "    NOTE: $1: other drifted repository paths: [${others//$'\n'/, }]"
  fi
  if [ -n "${hits}" ]; then
    echo "FAIL: $1: drift reported [${hits//$'\n'/, }] on a repository policy nobody changed (issue #6631)" >&2
    exit 1
  fi
}

# FAIL unless a path under RepositoryPolicyText is reported, with exit 1.
assert_policy_reported() { # usage: assert_policy_reported <label> <json file> <rc>
  local paths
  paths="$(read_repo_paths "$1" "$2" "$3")"
  if ! grep -qE '^RepositoryPolicyText(\.|$)' <<<"${paths}"; then
    echo "FAIL: $1: drift did not report the out-of-band repository policy change; repository paths [${paths//$'\n'/, }] (issue #6631)" >&2
    cat "$2" >&2
    exit 1
  fi
  if [ "$3" != "1" ]; then
    echo "FAIL: $1: drift exited $3 with the policy drift reported, expected 1" >&2
    exit 1
  fi
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

# --- Phase 3: the repository policy's drift arm (issue #6631) ----------
DECLARED_ACTIONS="ecr:BatchGetImage ecr:GetDownloadUrlForLayer"
ACTIONS0="$(policy_actions)"
[ "${ACTIONS0}" = "${DECLARED_ACTIONS}" ] || { echo "FAIL: Phase 3 premise: the live CdkdIntegPull actions are [${ACTIONS0}], expected [${DECLARED_ACTIONS}]" >&2; exit 1; }
REPO_LID="$(repo_logical_id)"
echo "    repository record ${REPO_LID}; live policy carries the declared actions"

echo "==> Phase 3a: the post-write capture recorded the repository policy"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state3a.json" >/dev/null
OBS_SID="$(jq -r --arg lid "${REPO_LID}" \
  '.resources[$lid].observedProperties.RepositoryPolicyText.Statement
    | if type == "array" then .[0].Sid elif type == "object" then .Sid else "ABSENT" end' \
  "${WORK_DIR}/state3a.json")"
OBS_EOD="$(jq -r --arg lid "${REPO_LID}" \
  '.resources[$lid].observedProperties | has("EmptyOnDelete")' "${WORK_DIR}/state3a.json")"
[ "${OBS_SID}" = "CdkdIntegPull" ] || { echo "FAIL: Phase 3a: observedProperties.RepositoryPolicyText holds Sid '${OBS_SID}', expected CdkdIntegPull: the capture did not read the policy back (issue #6631)" >&2; exit 1; }
[ "${OBS_EOD}" = "false" ] || { echo "FAIL: Phase 3a: observedProperties records EmptyOnDelete ('${OBS_EOD}'), which AWS cannot report" >&2; exit 1; }
echo "    observed baseline holds the policy, and no EmptyOnDelete"

echo "==> Phase 3b: drift on the untouched repository"
RC3B="$(run_drift "${WORK_DIR}/drift3b.json")"
P3B="$(read_repo_paths "Phase 3b" "${WORK_DIR}/drift3b.json" "${RC3B}")"
assert_no_policy_keys "Phase 3b" "${P3B}"
echo "    no policy drift reported (rc ${RC3B})"

echo "==> Phase 3c: add an action to the policy out of band"
aws ecr get-repository-policy --repository-name "${REPO}" --region "${REGION}" \
  --query policyText --output text |
  jq -c '.Statement |= ((if type == "array" then . else [.] end) | map(if .Sid == "CdkdIntegPull"
    then .Action = ((if (.Action | type) == "array" then .Action else [.Action] end) + ["ecr:DescribeImages"])
    else . end))' >"${WORK_DIR}/oob-policy.json"
aws ecr set-repository-policy --repository-name "${REPO}" --region "${REGION}" \
  --policy-text "file://${WORK_DIR}/oob-policy.json" >/dev/null
ACTIONS3C="$(policy_actions)"
[ "${ACTIONS3C}" = "ecr:BatchGetImage ecr:DescribeImages ecr:GetDownloadUrlForLayer" ] || { echo "FAIL: Phase 3c premise: the out-of-band edit left actions [${ACTIONS3C}]" >&2; exit 1; }
RC3C="$(run_drift "${WORK_DIR}/drift3c.json")"
assert_policy_reported "Phase 3c" "${WORK_DIR}/drift3c.json" "${RC3C}"
echo "    the out-of-band policy change reported"

echo "==> Phase 3d: cdkd drift --revert restores the declared policy"
PID_BEFORE="$(state_physical_id)"
AWSID_BEFORE="$(aws_repo_identity)"
[ -n "${PID_BEFORE}" ] && valid_identity "${AWSID_BEFORE}" || { echo "FAIL: Phase 3d premise: empty identity before the revert (physicalId '${PID_BEFORE}', AWS '${AWSID_BEFORE}')" >&2; exit 1; }
revert_identity_snapshot "${WORK_DIR}/revert-ids-1-before" "${STACK}" "${REPO_LID}" || exit 1
REVERT3D_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  >"${WORK_DIR}/revert3d.log" 2>&1 || REVERT3D_RC=$?
cat "${WORK_DIR}/revert3d.log"
revert_identity_verify "${WORK_DIR}/revert-ids-1-before" "${WORK_DIR}/revert-ids-1-after" 1 "${WORK_DIR}/revert3d.log" || exit 1
[ "${REVERT3D_RC}" -eq 0 ] || { echo "FAIL: Phase 3d: drift --revert failed" >&2; cat "${WORK_DIR}/revert3d.log" >&2; exit 1; }
grep -qF "/${REPO_LID} (AWS::ECR::Repository): reverted" "${WORK_DIR}/revert3d.log" || { echo "FAIL: Phase 3d: the revert output has no 'reverted' line for ${REPO_LID}" >&2; exit 1; }
if grep -qiE 'replac|recreat|re-creat' "${WORK_DIR}/revert3d.log"; then
  echo "FAIL: Phase 3d: the revert output mentions a replacement / re-create" >&2
  grep -iE 'replac|recreat|re-creat' "${WORK_DIR}/revert3d.log" >&2
  exit 1
fi
PID_AFTER="$(state_physical_id)"
AWSID_AFTER="$(aws_repo_identity)"
[ -n "${PID_AFTER}" ] && valid_identity "${AWSID_AFTER}" || { echo "FAIL: Phase 3d: empty identity after the revert (physicalId '${PID_AFTER}', AWS '${AWSID_AFTER}')" >&2; exit 1; }
[ "${PID_AFTER}" = "${PID_BEFORE}" ] || { echo "FAIL: Phase 3d: the revert changed the state physicalId '${PID_BEFORE}' -> '${PID_AFTER}' (a replacement)" >&2; exit 1; }
[ "${AWSID_AFTER}" = "${AWSID_BEFORE}" ] || { echo "FAIL: Phase 3d: the revert changed the repository's ARN / createdAt '${AWSID_BEFORE}' -> '${AWSID_AFTER}' (deleted and re-created)" >&2; exit 1; }
echo "    revert kept the repository: physicalId ${PID_AFTER}, AWS identity unchanged"
ACTIONS3D="$(policy_actions)"
[ "${ACTIONS3D}" = "${DECLARED_ACTIONS}" ] || { echo "FAIL: Phase 3d: --revert left actions [${ACTIONS3D}], expected [${DECLARED_ACTIONS}] (issue #6631)" >&2; exit 1; }
RC3D="$(run_drift "${WORK_DIR}/drift3d.json")"
P3D="$(read_repo_paths "Phase 3d" "${WORK_DIR}/drift3d.json" "${RC3D}")"
assert_no_policy_keys "Phase 3d" "${P3D}"
echo "    declared actions restored; drift no longer reports the policy"

echo "==> Phase 3e: drift on the template-only baseline (observedProperties stripped)"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/lock.json"; then
  echo "FAIL: Phase 3e: a lock is held on ${STACK}; the state rewrite needs none" >&2
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state3e.json" >/dev/null
HAS_OBS="$(jq -r --arg lid "${REPO_LID}" '.resources[$lid] | has("observedProperties")' "${WORK_DIR}/state3e.json")"
[ "${HAS_OBS}" = "true" ] || { echo "FAIL: Phase 3e premise: ${REPO_LID} has no observedProperties to strip ('${HAS_OBS}')" >&2; exit 1; }
jq --arg lid "${REPO_LID}" 'del(.resources[$lid].observedProperties)' "${WORK_DIR}/state3e.json" >"${WORK_DIR}/stripped.json"
aws s3 cp "${WORK_DIR}/stripped.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
STRIPPED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg lid "${REPO_LID}" '.resources[$lid] | has("observedProperties")')"
[ "${STRIPPED}" = "false" ] || { echo "FAIL: Phase 3e: the rewritten record still has observedProperties ('${STRIPPED}')" >&2; exit 1; }
RC3E="$(run_drift "${WORK_DIR}/drift3e.json")"
P3E="$(read_repo_paths "Phase 3e" "${WORK_DIR}/drift3e.json" "${RC3E}")"
assert_no_policy_keys "Phase 3e" "${P3E}"
echo "    no policy or EmptyOnDelete drift on the template-only baseline (rc ${RC3E})"

echo "==> Phase 3f: delete the policy out of band (template-only baseline)"
aws ecr delete-repository-policy --repository-name "${REPO}" --region "${REGION}" >/dev/null
RC3F="$(run_drift "${WORK_DIR}/drift3f.json")"
assert_policy_reported "Phase 3f" "${WORK_DIR}/drift3f.json" "${RC3F}"
echo "    the deleted policy reported"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "repo ${REPO} still exists after destroy" aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}"
echo "    repo deleted"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ECR scanOnPush (CFn->SDK casing) + tag add/change/untag on update + ImageTagMutabilityExclusionFilters on create and on a filters-only update reach AWS + the repository policy's drift (capture, report, revert, template-only baseline), 4 phases passed"
