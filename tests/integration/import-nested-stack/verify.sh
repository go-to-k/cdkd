#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd import --migrate-from-cloudformation`
# RECURSIVE nested-stack support (Issue #464 PR A).
#
# Flow:
#   1. Build cdkd (so `dist/cli.js` is fresh).
#   2. `cdk deploy` the parent + nested child via upstream CDK CLI —
#      this simulates an already-existing CloudFormation-managed
#      stack the user wants to migrate off.
#   3. Run `cdkd import --migrate-from-cloudformation <ParentName> --yes`.
#      The recursive walk should:
#        - DescribeStackResources on parent → discover nested child
#        - DescribeStackResources on child → enumerate child's resources
#        - Write root state under `cdkd/<Parent>/<region>/state.json`
#        - Write child state under `cdkd/<Parent>~Child/<region>/state.json`
#          with `parentStack` / `parentLogicalId` / `parentRegion` populated
#        - Recursively inject `DeletionPolicy: Retain` on every leaf
#          resource in both parent AND child templates
#        - Retire the parent CFn stack (cascade-deletes the child CFn
#          stack record; AWS resources survive because of Retain)
#   4. Assert: parent + child state files exist with the right shape;
#      both source CFn stacks are gone (DELETE_COMPLETE or absent);
#      both SSM parameters are still alive on AWS (Retain worked).
#   5. `cdkd destroy <Parent> --force` to clean up.
#   6. Assert: both SSM parameters are gone; both cdkd state files are gone.
#
# Trap cleanup unconditionally tears down whatever state remains on any
# failure path so leftover orphans never persist.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-nested-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

# CDK uses fixed stack names (the env above doesn't propagate per-run
# suffix into the synth template). We pin the names here and rely on the
# trap cleanup + post-PASS deletion to keep the AWS account clean across
# re-runs.
PARENT_STACK="CdkdImportNestedStack"
# The auto-generated nested child stack ARN — we resolve it dynamically
# after deploy via `aws cloudformation describe-stack-resources`.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

PARENT_STATE_KEY="cdkd/${PARENT_STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${PARENT_STACK}~Child/${REGION}/state.json"

# Captured in step 6 once describe-stack-resources resolves the physical
# names. Initialized empty so the cleanup trap can reference them under
# `set -u` even when it fires before step 6. cleanup() deletes by these exact
# physical names — far more robust than the logical-id Contains sweep, whose
# filter has to track the deploy path's naming scheme by hand (it was wrong
# from the start here; see #584).
PARENT_PARAM_NAME=""
CHILD_PARAM_NAME=""

echo "[verify] region=${REGION} parent=${PARENT_STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  # 1. cdkd-managed state path: destroy the migrated cdkd stack so the
  #    underlying AWS resources go away. Best-effort.
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" \
      --key "${PARENT_STATE_KEY}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${PARENT_STACK}"
    ${CLI} destroy "${PARENT_STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force 2>&1 || true
  fi
  # 2. If the parent CFn stack is still alive (e.g. import never reached
  #    retire), tear it down via raw CFn — DeleteStack cascades into nested
  #    children so a single call covers the whole tree.
  if aws cloudformation describe-stacks \
      --stack-name "${PARENT_STACK}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${PARENT_STACK}"
    aws cloudformation delete-stack --stack-name "${PARENT_STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${PARENT_STACK}" --region "${REGION}" || true
  fi
  # 3a. Primary SSM reap: delete by the exact physical names captured in
  #     step 6. This is naming-scheme-independent, so it cannot rot the way
  #     the Contains sweep below did. Empty until step 6 runs, so a trap that
  #     fires earlier falls through to 3b.
  for n in "${PARENT_PARAM_NAME}" "${CHILD_PARAM_NAME}"; do
    [ -n "${n}" ] || continue
    echo "[verify] cleanup: aws ssm delete-parameter ${n}"
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null || true
  done
  # 3b. Last-resort fuzzy fallback for the case where the trap fired before
  #     step 6 captured the names. This fixture deploys via upstream
  #     `cdk deploy`, so CloudFormation auto-generates the SSM names as
  #     `CFN-ParentParam-<rand>` / `CFN-ChildParam-<rand>` — there is NO
  #     stack-name token to filter on, and SSM Contains accepts only ONE
  #     value per filter, so sweep each logical-id token separately. (3a is
  #     the durable fix; this stays as a belt-and-braces backstop.)
  for token in ParentParam ChildParam; do
    for p in $(aws ssm describe-parameters --region "${REGION}" \
      --parameter-filters "Key=Name,Option=Contains,Values=${token}" \
      --query 'Parameters[].Name' --output text 2>/dev/null || true); do
      echo "[verify] cleanup: aws ssm delete-parameter ${p}"
      aws ssm delete-parameter --name "${p}" --region "${REGION}" || true
    done
  done
  aws s3 rm "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

echo "[verify] step 2: install fixture deps (aws-cdk-lib for synth)"
# pnpm at this repo's root ignores per-fixture package.json under
# tests/integration/* (no workspace registration), so the fixture's
# aws-cdk-lib + aws-cdk deps come from the global vp-managed npm
# environment instead. CDK CLI is `cdk` (global), and aws-cdk-lib is
# resolved via Node's parent-directory lookup against the repo-root
# install. No `pnpm install` round-trip needed.
echo "[verify] step 2 ok: using global cdk (\$(which cdk))"

echo "[verify] step 3: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${PARENT_STACK} already exists — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${PARENT_STATE_KEY} already exists — clean up first"
  exit 1
fi

