#!/usr/bin/env bash
# verify.sh — cdkd API Gateway Stage config-prop backfill integ test
# (issue #609).
#
# Asserts that the Stage config props wired by the #609 backfill actually
# reach AWS on deploy (they ride on the Stage's OWN CreateStage /
# UpdateStage API call, NOT a separate control-plane call):
#   - AWS::ApiGateway::Stage TracingEnabled (X-Ray) == true
#   - AWS::ApiGateway::Stage Variables == { appVersion, featureFlag }
# Both are read back via `aws apigateway get-stage` and parsed with jq.
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="ApiGatewayStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

API_NAME="cdkd-hello-api"
STAGE_NAME="prod"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort cleanup
  # should run as much as it can with the env it has.
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

# --- Resolve the REST API id ------------------------------------------
API_ID=$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAIL: could not resolve REST API id for '${API_NAME}'" >&2
  exit 1
fi
echo "    Resolved REST API id: ${API_ID}"

# --- Read the stage back from AWS -------------------------------------
STAGE=$(aws apigateway get-stage \
  --rest-api-id "${API_ID}" \
  --stage-name "${STAGE_NAME}" \
  --region "${REGION}")

# --- Assertion 1: TracingEnabled reached AWS --------------------------
TRACING=$(echo "${STAGE}" | jq -r '.tracingEnabled')
if [ "${TRACING}" != "true" ]; then
  echo "FAIL: Stage tracingEnabled is '${TRACING}', expected 'true'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
echo "    OK: Stage tracingEnabled == true on AWS (TracingEnabled backfill CLOSED)"

# --- Assertion 2: Variables reached AWS -------------------------------
APP_VERSION=$(echo "${STAGE}" | jq -r '.variables.appVersion // empty')
FEATURE_FLAG=$(echo "${STAGE}" | jq -r '.variables.featureFlag // empty')
if [ "${APP_VERSION}" != "1.0.0" ]; then
  echo "FAIL: Stage variables.appVersion is '${APP_VERSION}', expected '1.0.0'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
if [ "${FEATURE_FLAG}" != "enabled" ]; then
  echo "FAIL: Stage variables.featureFlag is '${FEATURE_FLAG}', expected 'enabled'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
echo "    OK: Stage variables {appVersion, featureFlag} reached AWS (Variables backfill CLOSED)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

API_ID_AFTER=$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)
if [ "${API_ID_AFTER}" != "None" ] && [ -n "${API_ID_AFTER}" ]; then
  echo "FAIL: REST API '${API_NAME}' still exists after destroy (id ${API_ID_AFTER})" >&2
  exit 1
fi
echo "    OK: REST API is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> apigateway test passed (Stage config-prop backfill closed + clean destroy)"
