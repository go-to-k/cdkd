#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB WarmThroughput backfill integ test
# (issue #609).
#
# Asserts that a DynamoDB table whose template sets pre-warmed capacity
# (`WarmThroughput.ReadUnitsPerSecond` / `WriteUnitsPerSecond`) has those
# values reach AWS after `cdkd deploy` — the property was a silent-drop
# before the #609 backfill. The `dynamodb-streams` fixture's EventsTable
# is PROVISIONED (WarmThroughput works with both billing modes) and also
# exercises the sibling PITR / TTL props. Also asserts the destroy path
# cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="DynamodbStreamsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# AWS enforces minimums of 12000 read units / 4000 write units per second.
EXPECTED_READ=12000
EXPECTED_WRITE=4000

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# The fixture's EventsTable has no explicit tableName, so CDK auto-generates
# the physical name; we resolve it from cdkd state after deploy.
TABLE_NAME=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS table"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${TABLE_NAME}" ]; then
    aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# Resolve the auto-generated table physical name from cdkd state.
TABLE_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DynamoDB::Table") | .value.physicalId] | first // ""')
if [ -z "${TABLE_NAME}" ] || [ "${TABLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve DynamoDB table physical name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved table name: ${TABLE_NAME}"

# --- Assertion: WarmThroughput reached AWS ----------------------------
# DescribeTable returns Table.WarmThroughput (ReadUnitsPerSecond /
# WriteUnitsPerSecond plus an AWS-managed status field) only on tables that
# set warm throughput. Seeing the templated read/write values proves the
# silent-drop is closed by the #609 backfill.
WT=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.WarmThroughput' --output json 2>/dev/null)

ACTUAL_READ=$(echo "${WT}" | jq -r '.ReadUnitsPerSecond // "null"')
ACTUAL_WRITE=$(echo "${WT}" | jq -r '.WriteUnitsPerSecond // "null"')

if [ "${ACTUAL_READ}" != "${EXPECTED_READ}" ]; then
  echo "FAIL: Table.WarmThroughput.ReadUnitsPerSecond is '${ACTUAL_READ}', expected '${EXPECTED_READ}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.ReadUnitsPerSecond == ${EXPECTED_READ} on AWS"

if [ "${ACTUAL_WRITE}" != "${EXPECTED_WRITE}" ]; then
  echo "FAIL: Table.WarmThroughput.WriteUnitsPerSecond is '${ACTUAL_WRITE}', expected '${EXPECTED_WRITE}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.WriteUnitsPerSecond == ${EXPECTED_WRITE} on AWS (silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# DynamoDB DeleteTable is async: the table lingers in DELETING for a few
# seconds before describe-table returns ResourceNotFoundException. Poll
# until it is truly gone rather than racing the async delete.
TABLE_GONE=""
for _ in $(seq 1 24); do
  if ! aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB table is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-streams test passed (WarmThroughput backfill closed + clean destroy)"
