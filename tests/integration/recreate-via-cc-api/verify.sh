#!/usr/bin/env bash
# verify.sh — cdkd #615 --recreate-via-cc-api integ test
#
# Mid-life SDK→CC migration: a Lambda Function deployed without the
# silent-drop `LoggingConfig` (= state stamps `provisionedBy: 'sdk'`)
# is destroyed + recreated via Cloud Control API when the next deploy
# adds `LoggingConfig` AND passes `--recreate-via-cc-api`. The
# assertions confirm:
#
#   - state `provisionedBy` flips 'sdk' → 'cc-api'
#   - the Lambda's `LoggingConfig` reaches AWS via CC
#   - the physical id changed (recreate produced a NEW Lambda function;
#     the old one was destroyed)
#   - destroy via CC API delete path is clean
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateViaCcApi"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-recreate-via-cc-api-probe"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # IAM roles: `starts_with` is precise (CDK auto-names start with the stack id).
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
  set -eu
}

trap cleanup EXIT

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
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy WITHOUT LoggingConfig (lands SDK) -----------------
echo "==> Phase 1: deploy ${STACK} WITHOUT LoggingConfig (baseline → SDK route)"
unset CDKD_INTEG_USE_LOGGING_CONFIG
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_1=$(echo "${STATE_1}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: baseline Lambda has provisionedBy='${PROVISIONED_1}', expected 'sdk' (no silent-drop → SDK)" >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline Lambda provisionedBy == 'sdk'"

# Capture physical-id from baseline so the recreate assertion can verify a NEW one.
PHYS_ID_1=$(echo "${STATE_1}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
echo "    Baseline physical-id: ${PHYS_ID_1}"

# Baseline AWS check: LoggingConfig should NOT be JSON-formatted.
LOG_CONFIG_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LoggingConfig' --output json 2>/dev/null)
LF_1=$(echo "${LOG_CONFIG_1}" | jq -r '.LogFormat // ""')
if [ "${LF_1}" = "JSON" ]; then
  echo "FAIL: baseline Lambda has LogFormat=JSON — fixture forgot to omit LoggingConfig" >&2
  exit 1
fi
echo "    OK: baseline Lambda has no JSON LoggingConfig on AWS yet"

# --- Phase 2: re-deploy WITH LoggingConfig + --recreate-via-cc-api -----
echo "==> Phase 2: re-deploy ${STACK} WITH LoggingConfig + --recreate-via-cc-api (destroy+recreate via CC)"
export CDKD_INTEG_USE_LOGGING_CONFIG=true
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api RecreateProbe \
  --yes
unset CDKD_INTEG_USE_LOGGING_CONFIG

STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_2=$(echo "${STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: post-recreate Lambda has provisionedBy='${PROVISIONED_2}', expected 'cc-api' (recreate should have routed via CC)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: post-recreate Lambda provisionedBy flipped 'sdk' → 'cc-api'"

# Assert: physical-id CHANGED (destroy+recreate produced a new resource).
PHYS_ID_2=$(echo "${STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
echo "    Post-recreate physical-id: ${PHYS_ID_2}"
if [ "${PHYS_ID_2}" = "${PHYS_ID_1}" ]; then
  echo "FAIL: physical-id unchanged after --recreate-via-cc-api (expected destroy+recreate to produce a NEW physical resource)" >&2
  echo "    Both: ${PHYS_ID_1}"
  exit 1
fi
echo "    OK: physical-id changed across recreate (old destroyed, new created)"

# Post-recreate AWS check: LoggingConfig should now be JSON via CC.
LOG_CONFIG_2=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LoggingConfig' --output json 2>/dev/null)
LF_2=$(echo "${LOG_CONFIG_2}" | jq -r '.LogFormat // ""')
APP_2=$(echo "${LOG_CONFIG_2}" | jq -r '.ApplicationLogLevel // ""')
if [ "${LF_2}" != "JSON" ]; then
  echo "FAIL: post-recreate Lambda has LogFormat='${LF_2}', expected 'JSON' (CC should have forwarded LoggingConfig)" >&2
  exit 1
fi
if [ "${APP_2}" != "INFO" ]; then
  echo "FAIL: post-recreate Lambda has ApplicationLogLevel='${APP_2}', expected 'INFO'" >&2
  exit 1
fi
echo "    OK: post-recreate LoggingConfig reached AWS via CC (LogFormat=JSON, ApplicationLogLevel=INFO)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy via CC delete path"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Lambda function is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> recreate-via-cc-api test passed (#615 mid-life SDK→CC migration verified end-to-end)"
