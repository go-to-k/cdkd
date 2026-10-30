#!/usr/bin/env bash
# verify.sh - cdkd eventbridge integ + LogConfig backfill assertion (#609)
# + removal of the bus's optional properties (#1160, Phase 1.75).
#
# Deploys the eventbridge fixture and asserts that LogConfig reaches AWS
# via the CreateEventBus wire path (no separate control-plane API). Then
# destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="EventBridgeStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUS_NAME="cdkd-test-bus-${ACCOUNT_ID}"
SOURCE_KEY_FN="cdkd-test-source-key-fn-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Fixed name: a leftover would collide with the next run's CreateFunction.
  aws lambda delete-function --function-name "${SOURCE_KEY_FN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# --- Assertion: LogConfig reached AWS via CreateEventBus --------------
BUS=$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}")
LOG_LEVEL=$(echo "${BUS}" | jq -r '.LogConfig.Level // empty')
INCLUDE_DETAIL=$(echo "${BUS}" | jq -r '.LogConfig.IncludeDetail // empty')

if [ "${LOG_LEVEL}" != "INFO" ]; then
  echo "FAIL: EventBus LogConfig.Level is '${LOG_LEVEL}', expected 'INFO'" >&2
  echo "      raw describe-event-bus: ${BUS}" >&2
  exit 1
fi
if [ "${INCLUDE_DETAIL}" != "FULL" ]; then
  echo "FAIL: EventBus LogConfig.IncludeDetail is '${INCLUDE_DETAIL}', expected 'FULL'" >&2
  echo "      raw describe-event-bus: ${BUS}" >&2
  exit 1
fi
echo "    OK: EventBus LogConfig.Level == 'INFO' + IncludeDetail == 'FULL' on AWS (LogConfig backfill CLOSED)"
PRE_CREATED=$(echo "${BUS}" | jq -r '.CreationTime // empty')
PRE_DESC=$(echo "${BUS}" | jq -r '.Description // empty')
if [ "${PRE_DESC}" != "cdkd test bus" ]; then
  echo "FAIL: EventBus Description is '${PRE_DESC}' after create, expected 'cdkd test bus'" >&2
  exit 1
fi
# Issue #1160 baseline: the KMS key and the DLQ the removal phase drops are
# live first, so their absence afterwards is the removal's doing.
BUS_KEY_ARN=$(echo "${BUS}" | jq -r '.KmsKeyIdentifier // empty')
BUS_DLQ_ARN=$(echo "${BUS}" | jq -r '.DeadLetterConfig.Arn // empty')
if [ -z "${BUS_KEY_ARN}" ] || [ -z "${BUS_DLQ_ARN}" ]; then
  echo "FAIL: EventBus KmsKeyIdentifier='${BUS_KEY_ARN}' DeadLetterConfig.Arn='${BUS_DLQ_ARN}' after create, expected both set" >&2
  echo "      raw describe-event-bus: ${BUS}" >&2
  exit 1
fi
echo "    OK: EventBus KmsKeyIdentifier + DeadLetterConfig set on AWS"

# --- Assertion: Code.SourceKMSKeyArn reached AWS (issue #5300) --------
# usage: assert_source_key <phase label>
assert_source_key() {
  local got
  got=$(aws lambda get-function --function-name "${SOURCE_KEY_FN}" --region "${REGION}" \
    --query 'Code.SourceKMSKeyArn' --output text) || return 1
  if [ "${got}" != "${BUS_KEY_ARN}" ]; then
    echo "FAIL: $1: ${SOURCE_KEY_FN} Code.SourceKMSKeyArn is '${got}', expected the fixture key ${BUS_KEY_ARN} (issue #5300: the key was not sent)" >&2
    exit 1
  fi
  echo "    OK: $1: ${SOURCE_KEY_FN} package encrypted with the fixture key (issue #5300)"
}
source_key_sha() {
  aws lambda get-function-configuration --function-name "${SOURCE_KEY_FN}" --region "${REGION}" \
    --query 'CodeSha256' --output text
}
assert_source_key "create"
SOURCE_KEY_SHA_P1=$(source_key_sha)

# --- Assertion: Ref on AWS::Events::Rule resolves to the rule name ----
# (bug found by /hunt-bugs 2026-07-02: cdkd returned the rule ARN; CFn's Ref
# returns the rule name — `<busName>|<ruleName>` for a custom-bus rule.)
RULE_NAME=$(aws events list-rules --event-bus-name "${BUS_NAME}" --region "${REGION}" \
  --query "Rules[0].Name" --output text)
