#!/usr/bin/env bash
# verify.sh — cdkd Lambda EventInvokeConfig async-invoke UPDATE integ.
#
# Regression coverage for the bug where an async Lambda's EventInvokeConfig
# (onFailure destination + maxEventAge + retryAttempts) could be CREATEd but
# NOT UPDATEd. The type had no SDK provider, so it routed through Cloud
# Control, whose JSON-patch read-modify-write UPDATE picks up the AWS-injected
# empty `DestinationConfig.OnSuccess: {}` from the read handler and hard-fails
# model validation (`#/DestinationConfig/OnSuccess: required key [Destination]
# not found`) on every change to maxEventAge / retryAttempts. The fix adds an
# SDK provider whose create/update both PutFunctionEventInvokeConfig (a
# full-replace write, exactly what CloudFormation uses), sending only the
# configured OnFailure and never an empty OnSuccess.
#
# Phases:
#   1. Deploy (maxEventAge 2 min / retryAttempts 1 / onFailure -> DLQ). Assert
#      the async-invoke config reached AWS with MaxAge 120 / Retries 1 / the DLQ.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (maxEventAge 5 min / retryAttempts
#      2). Assert the UPDATE succeeds (this exact change was undeployable
#      pre-fix) and AWS now reports MaxAge 300 / Retries 2 / the same DLQ.
#   2b. Re-spell FunctionName as the function ARN (CDKD_TEST_FN_ARN=true).
#      It must update in place and the config must survive (issue #4118).
#   2c/2d. Feed FunctionName from a custom resource, then flip it name -> ARN:
#      the propagated replacement ceiling must lower to in place (issue #4134).
#   3. Destroy + assert the function is gone and the cdkd state file is removed.
#
# Issue #4091 (EventInvokeConfig is a cc-broken sticky exemption): before
# phase 2 the record is rewritten to provisionedBy=cc-api -- what a binary
# before the SDK provider recorded -- after asserting Cloud Control addresses
# the resource by the SAME id cdkd stored (the parity the exemption requires).
# Phase 2's UPDATE then must go through the SDK provider (Cloud Control's
# UPDATE fails on this type), flip the record to sdk in place and keep the id.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdLambdaEventInvokeConfigUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-event-invoke-config-update-test-fn"
DLQ_NAME="cdkd-event-invoke-config-update-test-dlq"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Phase 2's and 2b's captured deploy output (issues #4091, #4118), removed by cleanup too.
DEPLOY_P2_LOG=""
DEPLOY_2B_LOG=""
DEPLOY_2D_LOG=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${DEPLOY_P2_LOG}" ] && rm -f "${DEPLOY_P2_LOG}"
  [ -n "${DEPLOY_2B_LOG}" ] && rm -f "${DEPLOY_2B_LOG}"
  [ -n "${DEPLOY_2D_LOG}" ] && rm -f "${DEPLOY_2D_LOG}"
  aws lambda delete-function --function-name cdkd-event-invoke-config-update-test-cr --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name /aws/lambda/cdkd-event-invoke-config-update-test-cr \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # The EventInvokeConfig is deleted with the function; delete the function +
  # DLQ explicitly in case a partial run left them.
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  DLQ_URL="$(aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${DLQ_URL}" ] && [ "${DLQ_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${DLQ_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # The function's auto-created log group survives a function delete.
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

eic_field() {
  # $1 = jq query against get-function-event-invoke-config
  aws lambda get-function-event-invoke-config --function-name "${FN_NAME}" \
    --region "${REGION}" --query "$1" --output text
}

# --- Phase 1: deploy baseline (MaxAge 120 / Retries 1) ----------------
echo "==> Phase 1: deploy async Lambda (maxEventAge 2 min / retryAttempts 1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXAGE_P1="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_P1="$(eic_field 'MaximumRetryAttempts')"
ONFAIL_P1="$(eic_field 'DestinationConfig.OnFailure.Destination')"
echo "    Phase 1 async-invoke config: MaxAge=${MAXAGE_P1} Retries=${RETRIES_P1} OnFailure=${ONFAIL_P1}"
[ "${MAXAGE_P1}" = "120" ] || { echo "FAIL: expected MaxAge 120, got '${MAXAGE_P1}'" >&2; exit 1; }
[ "${RETRIES_P1}" = "1" ] || { echo "FAIL: expected Retries 1, got '${RETRIES_P1}'" >&2; exit 1; }
case "${ONFAIL_P1}" in
  *":${DLQ_NAME}") ;;
  *) echo "FAIL: expected OnFailure -> ${DLQ_NAME}, got '${ONFAIL_P1}'" >&2; exit 1 ;;
