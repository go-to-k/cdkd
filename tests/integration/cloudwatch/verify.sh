#!/usr/bin/env bash
# verify.sh — cdkd CloudWatch integ: log group + metric filter + alarm + SNS.
# Asserts the AWS::CloudWatch::Alarm WarmUpConfiguration / ActionConfiguration
# backfill (go-to-k/cdkd#2762) and the EvaluationWindow / EvaluationCriteria /
# EvaluationInterval one (go-to-k/cdkd#5524) reach AWS on the SDK route, that an
# update changes or REMOVES them on AWS, then destroys clean.
#
#   1 deploy             -- WarmUp + ActionConfiguration + a wall-clock
#                           EvaluationWindow declared; read back from
#                           DescribeAlarms; cdkd drift clean
#   2 CDKD_TEST_UPDATE   -- warm-up changed (OnlyStartEvaluating... declared
#                           false), ActionConfiguration and EvaluationWindow
#                           removed; drift clean (no phantom default window)
#   2b out-of-band window -- a wall-clock window set in AWS is drift, and
#                           drift --revert restores the default
#   3 + CDKD_TEST_PROMQL -- a PromQL alarm (EvaluationCriteria +
#                           EvaluationInterval, no metric members) created on
#                           the SDK route; drift clean
#   4 drift --revert     -- an out-of-band EvaluationInterval change is
#                           reported and reverted: the readback goes back
#                           through PutMetricAlarm without a metric member
#   5 interval 60 -> 120 -- an in-place update of the PromQL alarm
#   6 destroy            -- both alarms, topic, log group and state gone

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

STACK="CloudWatchStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOG_GROUP="/cdkd/cloudwatch-example/${STACK}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
REPO_ROOT="${PWD}/../../.."
ALARM_NAME=""
PROMQL_ALARM_NAME="${STACK}-promql"
# Must equal lib/cloudwatch-stack.ts's query. Exported: jq reads it as
# $ENV.PROMQL_QUERY and the out-of-band node call as process.env.
export PROMQL_QUERY='avg(rate(http_requests_total[5m])) > 100'
TOPIC_ARN=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  [ -n "${ALARM_NAME}" ] && aws cloudwatch delete-alarms --alarm-names "${ALARM_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws cloudwatch delete-alarms --alarm-names "${PROMQL_ALARM_NAME}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${TOPIC_ARN}" ] && aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
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

state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}
# The record of the alarm whose logical id starts with $1 (`ErrorAlarm` or
# `PromQLAlarm`): phase 3 adds a second alarm, so the type alone no longer
# names one.
record_of() { # usage: record_of <logical-id prefix> <jq-filter applied to the record>
  state_json | jq -r --arg p "$1" '[.resources | to_entries[] | select(.value.resourceType == "AWS::CloudWatch::Alarm" and (.key | startswith($p))) | .value]
    | if length == 1 then .[0] else error("expected exactly one \($p) alarm record, got \(length)") end | '"$2"
}
alarm_record() { # usage: alarm_record <jq-filter applied to the ErrorAlarm record>
  record_of ErrorAlarm "$1"
}

