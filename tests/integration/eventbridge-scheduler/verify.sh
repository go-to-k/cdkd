#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Scheduler (CC-API) integ.
# Asserts the schedule reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

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

assert_gone "schedule still exists after destroy" aws scheduler get-schedule --name "${SCHED}" --region "${REGION}"
echo "    OK: schedule gone"
GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> eventbridge-scheduler test passed"