esac
echo "    Phase 1 config reached AWS"

# --- Phase 1.5: the EventInvokeConfig must NOT show phantom drift -----------
# CDK always synthesizes `Qualifier: '$LATEST'` into the EventInvokeConfig, so
# cdkd state stores it; the provider's readCurrentState must emit it back or
# `cdkd drift` reports a false positive on every base async Lambda. We assert
# only that the EventInvokeConfig resource is drift-clean (the assertion is
# scoped to this type — an unrelated drift false-positive elsewhere in the
# stack is out of scope for this fixture).
echo "==> Phase 1.5: EventInvokeConfig shows no drift"
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
if printf '%s' "${DRIFT_OUT}" | grep -q 'AWS::Lambda::EventInvokeConfig'; then
  echo "FAIL: cdkd drift reported phantom drift on the EventInvokeConfig:" >&2
  printf '%s\n' "${DRIFT_OUT}" | grep -A4 'EventInvokeConfig' >&2
  exit 1
fi
echo "    EventInvokeConfig is drift-clean"

# --- Phase 1.6: seed a cc-api record (issue #4091) ---------------------
EIC_TYPE="AWS::Lambda::EventInvokeConfig"
eic_record() { # usage: eic_record <jq path under the resource>; prints "" when absent
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  echo "${state}" | jq -r --arg t "${EIC_TYPE}" "[.resources | to_entries[] | select(.value.resourceType == \$t) | .value${1}] | first // \"\""
}
EIC_ID=$(eic_record .physicalId)
EIC_LOGICAL=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg t "${EIC_TYPE}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .key] | first // ""')
[ "${EIC_ID}" = "${FN_NAME}|\$LATEST" ] || { echo "FAIL: #4091 premise: EventInvokeConfig physicalId is '${EIC_ID}', expected '${FN_NAME}|\$LATEST'" >&2; exit 1; }
PRE_LAYER=$(eic_record .provisionedBy)
[ "${PRE_LAYER}" = "sdk" ] || { echo "FAIL: #4091 premise: the EventInvokeConfig is provisionedBy '${PRE_LAYER}' before seeding, expected sdk" >&2; exit 1; }
# Parity, observed: Cloud Control reads the resource by the id cdkd stored.
CC_FN=$(aws cloudcontrol get-resource --type-name "${EIC_TYPE}" --identifier "${EIC_ID}" \
  --region "${REGION}" --query 'ResourceDescription.Identifier' --output text)
[ "${CC_FN}" = "${EIC_ID}" ] || { echo "FAIL: #4091: Cloud Control's identifier '${CC_FN}' differs from cdkd's physicalId '${EIC_ID}'" >&2; exit 1; }
echo "    OK: Cloud Control addresses the EventInvokeConfig by cdkd's physicalId (${EIC_ID})"
echo "==> Phase 1.6: seed the EventInvokeConfig record to provisionedBy=cc-api"
# Assignments, not argument substitutions, so a failed read or jq aborts here
# under `set -e` instead of uploading an empty state file.
SEED_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
SEEDED=$(echo "${SEED_STATE}" | jq --arg t "${EIC_TYPE}" '.resources |= with_entries(if .value.resourceType == $t then .value.provisionedBy = "cc-api" else . end)')
printf '%s\n' "${SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
SEEDED_LAYER=$(eic_record .provisionedBy)
[ "${SEEDED_LAYER}" = "cc-api" ] || { echo "FAIL: #4091: seeding the record to cc-api did not stick (got '${SEEDED_LAYER}')" >&2; exit 1; }

# --- Phase 2: UPDATE (MaxAge 300 / Retries 2) — undeployable pre-fix ---
echo "==> Phase 2: re-deploy with maxEventAge 5 min / retryAttempts 2 (UPDATE)"
DEPLOY_P2_LOG="$(mktemp)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_P2_LOG}" 2>&1; then
  cat "${DEPLOY_P2_LOG}" >&2
  rm -f "${DEPLOY_P2_LOG}"
  echo "FAIL: the phase 2 UPDATE over a cc-api EventInvokeConfig record failed (#4091)" >&2
  exit 1