# The alarm's member as JSON (`null` when unset), read through the SDK rather
# than `aws cloudwatch describe-alarms`: the CLI silently drops a response
# field its bundled model does not know (measured for EvaluationWindow on
# aws-cli 2.34.37, see sdk-to-cc-autoroute/verify.sh), which would turn the
# removal assertion below into a vacuous pass.
alarm_member_json() { # usage: alarm_member_json <MetricAlarm member> [alarm name]
  ( cd "${REPO_ROOT}" && REGION="${REGION}" ALARM="${2:-${ALARM_NAME}}" MEMBER="$1" node --input-type=module -e "
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
const client = new CloudWatchClient({ region: process.env.REGION });
const res = await client.send(new DescribeAlarmsCommand({ AlarmNames: [process.env.ALARM] }));
const alarms = res.MetricAlarms ?? [];
if (alarms.length !== 1) {
  console.error('expected exactly one alarm named ' + process.env.ALARM + ', got ' + alarms.length);
  process.exit(1);
}
process.stdout.write(JSON.stringify(alarms[0][process.env.MEMBER] ?? null));
" ) || { echo "FAIL: could not read $1 of alarm ${2:-${ALARM_NAME}}" >&2; exit 1; }
}
assert_member() { # usage: assert_member <member> <jq-expression over it that must be true> [alarm name]
  local got name="${3:-${ALARM_NAME}}"
  got="$(alarm_member_json "$1" "${name}")"
  if ! printf '%s' "${got}" | jq -e "$2" >/dev/null; then
    echo "FAIL: alarm ${name} ${1} is ${got}; expected it to satisfy: $2 (silent drop?)" >&2
    exit 1
  fi
  echo "    OK: ${name} ${1} = ${got}"
}
# `cdkd drift` must report the stack clean right after a deploy: the alarm's
# readCurrentState now carries WarmUpConfiguration / ActionConfiguration as
# AWS answers them, and a member AWS leaves out (Phase 2 declares
# OnlyStartEvaluatingAfterWarmUpPeriodEnds: false explicitly) must not read
# as drift (go-to-k/cdkd#2762).
assert_no_drift() { # usage: assert_no_drift <phase label> [alarm count, default 1]
  local out rc=0
  out="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || rc=$?
  if [ "${rc}" != 0 ]; then
    echo "FAIL: cdkd drift after $1 exited ${rc}, expected 0 (a phantom drift on a stack nothing touched since its deploy). Report: ${out}" >&2
    exit 1
  fi
  if ! printf '%s' "${out}" | jq -e --argjson n "${2:-1}" '[.[].clean[] | select(.type == "AWS::CloudWatch::Alarm")] | length == $n' >/dev/null; then
    echo "FAIL: cdkd drift after $1 does not list ${2:-1} alarm(s) as compared and clean. Report: ${out}" >&2
    exit 1
  fi
  echo "    OK: cdkd drift after $1 is clean, ${2:-1} alarm(s) compared"
}
assert_sdk_route() { # usage: assert_sdk_route [logical-id prefix, default ErrorAlarm]
  local by
  by="$(record_of "${1:-ErrorAlarm}" '.provisionedBy // "sdk"')"
  [ "${by}" = "sdk" ] || { echo "FAIL: ${1:-ErrorAlarm} routing layer is '${by}', expected 'sdk' (go-to-k/cdkd#2762 / #5524: the backfilled properties must not route it to Cloud Control)" >&2; exit 1; }
  echo "    OK: ${1:-ErrorAlarm} stayed on the SDK route"
}

echo "==> Phase 1: deploy with WarmUpConfiguration + ActionConfiguration + EvaluationWindow"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
ALARM_NAME="$(alarm_record '.physicalId // empty')"
[ -n "${ALARM_NAME}" ] || { echo "FAIL: no alarm physical id in state" >&2; exit 1; }
TOPIC_ARN="$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::Topic") | .value.physicalId // empty')"
[ -n "${TOPIC_ARN}" ] || { echo "FAIL: no SNS topic physical id in state" >&2; exit 1; }
assert_sdk_route
assert_member WarmUpConfiguration '.WarmUpPeriodDurationInMinutes == 15 and .OnlyStartEvaluatingAfterWarmUpPeriodEnds == true'
assert_member ActionConfiguration '.AlarmTagsPropagation.Enabled == true and .AlarmTagsPropagation.IncludedTagKeys == ["Team"]'
# readCurrentState carries this member as read, and `drift --revert` sends that
# readback to PutMetricAlarm. An EMPTY ExcludedTagKeys beside IncludedTagKeys
# would then send both lists, which AWS refuses. Fail here so the readback is
# normalized if AWS ever answers that way.
EXCLUDED_GOT="$(alarm_member_json ActionConfiguration)"
if printf '%s' "${EXCLUDED_GOT}" | jq -e '.AlarmTagsPropagation | has("ExcludedTagKeys")' >/dev/null; then
  echo "FAIL: AWS answers ActionConfiguration as ${EXCLUDED_GOT}: an ExcludedTagKeys beside the declared IncludedTagKeys. readCurrentState carries it as read, so a drift --revert would send both lists, which PutMetricAlarm refuses; normalize the readback in cloudwatch-alarm-provider.ts (go-to-k/cdkd#2762)" >&2
  exit 1
fi
echo "    OK: ActionConfiguration readback carries no ExcludedTagKeys"
assert_member EvaluationWindow '.WallClockWindow.Timezone == "UTC" and (has("SlidingWindow") | not)'
assert_no_drift "Phase 1"

