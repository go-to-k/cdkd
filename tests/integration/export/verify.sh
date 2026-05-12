#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd export` (cdkd → CloudFormation).
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdExportExample (S3 + SNS + Lambda + IAM Role + Custom Resource)
#   3. cdkd export CdkdExportExample --include-non-importable --yes
#      → assert exit 0; runs phase 1 IMPORT (S3, SNS, Lambda, IAM Role)
#        and phase 2 UPDATE (Custom Resource CREATE).
#   4. Verify CFn stack exists and contains the imported resources.
#   5. Verify cdkd state for the stack is GONE (S3 head-object 404).
#   6. aws cloudformation delete-stack → wait for delete-complete.
#
# AWS resources are unchanged across the cdkd→CFn migration; the CFn
# DeleteStack at the end is what cleans them up.
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdExportExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/export"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
pnpm --dir "${REPO_ROOT}" install
pnpm --dir "${REPO_ROOT}" run build

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # If cdkd export succeeded, the stack is now in CFn; delete via CFn.
    if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
      aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
      aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
    else
      # Otherwise the stack is still in cdkd state; destroy via cdkd.
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
  fi
  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: cdkd export --include-non-importable -y (expect exit 0)"
${CLI} export "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --include-non-importable \
  -y \
  --verbose

echo "[verify] step 4: verify CFn stack exists"
STATUS="$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query 'Stacks[0].StackStatus' --output text)"
echo "[verify] CFn stack status: ${STATUS}"
case "${STATUS}" in
  UPDATE_COMPLETE|IMPORT_COMPLETE)
    echo "[verify] step 4 ok"
    ;;
  *)
    echo "[verify] FAIL: expected UPDATE_COMPLETE or IMPORT_COMPLETE, got ${STATUS}"
    exit 1
    ;;
esac

# Confirm every cdkd-deployed resource type made it into the CFn stack.
echo "[verify] step 4b: verify imported resource types present"
RESOURCES="$(aws cloudformation list-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query 'StackResourceSummaries[].ResourceType' --output text)"
echo "[verify] CFn resources: ${RESOURCES}"
for needed in 'AWS::S3::Bucket' 'AWS::SNS::Topic' 'AWS::Lambda::Function' 'AWS::IAM::Role'; do
  if ! echo "${RESOURCES}" | grep -q "${needed}"; then
    echo "[verify] FAIL: ${needed} not found in CFn stack"
    exit 1
  fi
done
# Phase-2 Custom Resources arrive in the second changeset. CDK emits two
# distinct CFn resource types depending on whether the user passed
# `resourceType: 'Custom::Foo'` to `new CustomResource(...)`: the typed
# form `Custom::*` or the untyped default `AWS::CloudFormation::CustomResource`.
# The integ fixture uses the untyped form, but accept either so the
# check is robust to future fixture tweaks.
if ! echo "${RESOURCES}" | grep -qE '(Custom::|AWS::CloudFormation::CustomResource)'; then
  echo "[verify] FAIL: no Custom Resource in CFn stack (phase 2 missed)"
  exit 1
fi
echo "[verify] step 4b ok"

echo "[verify] step 5: verify cdkd state is GONE"
# state.json key for v2+ schema is cdkd/<stack>/<region>/state.json
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
echo "[verify] step 5 ok: cdkd state cleared"

echo "[verify] step 6: aws cloudformation delete-stack (clean up CFn-managed resources)"
aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}"
aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}"
echo "[verify] step 6 ok: CFn stack deleted"

trap - EXIT
echo "[verify] PASS"
