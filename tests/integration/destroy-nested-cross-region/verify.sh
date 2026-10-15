#!/usr/bin/env bash
# verify.sh -- `cdkd destroy` and `cdkd state destroy` of a stack recorded in a
# region other than the CLI's, whose nested child holds a named resource
# (issue [#4941](https://github.com/go-to-k/cdkd/issues/4941)).
#
# THE DEFECT. The caller builds its provider registry in the CLI's region and
# hands that registry, with its CLI-region clients, to the nested-stack
# context. The runner switched region for the PARENT's own resources, but the
# child ran with the parent's region as its base, so it never switched and
# took the caller's registry. The Kinesis provider captures `ambientRegion()`
# when it is constructed, so the child's stream was deleted BY NAME in the
# CLI's region: a same-named stream there, which cdkd does not manage, was
# deleted irreversibly, and the real one was left behind.
#
# THE DISCRIMINATOR. The stack is pinned to us-west-2 and every destroy runs
# with AWS_REGION=us-east-1, where a SENTINEL stream with the child's stream
# name is created first. Each arm asserts the sentinel is still ACTIVE and
# the child's stream in us-west-2 is gone. Before the fix the sentinel was
# deleted and the us-west-2 stream survived; the destroy itself exited 0.
#
# PHASES
#   0. Refuse if a stream of that name is already in us-east-1 (it is not
#      this run's), then create the sentinel there and wait for it.
#   D1. Deploy (in us-west-2).
#   D2. PREMISE: the child's stream is in us-west-2, the parent and child
#       state records are under us-west-2.
#   D3. ARM D: `cdkd destroy` with AWS_REGION=us-east-1: exit 0, the sentinel
#       is ACTIVE, the us-west-2 stream is gone, both records are gone.
#   S1. Deploy again.
#   S2. ARM S: `cdkd state destroy` with AWS_REGION=us-east-1: the same checks.
#   R1. Deploy again.
#   R2. ARM R: `cdkd state destroy --region us-west-2` with AWS_REGION=us-east-1.
#       The stack is in the flag's region, so the runner keeps the command's
#       registry, which must be built in that region: the same checks.
#
# Requires: STATE_BUCKET, a built dist/cli.js.

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

