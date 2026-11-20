#!/usr/bin/env bash
# verify.sh — a same-name IAM role and group re-create attach back what IAM
# detached before deleting them (issue #4461).
#
# Phases: deploy a fixed-name role, group and user, a managed policy attached
# to all three, an instance profile holding the role, a user in the group
# (its `Groups`), a second one added by a `UserToGroupAddition`, and inline
# policies on the group and the user -> premise: the template diffs to no
# changes -> THE ARM: `--recreate-via-cc-api` the role, the group and the user;
# premises: each keeps its name and gets a new id (it really was re-created)
# -> every attachment is back, and the template diffs to no changes again ->
# destroy + gone-probes.
#
# Before the fix the managed policy, the instance profile and the user diffed
# NO_CHANGE (their references resolve to the same names), so the re-created
# role ran without the Deny guardrail and outside its profile, and the group
# without its policy and member, while state recorded all of them.

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
. ../revert-identity.sh
REVERT_WORK=""

STACK="CdkdIamRecreateReattachExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE="${STACK}-role"
GROUP="${STACK}-group"
USER_NAME="${STACK}-member"
ADDED="${STACK}-added"
RUSER="${STACK}-user"
USER_INLINE="${STACK}-user-inline"
PROFILE="${STACK}-profile"
MANAGED="${STACK}-guardrail"
INLINE="${STACK}-inline"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_json() {
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s\n' "${json}"
}

# Each a strict capture: a probe failure aborts rather than reading as absent.
role_policies() { aws iam list-attached-role-policies --role-name "${ROLE}" --query "length(AttachedPolicies[?PolicyName=='${MANAGED}'])" --output text; }
group_policies() { aws iam list-attached-group-policies --group-name "${GROUP}" --query "length(AttachedPolicies[?PolicyName=='${MANAGED}'])" --output text; }
profile_roles() { aws iam get-instance-profile --instance-profile-name "${PROFILE}" --query "length(InstanceProfile.Roles[?RoleName=='${ROLE}'])" --output text; }
group_members() { aws iam get-group --group-name "${GROUP}" --query "length(Users[?UserName=='${USER_NAME}'])" --output text; }
group_inline() { aws iam list-group-policies --group-name "${GROUP}" --query "length(PolicyNames[?@=='${INLINE}'])" --output text; }
group_added() { aws iam get-group --group-name "${GROUP}" --query "length(Users[?UserName=='${ADDED}'])" --output text; }
user_policies() { aws iam list-attached-user-policies --user-name "${RUSER}" --query "length(AttachedPolicies[?PolicyName=='${MANAGED}'])" --output text; }
user_inline() { aws iam list-user-policies --user-name "${RUSER}" --query "length(PolicyNames[?@=='${USER_INLINE}'])" --output text; }
user_id() { aws iam get-user --user-name "${RUSER}" --query User.UserId --output text; }
role_id() { aws iam get-role --role-name "${ROLE}" --query Role.RoleId --output text; }
group_id() { aws iam get-group --group-name "${GROUP}" --query Group.GroupId --output text; }

assert_attached() { # usage: assert_attached <phase>
  local what got
  for what in role_policies group_policies profile_roles group_members group_inline \
    group_added user_policies user_inline; do
    got=$("${what}")
    [ "${got}" = "1" ] || { echo "FAIL: $1: ${what} = ${got}, expected 1 (issue #4461)" >&2; exit 1; }
  done
}