RULE_REF=$(aws ssm get-parameter --name "/${STACK}/rule-ref" --region "${REGION}" \
  --query Parameter.Value --output text)
if [ "${RULE_REF}" != "${BUS_NAME}|${RULE_NAME}" ]; then
  echo "FAIL: Ref on AWS::Events::Rule resolved to '${RULE_REF}', expected '${BUS_NAME}|${RULE_NAME}'" >&2
  exit 1
fi
echo "    OK: Ref on AWS::Events::Rule == '${BUS_NAME}|${RULE_NAME}' (rule name, not ARN)"

# --- Phase 1.5: UPDATE drops the rule while keeping the bus (issue #955) ---
# Re-deploy without the rule: the diff-driven standalone delete of a
# custom-bus rule must address the CUSTOM bus. Before the fix the delete
# hit the default bus, reported "does not exist", silently no-oped, and
# left the rule orphaned on AWS.
echo "==> Phase 1.5: update (drop the custom-bus rule, keep the bus, change its Description)"
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

REMAINING_RULES=$(aws events list-rules --event-bus-name "${BUS_NAME}" --region "${REGION}" \
  --query "length(Rules)" --output text)
if [ "${REMAINING_RULES}" != "0" ]; then
  echo "FAIL: custom bus '${BUS_NAME}' still has ${REMAINING_RULES} rule(s) after the rule was removed from the template (standalone custom-bus rule delete no-oped — issue #955)" >&2
  aws events list-rules --event-bus-name "${BUS_NAME}" --region "${REGION}" >&2
  exit 1
fi
# stdout only: jq parses POST_BUS below, so a CLI warning must not land in it.
if ! POST_BUS=$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"); then
  echo "FAIL: custom bus '${BUS_NAME}' disappeared during the update (describe-event-bus failed, its error above)" >&2
  exit 1
fi
echo "    OK: rule deleted from the CUSTOM bus (0 rules remain, bus still exists)"

# Issue #2613: the same update changes the bus Description, an in-place
# UpdateEventBus through the provider's update() and its recorded-region guard.
POST_DESC=$(echo "${POST_BUS}" | jq -r '.Description // empty')
if [ "${POST_DESC}" != "cdkd test bus (updated)" ]; then
  echo "FAIL: EventBus Description is '${POST_DESC}' after the update, expected 'cdkd test bus (updated)' (issue #2613: the bus update() did not apply)" >&2
  echo "      raw describe-event-bus: ${POST_BUS}" >&2
  exit 1
fi
POST_CREATED=$(echo "${POST_BUS}" | jq -r '.CreationTime // empty')
if [ -z "${PRE_CREATED}" ] || [ "${POST_CREATED}" != "${PRE_CREATED}" ]; then
  echo "FAIL: EventBus CreationTime is '${POST_CREATED}' after the update, '${PRE_CREATED}' after create (issue #2613: the Description change must update the bus in place, not replace it)" >&2
  exit 1
fi
echo "    OK: EventBus Description updated in place, CreationTime unchanged (issue #2613)"

# Issue #5300: the same update changes the function's inline code, so the key
# must ride UpdateFunctionCode as well.
if [ "$(source_key_sha)" = "${SOURCE_KEY_SHA_P1}" ]; then
  echo "FAIL: ${SOURCE_KEY_FN} CodeSha256 unchanged after the code change -- UpdateFunctionCode never ran" >&2
  exit 1
fi
assert_source_key "update"
SOURCE_KEY_SHA_UPD=$(source_key_sha)

# --- Phase 1.75: REMOVAL drops the bus's optional properties (issue #1160) ---
# The template no longer declares Description, KmsKeyIdentifier, LogConfig or
# DeadLetterConfig. CloudFormation clears each one (measured A/B: no
# Description, the AWS owned key, LogConfig OFF / NONE, no DLQ), while
# UpdateEventBus keeps any field it is not given, so before the fix all four
# stayed live.
echo "==> Phase 1.75: removal (drop Description, KmsKeyIdentifier, LogConfig, DeadLetterConfig)"
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! RM_BUS=$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"); then
  echo "FAIL: custom bus '${BUS_NAME}' disappeared during the removal phase (describe-event-bus failed, its error above)" >&2
  exit 1
