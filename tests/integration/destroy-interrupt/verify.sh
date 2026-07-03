#!/usr/bin/env bash
# verify.sh - cdkd destroy-interrupt integ.
#
# Exercises TWO behaviors that previously had ZERO integ coverage:
#
#   #816 graceful SIGINT on destroy:
#       A first Ctrl-C mid-destroy must STOP scheduling new deletes, let
#       in-flight provider.delete calls finish, flush the (trimmed)
#       incremental state, RELEASE the stack lock, and exit non-zero.
#       Pre-fix the process died mid-destroy: the lock was stranded for
#       its 30-minute TTL and the finally cleanup never ran.
#
#   #804 Custom-Resource replay fail-fast:
#       On a re-run after a first interrupted/partial destroy, replaying
#       the Custom Resource delete used to stall ~10 minutes invoking
#       GetFunction against the backing Lambda that the first run already
#       deleted. The fail-fast + incremental destroy persistence make the
#       re-run resume cleanly and quickly.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
#
# Portability: BSD/macOS-safe (no `grep -P`, no `date -d`). Real exit
# codes are captured to variables (never trusted through a `tee | tail`
# pipe). Each PASS assertion prints an explicit "OK:" line and the script
# prints a single "[verify] PASS" only at the very end.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDestroyInterruptExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# --- helpers ----------------------------------------------------------

# Drop a hard cdkd destroy + leftover state/lock objects. Used both as the
# EXIT trap (aggressive cleanup on failure) and as pre-run hygiene.
cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

state_exists() {
  aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
}

lock_exists() {
  aws s3 ls "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1
}

# Bounded poll: returns 0 (released) once the lock object is GONE, or 1
# if it is still present after the budget. Lock release is the final
# step of the destroy's `finally` (an async S3 DeleteObject) that may
# settle slightly after the node process exits, so a single immediate
# check can race the delete. Only call this AFTER `wait` has confirmed
# the node process fully exited — while the process is alive the lock is
# LEGITIMATELY held (it is released in the finally, not mid-drain).
wait_for_lock_release() {
  local tries=0
  while [ "${tries}" -lt 10 ]; do
    if ! lock_exists; then
      return 0
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  return 1
}

# --- preconditions ----------------------------------------------------

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy (clean) ------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! state_exists; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: deploy created state file"

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
VPC_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first')
# The CR handler's execution role + the Lambda SecurityGroup are auto-named,
# so capture their concrete physical ids from the deployed state NOW. The SG
# is implicitly covered by the VPC-gone assert (a lingering SG keeps an ENI
# which keeps the VPC alive), but we assert it EXPLICITLY too — and the IAM
# role is NOT VPC-bound, so it could orphan independently of the VPC. A
# state-empty check alone would miss an orphaned role that carries no stack
# name. We assert each exact id is NOT-FOUND post-destroy.
ROLE_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .value.physicalId] | first')
SG_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | first')
# SSM parameters are CDK/cdkd auto-named (no explicit Name), so capture
# their concrete physical ids from the deployed state NOW — a name-prefix
# scan after destroy is unreliable (the auto-name need not contain the
# stack name). We assert each of these exact names is gone post-destroy.
PARAM_NAMES=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SSM::Parameter") | .value.physicalId')
echo "    resolved backing Lambda: ${FN_NAME}"
echo "    resolved VPC: ${VPC_ID}"
echo "    resolved IAM role: ${ROLE_NAME}"
echo "    resolved SecurityGroup: ${SG_ID}"
echo "    resolved SSM parameters:"
echo "${PARAM_NAMES}" | sed 's/^/      - /'

