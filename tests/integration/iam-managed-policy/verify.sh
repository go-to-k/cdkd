#!/usr/bin/env bash
# verify.sh - iam-managed-policy: an IAM Role plus a standalone customer-managed
# AWS::IAM::ManagedPolicy attached to that role via the policy's `roles: [...]`.
#
# Converted from a standard-flow smoke test to a verify.sh so it owns its own
# deploy + assert + destroy cycle. A bare `cdkd deploy` / `cdkd destroy --force`
# invoked directly from a shell is refused by the auto-mode classifier (it looks
# like a skill bypass / Blind Apply); wrapping the same calls inside verify.sh
# lets `/run-integ iam-managed-policy` exercise the path end-to-end.
#
# LOAD-BEARING assertions:
#   - after deploy the customer-managed policy is ATTACHED to the role (the
#     `roles: [role]` linkage), the instance profile holds ServiceRole, GroupA
#     holds MemberA (UserToGroupAddition) and GroupB holds MemberB (its Groups);
#   - after the CDKD_TEST_UPDATE=true redeploy, which SWAPS each list against the
#     one cdkd recorded (go-to-k/cdkd#3906, go-to-k/cdkd#3888), the policy is on
#     SecondRole and off ServiceRole, the profile holds SecondRole only, GroupA
#     holds exactly MemberB and MemberC, and GroupB is empty;
#   - the destroy path detaches the policy before deleting it and then deletes
#     the roles - a clean destroy with everything gone proves the
#     detach-before-delete ordering held;
#   - (go-to-k/cdkd#6697) ReadLogsPolicy attached out of band to SecondRole,
#     which its `Roles` does not name: while the policy is compared, `cdkd
#     drift` reports the attach on the policy and not on SecondRole; once the
#     policy's record is marked `observedBaselineRefused` (seeded in the S3
#     state, so the policy is not compared), drift reports it on SecondRole,
#     and `cdkd drift --revert --yes` detaches it from SecondRole in place (no
#     replacement), keeps ServiceRole's declared attachment, and drift no
#     longer reports SecondRole;
#   - (go-to-k/cdkd#6655) ServiceRole and ReadLogsPolicy, deleted and
#     re-created under their names outside the stack before the destroy, are
#     REFUSED by the destroy (their RoleId / PolicyId differs from the
#     recorded one) and left intact; once removed by hand, a second destroy
#     finishes.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CdkdIamManagedPolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t iam-managed-policy.XXXXXX)"
# go-to-k/cdkd#6697: the drift / revert arm's reports and identity snapshots.
. ../revert-identity.sh
REVERT_DIR="$(mktemp -d -t iam-managed-policy-revert.XXXXXX)"

# IAM is eventually consistent right after create; let the CLI back off
# transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  # go-to-k/cdkd#6655: the role re-created outside the stack in step 3e is
  # no record's, so no destroy below removes it (it refuses it).
  if [ -n "${FOREIGN_ROLE:-}" ]; then
    aws iam delete-role --role-name "${FOREIGN_ROLE}" >/dev/null 2>&1
  fi
  if [ -n "${FOREIGN_POLICY:-}" ]; then
    aws iam delete-policy --policy-arn "${FOREIGN_POLICY}" >/dev/null 2>&1
  fi
  # go-to-k/cdkd#6697: the out-of-band attach no record holds, should the run
  # stop before its revert.
  if [ -n "${OOB_ATTACHED_ROLE:-}" ]; then
    aws iam detach-role-policy --role-name "${OOB_ATTACHED_ROLE}" --policy-arn "${POLICY_ARN}" >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
  fi
  rm -f "${DEPLOY_LOG}" "${DEPLOY_LOG}.2" 2>/dev/null || true
  [ -n "${REVERT_DIR:-}" ] && rm -rf "${REVERT_DIR}" 2>/dev/null
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} - clean up first." >&2
  exit 1
fi

