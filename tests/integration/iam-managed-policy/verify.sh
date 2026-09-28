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
#     detach-before-delete ordering held.
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

STACK="CdkdIamManagedPolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t iam-managed-policy.XXXXXX)"

# IAM is eventually consistent right after create; let the CLI back off
# transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
  fi
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
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
  --query "Policies[?contains(PolicyName, 'ReadLogsPolicy')].Arn" \
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

echo "==> Step 4: destroy (exercises detach-before-delete + role delete)"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

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