fi
RM_DESC=$(echo "${RM_BUS}" | jq -r '.Description // empty')
RM_KEY=$(echo "${RM_BUS}" | jq -r '.KmsKeyIdentifier // empty')
RM_DLQ=$(echo "${RM_BUS}" | jq -r '.DeadLetterConfig.Arn // empty')
RM_LOG=$(echo "${RM_BUS}" | jq -r '"\(.LogConfig.Level // "")/\(.LogConfig.IncludeDetail // "")"')
if [ -n "${RM_DESC}" ] || [ -n "${RM_KEY}" ] || [ -n "${RM_DLQ}" ] || [ "${RM_LOG}" != "OFF/NONE" ]; then
  echo "FAIL: EventBus kept a removed property (issue #1160): Description='${RM_DESC}' KmsKeyIdentifier='${RM_KEY}' DeadLetterConfig.Arn='${RM_DLQ}' LogConfig='${RM_LOG}'; expected all empty and LogConfig 'OFF/NONE', as CloudFormation leaves it" >&2
  echo "      raw describe-event-bus: ${RM_BUS}" >&2
  exit 1
fi
RM_CREATED=$(echo "${RM_BUS}" | jq -r '.CreationTime // empty')
if [ "${RM_CREATED}" != "${PRE_CREATED}" ]; then
  echo "FAIL: EventBus CreationTime is '${RM_CREATED}' after the removal, '${PRE_CREATED}' after create (the removal must clear in place, not replace)" >&2
  exit 1
fi
echo "    OK: removed Description / KmsKeyIdentifier / DeadLetterConfig cleared, LogConfig OFF/NONE, in place (issue #1160)"

# Issue #5300: the removal also drops Code.SourceKMSKeyArn alongside a code
# change. CloudFormation KEEPS the key then (measured A/B, 2026-10-26: a
# stack update dropping SourceKMSKeyArn with a ZipFile change left
# GetFunction's Code.SourceKMSKeyArn on the old key). cdkd's UpdateFunctionCode
# names no key either, so the key must still be there: parity, not a reset.
if [ "$(source_key_sha)" = "${SOURCE_KEY_SHA_UPD}" ]; then
  echo "FAIL: ${SOURCE_KEY_FN} CodeSha256 unchanged by the removal phase's code change -- UpdateFunctionCode never ran" >&2
  exit 1
fi
RM_SOURCE_KEY=$(aws lambda get-function --function-name "${SOURCE_KEY_FN}" --region "${REGION}" \
  --query 'Code.SourceKMSKeyArn' --output text)
if [ "${RM_SOURCE_KEY}" != "${BUS_KEY_ARN}" ]; then
  echo "FAIL: removal: ${SOURCE_KEY_FN} Code.SourceKMSKeyArn is '${RM_SOURCE_KEY}' after the template dropped it with a code change, expected the key kept (${BUS_KEY_ARN}), as CloudFormation leaves it (issue #5300)" >&2
  exit 1
fi
echo "    OK: removal: ${SOURCE_KEY_FN} keeps the fixture key after UpdateFunctionCode without SourceKMSKeyArn, as CloudFormation does (issue #5300)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "EventBus '${BUS_NAME}' still exists after destroy" aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}"
echo "    OK: EventBus is gone"
assert_gone "function ${SOURCE_KEY_FN} still exists after destroy" aws lambda get-function-configuration --function-name "${SOURCE_KEY_FN}" --region "${REGION}"

assert_gone "DLQ '${BUS_DLQ_ARN##*:}' still exists after destroy" aws sqs get-queue-url --queue-name "${BUS_DLQ_ARN##*:}" --region "${REGION}"
echo "    OK: bus DLQ is gone"
# A KMS key is never deleted at once: destroy schedules it.
KEY_STATE=$(aws kms describe-key --key-id "${BUS_KEY_ARN}" --region "${REGION}" --query KeyMetadata.KeyState --output text)
if [ "${KEY_STATE}" != "PendingDeletion" ]; then
  echo "FAIL: bus KMS key ${BUS_KEY_ARN} is '${KEY_STATE}' after destroy, expected 'PendingDeletion'" >&2
  exit 1
fi
echo "    OK: bus KMS key is PendingDeletion"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> eventbridge test passed (EventBus LogConfig backfill closed + clean destroy)"
