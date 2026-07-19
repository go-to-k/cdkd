#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Scheduler (CC-API) integ.
# Asserts the schedule reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEventbridgeSchedulerExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
SCHED="${STACK}-sched"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws scheduler delete-schedule --name "${SCHED}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EXPR=$(aws scheduler get-schedule --name "${SCHED}" --region "${REGION}" \
  --query 'ScheduleExpression' --output text 2>/dev/null)
if [ "${EXPR}" != "rate(1 hour)" ]; then
  echo "FAIL: schedule ScheduleExpression is '${EXPR}', expected 'rate(1 hour)'" >&2
  exit 1
fi
echo "    OK: schedule reached AWS (ScheduleExpression: ${EXPR})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

aws scheduler get-schedule --name "${SCHED}" --region "${REGION}" >/dev/null 2>&1 && { echo "FAIL: schedule still exists after destroy" >&2; exit 1; }
echo "    OK: schedule gone"
GONE=""
for _ in $(seq 1 18); do
  aws lambda get-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || { GONE=1; break; }
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && { echo "FAIL: state remains" >&2; exit 1; }
echo "    OK: state gone"
echo ""
echo "==> eventbridge-scheduler test passed"
