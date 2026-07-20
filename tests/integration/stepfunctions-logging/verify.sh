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
# Also the integ coverage for SFN LoggingConfiguration + TracingConfiguration
# removal-clear on UPDATE (issue #978): UpdateStateMachine is patch-style, so a
# config removed from the template is silently kept unless cdkd sends the
# explicit disable sentinel. Phase 2 removes BOTH logging and tracing and
# asserts AWS actually cleared them.
#
# Phases:
#   1. Deploy an Express state machine with logging level ALL + tracing
#      ENABLED. Assert AWS reports both, then start-sync-execution succeeds.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (logging + tracing REMOVED from the
#      template). Assert AWS now reports logging level OFF and tracing disabled
#      (the removal actually reached AWS, not just cdkd state).
#   3. Destroy + assert the state machine is gone and cdkd state is removed.
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
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

sm_arn() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["StateMachineArn"])'
}

logging_level() {
  aws stepfunctions describe-state-machine --state-machine-arn "$1" --region "${REGION}" \
    --query 'loggingConfiguration.level' --output text
}

# JMESPath length() is wrapped as length(X || `[]`) so an empty/absent
# destinations list yields 0 instead of a non-zero AWS CLI exit that would
# abort under `set -e` (see feedback_integ_jmespath_length_null_set_e_abort).
logging_destinations_count() {
  aws stepfunctions describe-state-machine --state-machine-arn "$1" --region "${REGION}" \
    --query 'length(loggingConfiguration.destinations || `[]`)' --output text
}

tracing_enabled() {
  aws stepfunctions describe-state-machine --state-machine-arn "$1" --region "${REGION}" \
    --query 'tracingConfiguration.enabled' --output text
}

# --- Phase 1: deploy baseline (logging level ALL + tracing enabled) ----
echo "==> Phase 1: deploy Express state machine with logging level ALL + tracing enabled"
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

TRACING_P1="$(tracing_enabled "${SM_ARN}")"
echo "    AWS tracing enabled (Phase 1): ${TRACING_P1}"
if [ "${TRACING_P1}" != "True" ]; then
  echo "FAIL: expected tracing enabled=True after Phase 1, got '${TRACING_P1}'" >&2
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

# --- Phase 2: remove logging + tracing (must reach AWS) ----------------
echo "==> Phase 2: re-deploy with logging + tracing REMOVED (issue #978 removal-clear)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LEVEL_P2="$(logging_level "${SM_ARN}")"
echo "    AWS logging level (Phase 2): ${LEVEL_P2}"
if [ "${LEVEL_P2}" != "OFF" ]; then
  echo "FAIL: expected logging level OFF after Phase 2 (removal silently dropped?), got '${LEVEL_P2}'" >&2
  exit 1
fi

DEST_P2="$(logging_destinations_count "${SM_ARN}")"
echo "    AWS logging destinations (Phase 2): ${DEST_P2}"
if [ "${DEST_P2}" != "0" ]; then
  echo "FAIL: expected 0 logging destinations after Phase 2, got '${DEST_P2}'" >&2
  exit 1
fi

TRACING_P2="$(tracing_enabled "${SM_ARN}")"
echo "    AWS tracing enabled (Phase 2): ${TRACING_P2}"
if [ "${TRACING_P2}" != "False" ]; then
  echo "FAIL: expected tracing enabled=False after Phase 2 (removal silently dropped?), got '${TRACING_P2}'" >&2
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

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — SFN Express + Logging/Tracing deploy (assume-role retry), removal-clear update (#978), destroy: all 3 phases passed"