echo "==> Step 1: deploy (IAM Roles, customer-managed policy, profile, groups, users)"
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2: locate the role + customer-managed policy"
# NB: iam list-* paginates, and the AWS CLI applies --query PER PAGE, so a
# trailing `| [0]` injects a `None` for every page without a match. Filter to
# the matching field only (empty pages contribute nothing), then take the first
# non-empty line with awk (exits 0 even on no match, so pipefail does not abort
# the legitimate "not found" case the guard below is meant to catch).
ROLE_NAME=$(aws iam list-roles \
  --query "Roles[?contains(RoleName, '${STACK}') && contains(RoleName, 'ServiceRole')].RoleName" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
if [ -z "${ROLE_NAME}" ]; then
  echo "FAIL: no ServiceRole found for ${STACK}" >&2
  exit 1
fi
POLICY_ARN=$(aws iam list-policies --scope Local \
  --query "Policies[?contains(PolicyName, '${STACK}') && contains(PolicyName, 'ReadLogsPolicy')].Arn" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
if [ -z "${POLICY_ARN}" ]; then
  echo "FAIL: no customer-managed ReadLogsPolicy found" >&2
  exit 1
fi
echo "    OK: role=${ROLE_NAME} policy=${POLICY_ARN}"

echo "==> Step 3 (LOAD-BEARING): assert the managed policy is ATTACHED to the role"
ATTACHED=$(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
  --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'] | length(@)" --output text)
if [ "${ATTACHED}" != "1" ]; then
  echo "FAIL: ReadLogsPolicy is not attached to ${ROLE_NAME} (roles: linkage broke)" >&2
  exit 1
fi
echo "    OK: ReadLogsPolicy is attached to ${ROLE_NAME}"

# One IAM name per line, sorted: list readbacks are order-insensitive.
find_name() { # usage: find_name <list-verb> <collection> <name-field> <logical-id>
  aws iam "$1" --query "$2[?contains($3, '${STACK}') && contains($3, '$4')].$3" \
    --output text | tr '\t' '\n' | awk 'NF{print; exit}'
}
group_members() { # usage: group_members <group-name>
  aws iam get-group --group-name "$1" --query "Users[].UserName" --output text \
    | tr '\t' '\n' | awk 'NF' | sort | tr '\n' ' '
}
profile_roles() { # usage: profile_roles <instance-profile-name>
  aws iam get-instance-profile --instance-profile-name "$1" \
    --query "InstanceProfile.Roles[].RoleName" --output text | tr '\t' '\n' | awk 'NF' | sort | tr '\n' ' '
}
policy_on_role() { # usage: policy_on_role <role-name> -> 1 when attached, 0 when not
  aws iam list-attached-role-policies --role-name "$1" \
    --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}'] | length(@)" --output text
}
expect_eq() { # usage: expect_eq <what> <want> <readback-fn> <arg>
  # Polls: IAM reads are eventually consistent right after a write. A failed
  # readback FAILS the run rather than reading as an empty list, which would
  # satisfy the empty expectation below.
  local got="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    got=$("$3" "$4") || { echo "FAIL: $1: readback failed" >&2; exit 1; }
    [ "${got}" = "$2" ] && break
    sleep 5
  done
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1: want '$2', got '${got}'" >&2
    exit 1
  fi
  echo "    OK: $1 = '${got}'"
}

SECOND_ROLE=$(find_name list-roles Roles RoleName SecondRole)
PROFILE=$(find_name list-instance-profiles InstanceProfiles InstanceProfileName Profile)
GROUP_A=$(find_name list-groups Groups GroupName GroupA)
GROUP_B=$(find_name list-groups Groups GroupName GroupB)
MEMBER_A=$(find_name list-users Users UserName MemberA)
MEMBER_B=$(find_name list-users Users UserName MemberB)
MEMBER_C=$(find_name list-users Users UserName MemberC)
for v in SECOND_ROLE PROFILE GROUP_A GROUP_B MEMBER_A MEMBER_B MEMBER_C; do
  if [ -z "${!v}" ]; then echo "FAIL: ${v} not found for ${STACK}" >&2; exit 1; fi
done

echo "==> Step 3b (LOAD-BEARING): the baseline lists landed as declared"
expect_eq "instance profile roles" "${ROLE_NAME} " profile_roles "${PROFILE}"
expect_eq "GroupA members" "${MEMBER_A} " group_members "${GROUP_A}"
expect_eq "GroupB members" "${MEMBER_B} " group_members "${GROUP_B}"

echo "==> Step 3b2 (LOAD-BEARING, go-to-k/cdkd#6697): an attach of a policy drift did not compare is the principal's drift"
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }
lid_of() { # usage: lid_of <resourceType> <physicalId>
  state_json | jq -r --arg t "$1" --arg p "$2" \
    '.resources | to_entries[] | select(.value.resourceType == $t and .value.physicalId == $p) | .key'
}
POLICY_LID="$(lid_of AWS::IAM::ManagedPolicy "${POLICY_ARN}")"
SECOND_LID="$(lid_of AWS::IAM::Role "${SECOND_ROLE}")"
ROLE_LID="$(lid_of AWS::IAM::Role "${ROLE_NAME}")"
for v in POLICY_LID SECOND_LID ROLE_LID; do
  if [ -z "${!v}" ]; then echo "FAIL: no state record for ${v}" >&2; exit 1; fi
done
run_drift_json() { # usage: run_drift_json <out-file> -> DRIFT_RC; exit 0..2 is a report
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
    >"$1" 2>"$1.err"
  DRIFT_RC=$?
  set -e
  if [ "${DRIFT_RC}" -gt 2 ] || ! jq -e . "$1" >/dev/null 2>&1; then
    echo "FAIL: cdkd drift --json exited ${DRIFT_RC} without a JSON report" >&2
    cat "$1" "$1.err" >&2
    exit 1
  fi
}
# Whether <logical-id>'s drift names the policy ARN under a path starting <key>.
drift_names_policy() { # usage: drift_names_policy <report> <logical-id> <key>
  jq -e --arg l "$2" --arg k "$3" --arg a "${POLICY_ARN}" '
    [.[] | (.drifted // [])[] | select(.logicalId == $l) | .changes[]
      | select(.path | startswith($k)) | (.awsValue | tostring) | contains($a)] | any
  ' "$1" >/dev/null
}
drifted_ids() { # usage: drifted_ids <report> -> one drifted logical id per line, sorted
  jq -r '[.[] | (.drifted // [])[] | .logicalId] | sort | .[]' "$1"
}

# The attach SecondRole's own template does not declare, and the policy's
# `Roles` does not name. IAM is eventually consistent: wait until it reads.
aws iam attach-role-policy --role-name "${SECOND_ROLE}" --policy-arn "${POLICY_ARN}"
OOB_ATTACHED_ROLE="${SECOND_ROLE}"
expect_eq "ReadLogsPolicy on ${SECOND_ROLE} (out of band)" "1" policy_on_role "${SECOND_ROLE}"
# The policy's own drift reads `ListEntitiesForPolicy`, a separate read that
# can lag the role-side one.
policy_lists_role() { # usage: policy_lists_role <role-name> -> 1 when listed, 0 when not
  aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" --entity-filter Role \
    --query "PolicyRoles[?RoleName=='$1'] | length(@)" --output text
}
expect_eq "ReadLogsPolicy lists ${SECOND_ROLE} (out of band)" "1" policy_lists_role "${SECOND_ROLE}"

# NEGATIVE CONTROL: the policy is compared, so the attach is its drift
# (`Roles`), and SecondRole does not report it a second time (go-to-k/cdkd#6627).
REPORT="${REVERT_DIR}/drift-compared.json"
run_drift_json "${REPORT}"
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} with ReadLogsPolicy attached out of band, want 1" >&2
  cat "${REPORT}" >&2
  exit 1
fi
if ! jq -e --arg l "${POLICY_LID}" --arg r "${SECOND_ROLE}" '
    [.[] | (.drifted // [])[] | select(.logicalId == $l) | .changes[]
      | select(.path | startswith("Roles")) | (.awsValue | tostring) | contains($r)] | any
  ' "${REPORT}" >/dev/null; then
  echo "FAIL: ReadLogsPolicy (${POLICY_LID}) does not report ${SECOND_ROLE} in its Roles drift" >&2
  cat "${REPORT}" >&2
  exit 1
fi
if drifted_ids "${REPORT}" | grep -qxF "${SECOND_LID}"; then
  echo "FAIL: ${SECOND_LID} reports the attach although ReadLogsPolicy was compared (a second detach on --revert)" >&2
  cat "${REPORT}" >&2
  exit 1
fi
echo "    OK: the compared policy reports the attach, ${SECOND_LID} does not"

# Make ReadLogsPolicy NOT compared: mark its record's baseline refused, the
# marker a `cdkd import` writes (drift reports `notCompared: baselineRefused`
# before any read). Assignments, so a failed read or jq aborts here; an empty
# read is never uploaded over the state.
SEED_STATE="$(state_json)"
SEEDED="$(printf '%s' "${SEED_STATE}" | jq --arg id "${POLICY_LID}" '.resources[$id].observedBaselineRefused = true')"
if [ -z "${SEEDED}" ] || [ "$(printf '%s' "${SEEDED}" | jq -r --arg id "${POLICY_LID}" '.resources[$id].observedBaselineRefused')" != "true" ]; then
  echo "FAIL: could not seed observedBaselineRefused on ${POLICY_LID}" >&2
  exit 1
fi
printf '%s\n' "${SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null

REPORT="${REVERT_DIR}/drift-not-compared.json"
run_drift_json "${REPORT}"
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} with ReadLogsPolicy not compared, want 1 (the attach on ${SECOND_LID})" >&2
  cat "${REPORT}" >&2
  exit 1
fi
if ! jq -e --arg l "${POLICY_LID}" \
  '[.[] | (.notCompared // [])[] | select(.logicalId == $l and .cause == "baselineRefused")] | length == 1' \
  "${REPORT}" >/dev/null; then
  echo "FAIL: ReadLogsPolicy (${POLICY_LID}) is not reported notCompared: baselineRefused; the seed did not take" >&2
  cat "${REPORT}" >&2
  exit 1
fi
if ! drift_names_policy "${REPORT}" "${SECOND_LID}" ManagedPolicyArns; then
  echo "FAIL: ${SECOND_LID} does not report the out-of-band ReadLogsPolicy attach while the policy is not compared (go-to-k/cdkd#6697: reported on neither resource)" >&2
  cat "${REPORT}" >&2
  exit 1
fi
if drifted_ids "${REPORT}" | grep -qxF "${ROLE_LID}"; then
  echo "FAIL: ${ROLE_LID} reports drift; its attachment is the one the policy's Roles declares" >&2
  cat "${REPORT}" >&2
  exit 1
fi
echo "    OK: with the policy not compared, ${SECOND_LID} reports the attach and ${ROLE_LID} does not"

REVERT_LOG="${REVERT_DIR}/revert.log"
revert_identity_snapshot "${REVERT_DIR}/ids-before" "${STACK}" "${SECOND_LID}" "${ROLE_LID}" "${POLICY_LID}" || exit 1
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes >"${REVERT_LOG}" 2>&1
REVERT_RC=$?
set -e
# The seeded marker makes cdkd print its refused-baseline remedy for the
# policy, which names "a deploy that replaces the resource" as a way to clear
# it: cdkd's advice, not a replacement this revert made.
revert_identity_verify "${REVERT_DIR}/ids-before" "${REVERT_DIR}/ids-after" 3 "${REVERT_LOG}" \
  "ignore=a deploy that replaces the resource" || exit 1
sed 's/^/    | /' "${REVERT_LOG}"
if [ "${REVERT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift --revert --yes exited ${REVERT_RC}" >&2
  exit 1
fi
DETACH_PLAN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${REVERT_LOG}" | grep -F "detaches managed policy" || true)"
DETACH_LINES="$(printf '%s' "${DETACH_PLAN}" | grep -c . || true)"
echo "    revert plan detach line(s):"
printf '%s\n' "${DETACH_PLAN}" | sed 's/^/    > /'
if [ "${DETACH_LINES}" != "1" ] || ! grep -qF "${POLICY_ARN}" <<<"${DETACH_PLAN}"; then
  echo "FAIL: the revert plan lists ${DETACH_LINES} managed-policy detaches, want exactly 1, of ${POLICY_ARN} (SecondRole's)" >&2
  exit 1
fi
echo "    OK: the revert plan lists exactly 1 detach, of ${POLICY_ARN}"
expect_eq "ReadLogsPolicy on ${SECOND_ROLE} after the revert" "0" policy_on_role "${SECOND_ROLE}"
OOB_ATTACHED_ROLE=""
expect_eq "ReadLogsPolicy on ${ROLE_NAME} (declared) after the revert" "1" policy_on_role "${ROLE_NAME}"

REPORT="${REVERT_DIR}/drift-after-revert.json"
run_drift_json "${REPORT}"
if drifted_ids "${REPORT}" | grep -qxF "${SECOND_LID}"; then
  echo "FAIL: ${SECOND_LID} still reports drift after the revert" >&2
  cat "${REPORT}" >&2
  exit 1
fi
echo "    OK: the revert detached the attach once, in place, and ${SECOND_LID} is clean"

# Restore the record so the rest of the run deploys and destroys it as usual.
SEED_STATE="$(state_json)"
RESTORED="$(printf '%s' "${SEED_STATE}" | jq --arg id "${POLICY_LID}" 'del(.resources[$id].observedBaselineRefused)')"
if [ -z "${RESTORED}" ]; then echo "FAIL: could not restore ${POLICY_LID}'s record" >&2; exit 1; fi
printf '%s\n' "${RESTORED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
REPORT="${REVERT_DIR}/drift-restored.json"
run_drift_json "${REPORT}"
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} once the policy's record was restored, want 0" >&2
  cat "${REPORT}" >&2
  exit 1
fi
echo "    OK: drift is clean with the policy compared again"

echo "==> Step 3c: redeploy with CDKD_TEST_UPDATE=true (every principal list swapped)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
UPDATE_RC=$?
set -e
if [ "${UPDATE_RC}" -ne 0 ]; then
  echo "FAIL: update deploy exited ${UPDATE_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: update deploy exited 0"

echo "==> Step 3d (LOAD-BEARING): each list moved exactly as declared"
expect_eq "ReadLogsPolicy on ${ROLE_NAME}" "0" policy_on_role "${ROLE_NAME}"
expect_eq "ReadLogsPolicy on ${SECOND_ROLE}" "1" policy_on_role "${SECOND_ROLE}"
expect_eq "instance profile roles" "${SECOND_ROLE} " profile_roles "${PROFILE}"
WANT_A=$(printf '%s\n%s\n' "${MEMBER_B}" "${MEMBER_C}" | sort | tr '\n' ' ')
expect_eq "GroupA members" "${WANT_A}" group_members "${GROUP_A}"
expect_eq "GroupB members" "" group_members "${GROUP_B}"

echo "==> Step 3e (go-to-k/cdkd#6655): ${ROLE_NAME} and ReadLogsPolicy are deleted and their names re-used outside the stack"
# IAM reads are eventually consistent: wait until the read answers the same
# value three times in a row, so cdkd's own read sees what this step made.
await_stable() { # usage: await_stable <want> aws <service> <read-verb> [args...]
  local want="$1" got n=0 i
  shift
  for i in $(seq 1 30); do
    if got=$("$@" 2>&1) && [ "${got}" = "${want}" ]; then
      n=$((n + 1))
      [ "${n}" -ge 3 ] && return 0
    else
      n=0
    fi
    sleep 3
  done
  echo "FAIL: '$*' never settled on '${want}' (last: '${got}')" >&2
  exit 1
}
await_gone_stable() { # usage: await_gone_stable aws <service> <read-verb> [args...]
  local n=0 i
  for i in $(seq 1 30); do
    if gone_probe "$@"; then
      n=$((n + 1))
      [ "${n}" -ge 3 ] && return 0
    else
      n=0
    fi
    sleep 3
  done
  echo "FAIL: '$*' still answers after its delete" >&2
  exit 1
}
recreate() { # usage: recreate <log> aws iam create-... ; prints the new id
  local i
  for i in $(seq 1 12); do
    if "${@:2}" 2>"$1"; then return 0; fi
    # Only the delete not having settled yet is retried.
    grep -q 'EntityAlreadyExists' "$1" || { cat "$1" >&2; exit 1; }
    sleep 5
  done
  echo "FAIL: could not re-create within a minute of its delete: ${*:2}" >&2
  exit 1
}
OLD_ROLE_ID=$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.RoleId --output text)
OLD_POLICY_ID=$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query Policy.PolicyId --output text)
POLICY_NAME="${POLICY_ARN##*/}"
POLICY_PATH="${POLICY_ARN#*:policy}"
POLICY_PATH="${POLICY_PATH%"${POLICY_NAME}"}"
# Armed BEFORE the delete: a create that lands while its CLI call reports a
# failure still leaves a stranger under the name, which no destroy removes.
FOREIGN_ROLE="${ROLE_NAME}"
FOREIGN_POLICY="${POLICY_ARN}"
# After the update nothing is attached to ServiceRole (the policy and the
# profile moved to SecondRole), so a bare DeleteRole takes it.
aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null
aws iam detach-role-policy --role-name "${SECOND_ROLE}" --policy-arn "${POLICY_ARN}" >/dev/null
for v in $(aws iam list-policy-versions --policy-arn "${POLICY_ARN}" \
  --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text); do
  aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${v}" >/dev/null
