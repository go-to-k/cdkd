#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd export` RECURSIVE nested-stack
# support (Issue #464 PR B2 — per-stack IMPORT loop per design doc §4.3).
#
# Flow:
#   1. Build cdkd (so `dist/cli.js` is fresh).
#   2. `cdkd deploy` the parent + nested child via cdkd itself (NOT
#      upstream cdk deploy — PR B2 tests the cdkd → CFn direction).
#   3. Assert state files exist at v6 keys.
#   4. Run `cdkd export <Parent> --yes`. The per-stack IMPORT loop should:
#        - IMPORT the leaf child first as a standalone CFn stack at
#          `<Parent>-Child` (cdkd2cfnStackName mapping)
#        - IMPORT the root parent, adopting the just-IMPORTed child via
#          "Nest an existing stack" — DeletionPolicy: Retain + StackId
#          adoption in ResourcesToImport[]
#        - Delete cdkd state for both stacks (leaf-first).
#   5. Assert: both CFn stacks alive, parent's DescribeStackResources
#      lists the Child row with PhysicalResourceId = child stack ARN;
#      both SSM parameters still alive on AWS.
#   6. `aws cloudformation delete-stack <Parent>` cascades to clean up.
#   7. Assert: SSM parameters gone, CFn stacks gone, cdkd state gone.
#
# Trap cleanup unconditionally tears down whatever state remains on any
# failure path so leftover orphans never persist.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/export-nested-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

PARENT_STACK="CdkdExportNestedStack"
# Per cdkd2cfnStackName: the cdkd child key `<Parent>~Child` maps to
# `<Parent>-Child` for the CFn stack name (since CFn rejects `~`).
CHILD_CDKD_STACK="${PARENT_STACK}~Child"
CHILD_CFN_STACK="${PARENT_STACK}-Child"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

PARENT_STATE_KEY="cdkd/${PARENT_STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_CDKD_STACK}/${REGION}/state.json"

# Captured in step 5 once the cdkd state read succeeds. Initialized empty so
# the cleanup trap can reference them under `set -u` even when it fires before
# step 5. cleanup() deletes by these exact physical names — far more robust
# than the name-prefix Contains sweep, whose filter has to track the deploy
# path's naming scheme by hand (it has silently rotted twice; see #583/#588).
PARENT_PARAM_NAME=""
CHILD_PARAM_NAME=""

echo "[verify] region=${REGION} parent=${PARENT_STACK} child-cfn=${CHILD_CFN_STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  # 1. CFn parent: a successful export migrated cdkd → CFn, so a leftover
  #    parent CFn stack is the most common cleanup target. DeleteStack
  #    cascades into nested children.
  if aws cloudformation describe-stacks \
      --stack-name "${PARENT_STACK}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${PARENT_STACK}"
    aws cloudformation delete-stack --stack-name "${PARENT_STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${PARENT_STACK}" --region "${REGION}" || true
  fi
  # 1b. If the per-stack IMPORT loop landed the child as a standalone CFn
  #     stack but failed BEFORE adopting it under the parent, the child
  #     stays at the top level. Reap it too.
  if aws cloudformation describe-stacks \
      --stack-name "${CHILD_CFN_STACK}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${CHILD_CFN_STACK}"
    aws cloudformation delete-stack --stack-name "${CHILD_CFN_STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${CHILD_CFN_STACK}" --region "${REGION}" || true
  fi
  # 2. cdkd-managed state path: if the export never reached the
  #    state-cleanup step, destroy the cdkd-managed copy so the AWS
  #    resources go away. Best-effort. Fire when EITHER the parent OR the
  #    child state exists: a trap on INT/TERM mid-deploy can leave only the
  #    child state written (NestedStackProvider.create persists it before
  #    the parent finishes), and cdkd destroy <parent> still tears the whole
  #    tree down (the SSM sweep below is the final backstop either way).
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && { \
      aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1 || \
      aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; }; then
    echo "[verify] cleanup: cdkd destroy ${PARENT_STACK}"
    ${CLI} destroy "${PARENT_STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force 2>&1 || true
  fi
  # 3a. Primary SSM reap: delete by the exact physical names captured in
  #     step 5. This is naming-scheme-independent, so it cannot rot the way
  #     the Contains sweep below has. Empty until step 5 runs, so a trap that
  #     fires earlier falls through to 3b.
  for n in "${PARENT_PARAM_NAME}" "${CHILD_PARAM_NAME}"; do
    [ -n "${n}" ] || continue
    echo "[verify] cleanup: aws ssm delete-parameter ${n}"
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null || true
  done
  # 3b. Last-resort fuzzy fallback for the case where the trap fired before
  #     step 5 captured the names. SSM describe-parameters Contains is
  #     CASE-SENSITIVE; this fixture deploys via cdkd, whose
  #     generateResourceName stack-name-prefixes the parameter
  #     (CdkdExportNestedStack-...), so match that prefix. (This filter was
  #     wrong/regressed in #583/#588; 3a is the durable fix, this stays as a
  #     belt-and-braces backstop.)
  for p in $(aws ssm describe-parameters --region "${REGION}" \
    --parameter-filters "Key=Name,Option=Contains,Values=CdkdExportNestedStack" \
    --query 'Parameters[].Name' --output text 2>/dev/null || true); do
    echo "[verify] cleanup: aws ssm delete-parameter ${p}"
    aws ssm delete-parameter --name "${p}" --region "${REGION}" || true
  done
  aws s3 rm "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${PARENT_STACK} already exists in CFn — clean up first"
  exit 1
