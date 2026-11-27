#!/usr/bin/env bash
# verify.sh -- deleting an AWS::IAM::ManagedPolicy detaches only the principals
# it declares, and refuses over one attached outside the stack (issue #7117).
#
# cdkd detached the policy from every principal ListEntitiesForPolicy returned,
# so a role another stack or an operator attached it to silently lost its
# permissions. CloudFormation detaches only the declared Roles / Users / Groups
# and fails the delete with "Cannot delete a policy attached to entities"
# (measured on a CloudFormation A/B stack, hunt r205112880).
# Phases:
#   1. deploy v1 (Declared with Roles: [Role], Removed with no principals,
#      RoleSide attached through Role's ManagedPolicyArns); attach Declared and
#      Removed to a role outside the stack;
#   2. deploy `removed` (Removed and RoleSide dropped): the deploy exits 2 (a
#      kept removal delete) naming the outside role; Removed still exists,
#      still attached there, and its record is kept; RoleSide is deleted (the
#      role's own update let go of it);
#   3. detach Removed from the outside role and redeploy: Removed is deleted;
#   4. destroy: refused over Declared's outside attachment (Declared and its
#      record kept, and Role, which it references, with it, as CloudFormation
#      leaves them); detach it, destroy again: nothing of the stack left, the
#      outside role untouched.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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

STACK="CdkdIamManagedPolicyOutsidePrincipalExample"
REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
OUTSIDE_ROLE="CdkdIamMpOutsidePrincipal-outside"
unset CDKD_TEST_UPDATE

# Local policies whose name starts with the stack name, one ARN per line.
stack_policies() {
  aws iam list-policies --scope Local \
    --query "Policies[?starts_with(PolicyName, '${STACK}')].Arn" --output text | tr '\t' '\n' | awk 'NF'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -n "${CLEANUP_FILES:-}" ] && rm -f "${CLEANUP_FILES}"
  for arn in $(aws iam list-attached-role-policies --role-name "${OUTSIDE_ROLE}" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${OUTSIDE_ROLE}" --policy-arn "${arn}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${OUTSIDE_ROLE}" >/dev/null 2>&1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdIamManagedPolicyOutsidePrincipal?*)
      for arn in $(stack_policies 2>/dev/null); do
        for r in $(aws iam list-entities-for-policy --policy-arn "${arn}" --query 'PolicyRoles[].RoleName' --output text 2>/dev/null); do
          aws iam detach-role-policy --role-name "${r}" --policy-arn "${arn}" >/dev/null 2>&1
        done
        aws iam delete-policy --policy-arn "${arn}" >/dev/null 2>&1
      done ;;
    *) echo "WARN: teardown sweep refused: unexpected stack name '${STACK}'" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
# The outside role's attached policy ARNs, sorted, space-separated.
outside_attached() {
  local out
  out="$(aws iam list-attached-role-policies --role-name "${OUTSIDE_ROLE}" \
    --query 'AttachedPolicies[].PolicyArn' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | awk 'NF' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
}
policy_exists() { # usage: policy_exists <arn> -- 0 when it exists
  ! gone_probe aws iam get-policy --policy-arn "$1"
}
DEPLOY_LOG="$(mktemp)"
CLEANUP_FILES="${DEPLOY_LOG}"
plain() { sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}"; }

echo "==> Phase 1: deploy v1, then attach two of its policies outside the stack"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
for lid in Declared Removed RoleSide; do
  [ "$(state_field "[.resources | to_entries[] | select(.key | startswith(\"${lid}\"))][0].value.provisionedBy // \"sdk\"")" != "cc-api" ] || {
    echo "FAIL: phase 1 premise: ${lid} was created on Cloud Control" >&2; exit 1; }
done
arn_of() { state_field "[.resources | to_entries[] | select(.key | startswith(\"$1\")) | select(.value.resourceType == \"AWS::IAM::ManagedPolicy\")][0].value.physicalId // \"\""; }
DECLARED="$(arn_of Declared)"; REMOVED="$(arn_of Removed)"; ROLESIDE="$(arn_of RoleSide)"
for a in "${DECLARED}" "${REMOVED}" "${ROLESIDE}"; do
  case "${a}" in arn:aws*:iam::*:policy/?*) ;; *) echo "FAIL: phase 1: a policy recorded '${a}'" >&2; exit 1 ;; esac
done
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws iam create-role --role-name "${OUTSIDE_ROLE}" \
  --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${ACCOUNT}:root\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