# --- Phase 2: first Ctrl-C (graceful SIGINT, #816) --------------------
#
# Timing mechanism: launch `cdkd destroy --force` in the BACKGROUND with
# its stdout+stderr redirected to a log file, capture the node PID, then
# POLL the log for evidence that the delete loop has ACTUALLY STARTED
# before sending ONE SIGINT. The poll is bounded (SIGINT_WAIT_MAX_S); if
# the destroy finishes before we can interrupt (a legitimate race on a
# fast account), we DETECT the process already exited, LOG it, and skip
# straight to the re-run / clean-end assertions instead of hard-failing
# on the race. This keeps the test robust: the contract under test (lock
# released + state preserved on interrupt) is only asserted when an
# interrupt actually lands; a too-fast destroy is an acceptable
# non-interrupt outcome.
#
# CRITICAL — the detection signal must prove the delete loop is underway
# AND the #816 SIGINT handler is already registered. cdkd registers the
# graceful-SIGINT handler in `runDestroyForStack` only AFTER acquiring
# the stack lock, immediately before logging "Building dependency
# graph..." (destroy-runner.ts ~L593). The "Resources to be deleted"
# PLAN banner is printed much EARLIER — before the lock acquire and
# before the handler exists. Triggering on that banner (the original
# bug) sent the SIGINT during lock-acquire, when Node's DEFAULT SIGINT
# behavior terminates the process before any handler runs: the `finally`
# that releases the lock never executes and the lock is stranded. That
# is a TEST race, not a #816 cdkd gap. We therefore trigger only on a
# signal emitted AFTER the handler is live: a per-resource completion
# line ("... deleted" via formatResourceLine) or the post-handler
# "Building dependency graph..." line (the live-renderer "Deleting ..."
# label is suppressed on the non-TTY redirected log, so it is not a
# reliable signal here).
SIGINT_WAIT_MAX_S=30
DESTROY_LOG="$(mktemp)"

echo "==> Phase 2: destroy in background, then send one SIGINT mid-delete"
# `setsid`-free: a plain background node process receives the explicit
# `kill -INT <pid>` we send; we deliberately target ONLY the node PID so
# the SIGINT goes to cdkd's own handler (not the whole process group).
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force --verbose >"${DESTROY_LOG}" 2>&1 &
DESTROY_PID=$!

# Poll for deletion-started evidence (bounded).
interrupted_sent=0
deadline=$((SECONDS + SIGINT_WAIT_MAX_S))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  # Process already exited? Then the destroy finished before we could
  # interrupt — acceptable race, handled below.
  if ! kill -0 "${DESTROY_PID}" 2>/dev/null; then
    break
  fi
  # First sign the delete loop is underway AND the #816 SIGINT handler is
  # registered: either a per-resource completion line ("<id> (<type>)
  # deleted") or the post-handler "Building dependency graph..." line.
  # Deliberately NOT matching the "Resources to be deleted" plan banner —
  # that prints before the lock acquire / handler registration, so a
  # SIGINT then would hit Node's default-terminate and strand the lock
  # (the original false failure). Match with grep -E (BSD-safe); anchor
  # "deleted" to the trailing-verb position so it cannot match the plan
  # banner's "Resources to be deleted".
  if grep -E -q "Building dependency graph|\) deleted" "${DESTROY_LOG}" 2>/dev/null; then
    echo "    delete loop started (handler registered) — sending SIGINT to PID ${DESTROY_PID}"
    kill -INT "${DESTROY_PID}" 2>/dev/null || true
    interrupted_sent=1
    break
  fi
  # Short poll interval. verify.sh runs under the /run-integ harness on a
  # real shell where `sleep` works normally (the sandbox `sleep`-blocked
  # constraint applies only to the agent's own Bash tool, not here).
  sleep 0.3
done

# If we never saw the handler-registration signal AND the process is
# still alive, send the SIGINT anyway ONLY if the handler-registration
# line has by now appeared in the log — otherwise the process is stuck
# pre-handler (strong-ref scan / lock acquire) and a SIGINT would hit
# Node's default-terminate and strand the lock (a false failure, not a
# #816 bug). In the (unexpected) pre-handler-stuck case, leave the
# process alone: `wait` below collects it, and the state-preserved /
# state-gone branch handles whatever it did.
if [ "${interrupted_sent}" -eq 0 ] && kill -0 "${DESTROY_PID}" 2>/dev/null; then
  if grep -E -q "Building dependency graph|\) deleted" "${DESTROY_LOG}" 2>/dev/null; then
    echo "    handler registered but no per-resource delete yet within ${SIGINT_WAIT_MAX_S}s; sending SIGINT now"
    kill -INT "${DESTROY_PID}" 2>/dev/null || true
    interrupted_sent=1
  else
    echo "    WARNING: no handler-registration signal within ${SIGINT_WAIT_MAX_S}s — destroy appears stuck pre-handler; NOT sending SIGINT (would strand the lock via default-terminate)"
  fi
fi