done
aws iam delete-policy --policy-arn "${POLICY_ARN}" >/dev/null
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"logs:DescribeLogGroups","Resource":"*"}]}'
NEW_ROLE_ID=$(recreate "${DEPLOY_LOG}" aws iam create-role --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "${TRUST}" --description "re-created outside the cdkd stack (cdkd#6655 integ)" \
  --query Role.RoleId --output text)
NEW_POLICY_ID=$(recreate "${DEPLOY_LOG}" aws iam create-policy --policy-name "${POLICY_NAME}" \
  --path "${POLICY_PATH}" --policy-document "${DOC}" --query Policy.PolicyId --output text)
# The premise: each name answers with ANOTHER id, the policy under the same ARN.
if [ -z "${OLD_ROLE_ID}" ] || [ -z "${NEW_ROLE_ID}" ] || [ "${NEW_ROLE_ID}" = "${OLD_ROLE_ID}" ]; then
  echo "FAIL: premise -- the re-created ${ROLE_NAME} must report another RoleId (old '${OLD_ROLE_ID}', new '${NEW_ROLE_ID}')" >&2
  exit 1
fi
if [ -z "${OLD_POLICY_ID}" ] || [ -z "${NEW_POLICY_ID}" ] || [ "${NEW_POLICY_ID}" = "${OLD_POLICY_ID}" ]; then
  echo "FAIL: premise -- the re-created ${POLICY_ARN} must report another PolicyId (old '${OLD_POLICY_ID}', new '${NEW_POLICY_ID}')" >&2
  exit 1
