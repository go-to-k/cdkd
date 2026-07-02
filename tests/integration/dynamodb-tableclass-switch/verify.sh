#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB TableClass-switch integ.
#
# Regression coverage for the bug where switching a table's TableClass
# (STANDARD <-> STANDARD_INFREQUENT_ACCESS) on redeploy was silently dropped:
# cdkd's dynamodb-table-provider.update() had no TableClass branch, so the
# deploy reported success while AWS kept the old class, and the next diff saw
# no change (state recorded the new class), so it could never self-heal.
# CloudFormation / `cdk deploy` apply this in place via UpdateTable. The fix
# wires TableClass into the existing UpdateTable branch (without re-asserting
# unchanged BillingMode / ProvisionedThroughput, which AWS rejects).
#
# Phases:
#   1. Deploy a STANDARD table. Assert AWS reports STANDARD.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (STANDARD_INFREQUENT_ACCESS).
#      Assert AWS now reports STANDARD_INFREQUENT_ACCESS (the switch actually
#      reached AWS, not just cdkd state).
#   3. Destroy + assert the table is gone and the cdkd state file is removed.
#
# AWS allows at most two TableClass switches per table per 30-day window; each
# run creates a fresh auto-named table and performs exactly one switch.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDynamodbTableclassSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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

table_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["TableName"])'
}

table_class() {
  # TableClassSummary is omitted for STANDARD tables — treat absent as STANDARD.
  local cls
  cls="$(aws dynamodb describe-table --table-name "$1" --region "${REGION}" \
    --query 'Table.TableClassSummary.TableClass' --output text)"
  if [ "${cls}" = "None" ]; then
    echo "STANDARD"
  else
    echo "${cls}"
  fi
}

# --- Phase 1: deploy baseline (STANDARD) --------------------------------
echo "==> Phase 1: deploy STANDARD table"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TABLE="$(table_name)"
echo "    table: ${TABLE}"

CLASS_P1="$(table_class "${TABLE}")"
echo "    AWS table class (Phase 1): ${CLASS_P1}"
if [ "${CLASS_P1}" != "STANDARD" ]; then
  echo "FAIL: expected STANDARD after Phase 1, got '${CLASS_P1}'" >&2
  exit 1
fi

# --- Phase 2: switch to STANDARD_INFREQUENT_ACCESS ----------------------
echo "==> Phase 2: re-deploy as STANDARD_INFREQUENT_ACCESS (TableClass via UpdateTable)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CLASS_P2="$(table_class "${TABLE}")"
echo "    AWS table class (Phase 2): ${CLASS_P2}"
if [ "${CLASS_P2}" != "STANDARD_INFREQUENT_ACCESS" ]; then
  echo "FAIL: expected STANDARD_INFREQUENT_ACCESS after Phase 2 (TableClass switch silently dropped?), got '${CLASS_P2}'" >&2
  exit 1
fi
echo "    table class switched (reached AWS, not just cdkd state)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DeleteTable is async: always enter the poll loop (a transient error on the
# FIRST describe must not be mistaken for NotFound and skip the deletion
# check), accept DELETING, and poll until fully gone.
table_gone=""
for attempt in $(seq 1 15); do
  STATUS="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1 || true)"
  if echo "${STATUS}" | grep -q "ResourceNotFoundException"; then
    table_gone="yes"
    break
  fi
  # Anything other than DELETING / gone is most likely a transient
  # describe error (throttle, network) — keep polling instead of
  # hard-failing after a clean destroy; the attempt bound terminates.
  if [ "${STATUS}" != "DELETING" ]; then
    echo "    describe returned unexpected output (attempt ${attempt}/15): ${STATUS}"
  else
    echo "    table still DELETING (attempt ${attempt}/15), waiting..."
  fi
  sleep 4
done
if [ -z "${table_gone}" ]; then
  echo "FAIL: table ${TABLE} did not finish deleting within ~60s" >&2
  exit 1
fi
echo "    table deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB TableClass switch (STANDARD -> STANDARD_INFREQUENT_ACCESS) reaches AWS, all 3 phases passed"