# go-to-k/cdkd#6609: the baseline captured right after cdkd's own write must
# hold the member the deploy just wrote. `cdkd drift` alone cannot see a stale
# baseline while the live member is the declared one (the drift heal rule
# skips the key then), so this reads the record itself: its observed member
# must be exactly what AWS holds now, key order aside.
assert_observed_member() { # usage: assert_observed_member <logical-id> <jq path into observedProperties> <live JSON> <label>
  local recorded live
  recorded=$(state_json | jq -cS --arg l "$1" \
    ".resources[\$l].observedProperties as \$o | if \$o == null then \"<no baseline>\" else ((\$o | $2) // \"<absent>\") end") \
    || { echo "FAIL: cannot read the state record of $1 after $4" >&2; exit 1; }
  live=$(jq -cS . <<<"$3") || { echo "FAIL: the live value of $1 $2 is not JSON after $4: $3" >&2; exit 1; }
  if [ "${recorded}" != "${live}" ]; then
    echo "FAIL: $1's recorded baseline $2 is not what AWS holds after $4 (#6609)" >&2
    echo "  recorded: ${recorded}" >&2
    echo "  live:     ${live}" >&2
    exit 1
  fi
  echo "    OK: $1's baseline $2 is the live value after $4 (#6609)"
}
assert_iam_baselines() { # usage: assert_iam_baselines <phase>
  local version
  version=$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query Policy.DefaultVersionId --output text) || return 1
  assert_observed_member Guardrail .PolicyDocument "$(aws iam get-policy-version --policy-arn "${POLICY_ARN}" \
    --version-id "${version}" --query PolicyVersion.Document --output json)" "$1"
  assert_observed_member Guardrail '.Roles | sort' "$(aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" \
    --query 'sort(PolicyRoles[].RoleName)' --output json)" "$1"
  assert_observed_member Guardrail '.Groups | sort' "$(aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" \
    --query 'sort(PolicyGroups[].GroupName)' --output json)" "$1"
  assert_observed_member Guardrail '.Users | sort' "$(aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" \
    --query 'sort(PolicyUsers[].UserName)' --output json)" "$1"
  assert_observed_member Profile '.Roles | sort' "$(aws iam get-instance-profile --instance-profile-name "${PROFILE}" \
    --query 'sort(InstanceProfile.Roles[].RoleName)' --output json)" "$1"
  assert_observed_member Member '.Groups | sort' "$(aws iam list-groups-for-user --user-name "${USER_NAME}" \
    --query 'sort(Groups[].GroupName)' --output json)" "$1"
  assert_observed_member FixedRole .AssumeRolePolicyDocument "$(aws iam get-role --role-name "${ROLE}" \
    --query Role.AssumeRolePolicyDocument --output json)" "$1"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # A sweep scoped to this fixture's fixed names only.
  local arn=""
  [ -n "${POLICY_ARN:-}" ] && arn="${POLICY_ARN}"
  aws iam remove-role-from-instance-profile --instance-profile-name "${PROFILE}" --role-name "${ROLE}" >/dev/null 2>&1
  aws iam delete-instance-profile --instance-profile-name "${PROFILE}" >/dev/null 2>&1
  if [ -n "${arn}" ] && [ "${arn}" != "None" ]; then
    aws iam detach-role-policy --role-name "${ROLE}" --policy-arn "${arn}" >/dev/null 2>&1
    aws iam detach-group-policy --group-name "${GROUP}" --policy-arn "${arn}" >/dev/null 2>&1
    aws iam detach-user-policy --user-name "${RUSER}" --policy-arn "${arn}" >/dev/null 2>&1
    aws iam delete-policy --policy-arn "${arn}" >/dev/null 2>&1
  fi
  aws iam delete-group-policy --group-name "${GROUP}" --policy-name "${INLINE}" >/dev/null 2>&1
  aws iam remove-user-from-group --group-name "${GROUP}" --user-name "${USER_NAME}" >/dev/null 2>&1
  aws iam delete-user --user-name "${USER_NAME}" >/dev/null 2>&1
  aws iam remove-user-from-group --group-name "${GROUP}" --user-name "${ADDED}" >/dev/null 2>&1
  aws iam delete-user --user-name "${ADDED}" >/dev/null 2>&1
  aws iam delete-user-policy --user-name "${RUSER}" --policy-name "${USER_INLINE}" >/dev/null 2>&1
  aws iam delete-user --user-name "${RUSER}" >/dev/null 2>&1
  aws iam delete-group --group-name "${GROUP}" >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1
  if [ -n "${REVERT_WORK:-}" ]; then
    rm -f "${REVERT_WORK}/revert-ids-1b-before" "${REVERT_WORK}/revert-ids-1b-after" "${REVERT_WORK}/revert-1b.log"
    rmdir "${REVERT_WORK}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ -n "${ACCOUNT}" ] || { echo "FAIL: no account id" >&2; exit 1; }
# Built, not listed: `list-policies` pages, and `--output text` applies a
# `--query` per page.
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${MANAGED}"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
REVERT_WORK="$(mktemp -d)"

