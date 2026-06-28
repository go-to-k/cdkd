#!/usr/bin/env bash
# verify.sh — cdkd immutable-Name replacement integ (Kinesis Stream + Secret).
#
# AWS::Kinesis::Stream and AWS::SecretsManager::Secret `Name` are immutable in
# CloudFormation ("Update requires: Replacement"). cdkd previously had no
# replacement rule for either, so a rename was attempted as an in-place update —
# silently dropped (no AWS rename API), diverging cdkd state from AWS. This test
# proves cdkd now REPLACES (DELETE old + CREATE new) on a rename.
#
# Phases:
#   1. Deploy v1; assert the -v1 stream + -v1 secret exist.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (names -> -v2). Assert the -v2
#      resources exist AND the -v1 resources are GONE (replacement, not in-place
#      no-op). A pre-fix run leaves -v1 alive and -v2 absent.
#   3. Destroy; assert both -v2 resources are gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdReplacementImmutableNameExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# "live" = the stream exists AND is not mid-deletion. Kinesis DeleteStream is
# ASYNC, so describe-stream-summary keeps succeeding (StreamStatus=DELETING) for
# a while after a delete — treat DELETING as gone so the destroy / replacement
# assertions don't race the async teardown.
stream_live() {
  local status
  status="$(aws kinesis describe-stream-summary --stream-name "$1" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>/dev/null)" || return 1
  [ -n "${status}" ] && [ "${status}" != "DELETING" ] && [ "${status}" != "None" ]
}
secret_active() {
  # Active (not scheduled-for-deletion) secret with this exact name.
  local n; n="$(aws secretsmanager list-secrets --region "${REGION}" \
    --query "SecretList[?Name=='$1'].Name | [0]" --output text 2>/dev/null)"
  [ "${n}" = "$1" ]
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for suffix in v1 v2; do
    aws kinesis delete-stream --stream-name "${STACK}-stream-${suffix}" \
      --enforce-consumer-deletion --region "${REGION}" >/dev/null 2>&1
    aws secretsmanager delete-secret --secret-id "${STACK}-secret-${suffix}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  done
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

# --- Phase 1: deploy v1 -----------------------------------------------
echo "==> Phase 1: deploy v1 (stream + secret)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if ! stream_live "${STACK}-stream-v1"; then
  echo "FAIL: ${STACK}-stream-v1 missing after Phase 1" >&2; exit 1
fi
if ! secret_active "${STACK}-secret-v1"; then
  echo "FAIL: ${STACK}-secret-v1 missing after Phase 1" >&2; exit 1
fi
echo "    v1 stream + secret present"

# --- Phase 2: rename -> v2 (must REPLACE) -----------------------------
echo "==> Phase 2: re-deploy renaming both to -v2 (must replace, not in-place)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if ! stream_live "${STACK}-stream-v2"; then
  echo "FAIL: ${STACK}-stream-v2 missing after Phase 2 — rename was not applied (in-place no-op bug)" >&2
  exit 1
fi
if ! secret_active "${STACK}-secret-v2"; then
  echo "FAIL: ${STACK}-secret-v2 missing after Phase 2 — rename was not applied (in-place no-op bug)" >&2
  exit 1
fi
if stream_live "${STACK}-stream-v1"; then
  echo "FAIL: ${STACK}-stream-v1 still exists after Phase 2 — old resource not deleted on replacement" >&2
  exit 1
fi
if secret_active "${STACK}-secret-v1"; then
  echo "FAIL: ${STACK}-secret-v1 still active after Phase 2 — old resource not deleted on replacement" >&2
  exit 1
fi
echo "    replacement confirmed: -v2 present, -v1 gone"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if stream_live "${STACK}-stream-v2"; then
  echo "FAIL: ${STACK}-stream-v2 still exists after destroy" >&2; exit 1
fi
if secret_active "${STACK}-secret-v2"; then
  echo "FAIL: ${STACK}-secret-v2 still active after destroy" >&2; exit 1
fi
echo "    both v2 resources deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — immutable-Name replacement (Kinesis Stream + Secret) CREATE + rename-replace + destroy, all 3 phases passed"
