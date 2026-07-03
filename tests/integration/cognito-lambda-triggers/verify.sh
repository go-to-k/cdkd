#!/usr/bin/env bash
# verify.sh — cdkd Cognito UserPool Lambda triggers integ.
#
# A daily CDK pattern: a UserPool with `lambdaTriggers` (preSignUp +
# postConfirmation). CDK wires a UserPool LambdaConfig (one ARN per trigger) +
# one AWS::Lambda::Permission per trigger granting cognito-idp invoke.
#
# Phases:
#   1. Deploy. Assert the UserPool's LambdaConfig carries BOTH trigger ARNs.
#   2. Functional: sign up a user. preSignUp sets autoConfirmUser=true and runs
#      INLINE during SignUp, so a CONFIRMED user proves the LambdaConfig +
#      Lambda permission actually work (a missing permission makes SignUp fail).
#   3. Destroy + assert the UserPool and state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdCognitoLambdaTriggersExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="cdkd-cognito-triggers-pool"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

delete_pool_by_name() {
  local pid
  pid="$(aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null)"
  if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
    aws cognito-idp delete-user-pool --user-pool-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_pool_by_name
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
POOL_ID="$(echo "${STATE}" | jq -r '.outputs.UserPoolId')"
CLIENT_ID="$(echo "${STATE}" | jq -r '.outputs.UserPoolClientId')"
if [ -z "${POOL_ID}" ] || [ "${POOL_ID}" = "null" ]; then
  echo "FAIL: could not resolve UserPoolId output after deploy" >&2
  exit 1
fi
echo "    Resolved UserPoolId=${POOL_ID} ClientId=${CLIENT_ID}"

# --- Assertion 1: LambdaConfig carries both trigger ARNs --------------
LC="$(aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}" \
  --query 'UserPool.LambdaConfig' --output json)"
PRE="$(echo "${LC}" | jq -r '.PreSignUp // empty')"
POST="$(echo "${LC}" | jq -r '.PostConfirmation // empty')"
if [ -z "${PRE}" ] || [ -z "${POST}" ]; then
  echo "FAIL: UserPool LambdaConfig missing a trigger ARN (PreSignUp='${PRE}' PostConfirmation='${POST}')" >&2
  echo "      raw LambdaConfig: ${LC}" >&2
  exit 1
fi
echo "    OK: LambdaConfig has both PreSignUp + PostConfirmation ARNs"

# --- Assertion 2: functional sign-up auto-confirms (trigger fired) -----
USERNAME="cdkd-probe-user"
PASSWORD="Cdkd-Test-1234!"
echo "==> Phase 2: sign up '${USERNAME}' (preSignUp must auto-confirm)"
aws cognito-idp sign-up --client-id "${CLIENT_ID}" --region "${REGION}" \
  --username "${USERNAME}" --password "${PASSWORD}" >/dev/null
STATUS="$(aws cognito-idp admin-get-user --user-pool-id "${POOL_ID}" --region "${REGION}" \
  --username "${USERNAME}" --query 'UserStatus' --output text 2>/dev/null || echo "MISSING")"
if [ "${STATUS}" != "CONFIRMED" ]; then
  echo "FAIL: signed-up user status is '${STATUS}', expected CONFIRMED (preSignUp trigger did not run)" >&2
  exit 1
fi
echo "    OK: user auto-confirmed (preSignUp trigger fired inline during SignUp)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Use describe-user-pool on the known id (strongly consistent) — list-user-pools
# is eventually consistent and can still show a just-deleted pool for a few
# seconds, which would be a false-positive failure.
if aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: UserPool ${POOL_ID} still exists after destroy" >&2
  exit 1
fi
echo "    OK: UserPool is gone"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — Cognito Lambda triggers wired + fired end-to-end, all 3 phases passed"
