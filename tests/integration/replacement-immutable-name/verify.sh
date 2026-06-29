#!/usr/bin/env bash
# verify.sh — cdkd immutable-Name replacement integ (6 resource types).
#
# Each resource's NAME is immutable in CloudFormation ("Update requires:
# Replacement"). cdkd previously had no replacement rule for these types, so a
# rename was attempted as an in-place update and silently diverged cdkd state
# from AWS (rename dropped; Events Rule / CloudWatch Alarm even created a SECOND
# resource and orphaned the old one). This test proves cdkd now REPLACES
# (DELETE old + CREATE new) on a rename.
#
#   covers: Kinesis::Stream, SecretsManager::Secret, StepFunctions::StateMachine,
#           Events::Rule, SSM::Parameter, CloudWatch::Alarm
#
# Phases:
#   1. Deploy v1; assert every -v1 resource exists.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (names -> -v2). Assert every -v2
#      resource exists AND every -v1 resource is GONE (replacement, not in-place
#      no-op / orphan). A pre-fix run leaves -v1 alive (and v2 absent, or v2 an
#      orphan alongside v1 for Rule/Alarm).
#   3. Destroy; assert every -v2 resource is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdReplacementImmutableNameExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# --- existence helpers (async-delete aware where needed) ---------------
stream_live() {
  # Kinesis DeleteStream is async (StreamStatus=DELETING) — treat that as gone.
  local s
  s="$(aws kinesis describe-stream-summary --stream-name "$1" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>/dev/null)" || return 1
  [ -n "${s}" ] && [ "${s}" != "DELETING" ] && [ "${s}" != "None" ]
}
secret_active() {
  local n; n="$(aws secretsmanager list-secrets --region "${REGION}" \
    --query "SecretList[?Name=='$1'].Name | [0]" --output text 2>/dev/null)"
  [ "${n}" = "$1" ]
}
sm_live() {
  # DeleteStateMachine is async (status=DELETING) — treat that as gone. Match by name.
  local arn st
  arn="$(aws stepfunctions list-state-machines --region "${REGION}" \
    --query "stateMachines[?name=='$1'].stateMachineArn | [0]" --output text 2>/dev/null)"
  [ -n "${arn}" ] && [ "${arn}" != "None" ] || return 1
  st="$(aws stepfunctions describe-state-machine --state-machine-arn "${arn}" --region "${REGION}" \
    --query 'status' --output text 2>/dev/null)" || return 1
  [ "${st}" != "DELETING" ]
}
rule_exists() {
  local n; n="$(aws events list-rules --name-prefix "$1" --region "${REGION}" \
    --query "Rules[?Name=='$1'].Name | [0]" --output text 2>/dev/null)"
  [ "${n}" = "$1" ]
}
param_exists() {
  aws ssm get-parameter --name "$1" --region "${REGION}" >/dev/null 2>&1
}
alarm_exists() {
  local n; n="$(aws cloudwatch describe-alarms --alarm-names "$1" --region "${REGION}" \
    --query 'MetricAlarms[0].AlarmName' --output text 2>/dev/null)"
  [ "${n}" = "$1" ]
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for s in v1 v2; do
    aws kinesis delete-stream --stream-name "${STACK}-stream-${s}" --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1
    aws secretsmanager delete-secret --secret-id "${STACK}-secret-${s}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
    local arn
    arn="$(aws stepfunctions list-state-machines --region "${REGION}" --query "stateMachines[?name=='${STACK}-sm-${s}'].stateMachineArn | [0]" --output text 2>/dev/null)"
    [ -n "${arn}" ] && [ "${arn}" != "None" ] && aws stepfunctions delete-state-machine --state-machine-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
    aws events delete-rule --name "${STACK}-rule-${s}" --region "${REGION}" >/dev/null 2>&1
    aws ssm delete-parameter --name "/${STACK}/param-${s}" --region "${REGION}" >/dev/null 2>&1
    aws cloudwatch delete-alarms --alarm-names "${STACK}-alarm-${s}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy v1 -----------------------------------------------
echo "==> Phase 1: deploy v1 (6 resources)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

stream_live  "${STACK}-stream-v1" || { echo "FAIL: stream-v1 missing after Phase 1" >&2; exit 1; }
secret_active "${STACK}-secret-v1" || { echo "FAIL: secret-v1 missing after Phase 1" >&2; exit 1; }
sm_live      "${STACK}-sm-v1"     || { echo "FAIL: sm-v1 missing after Phase 1" >&2; exit 1; }
rule_exists  "${STACK}-rule-v1"   || { echo "FAIL: rule-v1 missing after Phase 1" >&2; exit 1; }
param_exists "/${STACK}/param-v1" || { echo "FAIL: param-v1 missing after Phase 1" >&2; exit 1; }
alarm_exists "${STACK}-alarm-v1"  || { echo "FAIL: alarm-v1 missing after Phase 1" >&2; exit 1; }
echo "    all 6 v1 resources present"

# --- Phase 2: rename -> v2 (must REPLACE) -----------------------------
# stream (Kinesis), secret (SecretsManager) and param (SSM) are stateful types,
# so a property-driven replacement (the immutable Name change) requires
# --force-stateful-recreation to confirm the data-losing DELETE+CREATE; without
# it the deploy is correctly blocked (STATEFUL_REPLACE_BLOCKED). The other three
# (sm=StateMachine, rule=Events::Rule, alarm=CloudWatch::Alarm) are ephemeral
# and would replace without the flag, but a single deploy uses one flag set.
echo "==> Phase 2: re-deploy renaming all to -v2 (must replace, not in-place)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force-stateful-recreation --yes

# new -v2 present
stream_live  "${STACK}-stream-v2" || { echo "FAIL: stream-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
secret_active "${STACK}-secret-v2" || { echo "FAIL: secret-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
sm_live      "${STACK}-sm-v2"     || { echo "FAIL: sm-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
rule_exists  "${STACK}-rule-v2"   || { echo "FAIL: rule-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
param_exists "/${STACK}/param-v2" || { echo "FAIL: param-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
alarm_exists "${STACK}-alarm-v2"  || { echo "FAIL: alarm-v2 missing after Phase 2 (rename not applied)" >&2; exit 1; }
# old -v1 gone (no in-place no-op, no orphan)
stream_live  "${STACK}-stream-v1" && { echo "FAIL: stream-v1 still live after Phase 2 (not replaced)" >&2; exit 1; }
secret_active "${STACK}-secret-v1" && { echo "FAIL: secret-v1 still active after Phase 2 (not replaced)" >&2; exit 1; }
sm_live      "${STACK}-sm-v1"     && { echo "FAIL: sm-v1 still live after Phase 2 (not replaced)" >&2; exit 1; }
rule_exists  "${STACK}-rule-v1"   && { echo "FAIL: rule-v1 still exists after Phase 2 (orphaned)" >&2; exit 1; }
param_exists "/${STACK}/param-v1" && { echo "FAIL: param-v1 still exists after Phase 2 (not replaced)" >&2; exit 1; }
alarm_exists "${STACK}-alarm-v1"  && { echo "FAIL: alarm-v1 still exists after Phase 2 (orphaned)" >&2; exit 1; }
echo "    replacement confirmed for all 6: -v2 present, -v1 gone"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

stream_live  "${STACK}-stream-v2" && { echo "FAIL: stream-v2 still live after destroy" >&2; exit 1; }
secret_active "${STACK}-secret-v2" && { echo "FAIL: secret-v2 still active after destroy" >&2; exit 1; }
sm_live      "${STACK}-sm-v2"     && { echo "FAIL: sm-v2 still live after destroy" >&2; exit 1; }
rule_exists  "${STACK}-rule-v2"   && { echo "FAIL: rule-v2 still exists after destroy" >&2; exit 1; }
param_exists "/${STACK}/param-v2" && { echo "FAIL: param-v2 still exists after destroy" >&2; exit 1; }
alarm_exists "${STACK}-alarm-v2"  && { echo "FAIL: alarm-v2 still exists after destroy" >&2; exit 1; }
echo "    all 6 v2 resources deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — immutable-Name replacement across 6 types, all 3 phases passed"
