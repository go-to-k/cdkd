#!/usr/bin/env bash
#
# End-to-end real-AWS validation for cdkd's DocDB + Neptune SDK providers
# (PR #207). Pre-PR these types fell through to CC API; this is the
# first time the new providers run against actual AWS.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDocdbNeptuneExample with per-type long timeouts
#      (DocDB / Neptune cluster + instance creates each take 5-10 min)
#   3. cdkd state list — sanity check that state was written
#   4. cdkd destroy --force with the same long per-type timeouts (DocDB
#      / Neptune deletes can also take 5-10 min)
#   5. cdkd state list — must report empty for the stack
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
#
# A failed run leaves DocDB / Neptune clusters that bill ~$0.07/hr each
# (db.t3.medium). The cleanup trap re-attempts destroy on any failure
# exit so a botched run does not bill the user indefinitely.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDocdbNeptuneExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/docdb-neptune"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# Per-resource timeout overrides for DocDB + Neptune. AWS create / delete
# round-trips on cluster + instance routinely run 5–10 min each; the
# default 30m cdkd budget is plenty per-resource but the warn threshold
# would otherwise fire spuriously. We pass both create-side AND delete-
# side cluster + instance overrides, since the same `--resource-timeout`
# flag applies to deploy and destroy.
TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::DocDB::DBCluster=20m
  --resource-timeout AWS::DocDB::DBInstance=25m
  --resource-timeout AWS::Neptune::DBCluster=20m
  --resource-timeout AWS::Neptune::DBInstance=25m
)

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# On any failure exit, re-attempt destroy so we never leak DocDB /
# Neptune clusters.
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup destroy"
    ${CLI} destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force \
      "${TIMEOUT_OVERRIDES[@]}" || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 3: cdkd state list (stack should be present)"
if ! ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state was not written after deploy"
  exit 1
fi
echo "[verify] step 3 ok"

echo "[verify] step 4: cdkd destroy --force"
${CLI} destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 5: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 5 ok: state cleared"

# AWS-side orphan auditing is delegated to /run-integ's /cleanup pass.

trap - EXIT INT TERM
echo "[verify] PASS"