node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
ROLE_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::IAM::Role") | .key' "${TEMPLATE}" | head -1)
GROUP_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::IAM::Group") | .key' "${TEMPLATE}" | head -1)
RUSER_ID=$(jq -r --arg n "${RUSER}" '.Resources | to_entries[] | select(.value.Type == "AWS::IAM::User" and .value.Properties.UserName == $n) | .key' "${TEMPLATE}" | head -1)
[ -n "${ROLE_ID}" ] && [ -n "${GROUP_ID}" ] && [ -n "${RUSER_ID}" ] || { echo "FAIL: no role / group / user logical id in ${TEMPLATE}" >&2; exit 1; }

echo "==> Phase 1: Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_attached "phase 1"
assert_iam_baselines "phase 1"

# go-to-k/cdkd#6609: `cdkd drift --revert` acts on what the capture recorded,
# so an out-of-band change of a member must report, revert to the template in
# place (same physical id, no delete / create), and leave drift clean.
revert_drift_json() { # usage: revert_drift_json [env args...] -- prints `cdkd drift --json`; exit 0..2 is a report
  local out rc=0
  out=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${out}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report (#6609 revert arm)" >&2
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}
assert_member_drifted() { # usage: assert_member_drifted <drift JSON> <type> <member key> <label>
  jq -e --arg t "$2" --arg k "$3" '
    def member: .path == $k or (.path | startswith($k + ".")) or (.path | startswith($k + "["));
    [.[] | (.drifted // [])[] | select(.type == $t) | .changes[] | select(member)] | length > 0
  ' <<<"$1" >/dev/null || {
    echo "FAIL: cdkd drift does not report the out-of-band $2 $3 after $4 (#6609)" >&2
    printf '%s\n' "$1" >&2
    exit 1
  }
  echo "    OK: cdkd drift reports the out-of-band $2 $3 after $4 (#6609)"
}
assert_drift_clean() { # usage: assert_drift_clean <label> [env args...]
  local rc=0 label="$1"
  shift
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || rc=$?
  [ "${rc}" -eq 0 ] || { echo "FAIL: cdkd drift exited ${rc} after ${label}, want 0 (#6609)" >&2; exit 1; }
  echo "    OK: cdkd drift is clean after ${label} (#6609)"
}
run_revert() { # usage: run_revert [env args...]
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
}
assert_same() { # usage: assert_same <label> <before> <after>
  [ -n "$2" ] && [ "$2" = "$3" ] || { echo "FAIL: $1 changed across the revert: '$2' -> '$3' (#6609: a delete / create)" >&2; exit 1; }
  echo "    OK: $1 unchanged across the revert ($2)"
}

echo "==> Phase 1b: a role removed from the instance profile out of band is reverted in place (#6609)"
PROFILE_ID_BEFORE="$(aws iam get-instance-profile --instance-profile-name "${PROFILE}" --query InstanceProfile.InstanceProfileId --output text)"
PROFILE_PID_BEFORE="$(state_json | jq -r '.resources.Profile.physicalId')"
aws iam remove-role-from-instance-profile --instance-profile-name "${PROFILE}" --role-name "${ROLE}"
DRIFT_1B="$(revert_drift_json)" || exit 1
assert_member_drifted "${DRIFT_1B}" AWS::IAM::InstanceProfile Roles "an out-of-band remove-role-from-instance-profile"
# go-to-k/cdkd#6639: the helpers run right after the revert returns, before any
# assertion on its result; the revert's rc is captured, not acted on, first.
revert_identity_snapshot "${REVERT_WORK}/revert-ids-1b-before" "${STACK}" Profile || exit 1
REVERT_RC=0
run_revert 2>&1 | tee "${REVERT_WORK}/revert-1b.log" || REVERT_RC=$?
revert_identity_verify "${REVERT_WORK}/revert-ids-1b-before" "${REVERT_WORK}/revert-ids-1b-after" 1 "${REVERT_WORK}/revert-1b.log" ignore=CdkdIamRecreateReattachExample || exit 1
[ "${REVERT_RC}" -eq 0 ] || { echo "FAIL: cdkd drift --revert exited ${REVERT_RC} (phase 1b)" >&2; exit 1; }
[ "$(profile_roles)" = "1" ] || { echo "FAIL: ${ROLE} is not back in ${PROFILE} after the revert" >&2; exit 1; }
echo "    OK: the revert put ${ROLE} back in ${PROFILE}"
assert_same "${PROFILE}'s InstanceProfileId" "${PROFILE_ID_BEFORE}" \
  "$(aws iam get-instance-profile --instance-profile-name "${PROFILE}" --query InstanceProfile.InstanceProfileId --output text)"
assert_same "Profile's state physical id" "${PROFILE_PID_BEFORE}" "$(state_json | jq -r '.resources.Profile.physicalId')"
assert_drift_clean "the phase 1b revert"
R0=$(role_id); G0=$(group_id); U0=$(user_id)
[ -n "${R0}" ] && [ -n "${G0}" ] && [ -n "${U0}" ] || { echo "FAIL: no RoleId / GroupId / UserId after phase 1" >&2; exit 1; }
echo "    OK: role ${ROLE}, group ${GROUP} and user ${RUSER} with every attachment"

echo "==> Phase 2: premise -- the template diffs to no changes"
set +e
PREMISE_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
PREMISE_RC=$?
set -e
[ "${PREMISE_RC}" -eq 0 ] || {
  printf '%s\n' "${PREMISE_OUT}" >&2
  echo "FAIL: premise: cdkd diff --fail exited ${PREMISE_RC} (expected 0, no changes)" >&2
  exit 1
}

echo "==> Phase 3: THE ARM -- recreate the role, the group and the user under their names"
OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${ROLE_ID}" --recreate-via-cc-api "${GROUP_ID}" \
  --recreate-via-cc-api "${RUSER_ID}" --yes 2>&1) || {
  printf '%s\n' "${OUT}" >&2
  echo "FAIL: the --recreate-via-cc-api deploy failed" >&2
  exit 1
}
printf '%s\n' "${OUT}"
# PREMISE: both really were deleted and re-created (a new unique id under the
# same name), so IAM really detached everything from them.
R1=$(role_id); G1=$(group_id)
[ -n "${R1}" ] && [ "${R1}" != "${R0}" ] || { echo "FAIL: premise: the role was not re-created (RoleId ${R0} -> ${R1:-<none>})" >&2; exit 1; }
[ -n "${G1}" ] && [ "${G1}" != "${G0}" ] || { echo "FAIL: premise: the group was not re-created (GroupId ${G0} -> ${G1:-<none>})" >&2; exit 1; }
U1=$(user_id)
[ -n "${U1}" ] && [ "${U1}" != "${U0}" ] || { echo "FAIL: premise: the user was not re-created (UserId ${U0} -> ${U1:-<none>})" >&2; exit 1; }
for key in "${ROLE_ID}" "${GROUP_ID}" "${RUSER_ID}"; do
  LAYER=$(state_json | jq -r --arg k "${key}" '.resources[$k].provisionedBy')
  [ "${LAYER}" = "cc-api" ] || { echo "FAIL: ${key} is recorded on ${LAYER} after the recreate, expected cc-api" >&2; exit 1; }
done
assert_attached "phase 3"
# The records agree with AWS again: nothing left for a later deploy to do.
set +e
AFTER_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
AFTER_RC=$?
set -e
[ "${AFTER_RC}" -eq 0 ] || {
  printf '%s\n' "${AFTER_OUT}" >&2
  echo "FAIL: cdkd diff --fail exited ${AFTER_RC} after the recreate (expected 0, no changes)" >&2
  exit 1
}
echo "    OK: role, group and user re-created; every attachment is back"
# go-to-k/cdkd#6609: the re-attach rewrote the attachments right after the
# re-create, so their baselines must be the live values too.
assert_iam_baselines "phase 3 (re-create and re-attach)"

echo "==> Phase 4: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "IAM role ${ROLE} survived destroy" aws iam get-role --role-name "${ROLE}"
assert_gone "IAM group ${GROUP} survived destroy" aws iam get-group --group-name "${GROUP}"
for u in "${USER_NAME}" "${ADDED}" "${RUSER}"; do
  assert_gone "IAM user ${u} survived destroy" aws iam get-user --user-name "${u}"
done
assert_gone "instance profile ${PROFILE} survived destroy" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE}"
assert_gone "managed policy ${MANAGED} survived destroy" aws iam get-policy --policy-arn "${POLICY_ARN}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — iam-recreate-reattach (a same-name role / group / user re-create is attached back)"