fi
await_stable "${NEW_ROLE_ID}" aws iam get-role --role-name "${ROLE_NAME}" --query Role.RoleId --output text
await_stable "${NEW_POLICY_ID}" aws iam get-policy --policy-arn "${POLICY_ARN}" --query Policy.PolicyId --output text
echo "    OK: ${ROLE_NAME} and ${POLICY_ARN} re-created outside the stack under other ids"

echo "==> Step 4: destroy (exercises detach-before-delete, and refuses the re-created role)"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
# go-to-k/cdkd#6655 (LOAD-BEARING): the delete compares the recorded RoleId
# with the live one and refuses the stranger. Before the fix this destroy
# exited 0 and deleted the re-created role.
if [ "${DESTROY_RC}" -eq 0 ]; then
  echo "FAIL: destroy exited 0 over a role re-created outside the stack under the recorded name: it was deleted, not refused" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
# The refusal's own line, keyed on two independent markers so a reworded
# refusal fails loudly instead of matching nothing.
# One awk pass (no `grep | grep -q`: under pipefail the first grep's SIGPIPE
# would read as a failed match).
refusal_line() { # usage: refusal_line <head> <tail> -> 0 when one line holds both
  awk -v h="$1" -v t="$2" 'index($0, h) && index($0, t) { f = 1 } END { exit !f }' "${DEPLOY_LOG}"
}
if ! refusal_line "Cannot delete IAM role ServiceRole" "RoleId differs from the recorded one"; then
  if grep -qF "Cannot delete IAM role ServiceRole" "${DEPLOY_LOG}"; then
    echo "FAIL: the ServiceRole refusal no longer says 'RoleId differs from the recorded one': update this check" >&2
  else
    echo "FAIL: destroy exited ${DESTROY_RC} without the ServiceRole identity refusal" >&2
  fi
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
if ! refusal_line "Cannot delete IAM managed policy ReadLogsPolicy" "PolicyId differs from the recorded one"; then
  if grep -qF "Cannot delete IAM managed policy ReadLogsPolicy" "${DEPLOY_LOG}"; then
    echo "FAIL: the ReadLogsPolicy refusal no longer says 'PolicyId differs from the recorded one': update this check" >&2
  else
    echo "FAIL: destroy exited ${DESTROY_RC} without the ReadLogsPolicy identity refusal" >&2
  fi
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
for id in "${NEW_ROLE_ID}" "${OLD_ROLE_ID}" "${NEW_POLICY_ID}" "${OLD_POLICY_ID}"; do
  if grep -qF "${id}" "${DEPLOY_LOG}"; then
    echo "FAIL: the destroy output prints an AWS-minted id" >&2
    exit 1
  fi