echo "==> Phase 2: update -- warm-up changed, ActionConfiguration and EvaluationWindow removed"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_sdk_route
assert_member WarmUpConfiguration '.WarmUpPeriodDurationInMinutes == 30 and (.OnlyStartEvaluatingAfterWarmUpPeriodEnds // false) == false'
# A removal: PutMetricAlarm replaces the whole configuration, so the absent
# member must leave the alarm with no tag propagation. AWS may answer the
# cleared member as absent or as a disabled propagation; either is cleared.
assert_member ActionConfiguration '. == null or (.AlarmTagsPropagation.Enabled // false) == false'
# go-to-k/cdkd#5524: the removed window falls back to AWS's default, which AWS
# may answer as absent or as an explicit `SlidingWindow: {}`. Either is the
# default; the drift check below is what proves the explicit form is not
# reported as a phantom change.
assert_member EvaluationWindow '. == null or . == {"SlidingWindow": {}}'
assert_no_drift "Phase 2"
# The readback emits EvaluationInterval for a PromQL alarm only, because
# PutMetricAlarm refuses it beside MetricName. Whether AWS reports one on a
# metric alarm is measured here, not assumed; either answer is safe.
EI_METRIC="$(alarm_member_json EvaluationInterval)"
[ "${EI_METRIC}" = "null" ] || echo "    NOTE: AWS reports EvaluationInterval=${EI_METRIC} on the metric alarm; the readback leaves it out (go-to-k/cdkd#5524)"

