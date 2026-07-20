#!/usr/bin/env bash
# verify.sh — cdkd Scheduler custom-group SDK provider integ (issue #961).
# A schedule in a CUSTOM ScheduleGroup was unaddressable via Cloud Control:
# UPDATE failed NotFound and a schedule-only removal silently orphaned the
# live schedule. Phases: deploy -> UPDATE (expression) -> schedule-only
# removal (group kept; the schedule MUST actually leave AWS) -> destroy.

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

STACK="CdkdSchedulerCustomGroupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
GROUP="${STACK}-grp"
SCHED="${STACK}-sched"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws scheduler delete-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  aws scheduler delete-schedule-group --name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  ACCT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [ -n "${ACCT}" ]; then
    aws sqs delete-queue --queue-url "https://sqs.${REGION}.amazonaws.com/${ACCT}/${STACK}-tgt" >/dev/null 2>&1 || true
    aws sqs delete-queue --queue-url "https://sqs.${REGION}.amazonaws.com/${ACCT}/${STACK}-dlq" >/dev/null 2>&1 || true
  fi
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

echo "==> Phase 1: Deploy (schedule in custom group, rate(1 hour))"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVE_SCHED \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EXPR=$(aws scheduler get-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}" \
  --query 'ScheduleExpression' --output text 2>/dev/null || true)
[ "${EXPR}" = "rate(1 hour)" ] || { echo "FAIL: base schedule is '${EXPR}'" >&2; exit 1; }
echo "    OK: schedule created in custom group (${EXPR})"

echo "==> Phase 2: UPDATE (rate(1 hour) -> rate(2 hours)) — the #961 NotFound path"
env -u CDKD_TEST_REMOVE_SCHED CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EXPR=$(aws scheduler get-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}" \
  --query 'ScheduleExpression' --output text 2>/dev/null || true)
[ "${EXPR}" = "rate(2 hours)" ] || { echo "FAIL: updated schedule is '${EXPR}'" >&2; exit 1; }
echo "    OK: in-place UPDATE reached the custom-group schedule (${EXPR})"

echo "==> Phase 3: schedule-only removal (group kept) — the #961 silent-orphan path"
env -u CDKD_TEST_UPDATE CDKD_TEST_REMOVE_SCHED=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone "schedule still LIVE in AWS after removal deploy (silent orphan — the #961 delete bug)" aws scheduler get-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}"
echo "    OK: schedule actually left AWS"
aws scheduler get-schedule-group --name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 \
  || { echo "FAIL: schedule group disappeared during schedule-only removal" >&2; exit 1; }
echo "    OK: schedule group survived"

echo "==> Phase 4: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "group still exists after destroy" aws scheduler get-schedule-group --name "${GROUP}" --region "${REGION}"
echo "    OK: group gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> scheduler-custom-group test passed"
