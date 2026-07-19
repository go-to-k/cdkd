#!/usr/bin/env bash
# verify.sh — cdkd #651 --recreate-via-sdk-provider integ test
#
# Mid-life CC→SDK migration: a Lambda Function deployed WITH
# `RuntimeManagementConfig` (= auto-routes via Cloud Control on the fresh deploy,
# state stamps `provisionedBy: 'cc-api'`) is destroyed + recreated via
# cdkd's SDK Provider when the next deploy drops `RuntimeManagementConfig` AND
# passes `--recreate-via-sdk-provider`. The assertions confirm:
#
#   - state `provisionedBy` flips 'cc-api' → 'sdk'
#   - the Lambda's `RuntimeManagementConfig.UpdateRuntimeOn` is back at the Auto default on AWS
#     (SDK Provider doesn't wire it, and the template no longer carries it)
#   - LastModified changed (the recreate produced a new Lambda instance;
#     the user-supplied functionName makes the physical id stable, so
#     LastModified is the witness)
#   - destroy via SDK delete path is clean
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateViaSdkProvider"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-recreate-via-sdk-provider-probe"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy WITH RuntimeManagementConfig (lands CC via auto-route) ------
echo "==> Phase 1: deploy ${STACK} WITH RuntimeManagementConfig (baseline -> auto-route to CC)"
export CDKD_INTEG_USE_SILENT_DROP=true
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
unset CDKD_INTEG_USE_SILENT_DROP

STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_1=$(echo "${STATE_1}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_1}" != "cc-api" ]; then
  echo "FAIL: baseline Lambda has provisionedBy='${PROVISIONED_1}', expected 'cc-api' (RuntimeManagementConfig auto-route should land CC)" >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline Lambda provisionedBy == 'cc-api'"

LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Baseline LastModified: ${LAST_MOD_1}"

# Baseline AWS check: UpdateRuntimeOn should be FunctionUpdate (CC route forwarded it).
RL_1=$(aws lambda get-runtime-management-config --function-name "${FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RL_1}" != "FunctionUpdate" ]; then
  echo "FAIL: baseline Lambda has RuntimeManagementConfig.UpdateRuntimeOn='${RL_1}', expected 'FunctionUpdate' (CC route should have set it)" >&2
  exit 1
fi
echo "    OK: baseline Lambda RuntimeManagementConfig.UpdateRuntimeOn is FunctionUpdate on AWS (CC route confirmed)"

# --- Phase 2: re-deploy WITHOUT RuntimeManagementConfig + --recreate-via-sdk-provider
echo "==> Phase 2: re-deploy ${STACK} WITHOUT RuntimeManagementConfig + --recreate-via-sdk-provider (destroy+recreate via SDK)"
unset CDKD_INTEG_USE_SILENT_DROP
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-sdk-provider RecreateProbe \
  --yes

STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_2=$(echo "${STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_2}" != "sdk" ]; then
  echo "FAIL: post-recreate Lambda has provisionedBy='${PROVISIONED_2}', expected 'sdk' (recreate should have routed via SDK)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: post-recreate Lambda provisionedBy flipped 'cc-api' -> 'sdk'"

LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Post-recreate LastModified: ${LAST_MOD_2}"
if [ "${LAST_MOD_2}" = "${LAST_MOD_1}" ]; then
  echo "FAIL: Lambda LastModified unchanged after --recreate-via-sdk-provider (expected destroy+recreate to produce a new Lambda instance)" >&2
  exit 1
fi
echo "    OK: LastModified updated across recreate (old destroyed, new created)"

# Post-recreate AWS check: UpdateRuntimeOn should be back at the Auto
# default (the template no longer carries it AND the SDK provider doesn't
# wire it anyway).
RL_2=$(aws lambda get-runtime-management-config --function-name "${FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RL_2}" = "FunctionUpdate" ]; then
  echo "FAIL: post-recreate Lambda still has RuntimeManagementConfig.UpdateRuntimeOn='FunctionUpdate' on AWS — the SDK recreate should not have wired RuntimeManagementConfig" >&2
  exit 1
fi
echo "    OK: post-recreate RuntimeManagementConfig.UpdateRuntimeOn is back at the default (UpdateRuntimeOn='${RL_2}' — SDK provider didn't wire it)"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy via SDK delete path"
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

# Audit follow-up: assert the IAM role was destroyed too — not just
# relying on the trap to clean it up. The trap remains as a defence-in-
# depth cleanup for leftover-from-prior-runs cases; this assertion
# confirms the destroy itself handled the role.
LEFTOVER_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" \
  --output text 2>/dev/null)
if [ -n "${LEFTOVER_ROLES}" ]; then
  echo "FAIL: IAM role(s) still exist after destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi
echo "    OK: IAM role is gone"

echo ""
echo "==> recreate-via-sdk-provider test passed (#651 mid-life CC->SDK migration verified end-to-end)"
