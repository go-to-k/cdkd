#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API greenfield fallback integ test
# (issue #614).
#
# Asserts that a Lambda Function whose template uses a silent-drop
# property (`RuntimeManagementConfig`) is auto-routed via Cloud Control
# API and that `RuntimeManagementConfig.UpdateRuntimeOn` reaches AWS
# verbatim — the silent-drop bug is closed by default. Also asserts the
# destroy path works through CC API.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdCcApiFallback"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-cc-api-fallback-probe"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion 1: state.provisionedBy on the Lambda is 'cc-api' -------
# Lookup by resourceType (CDK appends a hash to the logical id; the
# bare `SilentDropLambda` key does not exist — it's e.g.
# `SilentDropLambdaXXXXXXXX`).
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED}" != "cc-api" ]; then
  echo "FAIL: Lambda resource has provisionedBy='${PROVISIONED}', expected 'cc-api' (auto-route should have fired on RuntimeManagementConfig)" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: Lambda resource provisionedBy == 'cc-api' (auto-route fired)"

# --- Assertion 2: state.provisionedBy on the IAM Role is 'sdk' (heterogeneous) ---
ROLE_PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .value.provisionedBy // ""] | first')
if [ "${ROLE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: IAM Role resource has provisionedBy='${ROLE_PROVISIONED}', expected 'sdk'" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: IAM Role resource provisionedBy == 'sdk' (heterogeneous routing in one stack)"

# --- Assertion 3: RuntimeManagementConfig actually reached AWS ----------------------
# RuntimeManagementConfig lives on its own control-plane API
# (get-runtime-management-config), not on get-function-configuration.
# Default is 'Auto'; the fixture sets 'FunctionUpdate', so seeing
# 'FunctionUpdate' proves the CC route forwarded the silent-drop prop.
RTM_UPDATE_ON=$(aws lambda get-runtime-management-config \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RTM_UPDATE_ON}" != "FunctionUpdate" ]; then
  echo "FAIL: Lambda RuntimeManagementConfig.UpdateRuntimeOn is '${RTM_UPDATE_ON}', expected 'FunctionUpdate' (silent-drop NOT closed by CC route)" >&2
  exit 1
fi
echo "    OK: Lambda RuntimeManagementConfig.UpdateRuntimeOn == 'FunctionUpdate' on AWS (silent-drop CLOSED by #614)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy via CC delete path"
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
echo "==> cc-api-fallback test passed (silent-drop closed by CC auto-route + clean destroy)"
