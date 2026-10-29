#!/usr/bin/env bash
# verify.sh — cdkd CloudWatch integ: log group + metric filter + alarm + SNS.
# Asserts the AWS::CloudWatch::Alarm WarmUpConfiguration / ActionConfiguration
# backfill (go-to-k/cdkd#2762) reaches AWS on the SDK route, that an update
# changes one and REMOVES the other on AWS, then destroys clean.
#
#   1 deploy             -- both declared; read back from DescribeAlarms;
#                           cdkd drift clean
#   2 CDKD_TEST_UPDATE   -- warm-up changed (OnlyStartEvaluating... declared
#                           false), ActionConfiguration removed; drift clean
#   3 destroy            -- alarm, topic, log group and state gone

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
TOPIC_ARN=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  [ -n "${ALARM_NAME}" ] && aws cloudwatch delete-alarms --alarm-names "${ALARM_NAME}" --region "${REGION}" >/dev/null 2>&1
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
alarm_record() { # usage: alarm_record <jq-filter applied to the alarm's record>
  state_json | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::CloudWatch::Alarm") | .value]
    | if length == 1 then .[0] else error("expected exactly one alarm record, got \(length)") end | '"$1"
}

# The alarm's member as JSON (`null` when unset), read through the SDK rather
# than `aws cloudwatch describe-alarms`: the CLI silently drops a response
# field its bundled model does not know (measured for EvaluationWindow on
# aws-cli 2.34.37, see sdk-to-cc-autoroute/verify.sh), which would turn the
# removal assertion below into a vacuous pass.
alarm_member_json() { # usage: alarm_member_json <MetricAlarm member>
  ( cd "${REPO_ROOT}" && REGION="${REGION}" ALARM="${ALARM_NAME}" MEMBER="$1" node --input-type=module -e "
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
const client = new CloudWatchClient({ region: process.env.REGION });
const res = await client.send(new DescribeAlarmsCommand({ AlarmNames: [process.env.ALARM] }));
const alarms = res.MetricAlarms ?? [];
if (alarms.length !== 1) {
  console.error('expected exactly one alarm named ' + process.env.ALARM + ', got ' + alarms.length);
  process.exit(1);
}
process.stdout.write(JSON.stringify(alarms[0][process.env.MEMBER] ?? null));
" ) || { echo "FAIL: could not read $1 of alarm ${ALARM_NAME}" >&2; exit 1; }
}
assert_member() { # usage: assert_member <member> <jq-expression over it that must be true>
  local got
  got="$(alarm_member_json "$1")"
  if ! printf '%s' "${got}" | jq -e "$2" >/dev/null; then
    echo "FAIL: alarm ${ALARM_NAME} ${1} is ${got}; expected it to satisfy: $2 (silent drop?)" >&2
    exit 1
  fi
  echo "    OK: ${1} = ${got}"
}
# `cdkd drift` must report the stack clean right after a deploy: the alarm's
# readCurrentState now carries WarmUpConfiguration / ActionConfiguration as
# AWS answers them, and a member AWS leaves out (Phase 2 declares
# OnlyStartEvaluatingAfterWarmUpPeriodEnds: false explicitly) must not read
# as drift (go-to-k/cdkd#2762).
assert_no_drift() { # usage: assert_no_drift <phase label>
  local out rc=0
  out="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || rc=$?
  if [ "${rc}" != 0 ]; then
    echo "FAIL: cdkd drift after $1 exited ${rc}, expected 0 (a phantom drift on a stack nothing touched since its deploy). Report: ${out}" >&2
    exit 1
  fi
  if ! printf '%s' "${out}" | jq -e '[.[].clean[] | select(.type == "AWS::CloudWatch::Alarm")] | length == 1' >/dev/null; then
    echo "FAIL: cdkd drift after $1 does not list the alarm as compared and clean. Report: ${out}" >&2
    exit 1
  fi
  echo "    OK: cdkd drift after $1 is clean, the alarm compared"
}
assert_sdk_route() {
  local by
  by="$(alarm_record '.provisionedBy // "sdk"')"
  [ "${by}" = "sdk" ] || { echo "FAIL: AWS::CloudWatch::Alarm routing layer is '${by}', expected 'sdk' (go-to-k/cdkd#2762: the backfilled properties must not route it to Cloud Control)" >&2; exit 1; }
  echo "    OK: alarm stayed on the SDK route"
}

echo "==> Phase 1: deploy with WarmUpConfiguration + ActionConfiguration"
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
assert_no_drift "Phase 1"

echo "==> Phase 2: update -- warm-up changed, ActionConfiguration removed"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_sdk_route
assert_member WarmUpConfiguration '.WarmUpPeriodDurationInMinutes == 30 and (.OnlyStartEvaluatingAfterWarmUpPeriodEnds // false) == false'
# A removal: PutMetricAlarm replaces the whole configuration, so the absent
# member must leave the alarm with no tag propagation. AWS may answer the
# cleared member as absent or as a disabled propagation; either is cleared.
assert_member ActionConfiguration '. == null or (.AlarmTagsPropagation.Enabled // false) == false'
assert_no_drift "Phase 2"

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
assert_gone "topic ${TOPIC_ARN} remains" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: topic gone"
LOG_LEFT="$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${REGION}" --query "length(logGroups[?logGroupName=='${LOG_GROUP}'])" --output text)"
[ "${LOG_LEFT}" = "0" ] || { echo "FAIL: log group ${LOG_GROUP} remains" >&2; exit 1; }
echo "    OK: log group gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> cloudwatch test passed"
