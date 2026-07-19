#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd drift` + `cdkd drift --revert`
# against TAG-heavy and ARRAY-heavy resource types — the issue #802
# canonicalization path (`src/analyzer/drift-normalize.ts`).
#
# What this fixture proves that drift-revert / drift-revert-vpc do NOT:
#   - NO-FALSE-POSITIVE on a benign tag-list reorder: AWS returning a tag
#     set in a different order than the deploy-time snapshot must NOT show
#     as drift (canonicalizeTagListsDeep). Proven two ways: (a) a clean
#     deploy is drift-free even though several resources carry tag lists +
#     ARN arrays that AWS reorders on readback, and (b) an INDUCED reorder
#     (re-PUT the same S3 tags reversed) is still drift-free.
#   - TRUE-DRIFT still detected: a changed tag VALUE, an added managed-
#     policy Action, and an added SG ingress rule all surface as drift and
#     are reverted.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftArraysExample
#   3a. cdkd drift -> assert exit 0 (clean immediately after deploy)
#   3b. inject benign tag reorder; cdkd drift -> assert exit 0 (no false
#       positive on reorder)
#   4. inject REAL drift (tag value + policy action + SG ingress rule);
#       cdkd drift -> assert exit 1 (detected)
#   5. cdkd drift --revert -y -> assert exit 0
#   6. cdkd drift -> assert exit 0 (clean)
#   7. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
# BSD/macOS-portable (no `grep -P`, no `date -d`); real rc captured and an
# explicit `[verify] PASS` printed only on full success.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDriftArraysExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/drift-revert-arrays"
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
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3a: cdkd drift immediately after a clean deploy (expect exit 0)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: a clean deploy reported drift (exit ${rc}); tag-list / ARN-array reorder canonicalization regressed"
  exit 1
fi
echo "[verify] step 3a ok: clean deploy is drift-free"

echo "[verify] step 3b: induce a BENIGN tag reorder, then cdkd drift (expect exit 0)"
node inject-drift.ts reorder
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: a pure tag-list REORDER (same set, different order) was reported as drift (exit ${rc}) — #802 canonicalizeTagListsDeep regressed"
  exit 1
fi
echo "[verify] step 3b ok: benign reorder is NOT a false positive"

echo "[verify] step 4: inject REAL drift, then cdkd drift (expect exit 1)"
node inject-drift.ts drift
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected real drift exit 1, got ${rc}"
  exit 1
fi
echo "[verify] step 4 ok: real drift detected (exit ${rc})"

echo "[verify] step 5: cdkd drift --revert -y (expect exit 0)"
${CLI} drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}"

echo "[verify] step 6: cdkd drift again (expect exit 0)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: drift remained after --revert (exit ${rc})"
  exit 1
fi
echo "[verify] step 6 ok: AWS reverted to template, drift clean"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
