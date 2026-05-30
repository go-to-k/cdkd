#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke-agentcore --from-state`
# (G2 follow-up to PR #717's 3-axis review).
#
# Why this exists: PR #717's `tests/integration/local-invoke-agentcore/` is
# fully local — no AWS deploy. The cdkd-port-specific 3-arg
# `createLocalStateProvider` shim signature for the agentcore command had no
# end-to-end verification. This integ closes that gap:
#
#   1. cdkd deploy a stack with an `AWS::BedrockAgentCore::Runtime` that
#      carries an INTRINSIC-valued env var (BUCKET_NAME = Ref: <S3 bucket>).
#   2. PR baseline: `cdkd local invoke-agentcore <target>` (no --from-state)
#      — assert BUCKET_NAME comes through as "unset" (intrinsic dropped).
#   3. G2: `cdkd local invoke-agentcore <target> --from-state` — assert
#      BUCKET_NAME is the actual deployed S3 bucket name, and STATIC_VALUE
#      still passes through unchanged.
#   4. cdkd destroy --force
#
# Run via `/run-integ local-invoke-agentcore-from-state` (recommended) or
# directly:
#
#     bash tests/integration/local-invoke-agentcore-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the target
# account (real AgentCore Runtime + S3 bucket are provisioned).

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeAgentcoreFromStateFixture"
TARGET="${STACK}/EchoEnvAgent"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-agentcore-from-state"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  echo "[verify] step 1b: install fixture deps"
  vp install --prefer-offline
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

echo "[verify] step 2: cdkd deploy ${STACK}"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

BUCKET=$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json |
  jq -r '.state.outputs.BucketName')
if [ -z "${BUCKET}" ] || [ "${BUCKET}" = "null" ]; then
  echo "FAIL: BucketName output missing from cdkd state (got: '${BUCKET}')"
  exit 1
fi
echo "[verify] deployed bucket: ${BUCKET}"

echo "[verify] step 3: baseline — cdkd local invoke-agentcore WITHOUT --from-state"
RESULT_BASELINE=$(${CLI} local invoke-agentcore "${TARGET}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"BUCKET_NAME":"unset"' || {
  echo "FAIL: baseline (no --from-state) — expected BUCKET_NAME=\"unset\" (intrinsic dropped); got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"STATIC_VALUE":"cdkd-static"' || {
  echo "FAIL: baseline — expected STATIC_VALUE=\"cdkd-static\" pass-through; got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 4: G2 — cdkd local invoke-agentcore WITH --from-state"
RESULT_FROMSTATE=$(${CLI} local invoke-agentcore "${TARGET}" --from-state \
  --state-bucket "${STATE_BUCKET}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_FROMSTATE}"
echo "${RESULT_FROMSTATE}" | grep -q "\"BUCKET_NAME\":\"${BUCKET}\"" || {
  echo "FAIL: --from-state — expected BUCKET_NAME=\"${BUCKET}\" (deployed bucket name substituted); got: ${RESULT_FROMSTATE}"
  exit 1
}
echo "${RESULT_FROMSTATE}" | grep -q '"STATIC_VALUE":"cdkd-static"' || {
  echo "FAIL: --from-state — STATIC_VALUE pass-through broken; got: ${RESULT_FROMSTATE}"
  exit 1
}

echo "[verify] step 5: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] All assertions passed — G2 closed: cdkd local invoke-agentcore --from-state substitutes intrinsic env vars"
