#!/usr/bin/env bash
# verify.sh — cdkd Step Functions Express + LoggingConfiguration integ.
#
# Regression coverage for the states.amazonaws.com assume-role IAM-propagation
# race: cdkd's fast SDK path issues CreateStateMachine ~1s after the state
# machine role's CREATE, before IAM finishes propagating the trust policy, so
# AWS rejects it with "Neither the global service principal
# states.amazonaws.com, nor the regional one is authorized to assume the
# provided role." — a phrasing no retryable-error pattern matched, so the whole
# deploy hard-failed and rolled back. CloudFormation tolerates this via its
# deployment latency; cdkd retries (src/deployment/retryable-errors.ts).
#
# Also the first integ coverage for SFN LoggingConfiguration (CREATE + in-place
# UPDATE of the log level).
#
# Phases:
#   1. Deploy an Express state machine with logging level ALL. Assert AWS
#      reports the logging configuration, then start-sync-execution succeeds.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (level ERROR). Assert AWS now
#      reports ERROR (the update actually reached AWS, not just cdkd state).
#   3. Destroy + assert the state machine is gone and cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdStepfunctionsLoggingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

sm_arn() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["StateMachineArn"])'
}

logging_level() {
  aws stepfunctions describe-state-machine --state-machine-arn "$1" --region "${REGION}" \
    --query 'loggingConfiguration.level' --output text
}

# --- Phase 1: deploy baseline (logging level ALL) ----------------------
echo "==> Phase 1: deploy Express state machine with logging level ALL"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SM_ARN="$(sm_arn)"
echo "    state machine: ${SM_ARN}"

LEVEL_P1="$(logging_level "${SM_ARN}")"
echo "    AWS logging level (Phase 1): ${LEVEL_P1}"
if [ "${LEVEL_P1}" != "ALL" ]; then
  echo "FAIL: expected logging level ALL after Phase 1, got '${LEVEL_P1}'" >&2
  exit 1
fi

echo "==> Phase 1b: functional check (start-sync-execution)"
EXEC_STATUS="$(aws stepfunctions start-sync-execution --state-machine-arn "${SM_ARN}" \
  --input '{}' --region "${REGION}" --query 'status' --output text)"
echo "    execution status: ${EXEC_STATUS}"
if [ "${EXEC_STATUS}" != "SUCCEEDED" ]; then
  echo "FAIL: expected SUCCEEDED sync execution, got '${EXEC_STATUS}'" >&2
  exit 1
fi

# --- Phase 2: switch logging level to ERROR (must reach AWS) ------------
echo "==> Phase 2: re-deploy with logging level ERROR (in-place UpdateStateMachine)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LEVEL_P2="$(logging_level "${SM_ARN}")"
echo "    AWS logging level (Phase 2): ${LEVEL_P2}"
if [ "${LEVEL_P2}" != "ERROR" ]; then
  echo "FAIL: expected logging level ERROR after Phase 2 (update silently dropped?), got '${LEVEL_P2}'" >&2
  exit 1
fi

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# SFN DeleteStateMachine is ASYNC: accept DELETING and poll until gone.
sm_gone=""
for attempt in $(seq 1 15); do
  STATUS="$(aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" \
    --region "${REGION}" --query 'status' --output text 2>&1 || true)"
  if echo "${STATUS}" | grep -q "StateMachineDoesNotExist"; then
    sm_gone="yes"
    break
  fi
  # Anything other than DELETING / gone is most likely a transient describe
  # error (throttle, network) — keep polling instead of hard-failing after a
  # clean destroy; the 15-attempt bound terminates the loop either way.
  if [ "${STATUS}" != "DELETING" ]; then
    echo "    describe returned unexpected output (attempt ${attempt}/15): ${STATUS}"
  else
    echo "    state machine still DELETING (attempt ${attempt}/15), waiting..."
  fi
  sleep 4
done
if [ -z "${sm_gone}" ]; then
  echo "FAIL: state machine ${SM_ARN} did not finish deleting within ~60s" >&2
  exit 1
fi
echo "    state machine deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — SFN Express + LoggingConfiguration deploy (assume-role retry), level update, destroy: all 3 phases passed"
