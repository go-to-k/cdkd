#!/usr/bin/env bash
# verify.sh — cdkd GitHub Actions IAM OIDC provider integ.
#
# `iam.OpenIdConnectProvider` synthesizes Custom::AWSCDKOpenIdConnectProvider
# (a Lambda-backed CDK custom resource), so this exercises cdkd's custom
# resource CREATE / UPDATE / DELETE lifecycle on the everyday GitHub Actions
# federation pattern. Confirmed-clean /hunt-bugs pattern; regression guard.
#
# Phases:
#   1. Deploy; assert the provider exists with exactly the sts.amazonaws.com
#      clientId; capture its CreateDate.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds a second clientId). Assert
#      the clientId list grew AND CreateDate is unchanged (custom resource
#      UPDATE in place, no recreate).
#   3. Destroy + assert the provider is gone and the cdkd state is removed.
#
# NOTE: an AWS account holds at most ONE OIDC provider per issuer URL. This
# fixture assumes a dedicated test account with no pre-existing provider for
# token.actions.githubusercontent.com — the pre-run cleanup deletes it.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdIamOidcProviderExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" >/dev/null 2>&1 || true
  # Sweep stack-prefixed roles (deploy role + custom resource provider role).
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}')].RoleName" --output text 2>/dev/null); do
    for parn in $(aws iam list-attached-role-policies --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${role}" --policy-arn "${parn}" >/dev/null 2>&1 || true
    done
    for pname in $(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${role}" --policy-name "${pname}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
  # Sweep the custom resource backing Lambda + its log group. The log group
  # sweep goes by prefix (NOT via list-functions): after a successful destroy
  # the function is gone but its auto-created log group survives.
  for fn in $(aws lambda list-functions --region "${REGION}" --query "Functions[?starts_with(FunctionName, '${STACK}')].FunctionName" --output text 2>/dev/null); do
    aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for lg in $(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/lambda/${STACK}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (single clientId) ------------------------
echo "==> Phase 1: deploy OIDC provider with single clientId"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CLIENT_IDS_P1="$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" \
  --query 'ClientIDList' --output text)"
if [ "${CLIENT_IDS_P1}" != "sts.amazonaws.com" ]; then
  echo "FAIL: expected ClientIDList [sts.amazonaws.com], got '${CLIENT_IDS_P1}'" >&2
  exit 1
fi
CREATE_DATE_P1="$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" \
  --query 'CreateDate' --output text)"
echo "    provider created (CreateDate=${CREATE_DATE_P1}, clientIds=[${CLIENT_IDS_P1}])"

# --- Phase 2: add a clientId (custom resource in-place UPDATE) ---------
echo "==> Phase 2: re-deploy adding a second clientId (custom resource UPDATE)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CLIENT_ID_COUNT_P2="$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" \
  --query 'length(ClientIDList)' --output text)"
if [ "${CLIENT_ID_COUNT_P2}" != "2" ]; then
  echo "FAIL: expected 2 clientIds after update, got ${CLIENT_ID_COUNT_P2}" >&2
  exit 1
fi
CREATE_DATE_P2="$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" \
  --query 'CreateDate' --output text)"
if [ "${CREATE_DATE_P1}" != "${CREATE_DATE_P2}" ]; then
  echo "FAIL: provider was RECREATED (CreateDate ${CREATE_DATE_P1} -> ${CREATE_DATE_P2})" >&2
  exit 1
fi
echo "    clientId added in place (CreateDate unchanged) — custom resource UPDATE OK"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" >/dev/null 2>&1; then
  echo "FAIL: OIDC provider still exists after destroy" >&2
  exit 1
fi
echo "    provider deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — IAM OIDC provider custom resource create/update/delete lifecycle, all 3 phases passed"
