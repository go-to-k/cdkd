#!/usr/bin/env bash
# verify.sh — cdkd Lambda LayerVersion content-change REPLACEMENT integ.
#
# Regression coverage for the bug where editing a Lambda LayerVersion's content
# (same logical id) was misclassified as an in-place UPDATE. A LayerVersion is
# fully immutable on AWS (no UpdateLayerVersion API), so the provider's update()
# hard-failed — suggesting a `cdkd deploy --replace` flag that does not even
# exist — leaving the change undeployable. CloudFormation / `cdk deploy` handle
# this transparently: a content change publishes a NEW version and re-points the
# consuming function. The fix adds a replacement rule for AWS::Lambda::LayerVersion
# so the diff drives a DELETE + CREATE and promoteReplacementDependents re-points
# the function at the new layer version ARN.
#
# Phases:
#   1. Deploy the layer (content `v1`) + a function consuming it. Assert the
#      function points at the layer's version :1.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (content `v2`). Assert: deploy
#      succeeds WITHOUT any manual --replace flag, a new layer version :2 is
#      published, and the function now points at :2 (the replacement was
#      propagated to the dependent).
#   3. Destroy + assert the function is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaLayerVersionUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LAYER_NAME="cdkd-layer-version-update-test"
FN_NAME="cdkd-layer-version-update-test-fn"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # Delete every published version of the test layer.
  for v in $(aws lambda list-layer-versions --layer-name "${LAYER_NAME}" --region "${REGION}" \
    --query 'LayerVersions[].Version' --output text 2>/dev/null); do
    aws lambda delete-layer-version --layer-name "${LAYER_NAME}" --version-number "${v}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
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

fn_layer_arn() {
  aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    --query 'Layers[0].Arn' --output text
}

# --- Phase 1: deploy baseline (layer content v1) ----------------------
echo "==> Phase 1: deploy layer (v1) + consuming function"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ARN_P1="$(fn_layer_arn)"
echo "    function layer arn (Phase 1): ${ARN_P1}"
case "${ARN_P1}" in
  *":layer:${LAYER_NAME}:1") ;;
  *) echo "FAIL: expected function to point at layer ${LAYER_NAME}:1, got '${ARN_P1}'" >&2; exit 1 ;;
esac
echo "    function points at layer version :1"

# --- Phase 2: change layer content (REPLACEMENT, must NOT need --replace) ---
echo "==> Phase 2: re-deploy with v2 layer content (replacement + dependent re-point)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# A new version :2 must have been published.
VERSIONS="$(aws lambda list-layer-versions --layer-name "${LAYER_NAME}" --region "${REGION}" \
  --query 'LayerVersions[].Version' --output text)"
echo "    published layer versions: ${VERSIONS}"
case " ${VERSIONS} " in
  *" 2 "*) ;;
  *) echo "FAIL: expected a published layer version :2 after the content change, got '${VERSIONS}'" >&2; exit 1 ;;
esac
echo "    new layer version :2 published"

# The function must now follow to :2 (replacement propagated to dependent).
ARN_P2="$(fn_layer_arn)"
echo "    function layer arn (Phase 2): ${ARN_P2}"
case "${ARN_P2}" in
  *":layer:${LAYER_NAME}:2") ;;
  *) echo "FAIL: expected function to be re-pointed at layer ${LAYER_NAME}:2, got '${ARN_P2}'" >&2; exit 1 ;;
esac
echo "    function re-pointed at layer version :2 (replacement propagated)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    function deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Lambda LayerVersion content change auto-replaces (no --replace) and re-points the consuming function, all 3 phases passed"
