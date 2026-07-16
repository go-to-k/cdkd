#!/usr/bin/env bash
# verify.sh — cdkd EventBridge custom bus + Archive integ.
#
# First AWS::Events::Archive coverage in the integ suite. Asserts the archive
# config reaches AWS, the retention/pattern UPDATE is applied in place
# (CreationTime unchanged), and destroy removes archive-then-bus cleanly.
# Confirmed-clean /hunt-bugs pattern; regression guard.
#
# Phases:
#   1. Deploy; assert retention=3 and single-source pattern; capture
#      CreationTime.
#   2. Re-deploy with CDKD_TEST_UPDATE=true; assert retention=7, two-source
#      pattern, and CreationTime unchanged (in-place update).
#   3. Destroy + assert archive + bus are gone and the cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEventbridgeArchiveExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BUS_NAME="cdkd-integ-archive-bus"
ARCHIVE_NAME="cdkd-integ-archive"

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
  aws events delete-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws events delete-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline (retention 3, single source) ---------------
echo "==> Phase 1: deploy custom bus + archive"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RETENTION_P1="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'RetentionDays' --output text)"
if [ "${RETENTION_P1}" != "3" ]; then
  echo "FAIL: expected RetentionDays=3 after Phase 1, got '${RETENTION_P1}'" >&2
  exit 1
fi
PATTERN_P1="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'EventPattern' --output text)"
if ! printf '%s' "${PATTERN_P1}" | grep -q 'integ.app'; then
  echo "FAIL: archive event pattern missing integ.app: ${PATTERN_P1}" >&2
  exit 1
fi
CREATED_P1="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'CreationTime' --output text)"
echo "    archive created (retention=3, CreationTime=${CREATED_P1})"

# --- Phase 2: grow retention + pattern (in-place UPDATE) ------------------
echo "==> Phase 2: re-deploy with retention 7 + second source"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RETENTION_P2="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'RetentionDays' --output text)"
if [ "${RETENTION_P2}" != "7" ]; then
  echo "FAIL: expected RetentionDays=7 after update, got '${RETENTION_P2}'" >&2
  exit 1
fi
PATTERN_P2="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'EventPattern' --output text)"
if ! printf '%s' "${PATTERN_P2}" | grep -q 'integ.worker'; then
  echo "FAIL: archive event pattern missing added integ.worker: ${PATTERN_P2}" >&2
  exit 1
fi
CREATED_P2="$(aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" \
  --query 'CreationTime' --output text)"
if [ "${CREATED_P1}" != "${CREATED_P2}" ]; then
  echo "FAIL: archive was RECREATED (CreationTime ${CREATED_P1} -> ${CREATED_P2})" >&2
  exit 1
fi
echo "    retention + pattern updated in place (CreationTime unchanged)"

# --- Phase 3: destroy -----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws events describe-archive --archive-name "${ARCHIVE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: archive ${ARCHIVE_NAME} still exists after destroy" >&2
  exit 1
fi
if aws events describe-event-bus --name "${BUS_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: event bus ${BUS_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    archive + bus deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — EventBridge Archive deploy/update/destroy, all 3 phases passed"
