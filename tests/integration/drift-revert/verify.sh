#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftRevertExample
#   3. inject drift via direct AWS SDK calls
#   4. cdkd drift  -> assert exit 1 (drift detected)
#   5. cdkd drift --revert -y  -> assert exit 0
#   6. cdkd drift  -> assert exit 0 (clean)
#  6b. rewrite the recorded bucket-policy principal to a BOGUS unique id
#      -> assert exit 1 (a real principal change is still drift)
#  6c. rewrite it to the role's REAL unique id
#      -> assert exit 0 (issue #1515 canonicalization)
#   7. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDriftRevertExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/drift-revert"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: inject drift"
node inject-drift.ts

echo "[verify] step 4: cdkd drift (expect exit 1)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected drift exit 1, got ${rc}"
  exit 1
fi
echo "[verify] step 4 ok: exit ${rc}"

echo "[verify] step 5: cdkd drift --revert -y (expect exit 0)"
${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

echo "[verify] step 6: cdkd drift again (expect exit 0)"
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"

# Issue #1515: AWS renders an IAM role principal inside a resource policy as
# either its ARN or its `AROA…` unique id, so the deploy-time capture and a
# later read can hold two spellings of ONE principal — permanent phantom drift
# `--revert` cannot clear. Which form gets captured is a RACE (this fixture's
# autoDeleteObjects role is created concurrently with the policy referencing
# it), so the state baseline is rewritten HERE to make it deterministic.
# Both directions are asserted: a BOGUS unique id must still read as drift,
# which is what proves the clean verdict below is canonicalization and not the
# field silently dropping out of the comparison.
echo "[verify] step 6b: bogus principal unique id in the baseline (expect exit 1)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts bogus
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: a principal that is nobody's unique id must still be drift, got exit ${rc}"
  exit 1
fi
echo "[verify] step 6b ok: exit ${rc}"

echo "[verify] step 6c: the role's REAL unique id in the baseline (expect exit 0)"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" node inject-principal-uniqueid.ts real
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
echo "[verify] step 6c ok: issue #1515 canonicalization holds"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