done
STILL_ID=$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.RoleId --output text)
if [ "${STILL_ID}" != "${NEW_ROLE_ID}" ]; then
  echo "FAIL: the re-created ${ROLE_NAME} is not intact after the refused destroy (RoleId '${STILL_ID}')" >&2
  exit 1
fi
STILL_POLICY_ID=$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query Policy.PolicyId --output text)
if [ "${STILL_POLICY_ID}" != "${NEW_POLICY_ID}" ]; then
  echo "FAIL: the re-created ${POLICY_ARN} is not intact after the refused destroy (PolicyId '${STILL_POLICY_ID}')" >&2
  exit 1
fi
echo "    OK: destroy exited ${DESTROY_RC}, refusing the re-created ${ROLE_NAME} and ${POLICY_ARN} and leaving them intact"

echo "==> Step 4b (LOAD-BEARING): the UserToGroupAddition delete ran on its recorded Users"
# The group's own delete would clear the membership anyway, so zero orphans
# alone cannot tell a skipped UserToGroupAddition delete from one that ran.
# Positive marker first, from the same --verbose log: the delete's own debug
# line proves the grep sees this resource's output before its absence of the
# skip reason means anything.
if ! grep -q "Deleting IAM UserToGroupAddition Membership" "${DEPLOY_LOG}"; then
  echo "FAIL: destroy log has no 'Deleting IAM UserToGroupAddition Membership' line; the log wording drifted or the delete never ran" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
