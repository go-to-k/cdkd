#!/usr/bin/env bash
#
# End-to-end real-AWS test for issue #6081: the FIRST deploy of a Step
# Functions `.sync` (RUN_JOB) integration in an account and region, where the
# integration's EventBridge managed rule does not exist yet. CreateStateMachine
# then checks that the role may create the rule, and the grant cdkd created
# ~0.2s earlier has not propagated: AWS answers "is not authorized to create
# managed-rule" for ~10s. Before the fix cdkd failed and rolled back.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. delete the Batch `.sync` managed rule so the deploy is a FIRST deploy
#      (no other fixture uses Batch `.sync`; Step Functions re-creates the
#      rule on demand)
#   3. cdkd deploy --verbose; report whether the managed-rule window was hit
#   4. assert the state machine exists on AWS
#   5. cdkd destroy --force; assert the state machine, its role and the cdkd
#      state are gone
#   6. delete the managed rule the deploy created, restoring step 2's state
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdStepfunctionsSyncManagedRuleExample"
MANAGED_RULE="StepFunctionsGetEventsForBatchJobsRule"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/stepfunctions-sync-managed-rule"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

DEPLOY_LOG="$(mktemp -t cdkd-sfn-sync-deploy.XXXXXX.log)"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

# Removes the Batch `.sync` managed rule (its targets first). Best-effort: a
# rule that is already absent is the goal state.
delete_managed_rule() { (
  set +eu
  local ids
  ids="$(aws events list-targets-by-rule --rule "${MANAGED_RULE}" --region "${REGION}" \
    --query 'Targets[].Id' --output text 2>/dev/null)"
  if [ -n "${ids}" ] && [ "${ids}" != "None" ]; then
    # shellcheck disable=SC2086 # one argument per target id
    aws events remove-targets --rule "${MANAGED_RULE}" --ids ${ids} --force --region "${REGION}" > /dev/null
  fi
  aws events delete-rule --name "${MANAGED_RULE}" --force --region "${REGION}" 2>/dev/null
  return 0
) }

cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  delete_managed_rule
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: delete ${MANAGED_RULE} so this is the integration's first deploy"
delete_managed_rule
assert_gone "managed rule ${MANAGED_RULE} still exists before the deploy" \
  aws events describe-rule --name "${MANAGED_RULE}" --region "${REGION}"
echo "[verify]   ✓ ${MANAGED_RULE} absent"

echo "[verify] step 3: cdkd deploy ${STACK}"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${DEPLOY_LOG}"
# The window is IAM propagation, so a run can miss it; report which happened.
if grep -F "is not authorized to create managed-rule" "${DEPLOY_LOG}" > /dev/null; then
  echo "[verify]   ✓ CreateStateMachine hit the managed-rule window and cdkd retried through it (#6081 path)"
else
  echo "[verify]   NOTE: the managed-rule window did not open on this run -- the #6081 path was not exercised"
fi

echo "[verify] step 4: assert the state machine exists on AWS"
SM_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.SyncMachine80C63FAF.physicalId')"
if [ -z "${SM_ARN}" ] || [ "${SM_ARN}" = "null" ]; then
  echo "[verify] FAIL: no SyncMachine80C63FAF record in cdkd state"
  exit 1
fi
aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" --region "${REGION}" \
  --query 'status' --output text
ROLE_ARN="$(aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" --region "${REGION}" \
  --query 'roleArn' --output text)"
ROLE_NAME="${ROLE_ARN##*/}"
echo "[verify]   ✓ state machine ${SM_ARN} (role ${ROLE_NAME})"

echo "[verify] step 5: cdkd destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
# DeleteStateMachine is asynchronous: describe answers status DELETING for a
# while before StateMachineDoesNotExist.
for _ in $(seq 1 30); do
  if gone_probe aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" --region "${REGION}"; then
    break
  fi
  sleep 3
done
assert_gone "state machine ${SM_ARN} still exists 90s after destroy" \
  aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists post-destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "[verify]   ✓ state machine, role and state removed"

echo "[verify] PASS"
