#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke --from-cfn-stack`
# (issue #606).
#
# Why this exists: the existing `local-invoke-from-state` integ exercises
# the cdkd-deployed path (cdkd deploy + cdkd state read). Issue #606 adds
# a parallel path for CDK apps deployed via the upstream CDK CLI (cdk
# deploy → CloudFormation). The only way to exercise that round-trip is
# to deploy the fixture via `cdk deploy` (NOT `cdkd deploy`) and then
# invoke locally with `--from-cfn-stack`, which reads physical IDs via
# `cloudformation:DescribeStackResources` instead of cdkd's S3 state.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdk deploy CdkdLocalInvokeFromCfnStackFixture (upstream CDK CLI)
#   3. baseline: cdkd local invoke (no --from-cfn-stack) — assert
#      TABLE_NAME comes through as "unset" (env var dropped because it's
#      intrinsic-valued and the default behavior warns + drops).
#   4. issue #606: cdkd local invoke --from-cfn-stack — assert TABLE_NAME
#      is the actual deployed DynamoDB table name, and STATIC_VALUE still
#      passes through unchanged.
#   5. cdk destroy --force (NOT cdkd destroy — the fixture lives in CFn)
#
# Run via `/run-integ local-invoke-from-cfn-stack` (recommended) or directly:
#
#     bash tests/integration/local-invoke-from-cfn-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account. Also requires the global `cdk` (aws-cdk) CLI on $PATH —
# see step 2's note on the vp-managed environment.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeFromCfnStackFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Gate the cleanup trap on a "we created the stack" sentinel. Without
# this guard, the EXIT trap would fire on the pre-flight orphan scan's
# `exit 1` (when a same-named stack pre-exists in the user's account)
# and run `cdk destroy` on a stack we did NOT create, silently deleting
# user resources. The sentinel is set only after `cdk deploy` succeeds.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI, NOT cdkd)"
# The fixture deliberately uses upstream `cdk deploy` so the resulting
# stack is owned by CloudFormation, not cdkd. The cdk CLI is supplied by
# vp's globally-managed environment (same pattern as
# import-nested-stack); no per-fixture install round-trip needed since
# Node's parent-dir resolution finds aws-cdk-lib from the repo root.
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
WE_CREATED_STACK=1
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read the deployed DynamoDB table name from CloudFormation"
DEPLOYED_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::DynamoDB::Table`].PhysicalResourceId | [0]' \
  --output text)
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
if [ -z "${DEPLOYED_TABLE}" ] || [ "${DEPLOYED_TABLE}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed table name from CloudFormation"
  exit 1
fi

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  while [ $i -le $attempts ]; do
    if out=$(${CLI} local invoke "${args[@]}" 2>/dev/null | tail -1) && \
       echo "${out}" | grep -q '"tableName":'; then
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed, retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed; last stderr below:" >&2
  ${CLI} local invoke "${args[@]}" 2>&1 | tail -10 >&2
  return 1
}

echo "[verify] step 5: cdkd local invoke (no --from-cfn-stack) — expect TABLE_NAME=unset"
RESULT_BASELINE=$(invoke_with_retry "${STACK}/EchoTableHandler" --no-pull)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"tableName":"unset"' || {
  echo "[verify] FAIL: expected TABLE_NAME to be dropped (default warn-and-drop), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline response, got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 6: cdkd local invoke --from-cfn-stack — expect TABLE_NAME=${DEPLOYED_TABLE}"
# Bare --from-cfn-stack uses the cdkd stack name verbatim as the CFn
# stack name — which matches here because the CDK app exports the same
# name to both.
RESULT_FROM_CFN=$(invoke_with_retry "${STACK}/EchoTableHandler" --from-cfn-stack --no-pull)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"tableName\":\"${DEPLOYED_TABLE}\"" || {
  echo "[verify] FAIL: expected TABLE_NAME=${DEPLOYED_TABLE}, got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}

echo "[verify] step 7: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

echo ""
echo "[verify] All checks passed: --from-cfn-stack substituted TABLE_NAME with the deployed table name."