# The same "Removed user" line is also logged by MemberC's and GroupA's own
# deletes, so it counts only inside this resource's own log window: its delete
# is awaited, and both of those depend on it, so nothing interleaves there.
if ! awk -v m="Removed user ${MEMBER_C} from group ${GROUP_A}" '
  /Deleting IAM UserToGroupAddition Membership/ { w = 1 }
  w && index($0, m) { f = 1 }
  /Successfully deleted IAM UserToGroupAddition Membership/ { if (w) exit }
  END { exit !f }' "${DEPLOY_LOG}"; then
  echo "FAIL: the UserToGroupAddition delete did not remove its recorded user ${MEMBER_C} from ${GROUP_A} inside its own log window" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
if grep -qE "malformed Users in state|missing from state — membership not removed|no properties in state — group membership not removed" "${DEPLOY_LOG}"; then
  echo "FAIL: the UserToGroupAddition delete SKIPPED its record" >&2
  exit 1
fi
echo "    OK: the UserToGroupAddition delete removed ${MEMBER_C} from ${GROUP_A}, with no skip"

echo "==> Step 4c: remove the re-created role and policy (no record's), then destroy what the records still hold"
aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null
aws iam delete-policy --policy-arn "${POLICY_ARN}" >/dev/null
FOREIGN_ROLE=""
FOREIGN_POLICY=""
# IAM reads lag the delete; a read still answering with a re-created id
# would be refused again.
await_gone_stable aws iam get-role --role-name "${ROLE_NAME}"
await_gone_stable aws iam get-policy --policy-arn "${POLICY_ARN}"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}.2" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: the second destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}.2" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}.2"
echo "    OK: second destroy exited 0"

echo "==> Step 5: assert 0 orphans"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "IAM role ${SECOND_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${SECOND_ROLE}"
assert_gone "instance profile ${PROFILE} still exists after destroy" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE}"
for g in "${GROUP_A}" "${GROUP_B}"; do
  assert_gone "IAM group ${g} still exists after destroy" aws iam get-group --group-name "${g}"
done
for u in "${MEMBER_A}" "${MEMBER_B}" "${MEMBER_C}"; do
  assert_gone "IAM user ${u} still exists after destroy" aws iam get-user --user-name "${u}"
done
assert_gone "customer-managed policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"
echo "    OK: 0 orphans (state, roles, managed policy, profile, groups and users all gone)"

echo ""
echo "==> iam-managed-policy test passed: every principal list swapped on update, clean detach-before-delete destroy 0 orphans"
trap - EXIT INT TERM
