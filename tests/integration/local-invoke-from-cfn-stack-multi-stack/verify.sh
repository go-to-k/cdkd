#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke --from-cfn-stack`
# against a 2-stack CloudFormation app where the consumer stack's Lambda
# env var is `Fn::ImportValue` from a producer stack's export
# (issue #611 — Integ-fixture coverage gap).
#
# Why this exists: the single-stack `local-invoke-from-cfn-stack` integ
# only exercises `Ref` substitution (1 Lambda + 1 DynamoDB table within
# one CFn stack). The whole `fetchAllExports` + cross-stack
# `Fn::ImportValue` code path in `CfnLocalStateProvider` (~50 LOC) has
# no integ coverage on its own — only unit tests prove it. This fixture
# closes that gap with a producer/consumer pair: producer emits a
# CloudFormation `Output` with `Export.Name: cdkd-multi-stack-shared-
# value`; consumer's Lambda env var is `Fn::ImportValue` against the
# same name. With `--from-cfn-stack`, the consumer's env var should
# resolve to the producer's exported value at local-invoke time
# (read via `cloudformation:ListExports`, paginated + memoized).
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. pre-flight orphan scan for BOTH stacks
#   3. cdk deploy (producer + consumer, in that order — cdk handles the
#      ordering automatically from `addDependency`)
#   4. read the producer's exported value via list-exports
#   5. baseline: cdkd local invoke (no --from-cfn-stack) — assert
#      SHARED_VALUE comes through as "unset" (warn-and-drop on
#      intrinsics)
#   6. issue #611 ask: cdkd local invoke --from-cfn-stack — assert
#      SHARED_VALUE is the producer's exported value; this is what
#      proves Fn::ImportValue substitution works against ListExports
#   7. cdk destroy (consumer FIRST so the export isn't in use while
#      the producer stack is being deleted)
#
# Run via `/run-integ local-invoke-from-cfn-stack-multi-stack` (recommended)
# or directly:
#
#     bash tests/integration/local-invoke-from-cfn-stack-multi-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account. Also requires the global `cdk` (aws-cdk) CLI on $PATH —
# same as the single-stack fixture.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
PRODUCER_STACK="CdkdLocalInvokeMultiStackProducer"
CONSUMER_STACK="CdkdLocalInvokeMultiStackConsumer"
EXPORT_NAME="cdkd-multi-stack-shared-value"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-cfn-stack-multi-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

echo "[verify] region=${REGION} producer=${PRODUCER_STACK} consumer=${CONSUMER_STACK} export=${EXPORT_NAME}"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Gate the cleanup trap on a "we created the stacks" sentinel. Without
# this guard, the EXIT trap would fire on the pre-flight orphan scan's
# `exit 1` (when a same-named stack pre-exists in the user's account)
# and run `cdk destroy` on a stack we did NOT create, silently deleting
# user resources. The sentinel is set only after `cdk deploy` succeeds.
# This is the same lesson PR #610 baked into the single-stack fixture.
WE_CREATED_STACKS=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACKS}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    # Consumer FIRST so the Fn::ImportValue dependency is released
    # before producer's export is deleted; CDK CLI would refuse to
    # delete producer otherwise.
    (cd "${TEST_DIR}" && cdk destroy "${CONSUMER_STACK}" "${PRODUCER_STACK}" --force \
      --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: pre-flight orphan scan for BOTH stacks"
for stack in "${PRODUCER_STACK}" "${CONSUMER_STACK}"; do
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: ${stack} already exists in CloudFormation — clean up first via:"
    echo "          aws cloudformation delete-stack --stack-name ${stack} --region ${REGION}"
    exit 1
  fi
done

echo "[verify] step 3: cdk deploy producer + consumer (upstream CDK CLI, NOT cdkd)"
# CDK CLI deploys in dependency order: producer first, consumer after,
# so the export exists before the consumer's Fn::ImportValue resolves.
#
# Set the sentinel BEFORE `cdk deploy` rather than after. Pre-flight has
# already verified the namespace is clean, so once we issue the deploy
# command we OWN the namespace — including the partial-failure case
# where `cdk deploy` creates the producer but the consumer fails
# (otherwise the EXIT trap would skip cleanup and leave the producer
# stack as an orphan). `cdk destroy` is a no-op on stacks that never
# got created, so the optimistic-set is safe even on early-failure
# paths (credential / network errors before any stack reaches AWS).
WE_CREATED_STACKS=1
cdk deploy "${PRODUCER_STACK}" "${CONSUMER_STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read the producer's exported value via list-exports"
DEPLOYED_VALUE=$(aws cloudformation list-exports \
  --region "${REGION}" \
  --query "Exports[?Name==\`${EXPORT_NAME}\`].Value | [0]" \
  --output text)
echo "[verify]   exported value: ${DEPLOYED_VALUE}"
if [ -z "${DEPLOYED_VALUE}" ] || [ "${DEPLOYED_VALUE}" = "None" ]; then
  echo "[verify] FAIL: could not read exported value '${EXPORT_NAME}' from CloudFormation"
  exit 1
fi

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable. Same
# pattern as the single-stack fixture.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  while [ $i -le $attempts ]; do
    if out=$(${CLI} local invoke "${args[@]}" 2>/dev/null | tail -1) && \
       echo "${out}" | grep -q '"sharedValue":'; then
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

echo "[verify] step 5: cdkd local invoke (no --from-cfn-stack) — expect SHARED_VALUE=unset"
RESULT_BASELINE=$(invoke_with_retry "${CONSUMER_STACK}/EchoSharedHandler" --no-pull)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"sharedValue":"unset"' || {
  echo "[verify] FAIL: expected SHARED_VALUE to be dropped (default warn-and-drop), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline response, got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 6: cdkd local invoke --from-cfn-stack — expect SHARED_VALUE=${DEPLOYED_VALUE}"
# Bare --from-cfn-stack uses the cdkd stack name verbatim as the CFn
# stack name. The consumer stack carries the Fn::ImportValue, so we
# point at the consumer; CfnLocalStateProvider then calls list-exports
# (across the account, not scoped to a specific stack) to resolve the
# import.
RESULT_FROM_CFN=$(invoke_with_retry "${CONSUMER_STACK}/EchoSharedHandler" --from-cfn-stack --no-pull)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"sharedValue\":\"${DEPLOYED_VALUE}\"" || {
  echo "[verify] FAIL: expected SHARED_VALUE=${DEPLOYED_VALUE}, got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}

echo "[verify] step 7: cdk destroy --force (consumer FIRST, then producer)"
# Consumer FIRST so the Fn::ImportValue dependency is released before
# producer's export is deleted; otherwise CFn refuses to delete a stack
# whose export is still in use.
cdk destroy "${CONSUMER_STACK}" "${PRODUCER_STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

echo ""
echo "[verify] All checks passed: --from-cfn-stack substituted Fn::ImportValue with the producer's exported value."
