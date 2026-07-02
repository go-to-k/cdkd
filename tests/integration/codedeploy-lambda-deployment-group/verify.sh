#!/usr/bin/env bash
# verify.sh — cdkd CodeDeploy Lambda canary deployment group integ.
#
# AWS::CodeDeploy::Application / ::DeploymentGroup have NO SDK provider in
# cdkd, so they route via Cloud Control. The DeploymentGroup create references
# the same-stack service role created ~1s earlier, and CodeDeploy validates
# the trust policy at create time — so every fresh deploy re-opens the
# IAM-propagation race this fixture's retry pattern fixes ("AWS CodeDeploy
# does not have the permissions required to assume the role ...", which the
# pre-fix classifier did NOT retry).
#
# Phases:
#   1. Deploy baseline (code v1). Assert the CodeDeploy application (compute
#      platform Lambda) + deployment group (LambdaCanary10Percent5Minutes,
#      BLUE_GREEN) reached AWS, the alias points at version 1, and the
#      DeploymentGroup routed via cc-api.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (code v1 -> v2, which mints a NEW
#      Lambda::Version logical id). Assert the alias flipped to version 2 and
#      an invoke through the alias returns v2. (cdkd flips the alias directly;
#      the CFn CodeDeployLambdaAliasUpdate canary shift is a documented
#      divergence — see the stack file header.)
#   3. Destroy + assert the application / deployment group / function are
#      gone, the cdkd state file is removed, and Lambda log groups are swept.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdCodedeployLambdaDeploymentGroupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-codedeploy-canary-fn"
APP_NAME="cdkd-codedeploy-integ-app"
DG_NAME="cdkd-codedeploy-integ-dg"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${FN_NAME}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Deleting the application cascades to its deployment groups.
  aws deploy delete-application --application-name "${APP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (code v1) --------------------------------
echo "==> Phase 1: deploy baseline (code v1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PLATFORM="$(aws deploy get-application --application-name "${APP_NAME}" \
  --region "${REGION}" --query 'application.computePlatform' --output text)"
if [ "${PLATFORM}" != "Lambda" ]; then
  echo "FAIL: expected application computePlatform=Lambda, got '${PLATFORM}'" >&2
  exit 1
fi

DG_JSON="$(aws deploy get-deployment-group --application-name "${APP_NAME}" \
  --deployment-group-name "${DG_NAME}" --region "${REGION}" \
  --query 'deploymentGroupInfo.[deploymentConfigName,deploymentStyle.deploymentType]' \
  --output text)"
if [ "${DG_JSON}" != "CodeDeployDefault.LambdaCanary10Percent5Minutes	BLUE_GREEN" ]; then
  echo "FAIL: unexpected deployment group config/style: '${DG_JSON}'" >&2
  exit 1
fi
echo "    Application (Lambda) + DeploymentGroup (Canary10Percent5Minutes, BLUE_GREEN) reached AWS"

ALIAS_V1="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V1}" != "1" ]; then
  echo "FAIL: expected alias at version 1 after Phase 1, got '${ALIAS_V1}'" >&2
  exit 1
fi
echo "    Alias 'live' -> version 1"

# Assert the DeploymentGroup routed via Cloud Control (no SDK provider).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::CodeDeploy::DeploymentGroup");process.stdout.write((r[k]&&r[k].provisionedBy)||"")})')"
if [ "${PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: expected DeploymentGroup provisionedBy=cc-api, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    DeploymentGroup routed via Cloud Control (provisionedBy=cc-api)"

# --- Phase 2: UPDATE (code v1 -> v2, new Version, alias flip) -----------
echo "==> Phase 2: UPDATE (code v1 -> v2, new Lambda::Version, alias flip)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ALIAS_V2="$(aws lambda get-alias --function-name "${FN_NAME}" --name live \
  --region "${REGION}" --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V2}" != "2" ]; then
  echo "FAIL: expected alias at version 2 after Phase 2, got '${ALIAS_V2}'" >&2
  exit 1
fi

INVOKE_OUT="$(mktemp)"
aws lambda invoke --function-name "${FN_NAME}:live" --region "${REGION}" \
  "${INVOKE_OUT}" >/dev/null
if ! grep -q '"version":"v2"' "${INVOKE_OUT}"; then
  echo "FAIL: invoke through alias did not return v2: $(cat "${INVOKE_OUT}")" >&2
  rm -f "${INVOKE_OUT}"
  exit 1
fi
rm -f "${INVOKE_OUT}"
echo "    Alias 'live' -> version 2; invoke returns v2"

# --- Phase 3: destroy + orphan-zero -------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws deploy get-application --application-name "${APP_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: CodeDeploy application still exists after destroy" >&2
  exit 1
fi
# Errors with ApplicationDoesNotExistException / DeploymentGroupDoesNotExist-
# Exception once either level is gone — both count as "deployment group gone".
if aws deploy get-deployment-group --application-name "${APP_NAME}" \
  --deployment-group-name "${DG_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: CodeDeploy deployment group still exists after destroy" >&2
  exit 1
fi
if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda function still exists after destroy" >&2
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2
  exit 1
fi
echo "    Application / function / state all gone"

# The Phase 2 invoke auto-created /aws/lambda/<fn> — sweep it so the run
# leaves zero orphans (see feedback_functional_assert_creates_loggroup_orphan).
sweep_log_groups

echo "[verify] PASS"
