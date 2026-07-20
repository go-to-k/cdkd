#!/usr/bin/env bash
# verify.sh — cdkd Cognito add-custom-attribute (Schema in-place update) integ.
#
# Regression coverage for the bug where adding a custom attribute to an existing
# Cognito User Pool on redeploy was silently dropped: cdkd's
# cognito-provider.update() ignored the Schema property entirely, so the deploy
# reported success while AWS kept the old schema, and the next diff saw the
# change again with nothing applied. AWS supports adding a custom attribute in
# place via AddCustomAttributes; the fix wires that into update().
#
# Phases:
#   1. Deploy a pool with custom attributes tenantId + level. Assert AWS reports
#      exactly those two custom attributes.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds custom:region). Assert AWS now
#      reports all three (the added attribute reached AWS, not just cdkd state).
#   3. Destroy + assert the pool is gone and the cdkd state file is removed.
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
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdCognitoCustomAttributeAddExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="cdkd-cognito-attr-add-test"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

pool_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local pid
  pid="$(pool_id)"
  if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
    aws cognito-idp delete-user-pool --user-pool-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
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

custom_attr_count() {
  local pid="$1"
  aws cognito-idp describe-user-pool --user-pool-id "${pid}" --region "${REGION}" \
    --query "length(UserPool.SchemaAttributes[?starts_with(Name, 'custom:')])" --output text
}

has_custom_attr() {
  local pid="$1" name="$2"
  aws cognito-idp describe-user-pool --user-pool-id "${pid}" --region "${REGION}" \
    --query "UserPool.SchemaAttributes[?Name=='custom:${name}'].Name | [0]" --output text
}

# --- Phase 1: deploy baseline (tenantId + level) ----------------------
echo "==> Phase 1: deploy pool with custom attributes tenantId + level"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PID="$(pool_id)"
if [ -z "${PID}" ] || [ "${PID}" = "None" ]; then
  echo "FAIL: pool ${POOL_NAME} not found after Phase 1" >&2
  exit 1
fi
COUNT_P1="$(custom_attr_count "${PID}")"
echo "    custom attribute count (Phase 1): ${COUNT_P1}"
if [ "${COUNT_P1}" != "2" ]; then
  echo "FAIL: expected 2 custom attributes after Phase 1, got '${COUNT_P1}'" >&2
  exit 1
fi
echo "    pool has tenantId + level"

# --- Phase 2: add custom:region (must actually reach AWS) -------------
echo "==> Phase 2: re-deploy adding custom:region (AddCustomAttributes)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

COUNT_P2="$(custom_attr_count "${PID}")"
echo "    custom attribute count (Phase 2): ${COUNT_P2}"
if [ "${COUNT_P2}" != "3" ]; then
  echo "FAIL: expected 3 custom attributes after Phase 2 (add silently dropped?), got '${COUNT_P2}'" >&2
  exit 1
fi
REGION_ATTR="$(has_custom_attr "${PID}" region)"
if [ "${REGION_ATTR}" != "custom:region" ]; then
  echo "FAIL: expected custom:region to be added, got '${REGION_ATTR}'" >&2
  exit 1
fi
echo "    custom:region added (reached AWS, not just cdkd state)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if [ -n "$(pool_id)" ] && [ "$(pool_id)" != "None" ]; then
  echo "FAIL: pool ${POOL_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    pool deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Cognito add-custom-attribute reaches AWS via AddCustomAttributes, all 3 phases passed"
