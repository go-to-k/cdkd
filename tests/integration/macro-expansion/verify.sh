#!/usr/bin/env bash
#
# End-to-end real-AWS test for cdkd's CloudFormation macro support
# (Issue #463). Verifies that a CDK app declaring
# `Transform: ['AWS::Serverless-2016-10-31']` (SAM) plus an
# `AWS::Serverless::Function` resource is expanded server-side by CFn
# via cdkd's macro-expander helper, then the resulting native
# `AWS::Lambda::Function` + `AWS::IAM::Role` are deployed via cdkd's
# SDK providers.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdMacroExpansionExample (deploy logs the
#      "[macros] Expanding..." line and completes)
#   3. read the deployed Lambda function name from cdkd state
#   4. assert the Lambda function exists on AWS (`get-function`)
#   5. invoke the function via `lambda invoke` and assert statusCode=200
#      in the response payload
#   6. cdkd destroy --force
#   7. assert the function is gone on AWS (`get-function` errors with
#      ResourceNotFoundException) and cdkd state is empty
#
# Wall-clock budget: ~3-5 min (macro expansion adds ~30-60s for SAM
# cold-start on the first run; subsequent runs hit the warm SAM macro
# Lambda layer in AWS's account). Total ~2 min for the Lambda
# create/destroy and ~30-60s for the macro round-trip itself.
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdMacroExpansionExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/macro-expansion"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# Per-run tmp files via mktemp so parallel CI matrix runs do not
# collide on shared /tmp paths. The trap cleanup below removes them.
DEPLOY_LOG="$(mktemp -t cdkd-macro-deploy.XXXXXX.log)"
INVOKE_OUT="$(mktemp -t cdkd-macro-invoke.XXXXXX.json)"
INVOKE_META="$(mktemp -t cdkd-macro-invoke-meta.XXXXXX.json)"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    # Belt-and-braces: the transient macro-expand stack should always
    # be cleaned up by cdkd's expander `finally` block, but on a
    # cdkd-side crash mid-expansion it could be left behind. Sweep any
    # `cdkd-macro-expand-*` stacks in REVIEW_IN_PROGRESS.
    for orphan in $(aws cloudformation list-stacks --region "${REGION}" \
        --stack-status-filter REVIEW_IN_PROGRESS \
        --query "StackSummaries[?starts_with(StackName,'cdkd-macro-expand-')].StackName" \
        --output text 2>/dev/null || true); do
      [ -n "${orphan}" ] && aws cloudformation delete-stack --stack-name "${orphan}" --region "${REGION}" || true
    done
  fi
  # Remove the mktemp'd files (success + failure paths).
  rm -f "${DEPLOY_LOG}" "${INVOKE_OUT}" "${INVOKE_META}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy ${STACK} (expect macro expansion log line)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${DEPLOY_LOG}"
if ! grep -F "[macros] Expanding CloudFormation macros" "${DEPLOY_LOG}" > /dev/null; then
  echo "[verify] FAIL: expected '[macros] Expanding CloudFormation macros' line in deploy log"
  exit 1
fi
echo "[verify]   ✓ macro-expansion log line observed"

echo "[verify] step 3: read deployed Lambda function name from cdkd state"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
FN_NAME="$(echo "${STATE_JSON}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId' | head -1)"
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "[verify] FAIL: no AWS::Lambda::Function entry in cdkd state. Available types:"
  echo "${STATE_JSON}" | jq -r '.resources | to_entries[] | .value.resourceType' | sort -u
  exit 1
fi
echo "[verify]   ✓ deployed function name: ${FN_NAME}"

echo "[verify] step 4: assert function exists on AWS"
aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" --query 'Configuration.[FunctionName,Runtime,Handler]' --output table

echo "[verify] step 5: invoke function and assert statusCode=200"
aws lambda invoke --function-name "${FN_NAME}" --region "${REGION}" --payload '{}' --cli-binary-format raw-in-base64-out "${INVOKE_OUT}" > "${INVOKE_META}"
cat "${INVOKE_OUT}"
INVOKE_STATUS="$(jq -r '.statusCode' "${INVOKE_OUT}")"
if [ "${INVOKE_STATUS}" != "200" ]; then
  echo "[verify] FAIL: expected statusCode=200, got ${INVOKE_STATUS}"
  exit 1
fi
echo "[verify]   ✓ Lambda returned statusCode=200"

echo "[verify] step 6: cdkd destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 7: assert function is gone on AWS"
if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" > /dev/null 2>&1; then
  echo "[verify] FAIL: function ${FN_NAME} still exists post-destroy"
  exit 1
fi
echo "[verify]   ✓ function deleted"

echo "[verify] step 7b: assert cdkd state is empty for ${STACK}"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" > /dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
echo "[verify]   ✓ cdkd state cleared"

echo "[verify] PASS"
