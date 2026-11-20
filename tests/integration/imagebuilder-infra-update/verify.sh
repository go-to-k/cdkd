#!/usr/bin/env bash
# verify.sh -- cdkd AWS::ImageBuilder::InfrastructureConfiguration update and
# drift revert without `ResourceTags` (issue #6569).
#
# The type has no SDK provider, so it goes through Cloud Control, whose read
# model for a configuration created without `ResourceTags` carries
# `"ResourceTags": {}`. Cloud Control applies the update patch on top of that
# model, so every update sent the empty map and UpdateInfrastructureConfiguration
# refused it (`resourceTags length must satisfy min_items 1`), on `cdkd deploy`
# and on `cdkd drift --revert` alike. cdkd now adds `remove /ResourceTags`
# (`src/provisioning/cc-read-back-empty-keys.ts`).
#
# Phases:
#   1. Deploy a role, an instance profile and an infrastructure configuration
#      with no resourceTags (t3.micro, terminateInstanceOnFailure true, a
#      description). Assert: state records it on the Cloud Control route, AWS
#      reports the template's values, and the premise holds: the Cloud Control
#      read model carries `ResourceTags: {}`.
#   2. UPDATE (CDKD_TEST_UPDATE=true: t3.small + t3.medium,
#      terminateInstanceOnFailure false, description removed). Assert all three
#      reached AWS and the configuration kept its ARN and creation date.
#   3. Change InstanceTypes out of band (t3.large). Assert `cdkd drift` reports
#      the configuration drifted, then `cdkd drift --revert` restores
#      t3.small + t3.medium and a second drift no longer reports it.
#   4. Destroy. Assert the configuration, the instance profile, the role and
#      the state file are gone.
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

# revert_identity_* : prove a drift --revert kept every resource it touched (#6639).
. ../revert-identity.sh
export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

STACK="CdkdImageBuilderInfraUpdate"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
INFRA_LOGICAL="Infra"
INFRA_NAME="${STACK}-infra"
DRIFT_OUT="${TMPDIR:-/tmp}/cdkd-6569-drift.$$.log"
REVERT_DIR=""
REVERT_PFX=""

