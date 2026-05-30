#!/usr/bin/env bash
# verify.sh - cdkd eventbridge integ + LogConfig backfill assertion (#609).
#
# Deploys the eventbridge fixture and asserts that LogConfig reaches AWS
# via the CreateEventBus wire path (no separate control-plane API). Then
# destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="EventBridgeStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUS_NAME="cdkd-test-bus-${ACCOUNT_ID}"

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

# --- Assertion: LogConfig reached AWS via CreateEventBus --------------
BUS=$(aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}")
LOG_LEVEL=$(echo "${BUS}" | jq -r '.LogConfig.Level // empty')
INCLUDE_DETAIL=$(echo "${BUS}" | jq -r '.LogConfig.IncludeDetail // empty')

if [ "${LOG_LEVEL}" != "INFO" ]; then
  echo "FAIL: EventBus LogConfig.Level is '${LOG_LEVEL}', expected 'INFO'" >&2
  echo "      raw describe-event-bus: ${BUS}" >&2
  exit 1
fi
if [ "${INCLUDE_DETAIL}" != "FULL" ]; then
  echo "FAIL: EventBus LogConfig.IncludeDetail is '${INCLUDE_DETAIL}', expected 'FULL'" >&2
  echo "      raw describe-event-bus: ${BUS}" >&2
  exit 1
fi
echo "    OK: EventBus LogConfig.Level == 'INFO' + IncludeDetail == 'FULL' on AWS (LogConfig backfill CLOSED)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: EventBus '${BUS_NAME}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: EventBus is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> eventbridge test passed (EventBus LogConfig backfill closed + clean destroy)"
