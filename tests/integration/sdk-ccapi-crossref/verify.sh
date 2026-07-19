#!/usr/bin/env bash
# verify.sh — cdkd SDK-provider <-> Cloud Control API cross-reference
# boundary integ test (#614 routing mix).
#
# cdkd's #614 routing auto-routes a resource through Cloud Control API
# instead of its registered SDK Provider the moment its template sets a
# top-level property the SDK Provider would silently drop. This fixture
# forces a heterogeneous routing mix in ONE stack and crosses the SDK <-> CC
# boundary with Fn::GetAtt in BOTH directions:
#
#   - KinesisStream (AWS::Kinesis::Stream, silent-drop DesiredShardLevelMetrics)
#       -> CC API (provisionedBy=cc-api)
#   - CcLambda (AWS::Lambda::Function, silent-drop RuntimeManagementConfig)
#       -> CC API (provisionedBy=cc-api)
#   - ExecRole (AWS::IAM::Role, no silent-drop)        -> SDK (provisionedBy=sdk)
#   - StreamArnParam (AWS::SSM::Parameter, no silent-drop) -> SDK (provisionedBy=sdk)
#
# Cross-refs asserted:
#   (A) SDK -> CC:  StreamArnParam.Value = Fn::GetAtt(KinesisStream, 'Arn')
#       Assert the SSM parameter's value on AWS equals the real stream ARN.
#   (B) CC -> SDK:  CcLambda.Role = Fn::GetAtt(ExecRole, 'Arn')
#       Assert the Lambda's configured role ARN on AWS equals the real role ARN.
#
# Memory `feedback_cc_api_routing_bypasses_sdk_delete_logic`: CC routing
# BYPASSES the SDK provider's delete() entirely, so a clean destroy of the
# CC-routed Kinesis stream + Lambda is itself a meaningful check.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD/macOS-portable: no `grep -P`, no `date -d`. Real exit codes are
# captured to variables; the script prints `[verify] PASS` ONLY on full
# success.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSdkCcApiCrossrefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

STREAM_NAME="cdkd-crossref-stream"
FN_NAME="cdkd-crossref-fn"
ROLE_NAME="cdkd-crossref-exec-role"
PARAM_NAME="/cdkd/crossref/stream-arn"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first expansion — best-effort cleanup runs with the env
  # it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  exit 1
}

if [ -z "${STATE_BUCKET:-}" ]; then
  fail "STATE_BUCKET env var is required"
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  fail "local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first"
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  fail "no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy"
fi

# Helper: read provisionedBy for the (single) resource of a given type.
provisioned_by_for_type() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.provisionedBy // ""] | first // ""'
}

# --- Assertion 1: the two silent-drop resources are CC-API-routed ----
KINESIS_PB=$(provisioned_by_for_type "AWS::Kinesis::Stream")
if [ "${KINESIS_PB}" != "cc-api" ]; then
  echo "${STATE}" | jq .
  fail "Kinesis Stream provisionedBy='${KINESIS_PB}', expected 'cc-api' (DesiredShardLevelMetrics should auto-route)"
fi
echo "    OK: Kinesis Stream provisionedBy == 'cc-api'"

LAMBDA_PB=$(provisioned_by_for_type "AWS::Lambda::Function")
if [ "${LAMBDA_PB}" != "cc-api" ]; then
  echo "${STATE}" | jq .
  fail "Lambda provisionedBy='${LAMBDA_PB}', expected 'cc-api' (RuntimeManagementConfig should auto-route)"
fi
echo "    OK: Lambda provisionedBy == 'cc-api'"

# --- Assertion 2: the two no-silent-drop resources stay SDK-routed ---
ROLE_PB=$(provisioned_by_for_type "AWS::IAM::Role")
if [ "${ROLE_PB}" != "sdk" ]; then
  echo "${STATE}" | jq .
  fail "IAM Role provisionedBy='${ROLE_PB}', expected 'sdk'"
fi
echo "    OK: IAM Role provisionedBy == 'sdk'"

PARAM_PB=$(provisioned_by_for_type "AWS::SSM::Parameter")
if [ "${PARAM_PB}" != "sdk" ]; then
  echo "${STATE}" | jq .
  fail "SSM Parameter provisionedBy='${PARAM_PB}', expected 'sdk'"
