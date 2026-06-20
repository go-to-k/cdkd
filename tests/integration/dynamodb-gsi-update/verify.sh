#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB "add a Global Secondary Index" in-place UPDATE integ.
#
# Regression coverage for the bug where adding a GSI to an existing table grew
# AttributeDefinitions, which cdkd misclassified as an immutable-property change
# and tried to REPLACE the table (CreateTable on the same name -> "Table already
# exists" -> deploy fails + rollback). The fix routes the GSI add through
# UpdateTable's GlobalSecondaryIndexUpdates so the table is updated in place.
#
# Phases:
#   1. Deploy the table with only the `pk` partition key; capture its
#      CreationDateTime + assert no GSI.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds GSI `gsi1` on `gsipk`).
#      Assert: deploy succeeds, the table's CreationDateTime is UNCHANGED (no
#      replacement), GSI `gsi1` exists and reaches ACTIVE, and the table routes
#      via the SDK provider (provisionedBy=sdk).
#   3. Destroy + assert the table is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbGsiUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-gsi-update-test-table"
GSI_NAME="gsi1"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

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

# --- Phase 1: deploy baseline (no GSI) --------------------------------
echo "==> Phase 1: deploy baseline table (pk only, no GSI)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GSI_COUNT_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text)"
if [ "${GSI_COUNT_P1}" != "0" ]; then
  echo "FAIL: expected 0 GSIs after Phase 1, got ${GSI_COUNT_P1}" >&2
  exit 1
fi

CREATION_P1="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
echo "    baseline table CreationDateTime=${CREATION_P1}"

# --- Phase 2: add a GSI (in-place UPDATE, must NOT replace) ------------
echo "==> Phase 2: re-deploy adding GSI ${GSI_NAME} (in-place UpdateTable)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The table must be the SAME table (no replacement): CreationDateTime unchanged.
CREATION_P2="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.CreationDateTime' --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: table was REPLACED (CreationDateTime ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    table identity preserved (CreationDateTime unchanged) — no replacement"

# The GSI must exist and be ACTIVE.
GSI_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='${GSI_NAME}'].IndexStatus | [0]" --output text)"
if [ "${GSI_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: GSI ${GSI_NAME} expected ACTIVE, got '${GSI_STATUS}'" >&2
  exit 1
fi
echo "    GSI ${GSI_NAME} is ACTIVE"

# The table must route via the SDK provider (catch a silent-drop routing flip).
PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::DynamoDB::Table");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected DynamoDB table provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    table routed via SDK provider (provisionedBy=sdk)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DeleteTable is ASYNC: cdkd's destroy returns once DeleteTable is accepted, at
# which point describe-table still reports the table in DELETING state for a
# while. Accept GONE (ResourceNotFound) OR DELETING as success; only a table
# still in a live state (ACTIVE / UPDATING) means the delete never happened.
# (No polling/sleep — DeleteTable transitions the table to DELETING
# synchronously, so a single check right after destroy is sufficient.)
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

echo "[verify] PASS — DynamoDB GSI add is an in-place UPDATE (no replacement), all 3 phases passed"