fi
DEPLOY_P2_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_P2_LOG}")"
rm -f "${DEPLOY_P2_LOG}"
DEPLOY_P2_LOG=""
printf '%s\n' "${DEPLOY_P2_PLAIN}"
POST_LAYER=$(eic_record .provisionedBy)
POST_ID=$(eic_record .physicalId)
[ "${POST_LAYER}" = "sdk" ] || { echo "FAIL: #4091: the cc-api record did not flip back to sdk (got '${POST_LAYER}')" >&2; exit 1; }
[ "${POST_ID}" = "${EIC_ID}" ] || { echo "FAIL: #4091: the flip changed the physicalId (${EIC_ID} -> ${POST_ID})" >&2; exit 1; }
# The id is name-keyed, so a delete + create would keep it: the log is the
# only replacement witness. Every replacement wording the engine prints names
# the logical id beside some form of "replac".
if grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_P2_PLAIN}" | grep -qi 'replac'; then
  echo "FAIL: #4091: the flip REPLACED ${EIC_LOGICAL} instead of updating it in place:" >&2
  grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_P2_PLAIN}" | grep -i 'replac' >&2
  exit 1
fi
# Sentinel: the flipped record above -- a flip with no line means the wording drifted.
if ! grep -qF "${EIC_LOGICAL} (${EIC_TYPE}): moving to the SDK provider" <<<"${DEPLOY_P2_PLAIN}"; then
  echo "FAIL: #4091: the record flipped, but no 'moving to the SDK provider' line names ${EIC_LOGICAL} -- the wording drifted" >&2
  exit 1
fi
echo "    OK: the cc-api record returned to the SDK provider in place (#4091)"

MAXAGE_P2="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_P2="$(eic_field 'MaximumRetryAttempts')"
ONFAIL_P2="$(eic_field 'DestinationConfig.OnFailure.Destination')"
echo "    Phase 2 async-invoke config: MaxAge=${MAXAGE_P2} Retries=${RETRIES_P2} OnFailure=${ONFAIL_P2}"
[ "${MAXAGE_P2}" = "300" ] || { echo "FAIL: expected MaxAge 300 after update, got '${MAXAGE_P2}'" >&2; exit 1; }
[ "${RETRIES_P2}" = "2" ] || { echo "FAIL: expected Retries 2 after update, got '${RETRIES_P2}'" >&2; exit 1; }
case "${ONFAIL_P2}" in
  *":${DLQ_NAME}") ;;
  *) echo "FAIL: expected OnFailure -> ${DLQ_NAME} preserved after update, got '${ONFAIL_P2}'" >&2; exit 1 ;;
esac
echo "    Phase 2 UPDATE reached AWS (the change that was undeployable pre-fix)"

# --- Phase 2b: FunctionName re-spelled as the ARN (issue #4118) --------
echo "==> Phase 2b: re-spell FunctionName as the function ARN (same function)"
DEPLOY_2B_LOG="$(mktemp)"
if ! CDKD_TEST_UPDATE=true CDKD_TEST_FN_ARN=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_2B_LOG}" 2>&1; then
  cat "${DEPLOY_2B_LOG}" >&2
  rm -f "${DEPLOY_2B_LOG}"
  echo "FAIL: #4118: the re-spelled FunctionName deploy failed" >&2
  exit 1
fi
DEPLOY_2B_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_2B_LOG}")"
rm -f "${DEPLOY_2B_LOG}"
DEPLOY_2B_LOG=""
printf '%s\n' "${DEPLOY_2B_PLAIN}"
if grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_2B_PLAIN}" | grep -qi 'replac'; then
  echo "FAIL: #4118: re-spelling FunctionName REPLACED ${EIC_LOGICAL}:" >&2
  grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_2B_PLAIN}" | grep -i 'replac' >&2
  exit 1
fi
RECORDED_FN=$(eic_record .properties.FunctionName)
case "${RECORDED_FN}" in
  arn:*":function:${FN_NAME}") ;;
  *) echo "FAIL: #4118: the record's FunctionName is '${RECORDED_FN}', expected the function ARN (the deploy did not apply the re-spelling)" >&2; exit 1 ;;
esac
POST_ID=$(eic_record .physicalId)
[ "${POST_ID}" = "${EIC_ID}" ] || { echo "FAIL: #4118: the physicalId changed (${EIC_ID} -> ${POST_ID})" >&2; exit 1; }
# The discriminator: before #4118 the replacement's delete left NO config.
MAXAGE_2B="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_2B="$(eic_field 'MaximumRetryAttempts')"
ONFAIL_2B="$(eic_field 'DestinationConfig.OnFailure.Destination')"
[ "${MAXAGE_2B}" = "300" ] && [ "${RETRIES_2B}" = "2" ] || { echo "FAIL: #4118: the async-invoke config is MaxAge=${MAXAGE_2B} Retries=${RETRIES_2B}, expected 300 / 2" >&2; exit 1; }
case "${ONFAIL_2B}" in
  *":${DLQ_NAME}") ;;
  *) echo "FAIL: #4118: OnFailure is '${ONFAIL_2B}', expected ${DLQ_NAME}" >&2; exit 1 ;;