# Wait for the background destroy to exit and capture its REAL rc.
DESTROY_RC=0
wait "${DESTROY_PID}" || DESTROY_RC=$?
echo "    first destroy exited rc=${DESTROY_RC}"
echo "----- first destroy log (tail) -----"
tail -n 25 "${DESTROY_LOG}" || true
echo "------------------------------------"

# Did the interrupt actually land mid-destroy (state preserved), or did
# the destroy finish first (state gone)?
if state_exists; then
  echo "    interrupt landed mid-destroy — asserting #816 first-Ctrl-C contract"

  # (a) graceful exit: the handler printed the drain notice and the
  #     process exited (it did — `wait` returned). The interrupt path
  #     surfaces a non-zero exit; just assert it exited. Match the
  #     ACTUAL drain-notice text ("Interrupted — finishing in-flight
  #     deletes") — NOT a bare "interrupt", which also matches the stack
  #     name CdkdDestroyInterruptExample and would be a false positive.
  if grep -E -q "finishing in-flight deletes" "${DESTROY_LOG}"; then
    echo "    OK: destroy logged the graceful-interrupt drain notice"
  else
    echo "    NOTE: no explicit drain notice in log (interrupt may have landed between levels, before any in-flight delete); continuing"
  fi

  # (b) lock released — no lock object remains (the #816 fix: finally ran
  #     and released the lock; pre-fix the lock stranded for 30m). The
  #     node process already exited (`wait` returned above), so the
  #     finally has run; allow a brief bounded poll for the async S3
  #     DeleteObject to settle before asserting.
  if ! wait_for_lock_release; then
    echo "FAIL: stack lock object still present after graceful interrupt (should be released)" >&2
    exit 1
  fi
  echo "    OK: stack lock was released after the interrupt (no 30m strand)"

  # (c) state preserved (trimmed, not deleted). Already know state_exists.
  PRESERVED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  REMAIN=$(echo "${PRESERVED}" | jq -r '.resources | length')
  echo "    OK: state preserved with ${REMAIN} resource(s) still listed (partial destroy)"
else
  echo "    NOTE: destroy finished before the interrupt could land (fast-account race);"
  echo "          state is already gone. The #816 contract is only assertable on an"
  echo "          actual interrupt, so skipping the lock/state-preserved asserts and"
  echo "          verifying the clean-end state below."
  # A finished destroy must have released the lock too (bounded poll for
  # the async S3 DeleteObject to settle after the process exit).
  if ! wait_for_lock_release; then
    echo "FAIL: stack lock object present after a completed destroy" >&2
    exit 1
  fi
fi

# --- Phase 3: re-run / resume (CR fail-fast, #804) --------------------
#
# If state still exists (the interrupt landed), re-run destroy to
# completion and assert it RESUMES cleanly, the CR delete does NOT stall
# ~10 minutes against the already-deleted backing Lambda, and the stack
# ends fully gone. If state is already gone (race above), this is a
# no-op fast path that still confirms the clean end state.
if state_exists; then
  echo "==> Phase 3: re-run destroy to completion (assert resume + CR fail-fast)"
  RERUN_LOG="$(mktemp)"
  RERUN_START=${SECONDS}
  RERUN_RC=0
  node "${LOCAL_DIST}" destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --force --verbose >"${RERUN_LOG}" 2>&1 || RERUN_RC=$?
  RERUN_ELAPSED=$((SECONDS - RERUN_START))
  echo "    re-run destroy exited rc=${RERUN_RC} in ${RERUN_ELAPSED}s"
  echo "----- re-run destroy log (tail) -----"
  tail -n 25 "${RERUN_LOG}" || true
  echo "-------------------------------------"

  if [ "${RERUN_RC}" -ne 0 ]; then
    echo "FAIL: re-run destroy exited non-zero (rc=${RERUN_RC}) — should resume cleanly" >&2
    exit 1
  fi
  echo "    OK: re-run destroy completed with rc=0 (clean resume)"

  # #804 fail-fast: a CR replay that stalled on GetFunction would take
  # ~10 minutes (600s). Assert the whole re-run finished well under that.
  # 180s budget is generous for VPC + ENI teardown yet far below the 10m
  # stall.
  if [ "${RERUN_ELAPSED}" -ge 180 ]; then
    echo "FAIL: re-run destroy took ${RERUN_ELAPSED}s (>=180s) — suggests the #804 CR GetFunction stall regressed" >&2
    exit 1
  fi
  echo "    OK: re-run finished in ${RERUN_ELAPSED}s (< 180s) — no 10m CR stall"

  # The re-run must not have left a CR timeout / 10m-waiter signature.
  if grep -E -q "currently in the following state: Pending|has been deleting for 1[0-9]m|waitUntilFunctionActive" "${RERUN_LOG}"; then
    echo "FAIL: re-run log shows a long Lambda-waiter / CR stall signature (#804 regression)" >&2
    exit 1
  fi
  echo "    OK: re-run log shows no CR GetFunction stall signature"
