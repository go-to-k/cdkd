#!/usr/bin/env bash
# verify.sh — cdkd nested-map-key removal (Lambda env var) integ.
#
# A Lambda's Environment.Variables is a nested map. Removing a key from it must
# reach AWS. cdkd previously compared the nested map asymmetrically (only the
# new-side keys), so a removed key compared equal (NO_CHANGE) and never
# re-provisioned -> the dropped env var stayed live. This test proves cdkd now
# removes it.
#
# Phases:
#   1. Deploy with env {KEEP, TOREMOVE}; assert both present on AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (env {KEEP}). Assert TOREMOVE is GONE
#      from AWS and KEEP remains (a pre-fix run leaves TOREMOVE live).
#   3. Destroy; assert the function is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaEnvRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

envvar() {
  # Print the value of env var $1 on the function (empty if absent).
  aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
    --query "Environment.Variables.$1" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy {KEEP, TOREMOVE} ---------------------------------
echo "==> Phase 1: deploy env {KEEP, TOREMOVE}"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ "$(envvar KEEP)" != "yes" ] || [ "$(envvar TOREMOVE)" != "bye" ]; then
  echo "FAIL: expected KEEP=yes + TOREMOVE=bye after Phase 1, got KEEP=$(envvar KEEP) TOREMOVE=$(envvar TOREMOVE)" >&2
  exit 1
fi
echo "    KEEP + TOREMOVE present"

# --- Phase 2: remove TOREMOVE -----------------------------------------
echo "==> Phase 2: re-deploy env {KEEP} (TOREMOVE must be removed from AWS)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ "$(envvar KEEP)" != "yes" ]; then
  echo "FAIL: KEEP missing after Phase 2 (got '$(envvar KEEP)')" >&2; exit 1
fi
TR="$(envvar TOREMOVE)"
if [ "${TR}" = "bye" ]; then
  echo "FAIL: TOREMOVE still present after Phase 2 — nested-map-key removal not applied" >&2; exit 1
fi
echo "    TOREMOVE removed, KEEP retained"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1
fi
echo "    function deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — nested-map-key removal (Lambda env var), all 3 phases passed"
