#!/usr/bin/env bash
# verify.sh — cdkd Scheduler custom-group SDK provider integ (issue #961).
# A schedule in a CUSTOM ScheduleGroup was unaddressable via Cloud Control:
# UPDATE failed NotFound and a schedule-only removal silently orphaned the
# live schedule. Phases: deploy -> UPDATE (expression) -> schedule-only
# removal (group kept; the schedule MUST actually leave AWS) -> destroy.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdSchedulerCustomGroupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
GROUP="${STACK}-grp"
SCHED="${STACK}-sched"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws scheduler delete-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  aws scheduler delete-schedule-group --name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sqs delete-queue --queue-url "https://sqs.${REGION}.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/${STACK}-tgt" >/dev/null 2>&1 || true
  aws sqs delete-queue --queue-url "https://sqs.${REGION}.amazonaws.com/$(aws sts get-caller-identity --query Account --output text)/${STACK}-dlq" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT

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

if aws scheduler get-schedule --name "${SCHED}" --group-name "${GROUP}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: schedule still LIVE in AWS after removal deploy (silent orphan — the #961 delete bug)" >&2
  exit 1
fi
echo "    OK: schedule actually left AWS"
aws scheduler get-schedule-group --name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 \
  || { echo "FAIL: schedule group disappeared during schedule-only removal" >&2; exit 1; }
echo "    OK: schedule group survived"

echo "==> Phase 4: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

aws scheduler get-schedule-group --name "${GROUP}" --region "${REGION}" >/dev/null 2>&1 && { echo "FAIL: group still exists after destroy" >&2; exit 1; }
echo "    OK: group gone"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && { echo "FAIL: state remains" >&2; exit 1; }
echo "    OK: state gone"
echo ""
echo "==> scheduler-custom-group test passed"