else
  echo "==> Phase 3: state already gone from the completed Phase 2 destroy — skipping re-run"
fi

# --- Phase 4: clean end-state + orphan assertions ---------------------
echo "==> Phase 4: assert fully gone (state + AWS resources)"

if state_exists; then
  echo "FAIL: state file still exists after destroy completion" >&2
  exit 1
fi
echo "    OK: state file is gone"

if ! wait_for_lock_release; then
  echo "FAIL: lock object still present at end of run" >&2
  exit 1
fi
echo "    OK: lock object is gone"

# Backing Lambda gone.
if [ -n "${FN_NAME}" ] && [ "${FN_NAME}" != "null" ]; then
  if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: backing Lambda ${FN_NAME} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: backing Lambda is gone"
fi

# VPC gone (covers subnets / SG / ENI implicitly — a lingering ENI or SG
# would keep the VPC alive and DescribeVpcs would still return it).
if [ -n "${VPC_ID}" ] && [ "${VPC_ID}" != "null" ]; then
  if aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: VPC ${VPC_ID} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: VPC is gone (subnets / SG / ENI implicitly cleared)"

  # Defensive explicit ENI / SG scan against the (now-deleted) VPC id —
  # describe by vpc-id returns empty once the VPC is gone, so this is a
  # belt-and-suspenders check that the query path is clean.
  LEFT_ENIS=$(aws ec2 describe-network-interfaces --region "${REGION}" \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query 'length(NetworkInterfaces)' --output text 2>/dev/null || echo 0)
  if [ "${LEFT_ENIS}" != "0" ] && [ "${LEFT_ENIS}" != "None" ]; then
    echo "FAIL: ${LEFT_ENIS} ENI(s) still attached to ${VPC_ID} after destroy" >&2
    exit 1
  fi
  echo "    OK: no leftover ENIs for the VPC"
fi

# SecurityGroup gone (explicit). The VPC-gone assert already implies this —
# a lingering SG would keep an ENI which would keep the VPC alive — but we
# assert the exact group id directly so a misattributed orphan is caught even
# if the VPC delete path ever changes. describe-security-groups exits
# non-zero (InvalidGroup.NotFound) once the SG is deleted.
if [ -n "${SG_ID}" ] && [ "${SG_ID}" != "null" ]; then
  if aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: SecurityGroup ${SG_ID} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: SecurityGroup is gone"
fi

# IAM role gone (explicit). The role is NOT VPC-bound, so the VPC-gone assert
# does NOT cover it — it could orphan independently while state.json is empty
# (the "state-empty misses a no-stack-name orphan" class). get-role exits
# non-zero (NoSuchEntity) once the role is deleted.
if [ -n "${ROLE_NAME}" ] && [ "${ROLE_NAME}" != "null" ]; then
  if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
    echo "FAIL: IAM role ${ROLE_NAME} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: IAM role is gone"
fi

# SSM parameters: assert each exact physical id captured from the
# deployed state (auto-named, so we cannot rely on a stack-name scan) is
# gone. `aws ssm get-parameter` exits non-zero (ParameterNotFound) once
# the parameter is deleted.
if [ -n "${PARAM_NAMES}" ]; then
  while IFS= read -r pname; do
    [ -z "${pname}" ] && continue
    if aws ssm get-parameter --name "${pname}" --region "${REGION}" >/dev/null 2>&1; then
      echo "FAIL: SSM parameter ${pname} still exists after destroy" >&2
      exit 1
    fi
  done <<EOF
${PARAM_NAMES}
EOF
  echo "    OK: all SSM parameters are gone"
fi

echo ""
echo "[verify] PASS"
