#!/usr/bin/env bash
# verify.sh — cdkd Glue::Table OpenTableFormatInput (Iceberg) backfill integ
# test (issue #609).
#
# Asserts that a Glue Table whose template sets `OpenTableFormatInput`
# (Apache Iceberg, `{ IcebergInput: { MetadataOperation: 'CREATE', Version } }`)
# is actually created as an Iceberg table after `cdkd deploy` — the property
# was a silent-drop before the #609 backfill. OpenTableFormatInput is a
# create-time directive that GetTable does NOT echo back as an
# OpenTableFormatInput field; an Iceberg table surfaces via
# `Table.Parameters.table_type == 'ICEBERG'`, which is what we assert. Also
# asserts the destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="DataAnalyticsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# DB name mirrors the fixture: `${this.stackName}-analytics-db`.toLowerCase().
DB_NAME_FALLBACK="$(echo "${STACK}-analytics-db" | tr '[:upper:]' '[:lower:]')"
ICEBERG_TABLE_NAME="events_iceberg"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    # `state destroy` rejects `--force`; the confirmation skip flag is `--yes`.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    # Only sweep the state key when state destroy succeeded — otherwise we
    # would orphan the AWS resources the state record still points at.
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

# Resolve the database / iceberg-table names from the deploy state outputs,
# falling back to the fixture-computed values if the outputs are absent.
DB_NAME=$(echo "${STATE}" | jq -r '.outputs.DatabaseName // empty')
if [ -z "${DB_NAME}" ]; then
  DB_NAME="${DB_NAME_FALLBACK}"
fi
TABLE_NAME=$(echo "${STATE}" | jq -r '.outputs.IcebergTableName // empty')
if [ -z "${TABLE_NAME}" ]; then
  TABLE_NAME="${ICEBERG_TABLE_NAME}"
fi
echo "    Using database '${DB_NAME}', iceberg table '${TABLE_NAME}'"

# --- Assertion: OpenTableFormatInput reached AWS ----------------------
# OpenTableFormatInput is a create-time directive; GetTable does NOT return
# it as an OpenTableFormatInput field. An Iceberg table created via that
# directive surfaces with `Table.Parameters.table_type == 'ICEBERG'`. Seeing
# that proves OpenTableFormatInput was wired into CreateTable (silent-drop
# closed by the #609 backfill).
TABLE_TYPE=$(aws glue get-table \
  --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.Parameters.table_type' --output text 2>/dev/null || echo "")

# Case-insensitive comparison — Iceberg writes 'ICEBERG'.
TABLE_TYPE_UPPER=$(echo "${TABLE_TYPE}" | tr '[:lower:]' '[:upper:]')
if [ "${TABLE_TYPE_UPPER}" != "ICEBERG" ]; then
  echo "FAIL: Table.Parameters.table_type is '${TABLE_TYPE}', expected 'ICEBERG' (OpenTableFormatInput silent-drop NOT closed)" >&2
  aws glue get-table --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.Parameters' --output json 2>/dev/null || true
  exit 1
fi
echo "    OK: Table.Parameters.table_type == ICEBERG on AWS (OpenTableFormatInput silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws glue get-table --database-name "${DB_NAME}" --name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Glue Iceberg table ${DB_NAME}.${TABLE_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Glue Iceberg table is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> data-analytics test passed (OpenTableFormatInput Iceberg backfill closed + clean destroy)"