aws iam attach-role-policy --role-name "${OUTSIDE_ROLE}" --policy-arn "${DECLARED}"
aws iam attach-role-policy --role-name "${OUTSIDE_ROLE}" --policy-arn "${REMOVED}"
echo "    OK: ${OUTSIDE_ROLE} holds Declared and Removed"

echo "==> Phase 2: removing Removed and RoleSide refuses over the outside role"
export CDKD_TEST_UPDATE=removed
set +e
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
rc=${PIPESTATUS[0]}
set -e
[ "${rc}" != "0" ] || { echo "FAIL: phase 2: the deploy succeeded although Removed is attached outside the stack (go-to-k/cdkd#7117)" >&2; exit 1; }
# A refused template-removal delete is kept, not rolled back (go-to-k/cdkd#6969): exit 2.
[ "${rc}" = "2" ] || { echo "FAIL: phase 2: the deploy exited ${rc}, expected 2 (a kept removal delete)" >&2; exit 1; }
# Sentinel: the refusal's own line, and the role it names on it.
plain | grep -q "which the stack does not declare as its principals" || {
  echo "FAIL: phase 2: the deploy failed without the #7117 refusal (if cdkd reworded it, update this check)" >&2; exit 1; }
plain | grep "which the stack does not declare as its principals" | grep -q "role ${OUTSIDE_ROLE}" || {
  echo "FAIL: phase 2: the refusal does not name role ${OUTSIDE_ROLE}" >&2; exit 1; }
policy_exists "${REMOVED}" || { echo "FAIL: phase 2: Removed was deleted" >&2; exit 1; }
[ "$(outside_attached)" = "$(printf '%s\n' "${DECLARED}" "${REMOVED}" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')" ] || {
  echo "FAIL: phase 2: ${OUTSIDE_ROLE} no longer holds both policies: '$(outside_attached)' (go-to-k/cdkd#7117)" >&2; exit 1; }
[ "$(arn_of Removed)" = "${REMOVED}" ] || { echo "FAIL: phase 2: Removed's record was dropped" >&2; exit 1; }
assert_gone "phase 2: RoleSide (attached from the role's side) was not deleted" \
  aws iam get-policy --policy-arn "${ROLESIDE}"
echo "    OK: refused naming ${OUTSIDE_ROLE}; Removed kept and attached; RoleSide deleted"

echo "==> Phase 3: detach Removed outside the stack, then redeploy"
aws iam detach-role-policy --role-name "${OUTSIDE_ROLE}" --policy-arn "${REMOVED}"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "phase 3: Removed still exists" aws iam get-policy --policy-arn "${REMOVED}"
[ -z "$(arn_of Removed)" ] || { echo "FAIL: phase 3: Removed's record is still in state" >&2; exit 1; }
echo "    OK: Removed deleted"

echo "==> Phase 4: destroy refuses over Declared's outside attachment, then succeeds"
ROLE_NAME="$(state_field '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role")][0].value.physicalId // ""')"
[ -n "${ROLE_NAME}" ] || { echo "FAIL: phase 4 premise: no role recorded" >&2; exit 1; }
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${DEPLOY_LOG}"
rc=${PIPESTATUS[0]}
set -e
[ "${rc}" != "0" ] || { echo "FAIL: phase 4: destroy succeeded although Declared is attached outside the stack" >&2; exit 1; }
plain | grep "which the stack does not declare as its principals" | grep -q "role ${OUTSIDE_ROLE}" || {
  echo "FAIL: phase 4: destroy failed without the #7117 refusal naming ${OUTSIDE_ROLE}" >&2; exit 1; }
policy_exists "${DECLARED}" || { echo "FAIL: phase 4: Declared was deleted" >&2; exit 1; }
[ "$(outside_attached)" = "${DECLARED}" ] || {
  echo "FAIL: phase 4: ${OUTSIDE_ROLE} no longer holds Declared: '$(outside_attached)'" >&2; exit 1; }
[ "$(arn_of Declared)" = "${DECLARED}" ] || { echo "FAIL: phase 4: Declared's record was dropped" >&2; exit 1; }
aws iam detach-role-policy --role-name "${OUTSIDE_ROLE}" --policy-arn "${DECLARED}"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "Declared still exists after destroy" aws iam get-policy --policy-arn "${DECLARED}"
assert_gone "the stack's role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws iam get-role --role-name "${OUTSIDE_ROLE}" >/dev/null || { echo "FAIL: the outside role is gone" >&2; exit 1; }
echo "    OK: nothing of the stack left; ${OUTSIDE_ROLE} untouched"

echo ""
echo "[verify] PASS — a managed policy's delete detaches only its declared principals and refuses over one outside the stack"
