#!/usr/bin/env bash
# verify.sh — cdkd Step Functions Express + LoggingConfiguration integ.
#
# Regression coverage for the TWO IAM-propagation races a fresh state machine
# with logging can hit: the states.amazonaws.com assume-role race ("Neither the
# global service principal states.amazonaws.com, nor the regional one is
# authorized to assume the provided role.") and the log-destination race of
# issue #2783 ("The state machine IAM Role is not authorized to access the Log
# Destination"). cdkd's fast SDK path issues CreateStateMachine ~1s after the
# role and its DefaultPolicy CREATE, so the windows are open; neither phrasing
# was matched by any retryable-error pattern, so the whole deploy hard-failed
# and rolled back. CloudFormation tolerates both via its deployment latency;
# cdkd retries them on the dense cadence (src/deployment/retryable-errors.ts).
#
# Which race you get depends on the AGE GAP between the trust policy and the
# grants, and window 1 MASKS window 2 (SFN checks assume-role first). Phase 0
# exists to make window 2 deterministic — it deploys the role alone and lets it
# settle, so the Phase 1 create races the log-delivery grants only. Phase 1a
# then ASSERTS the retry happened, because a run that never reaches window 2
# would pass identically with the #2783 fix reverted.
#
# Also the integ coverage for SFN LoggingConfiguration + TracingConfiguration
# removal-clear on UPDATE (issue #978): UpdateStateMachine is patch-style, so a
# config removed from the template is silently kept unless cdkd sends the
# explicit disable sentinel. Phase 2 removes BOTH logging and tracing and
# asserts AWS actually cleared them.
#
# Phases:
#   0. Deploy the LogGroup + execution Role ALONE, then sleep so the trust
#      policy propagates ahead of the log-delivery grants.
#   1. Deploy an Express state machine with logging level ALL + tracing
#      ENABLED. Assert AWS reports both, then start-sync-execution succeeds.
#   1a. Assert cdkd RETRIED the log-destination rejection (needle + sentinel).
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
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Phase 1's captured deploy log, removed here rather than under a second
  # EXIT trap: bash traps do NOT chain, so a `trap ... EXIT` for this would
  # silently DISARM the AWS teardown above. Empty before Phase 1 assigns it.
  rm -f "${DEPLOY_LOG:-}"
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

# --- Phase 0: role alone, so its trust policy settles first ------------
# Without this the two races are indistinguishable: SFN checks assume-role
# FIRST, so a role and its grants created together let window 1 absorb the
# whole wait and window 2 never fires (measured us-east-1 2026-09-08). Deploying
# the role by itself and letting it settle leaves the log-destination race as
# the only window still open on the Phase 1 create.
echo "==> Phase 0: deploy the execution role + log group ALONE"
CDKD_TEST_STAGE=role-only node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TRUST_SETTLE_S="${TRUST_SETTLE_S:-20}"
echo "    letting the trust policy propagate (${TRUST_SETTLE_S}s)"
sleep "${TRUST_SETTLE_S}"

# A focused digest of the retry evidence, printed at the failure point. The
# deploy output is tee'd to stdout as well, so this does not RECOVER anything
# lost -- it pulls the handful of lines that decide the diagnosis out of a
# multi-hundred-line --verbose log, right next to the FAIL message explaining
# them.
dump_retry_evidence() {
  echo "      --- last propagation-retry lines seen (may be empty) ---" >&2
  grep -E 'Retrying|attempt [0-9]+/' "${DEPLOY_LOG:-/dev/null}" | tail -5 >&2 || true
  echo "      --- last AccessDenied / authorization lines seen ---" >&2
  grep -iE 'accessdenied|not authorized' "${DEPLOY_LOG:-/dev/null}" | tail -5 >&2 || true
}

# --- Phase 1: deploy baseline (logging level ALL + tracing enabled) ----
echo "==> Phase 1: deploy Express state machine with logging level ALL + tracing enabled"
# --verbose so the per-attempt propagation-retry lines reach the log; the
# assertion below reads them. A SUCCESSFUL retry prints nothing at the default
# level, so without --verbose there is no observable to assert on.
DEPLOY_LOG="$(mktemp)"
# `set +e` around the pipeline is what makes the rc check below REACHABLE:
# under `set -euo pipefail` a failing deploy aborts the script at the pipeline
# itself, so the check would be dead code and its message could never print.
# CDKD_TEST_STAGE is unset too -- an ambiently exported `role-only` would make
# this phase redeploy the Phase 0 subset and mis-report at 1a.
set +e
env -u CDKD_TEST_UPDATE -u CDKD_TEST_STAGE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1 |
  tee "${DEPLOY_LOG}"