CLEANED_UP=0
PRE_RUN=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_OUT}"
  if [ -n "${REVERT_DIR:-}" ]; then
    rm -f "${REVERT_DIR}"/revert.*
    rmdir "${REVERT_DIR}" 2>/dev/null
  fi
  # `state destroy` throws when there is no state, as before any run and after a
  # PASS, so its failure means something only for a state that exists. Anything
  # but a clean not-found counts as existing: keeping a record costs nothing.
  STATE_LEFT=0
  if [ -n "${STATE_BUCKET:-}" ]; then
    if STATE_HEAD="$(aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" 2>&1 >/dev/null)"; then
      STATE_LEFT=1
    elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${STATE_HEAD}"; then
      STATE_LEFT=1
    fi
  fi
  if [ "${STATE_LEFT}" = "1" ] && [ -f "${LOCAL_DIST}" ] &&
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1; then
    STATE_LEFT=0
  fi
  # A deploy that failed before state recorded them leaves resources nothing
  # here knows, and every name starts with the stack. The account is shared
  # and a peer may be running this fixture, so only this run's own teardown
  # deletes by prefix: before the run, a match is reported and stops it.
  LEFT_BY_PREFIX=""
  case "${STACK}" in
    CdkdImageBuilder?*)
      if SWEPT_INFRA="$(aws imagebuilder list-infrastructure-configurations --region "${REGION}" \
        --query "infrastructureConfigurationSummaryList[?starts_with(name, '${STACK}-')].arn" --output text 2>&1)"; then
        for arn in ${SWEPT_INFRA}; do
          [ "${arn}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} infrastructure-configuration:${arn}"
          else
            aws imagebuilder delete-infrastructure-configuration --infrastructure-configuration-arn "${arn}" \
              --region "${REGION}" >/dev/null 2>&1 || echo "WARN: could not delete ${arn}" >&2
          fi
        done
      else
        echo "WARN: could not list infrastructure configurations of ${STACK}: ${SWEPT_INFRA}" >&2
      fi
      if SWEPT_PROFILES="$(aws iam list-instance-profiles \
        --query "InstanceProfiles[?starts_with(InstanceProfileName, '${STACK}-')].InstanceProfileName" --output text 2>&1)"; then
        for name in ${SWEPT_PROFILES}; do
          [ "${name}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} instance-profile:${name}"
          else
            for r in $(aws iam get-instance-profile --instance-profile-name "${name}" \
              --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null); do
              aws iam remove-role-from-instance-profile --instance-profile-name "${name}" --role-name "${r}" >/dev/null 2>&1
            done
            aws iam delete-instance-profile --instance-profile-name "${name}" >/dev/null 2>&1 ||
              echo "WARN: could not delete instance profile ${name}" >&2
          fi
        done
      else
        echo "WARN: could not list instance profiles of ${STACK}: ${SWEPT_PROFILES}" >&2
      fi
      if SWEPT_ROLES="$(aws iam list-roles \
        --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text 2>&1)"; then
        for name in ${SWEPT_ROLES}; do
          [ "${name}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} role:${name}"
          else
            for p in $(aws iam list-attached-role-policies --role-name "${name}" \
              --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
              aws iam detach-role-policy --role-name "${name}" --policy-arn "${p}" >/dev/null 2>&1
            done
            aws iam delete-role --role-name "${name}" >/dev/null 2>&1 ||
              echo "WARN: could not delete role ${name}" >&2
          fi
        done
      else
        echo "WARN: could not list roles of ${STACK}: ${SWEPT_ROLES}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdImageBuilder?*" >&2
      ;;
  esac
  # The state is the only record of what a failed `state destroy` left behind.
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and resources of ${STACK} may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
  if [ -n "${LEFT_BY_PREFIX}" ]; then
    echo "FAIL: ${STACK} resources exist before this run, possibly a peer's live run:${LEFT_BY_PREFIX}" >&2
    exit 1
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
PRE_RUN=1
cleanup
# Created AFTER the pre-run cleanup above, which removes it (go-to-k/cdkd#6639).
REVERT_DIR="$(mktemp -d)"
REVERT_PFX="${REVERT_DIR}/revert"
PRE_RUN=0
CLEANED_UP=0

read_state() { # $1 = python expression over `s` (the state fetched into STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
infra_field() { # usage: infra_field <query under infrastructureConfiguration>; strict, no fallback
  aws imagebuilder get-infrastructure-configuration --infrastructure-configuration-arn "${INFRA_ARN}" \
    --region "${REGION}" --query "infrastructureConfiguration.$1" --output text
}
infra_types() { # the instance types, sorted
  infra_field "join(' ', sort(instanceTypes || \`[]\`))"
}

# --- Phase 1: deploy without resourceTags -----------------------------------
echo "==> Phase 1: deploy (an infrastructure configuration without resourceTags)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
INFRA_ARN="$(read_state "s['resources']['${INFRA_LOGICAL}']['physicalId']")"
INFRA_ROUTE="$(read_state "s['resources']['${INFRA_LOGICAL}'].get('provisionedBy', '')")"
PROFILE_NAME="$(read_state "s.get('outputs', {}).get('InstanceProfileName', '')")"
ROLE_NAME="$(read_state "s.get('outputs', {}).get('RoleName', '')")"
OUT_ARN="$(read_state "s.get('outputs', {}).get('InfraArn', '')")"
[ "${INFRA_ROUTE}" = "cc-api" ] ||
  { echo "FAIL: ${INFRA_LOGICAL} provisionedBy='${INFRA_ROUTE}', expected cc-api" >&2; exit 1; }
[ -n "${PROFILE_NAME}" ] && [ -n "${ROLE_NAME}" ] && [ "${OUT_ARN}" = "${INFRA_ARN}" ] ||
  { echo "FAIL: outputs profile='${PROFILE_NAME}' role='${ROLE_NAME}' arn='${OUT_ARN}' (state arn '${INFRA_ARN}')" >&2; exit 1; }

NAME_NOW="$(infra_field name)"
CREATED="$(infra_field dateCreated)"
TYPES="$(infra_types)"
TERMINATE="$(infra_field terminateInstanceOnFailure)"
DESCRIPTION="$(infra_field description)"
PROFILE_NOW="$(infra_field instanceProfileName)"
[ "${NAME_NOW}" = "${INFRA_NAME}" ] ||
  { echo "FAIL: configuration name '${NAME_NOW}', expected '${INFRA_NAME}'" >&2; exit 1; }
[ "${TYPES}" = "t3.micro" ] ||
  { echo "FAIL: instanceTypes '${TYPES}', expected 't3.micro'" >&2; exit 1; }
[ "${TERMINATE}" = "True" ] ||
  { echo "FAIL: terminateInstanceOnFailure '${TERMINATE}', expected True" >&2; exit 1; }
[ "${DESCRIPTION}" = "cdkd integ #6569" ] ||
  { echo "FAIL: description '${DESCRIPTION}', expected 'cdkd integ #6569'" >&2; exit 1; }
[ "${PROFILE_NOW}" = "${PROFILE_NAME}" ] ||
  { echo "FAIL: instanceProfileName '${PROFILE_NOW}', expected '${PROFILE_NAME}'" >&2; exit 1; }
echo "    ${INFRA_NAME} created via cc-api (t3.micro, terminate True, described)"

# The premise: without it the update below would pass on a tree without the fix.
assert_empty_resource_tags_premise() { # $1 = phase label
  local model premise
  model="$(aws cloudcontrol get-resource --type-name AWS::ImageBuilder::InfrastructureConfiguration \
    --identifier "${INFRA_ARN}" --region "${REGION}" --query 'ResourceDescription.Properties' --output text)" || return 1
  premise="$(printf '%s' "${model}" | python3 -c "import json, sys; m = json.load(sys.stdin); print('ResourceTags' in m and m['ResourceTags'] in ({}, []))")" || return 1
  [ "${premise}" = "True" ] ||
    { echo "FAIL: premise gone $1: the Cloud Control read model no longer carries an empty ResourceTags, so this fixture no longer exercises go-to-k/cdkd#6569 (model: ${model})" >&2; exit 1; }
  echo "    premise $1: the Cloud Control read model carries an empty ResourceTags"
}
assert_empty_resource_tags_premise "after the create"

# --- Phase 2: in-place UPDATE through Cloud Control -------------------------
echo "==> Phase 2: update (t3.small + t3.medium, terminate false, description removed)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TYPES_AFTER="$(infra_types)"
TERMINATE_AFTER="$(infra_field terminateInstanceOnFailure)"
DESCRIPTION_AFTER="$(infra_field description)"
CREATED_AFTER="$(infra_field dateCreated)"
[ "${TYPES_AFTER}" = "t3.medium t3.small" ] ||
  { echo "FAIL: instanceTypes after the update '${TYPES_AFTER}', expected 't3.medium t3.small' (go-to-k/cdkd#6569)" >&2; exit 1; }
[ "${TERMINATE_AFTER}" = "False" ] ||
  { echo "FAIL: terminateInstanceOnFailure after the update '${TERMINATE_AFTER}', expected False" >&2; exit 1; }
case "${DESCRIPTION_AFTER}" in
  None | "") ;;
  *) echo "FAIL: description after the update '${DESCRIPTION_AFTER}', expected it removed" >&2; exit 1 ;;
esac
[ "${CREATED_AFTER}" = "${CREATED}" ] ||
  { echo "FAIL: the configuration was replaced (created '${CREATED}' -> '${CREATED_AFTER}')" >&2; exit 1; }
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
ARN_AFTER="$(read_state "s['resources']['${INFRA_LOGICAL}']['physicalId']")"
[ "${ARN_AFTER}" = "${INFRA_ARN}" ] ||
  { echo "FAIL: ${INFRA_LOGICAL} state physical id changed across the update ('${INFRA_ARN}' -> '${ARN_AFTER}')" >&2; exit 1; }
echo "    update reached AWS in place"

# --- Phase 3: out-of-band change, drift, revert -----------------------------
echo "==> Phase 3: change instanceTypes out of band (t3.large), then drift --revert"
# UpdateInfrastructureConfiguration replaces the whole configuration, so every
# value the template sets is sent again as the update phase left it.
aws imagebuilder update-infrastructure-configuration --region "${REGION}" \
  --infrastructure-configuration-arn "${INFRA_ARN}" \
  --instance-profile-name "${PROFILE_NAME}" \
  --instance-types t3.large \
  --no-terminate-instance-on-failure >/dev/null
TYPES_OOB="$(infra_types)"
[ "${TYPES_OOB}" = "t3.large" ] ||
  { echo "FAIL: the out-of-band update did not set instanceTypes to t3.large, got '${TYPES_OOB}'" >&2; exit 1; }
assert_empty_resource_tags_premise "after the out-of-band update"

set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DRIFT_OUT}" 2>&1
DRIFT_RC=$?
set -e
cat "${DRIFT_OUT}"
grep -qF "~ ${INFRA_LOGICAL} (AWS::ImageBuilder::InfrastructureConfiguration)" "${DRIFT_OUT}" ||
  { echo "FAIL: drift did not report the out-of-band instanceTypes change on ${INFRA_LOGICAL}" >&2; exit 1; }
[ "${DRIFT_RC}" -eq 1 ] ||
  { echo "FAIL: drift exited ${DRIFT_RC} on a drifted stack, expected 1" >&2; exit 1; }
echo "    drift reports ${INFRA_LOGICAL} drifted"

revert_identity_snapshot "${REVERT_PFX}.ids-before" "${STACK}" "${INFRA_LOGICAL}" || exit 1
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes >"${REVERT_PFX}.log" 2>&1 || {
  cat "${REVERT_PFX}.log"
  echo "FAIL: cdkd drift --revert failed" >&2
  exit 1
}
cat "${REVERT_PFX}.log"
revert_output_assert_no_replacement "${REVERT_PFX}.log" || exit 1
revert_identity_snapshot "${REVERT_PFX}.ids-after" "${STACK}" "${INFRA_LOGICAL}" || exit 1
revert_identity_assert_unchanged "${REVERT_PFX}.ids-before" "${REVERT_PFX}.ids-after" 1 || exit 1
TYPES_REVERT="$(infra_types)"
[ "${TYPES_REVERT}" = "t3.medium t3.small" ] ||
  { echo "FAIL: drift --revert left instanceTypes '${TYPES_REVERT}', expected 't3.medium t3.small' (go-to-k/cdkd#6569)" >&2; exit 1; }
TERMINATE_REVERT="$(infra_field terminateInstanceOnFailure)"
[ "${TERMINATE_REVERT}" = "False" ] ||
  { echo "FAIL: drift --revert changed terminateInstanceOnFailure to '${TERMINATE_REVERT}', expected False" >&2; exit 1; }

set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DRIFT_OUT}" 2>&1
set -e
if grep -qF "~ ${INFRA_LOGICAL} (AWS::ImageBuilder::InfrastructureConfiguration)" "${DRIFT_OUT}"; then
  cat "${DRIFT_OUT}"
  echo "FAIL: ${INFRA_LOGICAL} still reports drift after drift --revert" >&2
  exit 1
fi
# Sentinel: the report must have run and named the stack, or the absence above
# proves nothing.
grep -qF "${STACK}" "${DRIFT_OUT}" ||
  { cat "${DRIFT_OUT}"; echo "FAIL: the drift after the revert printed no report for ${STACK}" >&2; exit 1; }
echo "    drift --revert restored t3.small + t3.medium; drift no longer reports ${INFRA_LOGICAL}"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "infrastructure configuration ${INFRA_ARN} still exists after destroy" \
  aws imagebuilder get-infrastructure-configuration --infrastructure-configuration-arn "${INFRA_ARN}" --region "${REGION}"
assert_gone "instance profile ${PROFILE_NAME} still exists after destroy" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE_NAME}"
assert_gone "role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

cleanup
trap - EXIT INT TERM
echo "[verify] PASS — an infrastructure configuration without resourceTags updated in place, drift --revert restored it, destroy left nothing"