fi
if aws cloudformation describe-stacks --stack-name "${CHILD_CFN_STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${CHILD_CFN_STACK} already exists in CFn — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${PARENT_STATE_KEY} already exists — clean up first"
  echo "[verify]       run: aws s3 rm s3://${STATE_BUCKET}/${PARENT_STATE_KEY}"
  exit 1
fi
# Symmetric child-state check: a prior partial failure can leave an orphan
# child state at cdkd/<Parent>~Child/<region>/state.json without the parent
# key, which the parent-only scan above would miss.
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${CHILD_STATE_KEY} already exists — clean up first"
  echo "[verify]       run: aws s3 rm s3://${STATE_BUCKET}/${CHILD_STATE_KEY}"
  exit 1
fi

echo "[verify] step 3: cdkd deploy ${PARENT_STACK} (parent + nested child via cdkd)"
(cd "${TEST_DIR}" && ${CLI} deploy "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose)
echo "[verify] step 3 ok: cdkd deploy completed"

echo "[verify] step 4: assert parent state v6 + child state with parent-link fields"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null
CHILD_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")
PARENT_LINK=$(echo "${CHILD_STATE}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s.get("parentStack","")+"/"+s.get("parentLogicalId","")+"/"+s.get("parentRegion",""))')
EXPECTED_LINK="${PARENT_STACK}/Child/${REGION}"
if [ "${PARENT_LINK}" != "${EXPECTED_LINK}" ]; then
  echo "[verify] FAIL: child state parent-link is '${PARENT_LINK}', expected '${EXPECTED_LINK}'"
  exit 1
fi
echo "[verify] step 4 ok: parent-link=${PARENT_LINK}"

echo "[verify] step 5: capture pre-export SSM parameter names (for survival assertion)"
# After cdkd deploy, the resources are managed by cdkd. Read the physical
# IDs from the cdkd state files so verify.sh doesn't need to call into
# describe-stack-resources (no CFn stack exists yet — that's exactly what
# export creates).
PARENT_PARAM_NAME=$(aws s3 cp "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" - --region "${REGION}" | \
  python3 -c 'import sys, json; s = json.load(sys.stdin); print(s["resources"]["ParentParam"]["physicalId"])')
CHILD_PARAM_NAME=$(echo "${CHILD_STATE}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s["resources"]["ChildParam"]["physicalId"])')
echo "[verify] step 5 ok: parent-param=${PARENT_PARAM_NAME} child-param=${CHILD_PARAM_NAME}"

echo "[verify] step 6: cdkd export ${PARENT_STACK} --yes (per-stack IMPORT loop)"
(cd "${TEST_DIR}" && ${CLI} export "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes \
  --verbose)
echo "[verify] step 6 ok: cdkd export exited 0"

echo "[verify] step 7: assert root parent CFn stack exists"
PARENT_STATUS=$(aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" \
  --query 'Stacks[0].StackStatus' --output text)
case "${PARENT_STATUS}" in
  IMPORT_COMPLETE|UPDATE_COMPLETE|CREATE_COMPLETE) ;;
  *)
    echo "[verify] FAIL: parent CFn stack status is '${PARENT_STATUS}', expected IMPORT/UPDATE/CREATE_COMPLETE"
    exit 1
    ;;
esac
echo "[verify] step 7 ok: parent CFn stack status=${PARENT_STATUS}"

echo "[verify] step 8: assert nested-stack child is adopted under the parent"
# `DescribeStackResources` on the parent should list a row at logical id
# 'Child' with the child's CFn stack ARN as PhysicalResourceId.
CHILD_ROW_PHYSICAL=$(aws cloudformation describe-stack-resources \
  --stack-name "${PARENT_STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?LogicalResourceId==`Child`].PhysicalResourceId' \
  --output text)
case "${CHILD_ROW_PHYSICAL}" in
  arn:aws:cloudformation:*:stack/*)
    echo "[verify] step 8 ok: child adopted with PhysicalResourceId=${CHILD_ROW_PHYSICAL}"
    ;;
  *)
    echo "[verify] FAIL: parent.Child row PhysicalResourceId is '${CHILD_ROW_PHYSICAL}', expected a CFn stack ARN"
    exit 1
    ;;
esac

echo "[verify] step 9: assert ParentId / RootId nesting relationship"
# `DescribeStacks` on the child stack should report ParentId = parent's
# StackId and RootId = parent's StackId. Together these confirm CFn
# treats the child as a true nested-stack member.
CHILD_DESC=$(aws cloudformation describe-stacks --stack-name "${CHILD_ROW_PHYSICAL}" --region "${REGION}")
CHILD_PARENT_ID=$(echo "${CHILD_DESC}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s["Stacks"][0].get("ParentId", ""))')
CHILD_ROOT_ID=$(echo "${CHILD_DESC}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s["Stacks"][0].get("RootId", ""))')
PARENT_ARN=$(aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" \
  --query 'Stacks[0].StackId' --output text)
if [ "${CHILD_PARENT_ID}" != "${PARENT_ARN}" ]; then
  echo "[verify] FAIL: child ParentId='${CHILD_PARENT_ID}' != parent ARN='${PARENT_ARN}'"
  exit 1
fi
if [ "${CHILD_ROOT_ID}" != "${PARENT_ARN}" ]; then
  echo "[verify] FAIL: child RootId='${CHILD_ROOT_ID}' != parent ARN='${PARENT_ARN}'"
  exit 1
fi
echo "[verify] step 9 ok: nested relationship confirmed (ParentId + RootId)"

echo "[verify] step 10: assert AWS resources survived the migration (export = no AWS change)"
aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}" >/dev/null
aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null
echo "[verify] step 10 ok: both SSM parameters still alive"

echo "[verify] step 11: assert cdkd state files GONE (per-stack leaf-first cleanup)"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: parent cdkd state still present at s3://${STATE_BUCKET}/${PARENT_STATE_KEY}"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: child cdkd state still present at s3://${STATE_BUCKET}/${CHILD_STATE_KEY}"
  exit 1
fi
echo "[verify] step 11 ok: both cdkd state files cleared"

echo "[verify] step 12: aws cloudformation delete-stack (leaf-first)"
# The parent's nested-stack row has DeletionPolicy: Retain (an AWS-docs
# "Nest an existing stack" requirement, kept post-import so a future
# parent-side rollback can't cascade-delete the child). So we explicitly
# delete the child first, then the parent — the parent's cascade would
# skip the child due to Retain. Users typically do this via CDK CLI after
# `cdk destroy <parent>` rewrites the parent template to remove the
# nested-stack row (which triggers child cleanup as a CFn UPDATE side
# effect); the raw `aws cloudformation` path used here mirrors the
# manual recovery flow.
aws cloudformation delete-stack --stack-name "${CHILD_CFN_STACK}" --region "${REGION}"
aws cloudformation wait stack-delete-complete --stack-name "${CHILD_CFN_STACK}" --region "${REGION}"
aws cloudformation delete-stack --stack-name "${PARENT_STACK}" --region "${REGION}"
aws cloudformation wait stack-delete-complete --stack-name "${PARENT_STACK}" --region "${REGION}"
echo "[verify] step 12 ok: CFn child + parent deleted (leaf-first)"

echo "[verify] step 13: assert AWS resources are GONE post-delete"
if aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: parent SSM parameter ${PARENT_PARAM_NAME} still exists after CFn delete-stack"
  exit 1
fi
if aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: child SSM parameter ${CHILD_PARAM_NAME} still exists after CFn delete-stack"
  exit 1
fi
echo "[verify] step 13 ok: both SSM parameters gone"

trap - EXIT INT TERM
echo "[verify] PASS"
