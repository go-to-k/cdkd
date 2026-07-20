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

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdDynamodbTableclassSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

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

table_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["TableName"])'
}

table_class() {
  # TableClassSummary is omitted for STANDARD tables — treat absent as STANDARD.
  # `|| return 1`: errexit is cleared inside $( ), so a probe error must be
  # propagated explicitly instead of reading as an empty class.
  local cls
  cls="$(aws dynamodb describe-table --table-name "$1" --region "${REGION}" \
    --query 'Table.TableClassSummary.TableClass' --output text)" || return 1
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

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — DynamoDB TableClass switch (STANDARD -> STANDARD_INFREQUENT_ACCESS) reaches AWS, all 3 phases passed"