echo "==> Phase 2b: a wall-clock window set out of band is drift, and --revert restores the default"
# The template is on the default window now, so the recorded baseline carries
# no EvaluationWindow; getDriftAbsentMeansDefaultKeys is what keeps the key
# compared (go-to-k/cdkd#5524). The out-of-band call re-sends the alarm's own
# configuration, as read, plus the window, so the window is the only change.
( cd "${REPO_ROOT}" && REGION="${REGION}" ALARM="${ALARM_NAME}" node --input-type=module -e "
import { CloudWatchClient, DescribeAlarmsCommand, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';
const client = new CloudWatchClient({ region: process.env.REGION });
const res = await client.send(new DescribeAlarmsCommand({ AlarmNames: [process.env.ALARM] }));
const a = (res.MetricAlarms ?? [])[0];
if (!a) { console.error('alarm ' + process.env.ALARM + ' not found'); process.exit(1); }
const keep = ['AlarmName', 'AlarmDescription', 'ActionsEnabled', 'OKActions', 'AlarmActions',
  'InsufficientDataActions', 'MetricName', 'Namespace', 'Statistic', 'ExtendedStatistic',
  'Dimensions', 'Period', 'Unit', 'EvaluationPeriods', 'DatapointsToAlarm', 'Threshold',
  'ComparisonOperator', 'TreatMissingData', 'EvaluateLowSampleCountPercentile',
  'WarmUpConfiguration', 'ActionConfiguration'];
const input = Object.fromEntries(keep.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
input.EvaluationWindow = { WallClockWindow: { Timezone: 'UTC' } };
await client.send(new PutMetricAlarmCommand(input));
" ) || { echo "FAIL: could not set ${ALARM_NAME}'s EvaluationWindow out of band" >&2; exit 1; }
assert_member EvaluationWindow '.WallClockWindow.Timezone == "UTC"'
WIN_RC=0
WIN_DRIFT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || WIN_RC=$?
[ "${WIN_RC}" != 0 ] || { echo "FAIL: cdkd drift did not report the out-of-band EvaluationWindow (rc=0); a console-set window on a default-window alarm is invisible (go-to-k/cdkd#5524). Report: ${WIN_DRIFT}" >&2; exit 1; }
printf '%s' "${WIN_DRIFT}" | grep -qF EvaluationWindow || {
  echo "FAIL: cdkd drift exited ${WIN_RC} but does not name EvaluationWindow. Report: ${WIN_DRIFT}" >&2; exit 1; }
echo "    OK: drift reports the out-of-band EvaluationWindow"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
assert_member EvaluationWindow '. == null or . == {"SlidingWindow": {}}'
assert_no_drift "Phase 2b"

echo "==> Phase 3: a PromQL alarm -- EvaluationCriteria + EvaluationInterval on the SDK route"
CDKD_TEST_UPDATE=true CDKD_TEST_PROMQL=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(record_of PromQLAlarm '.physicalId // empty')" = "${PROMQL_ALARM_NAME}" ] || {
  echo "FAIL: no PromQLAlarm record named ${PROMQL_ALARM_NAME} in state" >&2; exit 1; }
assert_sdk_route PromQLAlarm
assert_member EvaluationCriteria '.PromQLCriteria.Query == $ENV.PROMQL_QUERY' "${PROMQL_ALARM_NAME}"
assert_member EvaluationInterval '. == 60' "${PROMQL_ALARM_NAME}"
# The premise of the readback guard: AWS holds none of the metric members for a
# PromQL alarm, so the readback emitting none of them loses nothing.
assert_member Dimensions '. == null or . == []' "${PROMQL_ALARM_NAME}"
assert_member MetricName '. == null' "${PROMQL_ALARM_NAME}"
assert_member EvaluationWindow '. == null or . == {"SlidingWindow": {}}' "${PROMQL_ALARM_NAME}"
assert_no_drift "Phase 3" 2

echo "==> Phase 4: drift --revert sends the PromQL alarm's readback back through PutMetricAlarm"
# Out of band: the same alarm with a different interval. `drift --revert` then
# sends the recorded readback to update(), which is where an always-emit
# metric placeholder (`Dimensions: []`) beside EvaluationCriteria would make
# PutMetricAlarm refuse the call (go-to-k/cdkd#5524).
( cd "${REPO_ROOT}" && REGION="${REGION}" ALARM="${PROMQL_ALARM_NAME}" node --input-type=module -e "
import { CloudWatchClient, PutMetricAlarmCommand } from '@aws-sdk/client-cloudwatch';
const client = new CloudWatchClient({ region: process.env.REGION });
await client.send(new PutMetricAlarmCommand({
  AlarmName: process.env.ALARM,
  AlarmDescription: 'cdkd integ: PromQL alarm (go-to-k/cdkd#5524)',
  EvaluationCriteria: { PromQLCriteria: { Query: process.env.PROMQL_QUERY } },
  EvaluationInterval: 180,
}));
" ) || { echo "FAIL: could not change ${PROMQL_ALARM_NAME} out of band" >&2; exit 1; }
assert_member EvaluationInterval '. == 180' "${PROMQL_ALARM_NAME}"
DRIFT_RC=0
DRIFT_BEFORE="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || DRIFT_RC=$?
[ "${DRIFT_RC}" != 0 ] || { echo "FAIL: cdkd drift did not report the out-of-band EvaluationInterval change (rc=0); the revert below would test nothing. Report: ${DRIFT_BEFORE}" >&2; exit 1; }
printf '%s' "${DRIFT_BEFORE}" | grep -qF EvaluationInterval || {
  echo "FAIL: cdkd drift exited ${DRIFT_RC} but does not name EvaluationInterval. Report: ${DRIFT_BEFORE}" >&2; exit 1; }
echo "    OK: drift reports the EvaluationInterval change"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
assert_member EvaluationInterval '. == 60' "${PROMQL_ALARM_NAME}"
assert_member EvaluationCriteria '.PromQLCriteria.Query == $ENV.PROMQL_QUERY' "${PROMQL_ALARM_NAME}"
assert_no_drift "Phase 4" 2

echo "==> Phase 5: update the PromQL alarm in place (interval 60 -> 120)"
CDKD_TEST_UPDATE=true CDKD_TEST_PROMQL=true CDKD_TEST_PROMQL_INTERVAL=120 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_sdk_route PromQLAlarm
assert_member EvaluationInterval '. == 120' "${PROMQL_ALARM_NAME}"
assert_no_drift "Phase 5" 2

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  COUNT="$(aws cloudwatch describe-alarms --alarm-names "${ALARM_NAME}" --region "${REGION}" --query 'length(MetricAlarms)' --output text)"
  if [ "${COUNT}" = "0" ]; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: alarm ${ALARM_NAME} still exists after destroy" >&2; exit 1; }
echo "    OK: alarm gone"
PROMQL_LEFT="$(aws cloudwatch describe-alarms --alarm-names "${PROMQL_ALARM_NAME}" --region "${REGION}" --output json | jq '.MetricAlarms | length')"
[ "${PROMQL_LEFT}" = "0" ] || { echo "FAIL: alarm ${PROMQL_ALARM_NAME} still exists after destroy" >&2; exit 1; }
echo "    OK: PromQL alarm gone"
assert_gone "topic ${TOPIC_ARN} remains" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: topic gone"
LOG_LEFT="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${REGION}" --query "length(logGroups[?logGroupName=='${LOG_GROUP}'])" --output text)"
[ "${LOG_LEFT}" = "0" ] || { echo "FAIL: log group ${LOG_GROUP} remains" >&2; exit 1; }
echo "    OK: log group gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> cloudwatch test passed"
