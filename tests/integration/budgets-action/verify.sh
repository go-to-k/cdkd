#!/usr/bin/env bash
# verify.sh — AWS::Budgets::BudgetsAction created right after its same-stack
# execution role (issue #6845).
#
# Budgets validates at create time that it can assume the action's
# ExecutionRoleArn, and refuses a role IAM has not propagated yet with
# "Budgets permission required to assume [ExecutionRole: ...]". cdkd used to
# fail on that first answer; the rollback then deleted the role, so every
# re-run met the race again. Now it is retried on the IAM-propagation cadence.
#
# Phases:
#   1. Deploy budget + target role + managed policy + execution role + action
#      on a fresh stack. Assert the deploy exits 0 and the action exists on the
#      budget with the deployed execution role. Report whether the race was
#      hit (the retry line) -- informational: IAM sometimes propagates first.
#   2. Destroy; assert the budget, both roles and the state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdBudgetsActionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUDGET_NAME="cdkd-budgets-action-integ-budget"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DEPLOY_LOG=""

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  rm -f "${DEPLOY_LOG:-}"
  # Deleting the budget deletes its actions.
  aws budgets delete-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy on a fresh stack -------------------------------------
echo "==> Phase 1: deploy the budget action seconds after its fresh execution role"
DEPLOY_LOG="$(mktemp)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  tail -40 "${DEPLOY_LOG}"
  if grep -qF 'Budgets permission required to assume' "${DEPLOY_LOG}"; then
    echo "FAIL: the budget action's create was refused on IAM propagation and not waited out (go-to-k/cdkd#6845)" >&2
  else
    echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  fi
  exit 1
fi
echo "    deploy exited 0"

# Informational: whether this run met the race. `Retrying <id>` is withRetry's
# own per-attempt line (src/deployment/retry.ts).
if grep -qF 'Retrying BudgetStopAction' "${DEPLOY_LOG}"; then
  echo "    race hit: BudgetStopAction was retried while IAM propagated, then created"
else
  echo "    race not hit this run: IAM propagated before the action's first create"
fi

EXECUTION_ROLE_ARN="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const o=j.state.outputs||{};process.stdout.write(String(o.ExecutionRoleArn||""))})')"
case "${EXECUTION_ROLE_ARN}" in
  arn:aws:iam::*:role/?*) ;;
  *) echo "FAIL: expected the ExecutionRoleArn output in state, got '${EXECUTION_ROLE_ARN}'" >&2; exit 1 ;;
esac

ACTION_ROLES="$(aws budgets describe-budget-actions-for-budget \
  --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}" \
  --query 'Actions[].ExecutionRoleArn' --output json | tr -d ' \n')"
if [ "${ACTION_ROLES}" != "[\"${EXECUTION_ROLE_ARN}\"]" ]; then
  echo "FAIL: expected exactly one action on ${BUDGET_NAME} with ExecutionRoleArn ${EXECUTION_ROLE_ARN}, got ${ACTION_ROLES}" >&2
  exit 1
fi
echo "    budget action exists with the deployed execution role"

EXECUTION_ROLE_NAME="${EXECUTION_ROLE_ARN##*/}"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "budget ${BUDGET_NAME} still exists after destroy" aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}"
echo "    budget (and its action) deleted from AWS"

assert_gone "execution role ${EXECUTION_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${EXECUTION_ROLE_NAME}"
echo "    execution role deleted from AWS"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed"

trap - EXIT INT TERM
echo "[verify] PASS — AWS::Budgets::BudgetsAction created right after its fresh execution role, then destroyed"