fi
echo "    OK: SSM Parameter provisionedBy == 'sdk'"
echo "    OK: heterogeneous routing in one stack (2x cc-api, 2x sdk)"

# --- Assertion 3 (cross-ref A: SDK -> CC GetAtt) ---------------------
# StreamArnParam.Value = Fn::GetAtt(KinesisStream, 'Arn'). The SDK-routed
# SSM parameter must carry the CC-routed stream's REAL Arn. CC API's
# physical id for AWS::Kinesis::Stream is the stream NAME, so the resolver
# had to derive the Arn attribute correctly across the boundary.
REAL_STREAM_ARN=$(aws kinesis describe-stream-summary \
  --stream-name "${STREAM_NAME}" --region "${REGION}" \
  --query 'StreamDescriptionSummary.StreamARN' --output text 2>/dev/null)
if [ -z "${REAL_STREAM_ARN}" ] || [ "${REAL_STREAM_ARN}" = "None" ]; then
  fail "could not read real Kinesis stream ARN from AWS"
fi
PARAM_VALUE=$(aws ssm get-parameter \
  --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null)
if [ "${PARAM_VALUE}" != "${REAL_STREAM_ARN}" ]; then
  fail "cross-ref A (SDK->CC) wrong: SSM param value='${PARAM_VALUE}', expected stream Arn='${REAL_STREAM_ARN}'"
fi
echo "    OK: cross-ref A (SDK->CC) Fn::GetAtt(KinesisStream,'Arn') resolved to the real stream ARN"

# --- Assertion 4 (cross-ref B: CC -> SDK GetAtt) ---------------------
# CcLambda.Role = Fn::GetAtt(ExecRole, 'Arn'). The CC-routed Lambda must
# carry the SDK-routed role's REAL Arn.
REAL_ROLE_ARN=$(aws iam get-role \
  --role-name "${ROLE_NAME}" \
  --query 'Role.Arn' --output text 2>/dev/null)
if [ -z "${REAL_ROLE_ARN}" ] || [ "${REAL_ROLE_ARN}" = "None" ]; then
  fail "could not read real IAM role ARN from AWS"
fi
FN_ROLE=$(aws lambda get-function-configuration \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'Role' --output text 2>/dev/null)
if [ "${FN_ROLE}" != "${REAL_ROLE_ARN}" ]; then
  fail "cross-ref B (CC->SDK) wrong: Lambda role='${FN_ROLE}', expected role Arn='${REAL_ROLE_ARN}'"
fi
echo "    OK: cross-ref B (CC->SDK) Fn::GetAtt(ExecRole,'Arn') resolved to the real role ARN"

# --- Assertion 5: the silent-drop props actually reached AWS (CC route
#     forwarded the full property map) ----------------------------------
RTM_UPDATE_ON=$(aws lambda get-runtime-management-config \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RTM_UPDATE_ON}" != "FunctionUpdate" ]; then
  fail "Lambda RuntimeManagementConfig.UpdateRuntimeOn='${RTM_UPDATE_ON}', expected 'FunctionUpdate' (silent-drop NOT forwarded by CC route)"
fi
echo "    OK: Lambda RuntimeManagementConfig.UpdateRuntimeOn == 'FunctionUpdate' on AWS (silent-drop forwarded by CC)"

# --- Phase 2: destroy -----------------------------------------------------
# Memory feedback_cc_api_routing_bypasses_sdk_delete_logic: CC routing
# bypasses the SDK delete() entirely. A clean destroy of the CC-routed
# stream + Lambda is itself a meaningful boundary check.
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# --- Assertion 6: every named resource is gone from AWS ------------------
if aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  fail "Kinesis stream ${STREAM_NAME} still exists after destroy"
fi
echo "    OK: Kinesis stream is gone"

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  fail "Lambda function ${FN_NAME} still exists after destroy"
fi
echo "    OK: Lambda function is gone"

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  fail "IAM role ${ROLE_NAME} still exists after destroy"
fi
echo "    OK: IAM role is gone"

if aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  fail "SSM parameter ${PARAM_NAME} still exists after destroy"
fi
echo "    OK: SSM parameter is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  fail "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy"
fi
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS: sdk-ccapi-crossref (heterogeneous routing + bidirectional cross-ref resolution + clean CC-path destroy)"
