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
  # Best-effort cleanup: tolerate probe errors + unset vars (the handler exits).
  set +eu
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

echo "[verify] step 5b: cdkd diff expands the selected macro stack (issue #1150 regression)"
DIFF_LOG="$(mktemp -t cdkd-macro-diff.XXXXXX.log)"
${CLI} diff "${STACK}" --state-bucket "${STATE_BUCKET}" 2>&1 | tee "${DIFF_LOG}"
if ! grep -F "[macros] Expanding CloudFormation macros" "${DIFF_LOG}" > /dev/null; then
  echo "[verify] FAIL: expected the macro-expansion log line in cdkd diff output (post-selection expansion in diff.ts)"
  rm -f "${DIFF_LOG}"
  exit 1
fi
rm -f "${DIFF_LOG}"
echo "[verify]   ✓ diff ran macro expansion for the selected stack"

echo "[verify] step 6: cdkd destroy (must NOT expand macros - state-driven)"
DESTROY_LOG="$(mktemp -t cdkd-macro-destroy.XXXXXX.log)"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1 | tee "${DESTROY_LOG}"
if grep -F "[macros] Expanding CloudFormation macros" "${DESTROY_LOG}" > /dev/null; then
  echo "[verify] FAIL: cdkd destroy ran macro expansion; destroy must defer it (issue #1150/#1151)"
  rm -f "${DESTROY_LOG}"
  exit 1
fi
rm -f "${DESTROY_LOG}"
echo "[verify]   ✓ destroy skipped macro expansion"

echo "[verify] step 7: assert function is gone on AWS"
assert_gone "function ${FN_NAME} still exists post-destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "[verify]   ✓ function deleted"

echo "[verify] step 7b: assert cdkd state is empty for ${STACK}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "[verify]   ✓ cdkd state cleared"

echo "[verify] PASS"
