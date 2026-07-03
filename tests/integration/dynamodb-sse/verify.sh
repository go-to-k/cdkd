#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB SSESpecification (SSEEnabled -> Enabled) regression.
#
# CDK's TableEncryption.AWS_MANAGED synthesizes SSESpecification: { SSEEnabled:
# true } (CFn casing). The DynamoDB SDK CreateTable field is `Enabled`, so the
# provider passing the CFn shape verbatim silently created an AWS-owned-encrypted
# table (no SSEDescription) instead of AWS-managed KMS. This pins the mapping:
# describe-table must report SSEDescription.Status=ENABLED + SSEType=KMS.
#
# Phases:
#   1. Deploy; assert SSEDescription.Status=ENABLED and SSEType=KMS.
#   2. Destroy; assert the table and cdkd state are gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbSseExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-dynamodb-sse-table"

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
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy + assert SSE actually enabled --------------------
echo "==> Phase 1: deploy table with AWS_MANAGED encryption"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SSE_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.SSEDescription.Status' --output text 2>/dev/null || echo NONE)"
SSE_TYPE="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.SSEDescription.SSEType' --output text 2>/dev/null || echo NONE)"
if [ "${SSE_STATUS}" != "ENABLED" ]; then
  echo "FAIL: expected SSEDescription.Status=ENABLED, got '${SSE_STATUS}' (the SSEEnabled->Enabled mapping was dropped -> table got AWS-owned encryption)" >&2
  exit 1
fi
if [ "${SSE_TYPE}" != "KMS" ]; then
  echo "FAIL: expected SSEDescription.SSEType=KMS, got '${SSE_TYPE}'" >&2
  exit 1
fi
echo "    SSE ENABLED with SSEType=KMS (AWS-managed encryption reached AWS)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

status="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "GONE")"
if [ "${status}" != "GONE" ] && [ "${status}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${status}) after destroy" >&2
  exit 1
fi
echo "    table deleted (status: ${status})"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB AWS_MANAGED encryption (SSEEnabled->Enabled mapping) reaches AWS as SSEType=KMS, destroy clean"