echo "[verify] step 4: cdk deploy parent + nested child (simulating existing CFn stack)"
# `--require-approval never` skips the IAM prompt; `--no-version-reporting`
# and friends keep CDK quiet. The CDK toolkit handles asset publishing
# (nested-stack child template upload) automatically. Uses the global
# `cdk` binary supplied by vp (`/Users/goto/.vite-plus/bin/cdk` on dev
# machines, vp-bin path in CI) — see step 2's note on why no per-fixture
# install is needed.
(cd "${TEST_DIR}" && cdk deploy "${PARENT_STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")
echo "[verify] step 4 ok: cdk deploy completed"

echo "[verify] step 5: verify nested child is present on AWS"
# DescribeStackResources should report the nested-stack row at logical id 'Child'.
CHILD_PHYSICAL=$(aws cloudformation describe-stack-resources \
  --stack-name "${PARENT_STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?LogicalResourceId==`Child`].PhysicalResourceId' \
  --output text)
if [ -z "${CHILD_PHYSICAL}" ]; then
  echo "[verify] FAIL: 'Child' nested-stack row not found on parent"
  exit 1
fi
echo "[verify] step 5 ok: child physical-id=${CHILD_PHYSICAL}"

echo "[verify] step 6: capture pre-import SSM parameter names (for Retain assertion later)"
PARENT_PARAM_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "${PARENT_STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?LogicalResourceId==`ParentParam`].PhysicalResourceId' \
  --output text)
CHILD_PARAM_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "${CHILD_PHYSICAL}" \
  --region "${REGION}" \
  --query 'StackResources[?LogicalResourceId==`ChildParam`].PhysicalResourceId' \
  --output text)
echo "[verify] step 6 ok: parent-param=${PARENT_PARAM_NAME} child-param=${CHILD_PARAM_NAME}"

echo "[verify] step 7: cdkd import --migrate-from-cloudformation ${PARENT_STACK} --yes"
(cd "${TEST_DIR}" && ${CLI} import "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes \
  --verbose)
echo "[verify] step 7 ok: import command exited 0"

echo "[verify] step 8: assert parent state file exists at v6 key"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null
PARENT_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" - --region "${REGION}")
SCHEMA_V=$(echo "${PARENT_STATE}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["version"])')
if [ "${SCHEMA_V}" -lt 6 ]; then
  echo "[verify] FAIL: parent state schema version is ${SCHEMA_V}, expected >=6"
  exit 1
fi
# Parent state should have an entry for the nested-stack resource with
# the synthesized cdkd-local ARN as physical id (NOT the AWS child ARN).
CHILD_PHYS_IN_STATE=$(echo "${PARENT_STATE}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s["resources"]["Child"]["physicalId"])')
case "${CHILD_PHYS_IN_STATE}" in
  arn:cdkd-local:*) ;;
  *)
    echo "[verify] FAIL: parent state Child.physicalId is '${CHILD_PHYS_IN_STATE}', expected cdkd-local ARN"
    exit 1
    ;;
esac
echo "[verify] step 8 ok: parent state v${SCHEMA_V}, Child.physicalId=${CHILD_PHYS_IN_STATE}"

echo "[verify] step 9: assert child state file exists at v6 key with parent-link fields"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null
CHILD_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")
PARENT_LINK=$(echo "${CHILD_STATE}" | python3 -c \
  'import sys, json; s = json.load(sys.stdin); print(s.get("parentStack","")+"/"+s.get("parentLogicalId","")+"/"+s.get("parentRegion",""))')
EXPECTED_LINK="${PARENT_STACK}/Child/${REGION}"
if [ "${PARENT_LINK}" != "${EXPECTED_LINK}" ]; then
  echo "[verify] FAIL: child state parent-link is '${PARENT_LINK}', expected '${EXPECTED_LINK}'"
  exit 1
fi
echo "[verify] step 9 ok: child state parent-link=${PARENT_LINK}"

echo "[verify] step 10: assert source CFn stacks are retired (parent + child both gone)"
if aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" >/dev/null 2>&1; then
  STATUS=$(aws cloudformation describe-stacks --stack-name "${PARENT_STACK}" --region "${REGION}" \
    --query 'Stacks[0].StackStatus' --output text)
  if [ "${STATUS}" != "DELETE_COMPLETE" ]; then
    echo "[verify] FAIL: parent CFn stack still alive with status ${STATUS}"
    exit 1
  fi
fi
echo "[verify] step 10 ok: source CFn stacks retired"

echo "[verify] step 11: assert AWS resources survived retirement (Retain worked recursively)"
aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}" >/dev/null
aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null
echo "[verify] step 11 ok: both SSM parameters still alive"

echo "[verify] step 12: cdkd destroy ${PARENT_STACK} --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  --verbose)
echo "[verify] step 12 ok: cdkd destroy exited 0"

echo "[verify] step 13: assert AWS resources are GONE"
if aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: parent SSM parameter ${PARENT_PARAM_NAME} still exists after destroy"
  exit 1
fi
if aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: child SSM parameter ${CHILD_PARAM_NAME} still exists after destroy"
  exit 1
fi
echo "[verify] step 13 ok: both SSM parameters gone"

echo "[verify] step 14: assert cdkd state files GONE (both parent and child)"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: parent cdkd state still present at s3://${STATE_BUCKET}/${PARENT_STATE_KEY}"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: child cdkd state still present at s3://${STATE_BUCKET}/${CHILD_STATE_KEY}"
  exit 1
fi
echo "[verify] step 14 ok: both cdkd state files cleared"

trap - EXIT INT TERM
echo "[verify] PASS"