# The CLI's status, not tee's -- but capture tee's too: inside the `set +e`
# window a failed `tee` no longer aborts the run, and an unwritten log would
# surface later as Phase 1a's misleading "no propagation retry at all".
#
# Snapshot the WHOLE array in ONE command. Reading `${PIPESTATUS[0]}` into a
# variable is itself a command, which RESETS PIPESTATUS -- so a second read of
# `${PIPESTATUS[1]}` is an unbound variable and `set -u` aborts Phase 1 with a
# cryptic error on every run (measured on bash 3.2, the macOS /bin/bash).
PHASE1_RCS=("${PIPESTATUS[@]}")
DEPLOY_RC="${PHASE1_RCS[0]}"
TEE_RC="${PHASE1_RCS[1]}"
set -e
if [ "${DEPLOY_RC}" != "0" ]; then
  # THIS is the arm a #2783 regression trips: with the pattern removed the
  # create is terminal, the deploy hard-fails here, and Phase 1a is never
  # reached -- so the evidence has to be dumped from this arm too.
  echo "FAIL: Phase 1 deploy exited ${DEPLOY_RC}" >&2
  dump_retry_evidence
  exit "${DEPLOY_RC}"
fi
if [ "${TEE_RC}" != "0" ]; then
  echo "FAIL: could not capture the Phase 1 deploy log (tee exited ${TEE_RC});" >&2
  echo "      the assertion below would read an empty log and blame the retry." >&2
  exit 1
fi

# --- Phase 1a: assert the log-destination race was RETRIED (issue #2783) ---
# The needle is AWS's own sentence; the SENTINEL is cdkd's propagation-retry
# line, which is present whenever ANY propagation retry happened. Checking both
# distinguishes "the race did not occur" from "the retry line was reworded and
# this grep went blind" — a bare needle grep returning 0 cannot tell them apart
# (.claude/rules/testing.md, "a fixture that greps cdkd's OWN output").
echo "==> Phase 1a: assert the log-destination propagation race was retried (#2783)"
LOG_DEST_HITS="$(grep -c 'not authorized to access the Log Destination' "${DEPLOY_LOG}" || true)"
PROPAGATION_HITS="$(grep -cE 'attempt [0-9]+/26' "${DEPLOY_LOG}" || true)"
echo "    log-destination retries: ${LOG_DEST_HITS}; propagation-retry lines: ${PROPAGATION_HITS}"
if [ "${LOG_DEST_HITS}" -gt 0 ]; then
  echo "    OK: cdkd retried the log-destination rejection and the deploy still succeeded"
elif [ "${PROPAGATION_HITS}" -gt 0 ]; then
  echo "FAIL: propagation retries fired but none carried the log-destination phrase." >&2
  echo "      Either AWS reworded the message (update the pattern in" >&2
  echo "      src/deployment/retryable-errors.ts and this grep), or window 1 is" >&2
  echo "      still open despite the Phase 0 settle (raise TRUST_SETTLE_S)." >&2
  dump_retry_evidence
  exit 1
else
  echo "FAIL: no propagation retry at all -- the deploy never raced IAM, so this run" >&2
  echo "      proves nothing about issue #2783. Either the retry debug line moved off" >&2
  echo "      --verbose (it is logger.debug, so --verbose is required), or IAM now" >&2
  echo "      propagates the log-delivery grants inside the ~1s cdkd leaves between" >&2
  echo "      the DefaultPolicy CREATE and CreateStateMachine. Raising TRUST_SETTLE_S" >&2
  echo "      does NOT help that second case -- it widens the TRUST-policy gap only." >&2
  dump_retry_evidence
  exit 1
fi
rm -f "${DEPLOY_LOG}"

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
# CDKD_TEST_STAGE unset for the same reason Phase 1 unsets it: an ambiently
# exported `role-only` would drop the state machine from this template, so the
# removal-clear assertions below would probe a resource that had just been
# DELETED. (Phase 0 is immune -- its early return precedes the update gate.)
env -u CDKD_TEST_STAGE CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
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

echo "[verify] PASS — SFN Express + Logging/Tracing deploy (log-destination propagation retry, #2783), removal-clear update (#978), destroy: all phases passed"
