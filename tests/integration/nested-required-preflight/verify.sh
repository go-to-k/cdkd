#!/usr/bin/env bash
# verify.sh — cdkd nested `required` pre-flight refusal integ (issue #1802).
#
# A PRESENT nested block missing a member CloudFormation requires must be
# refused at pre-flight, before any AWS call; a partial block hidden behind an
# unresolved `Fn::If` must NOT be refused.
#
# Phases:
#   1. Fresh stack, CDKD_TEST_PARTIAL=true (Queue tag without Value): deploy
#      must fail with the refusal naming Queue and the missing member; neither
#      queue exists afterwards and no state file was written.
#   2. Clean deploy: both queues exist, Queue carries owner=cdkd, and
#      GuardedQueue (partial tag only in the unused Fn::If arm) deployed with
#      owner=guarded — the fail-safe positive control.
#   3. Deployed stack, CDKD_TEST_PARTIAL=true again: refused the same way, and
#      the live tag is still owner=cdkd.
#   4. Destroy; both queues and the state file are gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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

STACK="CdkdNestedRequiredPreflight"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
QUEUE="cdkd-nested-required-queue"
GUARDED="cdkd-nested-required-guarded"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="$(mktemp)"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for q in "${QUEUE}" "${GUARDED}"; do
    url="$(aws sqs get-queue-url --queue-name "${q}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${LOG}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup
LOG="$(mktemp)"

owner_tag() { # usage: owner_tag <queue-name>
  local url
  url="$(aws sqs get-queue-url --queue-name "$1" --region "${REGION}" --query QueueUrl --output text)" || return 1
  aws sqs list-queue-tags --queue-url "${url}" --region "${REGION}" --query 'Tags.owner' --output text
}

# The refusal must name the resource, the path and the missing member. The
# header line is the sentinel: if cdkd failed for another reason, it is absent.
assert_refused() { # usage: assert_refused <phase>
  local phase="$1" rc=0
  CDKD_TEST_PARTIAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG}" 2>&1 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    cat "${LOG}" >&2
    echo "FAIL: ${phase}: deploy with a Tags element missing Value SUCCEEDED; pre-flight should refuse it" >&2
    exit 1
  fi
  if ! grep -qF 'declare a nested property block without a member it requires' "${LOG}"; then
    cat "${LOG}" >&2
    echo "FAIL: ${phase}: deploy failed (rc=${rc}) but not with the nested-required refusal" >&2
    exit 1
  fi
  if ! grep -qF 'Queue (AWS::SQS::Queue): Tags[0] is missing required member Value' "${LOG}"; then
    cat "${LOG}" >&2
    echo "FAIL: ${phase}: refusal did not name Queue / Tags[0] / Value" >&2
    exit 1
  fi
  if grep -qF 'GuardedQueue' "${LOG}"; then
    cat "${LOG}" >&2
    echo "FAIL: ${phase}: GuardedQueue (partial only behind an unresolved Fn::If) was refused" >&2
    exit 1
  fi
  echo "    ${phase}: refused at pre-flight (rc=${rc}), naming Queue Tags[0] Value only"
}

# --- Phase 1: refusal on a fresh stack -----------------------------------
echo "==> Phase 1: partial tag on a fresh stack must be refused before any AWS call"
assert_refused "Phase 1"
assert_gone "Phase 1: ${QUEUE} exists after a refused deploy" aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}"
assert_gone "Phase 1: ${GUARDED} exists after a refused deploy" aws sqs get-queue-url --queue-name "${GUARDED}" --region "${REGION}"
assert_gone "Phase 1: state file written by a refused deploy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Phase 1: lock left behind by a refused deploy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/lock.json"
echo "    nothing created, no state written, lock released"

# --- Phase 2: clean deploy (positive control) -----------------------------
echo "==> Phase 2: complete tag deploys; the Fn::If-guarded partial is not refused"
env -u CDKD_TEST_PARTIAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
TAG2="$(owner_tag "${QUEUE}")"
GTAG2="$(owner_tag "${GUARDED}")"
echo "    Queue owner=${TAG2} GuardedQueue owner=${GTAG2}"
[ "${TAG2}" = "cdkd" ] || { echo "FAIL: Phase 2: expected Queue owner=cdkd, got '${TAG2}'" >&2; exit 1; }
[ "${GTAG2}" = "guarded" ] || { echo "FAIL: Phase 2: expected GuardedQueue owner=guarded (the Fn::If else arm), got '${GTAG2}'" >&2; exit 1; }

# --- Phase 3: refusal on the deployed stack --------------------------------
echo "==> Phase 3: partial tag on the deployed stack must be refused, live tag intact"
assert_refused "Phase 3"
TAG3="$(owner_tag "${QUEUE}")"
[ "${TAG3}" = "cdkd" ] || { echo "FAIL: Phase 3: live Queue tag changed to '${TAG3}' by a refused deploy" >&2; exit 1; }
echo "    live Queue tag still owner=cdkd"

# --- Phase 4: destroy ------------------------------------------------------
echo "==> Phase 4: destroy"
env -u CDKD_TEST_PARTIAL node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "${QUEUE} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}"
assert_gone "${GUARDED} still exists after destroy" aws sqs get-queue-url --queue-name "${GUARDED}" --region "${REGION}"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    queues and state removed"

trap - EXIT INT TERM
rm -f "${LOG}"
echo "[verify] PASS — nested required pre-flight: refused on a fresh and a deployed stack (nothing created, live tag intact), Fn::If-guarded partial deployed, clean destroy, 4 phases passed"
