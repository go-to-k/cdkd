#!/usr/bin/env bash
# verify.sh -- go-to-k/cdkd#7005: a removed resource whose DeletionPolicy keeps
# it (Retain / RetainExceptOnCreate) is shown as ORPHANED by `cdkd diff` and the
# deploy's `Changes:` line, and the deploy really keeps it in AWS.
#
# Phase 1: deploy five queues.
# Phase 2: `cdkd diff` with CDKD_TEST_REMOVAL=true (three queues removed):
#          the two retained rows carry the orphan marker, the DESTROY row does
#          not, and the totals read `1 to delete, 2 to orphan`.
# Phase 3: deploy the removal: the `Changes:` line says the same, the two
#          retained queues still exist, the DESTROY queue is gone.
# Phase 4: destroy: its plan lists QueueHeld (RETAIN, still in the stack) as
#          kept, not under "to be deleted", and leaves it in AWS. The retained
#          queues are then deleted here by API, and everything is asserted gone.

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

STACK="CdkdDiffOrphanRetainedRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
QUEUES=(keep held ret rou del)
LOG_DIR="$(mktemp -d)"

queue_url() { # usage: queue_url <suffix>; prints the URL, or fails
  aws sqs get-queue-url --queue-name "${STACK}-$1" --region "${REGION}" --query QueueUrl --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for q in "${QUEUES[@]}"; do
    url=$(queue_url "${q}" 2>/dev/null)
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

strip_ansi() { sed -E $'s/\x1b\\[[0-9;]*m//g' "$1"; }

echo "==> Phase 1: deploy the baseline"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
for q in "${QUEUES[@]}"; do
  queue_url "${q}" >/dev/null || { echo "FAIL: queue ${STACK}-${q} missing after the baseline deploy" >&2; exit 1; }
done
echo "    OK: five queues live"

echo "==> Phase 2: cdkd diff with three queues removed"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${LOG_DIR}/diff.log" 2>&1 \
  || { cat "${LOG_DIR}/diff.log" >&2; echo "FAIL: cdkd diff failed" >&2; exit 1; }
DIFF=$(strip_ansi "${LOG_DIR}/diff.log")
ORPHAN_MARK='\(AWS::SQS::Queue\) \[orphan: its DeletionPolicy keeps it in AWS\]'
# Sentinel: the DESTROY row is listed. Without it a reworded or vanished row
# would read as "no orphan marker" for the wrong reason.
grep -qE '^  \[-\] QueueDel[0-9A-F]* \(AWS::SQS::Queue\)$' <<<"${DIFF}" \
  || { echo "FAIL: the DESTROY queue's [-] row is missing or carries a marker" >&2; printf '%s\n' "${DIFF}" >&2; exit 1; }
for id in QueueRet QueueRou; do
  grep -qE "^  \[-\] ${id}[0-9A-F]* ${ORPHAN_MARK}\$" <<<"${DIFF}" \
    || { echo "FAIL: ${id} is not marked as an orphan in the diff" >&2; printf '%s\n' "${DIFF}" >&2; exit 1; }
done
grep -qF '0 to create, 0 to update, 1 to delete, 2 to orphan' <<<"${DIFF}" \
  || { echo "FAIL: the diff totals do not count the retained queues as orphaned" >&2; printf '%s\n' "${DIFF}" >&2; exit 1; }
echo "    OK: diff marks QueueRet and QueueRou as orphans, QueueDel as a delete"

echo "==> Phase 3: deploy the removal"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${LOG_DIR}/deploy.log" 2>&1 \
  || { cat "${LOG_DIR}/deploy.log" >&2; echo "FAIL: the removal deploy failed" >&2; exit 1; }
DEPLOY=$(strip_ansi "${LOG_DIR}/deploy.log")
grep -qF 'Changes: 0 to create, 0 to update, 1 to delete, 2 to orphan' <<<"${DEPLOY}" \
  || { echo "FAIL: the deploy's Changes line does not count the retained queues as orphaned" >&2; printf '%s\n' "${DEPLOY}" >&2; exit 1; }
for q in ret rou; do
  queue_url "${q}" >/dev/null || { echo "FAIL: retained queue ${STACK}-${q} was deleted by the removal deploy" >&2; exit 1; }
done
GONE=""
for _ in $(seq 1 12); do
  if gone_probe aws sqs get-queue-url --queue-name "${STACK}-del" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: queue ${STACK}-del still exists after its removal" >&2; exit 1; }
echo "    OK: Changes line counts 2 orphans; ret / rou kept in AWS; del deleted"

echo "==> Phase 4: destroy"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force > "${LOG_DIR}/destroy.log" 2>&1 \
  || { cat "${LOG_DIR}/destroy.log" >&2; echo "FAIL: destroy failed" >&2; exit 1; }
DESTROY=$(strip_ansi "${LOG_DIR}/destroy.log")
# Sentinel: the plan header is printed at all.
grep -qF 'Resources to be deleted (1):' <<<"${DESTROY}" \
  || { echo "FAIL: the destroy plan does not count only QueueKeep as deleted" >&2; printf '%s\n' "${DESTROY}" >&2; exit 1; }
grep -qF 'Resources kept in AWS by their DeletionPolicy (1):' <<<"${DESTROY}" \
  || { echo "FAIL: the destroy plan does not list QueueHeld as kept" >&2; printf '%s\n' "${DESTROY}" >&2; exit 1; }
grep -qE '^  - QueueHeld[0-9A-F]* \(AWS::SQS::Queue\), DeletionPolicy: Retain$' <<<"${DESTROY}" \
  || { echo "FAIL: the kept row for QueueHeld is missing" >&2; printf '%s\n' "${DESTROY}" >&2; exit 1; }
queue_url held >/dev/null || { echo "FAIL: QueueHeld (RETAIN) was deleted by destroy" >&2; exit 1; }
echo "    OK: destroy plan lists QueueHeld as kept, and it survives"
for q in held ret rou; do
  aws sqs delete-queue --queue-url "$(queue_url "${q}")" --region "${REGION}"
done
for q in "${QUEUES[@]}"; do
  GONE=""
  for _ in $(seq 1 12); do
    if gone_probe aws sqs get-queue-url --queue-name "${STACK}-${q}" --region "${REGION}"; then GONE=1; break; fi
    sleep 5
  done
  [ -z "${GONE}" ] && { echo "FAIL: queue ${STACK}-${q} still exists after destroy" >&2; exit 1; }
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: every queue and the state file are gone"
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo ""
echo "[verify] PASS — a removed retained resource is shown as orphaned and kept in AWS"