esac
echo "    OK: the re-spelled FunctionName updated in place and the config survived (#4118)"

# --- Phase 2c/2d: a PROPAGATED ceiling on a same-function move (issue #4134)
# 2c0 adds a custom resource that returns the function's NAME, unwired (the
# config keeps 2b's ARN spelling). 2c wires FunctionName to it: the value the
# diff resolves from state is the name, the same function as the recorded
# ARN, so an in-place update. 2d flips the CR to return the ARN: the CR updates
# in place, the diff raises a replacement ceiling on the config, and the
# resolved FunctionName moves name -> ARN of the SAME function. The engine
# must lower the ceiling to in place; a replacement would Put the config and
# then delete it from the same function.
echo "==> Phase 2c0: add the custom resource (returns the NAME), not yet wired"
CDKD_TEST_UPDATE=true CDKD_TEST_FN_ARN=true CDKD_TEST_FN_VIA_CR=name node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
echo "==> Phase 2c: feed FunctionName from the custom resource (the NAME)"
CDKD_TEST_UPDATE=true CDKD_TEST_FN_ARN=true CDKD_TEST_FN_VIA_CR=name CDKD_TEST_FN_WIRE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
RECORDED_2C=$(eic_record .properties.FunctionName)
[ "${RECORDED_2C}" = "${FN_NAME}" ] || { echo "FAIL: #4134 premise: after 2c the record's FunctionName is '${RECORDED_2C}', expected '${FN_NAME}'" >&2; exit 1; }
MAXAGE_2C="$(eic_field 'MaximumEventAgeInSeconds')"
[ "${MAXAGE_2C}" = "300" ] || { echo "FAIL: #4134 premise: after 2c the async-invoke config is MaxAge=${MAXAGE_2C}, expected 300" >&2; exit 1; }
echo "==> Phase 2d: flip the custom resource to return the ARN (propagated ceiling)"
DEPLOY_2D_LOG="$(mktemp)"
if ! CDKD_TEST_UPDATE=true CDKD_TEST_FN_ARN=true CDKD_TEST_FN_VIA_CR=arn CDKD_TEST_FN_WIRE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_2D_LOG}" 2>&1; then
  cat "${DEPLOY_2D_LOG}" >&2
  rm -f "${DEPLOY_2D_LOG}"
  echo "FAIL: #4134: the propagated re-spelling deploy failed" >&2
  exit 1
fi
DEPLOY_2D_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_2D_LOG}")"
rm -f "${DEPLOY_2D_LOG}"
DEPLOY_2D_LOG=""
printf '%s\n' "${DEPLOY_2D_PLAIN}"
if grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_2D_PLAIN}" | grep -qi 'replac'; then
  echo "FAIL: #4134: the propagated re-spelling REPLACED ${EIC_LOGICAL}:" >&2
  grep -F "${EIC_LOGICAL}" <<<"${DEPLOY_2D_PLAIN}" | grep -i 'replac' >&2
  exit 1
fi
RECORDED_2D=$(eic_record .properties.FunctionName)
case "${RECORDED_2D}" in
  arn:*":function:${FN_NAME}") ;;
  *) echo "FAIL: #4134: after 2d the record's FunctionName is '${RECORDED_2D}', expected the function ARN (the CR flip did not reach the config)" >&2; exit 1 ;;
esac
MAXAGE_2D="$(eic_field 'MaximumEventAgeInSeconds')"
RETRIES_2D="$(eic_field 'MaximumRetryAttempts')"
[ "${MAXAGE_2D}" = "300" ] && [ "${RETRIES_2D}" = "2" ] || { echo "FAIL: #4134: the async-invoke config is MaxAge=${MAXAGE_2D} Retries=${RETRIES_2D} after the propagated move, expected 300 / 2" >&2; exit 1; }
echo "    OK: the propagated same-function move updated the config in place and it survived (#4134)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    function deleted"
assert_gone "custom-resource handler still exists after destroy" aws lambda get-function-configuration --function-name cdkd-event-invoke-config-update-test-cr --region "${REGION}"
echo "    custom-resource handler deleted (its log group is removed by cleanup)"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Lambda EventInvokeConfig deploy + UPDATE (maxEventAge/retryAttempts change) reach AWS via the SDK provider, all 3 phases passed"
