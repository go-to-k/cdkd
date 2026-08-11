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
#     policy Action, an added SG ingress rule, and an added ELBv2
#     TargetGroup target all surface as drift and are reverted.
#   - UNORDERED OBJECT ARRAYS (issue #1620): `TargetGroup.Targets` is an
#     array of `{Id, Port}` objects that AWS returns in no guaranteed
#     order, so it is declared in `getDriftUnorderedPaths` and sorted on
#     BOTH comparison sides. Two consecutive clean drift runs prove the
#     canonicalization; an out-of-band RegisterTargets proves a real added
#     member is still detected rather than absorbed.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDriftArraysExample
#   3a. cdkd drift -> assert exit 0 (clean immediately after deploy)
#   3a2. cdkd drift AGAIN -> assert exit 0 + the templated TargetGroup
#       target set is intact (two consecutive runs disagreeing is the
#       unordered-readback signature; issue #1620 / #1515)
#   3b. inject benign tag reorder; cdkd drift -> assert exit 0 (no false
#       positive on reorder)
#   4. inject REAL drift (tag value + policy action + SG ingress rule +
#       an untemplated TargetGroup target); cdkd drift -> assert exit 1
#       (detected) and the fourth target is live
#   5. cdkd drift --revert -y -> assert exit 0
#   6. cdkd drift -> assert exit 0 (clean) + the untemplated target is
#       deregistered and the three templated ones RETAINED
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
DRIFT_OUT="$(mktemp -t cdkd-drift-arrays)"

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
  rm -f "${DRIFT_OUT}"
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

# The TargetGroup arm needs its ARN for the direct readback assertions below.
TARGET_GROUP_ARN="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).state?.outputs??{};if(!o.TargetGroupArn)throw new Error("no TargetGroupArn output");process.stdout.write(o.TargetGroupArn)})')"
export TARGET_GROUP_ARN
echo "[verify] target group: ${TARGET_GROUP_ARN}"

# Registered target IPs, sorted so the assertion is order-insensitive (AWS
# gives no readback-order guarantee — the very reason #1620 exists). A
# `draining` target is excluded here for the same reason the provider
# excludes it: it is being removed, not registered.
registered_target_ips() {
  local out
  out="$(aws elbv2 describe-target-health \
    --target-group-arn "${TARGET_GROUP_ARN}" \
    --query "join(' ', sort(TargetHealthDescriptions[?TargetHealth.State!='draining'].Target.Id || \`[]\`))" \
    --output text)" || return 1
  printf '%s' "${out}"
}

echo "[verify] step 3a2: a SECOND back-to-back cdkd drift (expect exit 0)"
# Two consecutive runs disagreeing with no code change in between is the
# signature the unordered-array class produces (issue #1515) — one run is not
# enough to prove the object-array pass (#1620) actually canonicalizes.
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: the second consecutive drift run reported drift (exit ${rc}) — an unordered readback (TargetGroup.Targets / tag lists) is not being canonicalized"
  exit 1
fi
BASELINE_TARGETS="$(registered_target_ips)"
if [ "${BASELINE_TARGETS}" != "10.0.0.10 10.0.0.11 10.0.0.12" ]; then
  echo "[verify] FAIL: expected the three templated targets, got '${BASELINE_TARGETS}'"
  exit 1
fi
echo "[verify] step 3a2 ok: repeated drift is stable; targets = ${BASELINE_TARGETS}"

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
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" > "${DRIFT_OUT}" 2>&1
rc=$?
set -e
cat "${DRIFT_OUT}"
if [ "${rc}" -ne 1 ]; then
  echo "[verify] FAIL: expected real drift exit 1, got ${rc}"
  exit 1
fi
# BINDING assertion for #1620: exit 1 alone is satisfied by the S3 / IAM / SG
# drifts, so it would pass identically with `Targets` back in
# getDriftUnknownPaths (never compared). The report must NAME the Targets path.
if ! grep -q 'Targets' "${DRIFT_OUT}"; then
  echo "[verify] FAIL: the drift report does not mention 'Targets' — the TargetGroup target list is not being compared at all (#1620 regressed to getDriftUnknownPaths?)"
  exit 1
fi
DRIFTED_TARGETS="$(registered_target_ips)"
if [ "${DRIFTED_TARGETS}" != "10.0.0.10 10.0.0.11 10.0.0.12 10.0.0.99" ]; then
  echo "[verify] FAIL: the injected fourth target is not live before the revert (got '${DRIFTED_TARGETS}') — the revert assertion below would pass vacuously"
  exit 1
fi
echo "[verify] step 4 ok: real drift detected (exit ${rc}); targets = ${DRIFTED_TARGETS}"

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
REVERTED_TARGETS="$(registered_target_ips)"
if [ "${REVERTED_TARGETS}" != "10.0.0.10 10.0.0.11 10.0.0.12" ]; then
  echo "[verify] FAIL: --revert did not restore the templated target set (got '${REVERTED_TARGETS}') — expected the untemplated 10.0.0.99 deregistered and the other three RETAINED"
  exit 1
fi
echo "[verify] step 6 ok: AWS reverted to template, drift clean; targets = ${REVERTED_TARGETS}"

echo "[verify] step 7: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
