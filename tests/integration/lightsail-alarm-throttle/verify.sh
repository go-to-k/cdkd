#!/usr/bin/env bash
# verify.sh -- cdkd Lightsail PutAlarm throttle integ (issue #6830).
# Deploys one Lightsail instance and 16 alarms on it in one burst, asserts every
# alarm reached Lightsail through the SDK provider, then destroys clean.
# PutAlarm / DeleteAlarm refill one token per second; through Cloud Control the
# burst throttled the handler's create AND its clean-up delete, and the retry
# met the leftover alarm as "already exists" (measured before #6830's fix).

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

STACK="CdkdLightsailAlarmThrottleExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
INSTANCE="${STACK}-instance"
ALARM_COUNT=16
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for i in 0 1 2 3 4 5 6 7; do
    for s in 1 2; do
      aws lightsail delete-alarm --alarm-name "${STACK}-alarm-${i}-${s}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  done
  aws lightsail delete-instance --instance-name "${INSTANCE}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${DEPLOY_LOG}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
DEPLOY_LOG="$(mktemp)"

echo "==> Deploy (${ALARM_COUNT} alarms in one burst)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --concurrency "${ALARM_COUNT}" --yes 2>&1 | tee "${DEPLOY_LOG}"

# The provider paces its own calls, so no alarm should reach the engine's retry.
RETRIES=$(grep -c 'Retrying Alarm' "${DEPLOY_LOG}" || true)
echo "    INFO: ${RETRIES} engine-level alarm create retr(y/ies) in this run"

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
BY="$(jq -r '.resources.Alarm0x1.provisionedBy // "<absent>"' <<<"${STATE_JSON}")"
if [ "${BY}" != "sdk" ]; then
  echo "FAIL: Alarm0x1 provisionedBy is '${BY}', expected 'sdk'" >&2
  exit 1
fi
echo "    OK: alarms provisioned through the SDK provider"

ALARMS=$(aws lightsail get-alarms --monitored-resource-name "${INSTANCE}" --region "${REGION}" \
  --query 'length(alarms)' --output text)
if [ "${ALARMS}" != "${ALARM_COUNT}" ]; then
  echo "FAIL: ${ALARMS} alarms on ${INSTANCE}, expected ${ALARM_COUNT}" >&2
  exit 1
fi
echo "    OK: ${ALARM_COUNT} alarms on ${INSTANCE}"

# One alarm's settings read back, so a PutAlarm member dropped on the wire fails.
SETTINGS=$(aws lightsail get-alarms --alarm-name "${STACK}-alarm-0-2" --region "${REGION}" \
  --query 'alarms[0].[metricName,comparisonOperator,threshold,evaluationPeriods]' --output json)
if ! jq -e '.[0] == "CPUUtilization" and .[1] == "GreaterThanOrEqualToThreshold" and .[2] == 99 and .[3] == 1' \
  >/dev/null <<<"${SETTINGS}"; then
  echo "FAIL: alarm-0-2 settings are ${SETTINGS}" >&2
  exit 1
fi
echo "    OK: alarm-0-2 settings reached Lightsail"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for i in 0 1 2 3 4 5 6 7; do
  for s in 1 2; do
    assert_gone "alarm ${STACK}-alarm-${i}-${s} still exists after destroy" \
      aws lightsail get-alarms --alarm-name "${STACK}-alarm-${i}-${s}" --region "${REGION}"
  done
done
echo "    OK: alarms gone"
GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws lightsail get-instance --instance-name "${INSTANCE}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: instance ${INSTANCE} still exists after destroy" >&2; exit 1; }
echo "    OK: instance gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"
echo ""
echo "[verify] PASS -- lightsail-alarm-throttle"
