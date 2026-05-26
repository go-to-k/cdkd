#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API greenfield fallback integ test
# (issue #614).
#
# Asserts that a Lambda Function whose template uses a silent-drop
# property (`LoggingConfig`) is auto-routed via Cloud Control API and
# that `LoggingConfig` reaches AWS verbatim — the silent-drop bug is
# closed by default. Also asserts the destroy path works through CC API.
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

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  set -e
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
PROVISIONED=$(echo "${STATE}" | jq -r '.resources.SilentDropLambda.provisionedBy // ""')
if [ "${PROVISIONED}" != "cc-api" ]; then
  echo "FAIL: resources.SilentDropLambda.provisionedBy is '${PROVISIONED}', expected 'cc-api'" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: resources.SilentDropLambda.provisionedBy == 'cc-api' (auto-route fired)"

# --- Assertion 2: state.provisionedBy on the IAM Role is 'sdk' (heterogeneous) ---
ROLE_PROVISIONED=$(echo "${STATE}" | jq -r '.resources.FnRole.provisionedBy // ""')
if [ "${ROLE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: resources.FnRole.provisionedBy is '${ROLE_PROVISIONED}', expected 'sdk'" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: resources.FnRole.provisionedBy == 'sdk' (heterogeneous routing in one stack)"

# --- Assertion 3: LoggingConfig actually reached AWS ----------------------
LOG_CONFIG=$(aws lambda get-function-configuration \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'LoggingConfig' --output json 2>/dev/null)
LOG_FORMAT=$(echo "${LOG_CONFIG}" | jq -r '.LogFormat // ""')
if [ "${LOG_FORMAT}" != "JSON" ]; then
  echo "FAIL: Lambda LoggingConfig.LogFormat is '${LOG_FORMAT}', expected 'JSON' (silent-drop NOT closed by CC route)" >&2
  echo "    AWS-side LoggingConfig: ${LOG_CONFIG}"
  exit 1
fi
echo "    OK: Lambda LoggingConfig.LogFormat == 'JSON' on AWS (silent-drop CLOSED by #614)"

APP_LEVEL=$(echo "${LOG_CONFIG}" | jq -r '.ApplicationLogLevel // ""')
if [ "${APP_LEVEL}" != "INFO" ]; then
  echo "FAIL: Lambda LoggingConfig.ApplicationLogLevel is '${APP_LEVEL}', expected 'INFO'" >&2
  exit 1
fi
echo "    OK: Lambda LoggingConfig.ApplicationLogLevel == 'INFO' on AWS"

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
