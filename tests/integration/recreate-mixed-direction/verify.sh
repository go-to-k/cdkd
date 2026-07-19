#!/usr/bin/env bash
# verify.sh — cdkd #651 follow-up: mixed-direction recreate
#
# In a single Phase 2 deploy, exercise BOTH directions:
#   - FwdProbe: SDK -> CC (--recreate-via-cc-api)
#   - BackProbe: CC -> SDK (--recreate-via-sdk-provider)
#
# Phase 1 sets up the inverted baseline (Fwd on SDK, Back on CC).
# Phase 2 inverts the template AND combines both flags in one deploy.
# Phase 3 destroys clean.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateMixedDirection"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FWD_FN_NAME="cdkd-recreate-mixed-direction-fwd"
BACK_FN_NAME="cdkd-recreate-mixed-direction-back"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FWD_FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${BACK_FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# --- Phase 1: baseline — Fwd on SDK, Back on CC ------------------------
echo "==> Phase 1: deploy ${STACK} (Fwd no RuntimeManagementConfig -> SDK; Back has RuntimeManagementConfig -> CC)"
export CDKD_INTEG_PHASE=1
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
unset CDKD_INTEG_PHASE

STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
FWD_PROVISIONED_1=$(echo "${STATE_1}" | jq -r '.resources.FwdProbe.provisionedBy // ""')
BACK_PROVISIONED_1=$(echo "${STATE_1}" | jq -r '.resources.BackProbe.provisionedBy // ""')

if [ "${FWD_PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: baseline FwdProbe has provisionedBy='${FWD_PROVISIONED_1}', expected 'sdk'" >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline FwdProbe provisionedBy == 'sdk'"

if [ "${BACK_PROVISIONED_1}" != "cc-api" ]; then
  echo "FAIL: baseline BackProbe has provisionedBy='${BACK_PROVISIONED_1}', expected 'cc-api'" >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline BackProbe provisionedBy == 'cc-api'"

FWD_LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${FWD_FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
BACK_LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${BACK_FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Baseline LastModified: Fwd=${FWD_LAST_MOD_1}  Back=${BACK_LAST_MOD_1}"

# --- Phase 2: mixed-direction recreate in a SINGLE deploy --------------
echo "==> Phase 2: mixed-direction recreate (Fwd SDK->CC AND Back CC->SDK in one deploy)"
export CDKD_INTEG_PHASE=2
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api FwdProbe \
  --recreate-via-sdk-provider BackProbe \
  --yes
unset CDKD_INTEG_PHASE

STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
FWD_PROVISIONED_2=$(echo "${STATE_2}" | jq -r '.resources.FwdProbe.provisionedBy // ""')
BACK_PROVISIONED_2=$(echo "${STATE_2}" | jq -r '.resources.BackProbe.provisionedBy // ""')

if [ "${FWD_PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: post-mixed FwdProbe has provisionedBy='${FWD_PROVISIONED_2}', expected 'cc-api' (SDK -> CC migration)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: FwdProbe provisionedBy flipped 'sdk' -> 'cc-api'"

if [ "${BACK_PROVISIONED_2}" != "sdk" ]; then
  echo "FAIL: post-mixed BackProbe has provisionedBy='${BACK_PROVISIONED_2}', expected 'sdk' (CC -> SDK migration)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: BackProbe provisionedBy flipped 'cc-api' -> 'sdk'"

# Both LastModified must change — the mixed deploy recreated both.
FWD_LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${FWD_FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
BACK_LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${BACK_FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)

if [ "${FWD_LAST_MOD_2}" = "${FWD_LAST_MOD_1}" ]; then
  echo "FAIL: FwdProbe LastModified unchanged after recreate (expected destroy+recreate to update it)" >&2
  exit 1
fi
echo "    OK: FwdProbe LastModified updated across recreate"

if [ "${BACK_LAST_MOD_2}" = "${BACK_LAST_MOD_1}" ]; then
  echo "FAIL: BackProbe LastModified unchanged after recreate (expected destroy+recreate to update it)" >&2
  exit 1
fi
echo "    OK: BackProbe LastModified updated across recreate"

# AWS-side RuntimeManagementConfig.UpdateRuntimeOn: Fwd now has FunctionUpdate
# (CC route forwarded the new property); Back now back at the Auto default
# (SDK provider doesn't wire it).
FWD_RL_2=$(aws lambda get-runtime-management-config --function-name "${FWD_FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)
BACK_RL_2=$(aws lambda get-runtime-management-config --function-name "${BACK_FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)

if [ "${FWD_RL_2}" != "FunctionUpdate" ]; then
  echo "FAIL: post-mixed FwdProbe RuntimeManagementConfig.UpdateRuntimeOn='${FWD_RL_2}', expected 'FunctionUpdate' (CC route should have set it)" >&2
  exit 1
fi
echo "    OK: FwdProbe RuntimeManagementConfig.UpdateRuntimeOn is FunctionUpdate on AWS (CC route forwarded the new property)"

if [ "${BACK_RL_2}" = "FunctionUpdate" ]; then
  echo "FAIL: post-mixed BackProbe still has RuntimeManagementConfig.UpdateRuntimeOn=FunctionUpdate on AWS (SDK recreate should NOT have wired RuntimeManagementConfig)" >&2
  exit 1
fi
echo "    OK: BackProbe RuntimeManagementConfig.UpdateRuntimeOn is back at the default (SDK recreate did not wire it)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy via mixed delete path (FwdProbe via CC, BackProbe via SDK)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws lambda get-function --function-name "${FWD_FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: FwdProbe Lambda ${FWD_FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: FwdProbe Lambda is gone"

if aws lambda get-function --function-name "${BACK_FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: BackProbe Lambda ${BACK_FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: BackProbe Lambda is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

LEFTOVER_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" \
  --output text 2>/dev/null)
if [ -n "${LEFTOVER_ROLES}" ]; then
  echo "FAIL: IAM role(s) still exist after destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi
echo "    OK: IAM role is gone"

echo ""
echo "==> recreate-mixed-direction test passed (#651 follow-up: mixed SDK->CC + CC->SDK in one deploy verified end-to-end)"