# The INVERSE assertion, and it needs the same three-way discipline for the
# same reason: a wrapped `if ! aws ...` reports "GONE" on ANY probe failure --
# throttle, expired creds, a transient 5xx -- which here means ACCUSING the fix
# of deleting state it actually preserved. It fails closed (never a false PASS),
# but a false FAIL on an unrelated AWS blip is its own kind of wrong.
# assert_exists returns 0 when the probe succeeds (resource confirmed present),
# FAILs with the caller's description when the probe reports not-found, and
# hard-FAILs as UNDETERMINED on any other probe failure without blaming the
# code under test.
assert_exists() { # usage: assert_exists "<missing description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  [ "${1:-}" = "aws" ] || { echo "FAIL: assert_exists: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 0
  fi
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
  echo "FAIL: exists-probe undetermined ($*): ${out}" >&2
  exit 1
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

export AWS_PAGER=""

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"
STACK="CdkdDestroyNestedXregionExample"
CHILD_STACK="${STACK}~Child"
# The stack's region (pinned in lib/) and the shell's region every destroy
# runs with. They must differ.
REGION="us-west-2"
CLI_REGION="us-east-1"
STREAM_NAME="${STACK}-child-stream"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found; run 'vp run build' first" >&2
  exit 1
fi

# Created AFTER the pre-run cleanup below, which removes it.
WORK_DIR=""
# Set once Phase 0 created the sentinel; gates its deletion in cleanup.
SENTINEL_CREATED=0

echo "=== destroy of a cross-region nested stack (issue #4941) ==="
echo "Stack:        ${STACK} (${REGION})"
echo "CLI region:   ${CLI_REGION}"
echo "Stream name:  ${STREAM_NAME}"
echo "State bucket: ${STATE_BUCKET}"

strip_ansi() { sed -e $'s/\033\\[[0-9;]*m//g'; }

# Best-effort: delete a stream by name in one region and wait until it is gone.
delete_stream() { # usage: delete_stream <region>
  (
    set +eu
    aws kinesis delete-stream --stream-name "${STREAM_NAME}" --enforce-consumer-deletion \
      --region "$1" >/dev/null 2>&1
    aws kinesis wait stream-not-exists --stream-name "${STREAM_NAME}" --region "$1" >/dev/null 2>&1
  )
}

cleanup() {
  (
    set +eu
    echo "=== cleanup ==="
    AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
      --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1
    AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}" node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}" node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    # The child's stream (a destroy that went to the wrong region leaves it),
    # and the sentinel only once THIS run created it: before that, a stream of
    # that name in ${CLI_REGION} is not the fixture's.
    delete_stream "${REGION}"
    if [ "${SENTINEL_CREATED}" = "1" ]; then
      delete_stream "${CLI_REGION}"
    fi
    rm -rf "${WORK_DIR:-}"
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Pre-run cleanup: a previous run's leftovers would make the deploy or the
# sentinel's create fail.
cleanup
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-4941-XXXXXX")"

# The stream's status in a region: ACTIVE / CREATING / UPDATING / DELETING,
# or GONE when describe reports not-found. Any other probe failure FAILs. ONE
# describe decides all three, so a DELETING stream that vanishes mid-check
# cannot turn a second call's not-found into an unexplained abort.
stream_status() { # usage: stream_status <region>
  local out
  if out="$(aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "$1" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>&1)"; then
    printf '%s\n' "${out}"
    return 0
  fi
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    echo "GONE"
    return 0
  fi
  echo "FAIL: stream-status probe undetermined (${STREAM_NAME} in $1): ${out}" >&2
  exit 1
}

# The checks every destroy arm makes. The sentinel FIRST: its loss is the
# irreversible half.
assert_destroyed_in_stack_region() { # usage: assert_destroyed_in_stack_region <arm> <rc> <log>
  local arm="$1" rc="$2" log="$3" sentinel child
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: ${arm}: the destroy exited ${rc} (want 0):" >&2
    tail -40 "${log}" | strip_ansi >&2
    exit 1
  fi
  sentinel="$(stream_status "${CLI_REGION}")"
  if [ "${sentinel}" != "ACTIVE" ]; then
    echo "FAIL: ${arm}: the sentinel stream ${STREAM_NAME} in ${CLI_REGION}, which cdkd does not manage, is ${sentinel} after the destroy (want ACTIVE): the nested child's delete ran in the CLI's region (issue #4941)" >&2
    exit 1
  fi
  child="$(stream_status "${REGION}")"
  if [ "${child}" != "GONE" ] && [ "${child}" != "DELETING" ]; then
    echo "FAIL: ${arm}: the child's stream ${STREAM_NAME} in ${REGION} is ${child} after the destroy (want GONE or DELETING) (issue #4941)" >&2
    exit 1
  fi
  assert_gone "${arm}: the parent state ${STATE_KEY} still exists after the destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
  assert_gone "${arm}: the child state ${CHILD_STATE_KEY} still exists after the destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
  echo "PASS: ${arm}: sentinel in ${CLI_REGION} ACTIVE, child stream in ${REGION} ${child}, both records gone"
  # The next deploy re-creates the same name in ${REGION}.
  aws kinesis wait stream-not-exists --stream-name "${STREAM_NAME}" --region "${REGION}"
}

deploy_and_check_premise() { # usage: deploy_and_check_premise <phase>
  AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --region "${REGION}" --state-bucket "${STATE_BUCKET}"
  assert_exists "$1: the parent state ${STATE_KEY} was not written by the deploy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
  assert_exists "$1: the child state ${CHILD_STATE_KEY} was not written by the deploy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
  local child
  child="$(stream_status "${REGION}")"
  if [ "${child}" != "ACTIVE" ]; then
    echo "FAIL: $1: the child's stream in ${REGION} is ${child} after the deploy (want ACTIVE)" >&2
    exit 1
  fi
  echo "PASS: $1: deployed; the child's stream is ACTIVE in ${REGION}"
}

# ---------------------------------------------------------------------------
# Phase 0: the sentinel in the CLI's region.
# ---------------------------------------------------------------------------
echo "=== Phase 0: creating the sentinel stream in ${CLI_REGION} ==="
# A stream of that name already in ${CLI_REGION} is not this run's, so it is
# never deleted: refuse to start instead.
PREEXISTING_STATUS="$(stream_status "${CLI_REGION}")"
if [ "${PREEXISTING_STATUS}" != "GONE" ]; then
  echo "FAIL: a stream named ${STREAM_NAME} already exists in ${CLI_REGION} (${PREEXISTING_STATUS}); this fixture does not delete a stream it did not create. If it is a leftover of an earlier run of this fixture, delete it with: aws kinesis delete-stream --stream-name ${STREAM_NAME} --region ${CLI_REGION}" >&2
  exit 1
fi
aws kinesis create-stream --stream-name "${STREAM_NAME}" --shard-count 1 --region "${CLI_REGION}"
SENTINEL_CREATED=1
aws kinesis wait stream-exists --stream-name "${STREAM_NAME}" --region "${CLI_REGION}"
SENTINEL_STATUS="$(stream_status "${CLI_REGION}")"
if [ "${SENTINEL_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: the sentinel stream is ${SENTINEL_STATUS} after create (want ACTIVE)" >&2
  exit 1
fi
echo "PASS: sentinel ACTIVE in ${CLI_REGION}"

# ---------------------------------------------------------------------------
# Arm D: `cdkd destroy` from a shell in another region.
# ---------------------------------------------------------------------------
echo "=== Phase D1/D2: deploy ==="
deploy_and_check_premise "D2"

echo "=== Phase D3: cdkd destroy with AWS_REGION=${CLI_REGION} ==="
set +e
AWS_REGION="${CLI_REGION}" AWS_DEFAULT_REGION="${CLI_REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force > "${WORK_DIR}/destroy.log" 2>&1
D_RC=$?
set -e
assert_destroyed_in_stack_region "D3 (cdkd destroy)" "${D_RC}" "${WORK_DIR}/destroy.log"

# ---------------------------------------------------------------------------
# Arm S: `cdkd state destroy` from a shell in another region.
# ---------------------------------------------------------------------------
echo "=== Phase S1: deploy ==="
deploy_and_check_premise "S1"

echo "=== Phase S2: cdkd state destroy with AWS_REGION=${CLI_REGION} ==="
set +e
AWS_REGION="${CLI_REGION}" AWS_DEFAULT_REGION="${CLI_REGION}" node "${LOCAL_DIST}" state destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --yes > "${WORK_DIR}/state-destroy.log" 2>&1
S_RC=$?
set -e
assert_destroyed_in_stack_region "S2 (the state subcommand)" "${S_RC}" "${WORK_DIR}/state-destroy.log"

# ---------------------------------------------------------------------------
# Arm R: `cdkd state destroy --region <stack region>` from a shell in another
# region (the stack is then in the run's region).
# ---------------------------------------------------------------------------
echo "=== Phase R1: deploy ==="
deploy_and_check_premise "R1"

echo "=== Phase R2: cdkd state destroy --region ${REGION} with AWS_REGION=${CLI_REGION} ==="
set +e
AWS_REGION="${CLI_REGION}" AWS_DEFAULT_REGION="${CLI_REGION}" node "${LOCAL_DIST}" state destroy "${STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET:-}" --yes > "${WORK_DIR}/state-destroy-region.log" 2>&1
R_RC=$?
set -e
assert_destroyed_in_stack_region "R2 (the state subcommand with --region)" "${R_RC}" "${WORK_DIR}/state-destroy-region.log"

echo "[verify] PASS — destroy and state destroy (with and without --region) of a cross-region nested stack deleted the child's stream in ${REGION} and left the same-named stream in ${CLI_REGION} alone (issue #4941)"
