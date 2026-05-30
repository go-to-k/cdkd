#!/usr/bin/env bash
# verify.sh - cdkd lambda integ (broad-set) + RecursiveLoop backfill assertion.
#
# Deploys the lambda fixture and asserts that RecursiveLoop reaches AWS
# via the dedicated PutFunctionRecursionConfig post-create API
# (LambdaFunctionProvider.create wires it after CreateFunction with
# delete-on-failure atomicity). Read-back uses the dedicated
# `aws lambda get-function-recursion-config` API. Then destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="LambdaStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the Handler function name from state (CDK auto-names it) ----
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.physicalId] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve Handler Lambda function name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved Handler function name: ${FN_NAME}"

# --- Assertion: provisionedBy == 'sdk' (RecursiveLoop now handled by SDK provider) ----
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED}" != "sdk" ]; then
  echo "FAIL: Handler Lambda has provisionedBy='${PROVISIONED}', expected 'sdk' (RecursiveLoop should NOT auto-route to CC now that the SDK provider handles it)" >&2
  exit 1
fi
echo "    OK: Handler Lambda provisionedBy == 'sdk' (RecursiveLoop is handled, no CC auto-route)"

# --- Assertion: RecursiveLoop reached AWS via PutFunctionRecursionConfig --
RECURSIVE_LOOP=$(aws lambda get-function-recursion-config \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'RecursiveLoop' --output text 2>/dev/null)
if [ "${RECURSIVE_LOOP}" != "Allow" ]; then
  echo "FAIL: Lambda RecursiveLoop is '${RECURSIVE_LOOP}', expected 'Allow' (PutFunctionRecursionConfig should have wired it)" >&2
  exit 1
fi
echo "    OK: Lambda RecursiveLoop == 'Allow' on AWS (SDK provider wired via PutFunctionRecursionConfig)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

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
echo "==> lambda test passed (RecursiveLoop backfill verified end-to-end + clean destroy)"
