#!/usr/bin/env bash
# verify.sh — cdkd Kinesis StreamMode-switch integ.
#
# Regression coverage for the bug where switching a Kinesis stream's StreamMode
# (PROVISIONED <-> ON_DEMAND) on redeploy was silently dropped: cdkd's
# kinesis-provider.update() had no UpdateStreamMode call, so the deploy reported
# success while AWS kept the old mode, and the next diff saw no change (state
# recorded the new mode), so it could never self-heal. CloudFormation / `cdk
# deploy` apply this in place via UpdateStreamMode. The fix wires UpdateStreamMode
# into update() and reconciles the shard count against the live open-shard count
# on the ON_DEMAND -> PROVISIONED direction.
#
# Phases:
#   1. Deploy a PROVISIONED (1 shard) stream. Assert AWS reports PROVISIONED.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (ON_DEMAND). Assert AWS now reports
#      ON_DEMAND (the switch actually reached AWS, not just cdkd state).
#   3. Destroy + assert the stream is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdKinesisStreamModeSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# AWS rate-limits StreamMode switches per stream NAME (a few per rolling 24h
# window), so each run uses a unique name to stay repeatable. Both phases of a
# single run share this one name (it must be stable WITHIN a run); the stack
# reads it via CDKD_KINESIS_STREAM_NAME.
STREAM_NAME="cdkd-kinesis-mode-switch-$(date +%s)"
export CDKD_KINESIS_STREAM_NAME="${STREAM_NAME}"

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
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --enforce-consumer-deletion \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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

stream_mode() {
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamModeDetails.StreamMode' --output text
}

# --- Phase 1: deploy baseline (PROVISIONED) ---------------------------
echo "==> Phase 1: deploy PROVISIONED stream (1 shard)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P1="$(stream_mode)"
echo "    AWS stream mode (Phase 1): ${MODE_P1}"
if [ "${MODE_P1}" != "PROVISIONED" ]; then
  echo "FAIL: expected PROVISIONED after Phase 1, got '${MODE_P1}'" >&2
  exit 1
fi
echo "    stream is PROVISIONED"

# --- Phase 2: switch to ON_DEMAND (must actually reach AWS) ------------
echo "==> Phase 2: re-deploy as ON_DEMAND (StreamMode switch via UpdateStreamMode)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P2="$(stream_mode)"
echo "    AWS stream mode (Phase 2): ${MODE_P2}"
if [ "${MODE_P2}" != "ON_DEMAND" ]; then
  echo "FAIL: expected ON_DEMAND after Phase 2 (StreamMode switch silently dropped?), got '${MODE_P2}'" >&2
  exit 1
fi
echo "    stream switched to ON_DEMAND (reached AWS, not just cdkd state)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Kinesis DeleteStream is ASYNC: the stream enters DELETING and
# describe-stream-summary keeps returning it for a few seconds after a clean
# destroy. Accept DELETING and poll until it is fully gone (ResourceNotFound),
# rather than asserting an immediate disappearance.
stream_gone=""
for attempt in $(seq 1 15); do
  # `|| true`: once the stream is fully gone, describe-stream-summary exits
  # non-zero (ResourceNotFoundException), which would trip `set -e` on the
  # assignment before we can inspect the captured message.
  STATUS="$(aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>&1 || true)"
  if echo "${STATUS}" | grep -q "ResourceNotFoundException"; then
    stream_gone="yes"
    break
  fi
  if [ "${STATUS}" != "DELETING" ]; then
    echo "FAIL: stream ${STREAM_NAME} in unexpected status '${STATUS}' after destroy" >&2
    exit 1
  fi
  echo "    stream still DELETING (attempt ${attempt}/15), waiting..."
  sleep 4
done
if [ -z "${stream_gone}" ]; then
  echo "FAIL: stream ${STREAM_NAME} did not finish deleting within ~60s" >&2
  exit 1
fi
echo "    stream deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Kinesis StreamMode switch (PROVISIONED -> ON_DEMAND) reaches AWS, all 3 phases passed"
