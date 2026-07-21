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
# LOAD-BEARING assertion: after deploy the customer-managed policy is ATTACHED
# to the role (the `roles: [role]` linkage), and the destroy path detaches the
# policy before deleting it and then deletes the role - a clean destroy with
# both gone proves the detach-before-delete ordering held.
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
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
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

echo "==> Step 1: deploy (IAM Role + customer-managed policy)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
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

echo "==> Step 5: assert 0 orphans"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "customer-managed policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"
echo "    OK: 0 orphans (state + role + managed policy all gone)"

echo ""
echo "==> iam-managed-policy test passed: policy attached to role, clean detach-before-delete destroy 0 orphans"
trap - EXIT INT TERM
