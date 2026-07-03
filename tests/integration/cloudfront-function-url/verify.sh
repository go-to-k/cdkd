#!/usr/bin/env bash
# verify.sh — cdkd Lambda::Permission InvokedViaFunctionUrl backfill integ
# test (issue #609).
#
# Asserts that a Lambda Permission whose template sets
# `InvokedViaFunctionUrl: true` (paired with the only AWS-accepted
# action `lambda:InvokeFunction`) has the AWS-side condition
# `Condition.Bool."lambda:InvokedViaFunctionUrl" == "true"` present on
# the resource-policy statement after `cdkd deploy` — the property was
# a silent-drop before the #609 backfill. Also asserts the destroy
# path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CloudFrontFunctionUrlStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPLICIT_SID="ExplicitFnUrlPermission"

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

# Pull the deployed Lambda function name from cdkd state outputs.
FUNCTION_NAME=$(echo "${STATE}" | jq -r '.outputs.FunctionName // empty')
if [ -z "${FUNCTION_NAME}" ]; then
  echo "FAIL: cdkd state did not emit a FunctionName output" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: deployed Lambda function name = ${FUNCTION_NAME}"

# --- Assertion: explicit Permission has the InvokedViaFunctionUrl
# --- condition reflected by AWS ---------------------------------------
# `InvokedViaFunctionUrl: true` is encoded by AWS by injecting a
# `Condition.StringEquals."lambda:FunctionUrlAuthType"` entry on the
# resource-policy statement. Seeing that condition on the explicit SID
# proves the silent-drop is closed by the #609 backfill.
POLICY_JSON=$(aws lambda get-policy \
  --function-name "${FUNCTION_NAME}" --region "${REGION}" \
  --query 'Policy' --output text 2>/dev/null)

if [ -z "${POLICY_JSON}" ]; then
  echo "FAIL: aws lambda get-policy returned no Policy for ${FUNCTION_NAME}" >&2
  exit 1
fi

STATEMENT=$(echo "${POLICY_JSON}" | jq --arg sid "${EXPLICIT_SID}" \
  '.Statement[] | select(.Sid == $sid)')
if [ -z "${STATEMENT}" ] || [ "${STATEMENT}" = "null" ]; then
  echo "FAIL: explicit permission SID '${EXPLICIT_SID}' not found in resource policy" >&2
  echo "${POLICY_JSON}" | jq .
  exit 1
fi
echo "    OK: explicit permission statement with SID '${EXPLICIT_SID}' is on the policy"

echo "    statement shape: $(echo "${STATEMENT}" | jq -c .)"

# Setting InvokedViaFunctionUrl: true on a Permission with Action
# lambda:InvokeFunction makes AWS inject a `Bool` Condition keyed on
# the `lambda:InvokedViaFunctionUrl` IAM context key (verified
# empirically against the live us-east-1 endpoint, 2026-05-29):
#
#   "Condition": { "Bool": { "lambda:InvokedViaFunctionUrl": "true" } }
#
# The condition's presence is what proves the property reached AWS and
# was not silent-dropped on the way.
INVOKED_VIA_URL=$(echo "${STATEMENT}" \
  | jq -r '.Condition.Bool."lambda:InvokedViaFunctionUrl" // empty')
if [ "${INVOKED_VIA_URL}" != "true" ]; then
  echo "FAIL: explicit permission statement is missing Condition.Bool.\"lambda:InvokedViaFunctionUrl\" (InvokedViaFunctionUrl silent-drop NOT closed)" >&2
  echo "${STATEMENT}" | jq .
  exit 1
fi
echo "    OK: Condition.Bool.\"lambda:InvokedViaFunctionUrl\" == 'true' (InvokedViaFunctionUrl silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Function gone implies its resource policy is gone too.
FUNCTION_GONE=""
for _ in $(seq 1 24); do
  if ! aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    FUNCTION_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${FUNCTION_GONE}" ]; then
  echo "FAIL: Lambda function ${FUNCTION_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: Lambda function is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> cloudfront-function-url test passed (InvokedViaFunctionUrl backfill closed + clean destroy)"
