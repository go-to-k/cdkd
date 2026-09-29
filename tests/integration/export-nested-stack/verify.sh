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
#   (steps 2b/9c/14) go-to-k/cdkd#3915: the parent's SSM-typed Parameter is
#       passed to the child; the imported child holds the stored VALUE.
#   (steps 5b/5c/9b) go-to-k/cdkd#3916: plant a parent state record named
#       like the parent Parameter `Stage`; a redeploy keeps the child value
#       `prod`, and the export (planted again) imports the child with
#       StageParam=prod.
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

# go-to-k/cdkd#3915: the SSM parameter the parent's SSM-typed `SsmStage`
# Parameter names. The name is PER RUN and reaches the synth through
# CDKD_TEST_SSM_STAGE_NAME (lib/parent-stack.ts's Default), so a concurrent
# run or a pre-existing parameter is never overwritten or deleted. Created
# with `put-parameter` WITHOUT --overwrite, and deleted by `cleanup` only once
# this run created it.
SSM_STAGE_NAME="/cdkd-export-nested-stack/stage-3915-$(date +%s)-$$"
SSM_STAGE_VALUE="ssm-resolved-3915"
SSM_STAGE_CREATED=""
export CDKD_TEST_SSM_STAGE_NAME="${SSM_STAGE_NAME}"
# Scratch for the go-to-k/cdkd#3916 state plant (copies of parent state);
# Created only once the EXIT trap is armed; `cleanup` removes it on every exit path.
PLANT_TMP=""

echo "[verify] region=${REGION} parent=${PARENT_STACK} child-cfn=${CHILD_CFN_STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  # Best-effort cleanup: tolerate probe errors + unset vars (the handler exits).
  set +eu
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
  [ -n "${PLANT_TMP}" ] && rm -rf "${PLANT_TMP}"
  if [ -n "${SSM_STAGE_CREATED}" ]; then
    aws ssm delete-parameter --name "${SSM_STAGE_NAME}" --region "${REGION}" 2>/dev/null || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
PLANT_TMP="$(mktemp -d)"

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

echo "[verify] step 2b: create the SSM parameter the parent's SSM-typed Parameter names (go-to-k/cdkd#3915)"
aws ssm put-parameter --name "${SSM_STAGE_NAME}" --value "${SSM_STAGE_VALUE}" --type String \
  --region "${REGION}" >/dev/null
SSM_STAGE_CREATED=1
echo "[verify] step 2b ok: ${SSM_STAGE_NAME}"

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

# go-to-k/cdkd#3916: a parent state record keyed by the parent PARAMETER's name
# (`Stage`) must not pick the value `{Ref: Stage}` resolves to. The record names
# an SSM parameter that does not exist, so `Ref` served from it would hand the
# child that NAME instead of `prod`.
PLANTED_ID="${PARENT_STACK}-planted-3916"
child_param_value() {
  aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" \
    --query Parameter.Value --output text
}
parent_has_stage_record() {
  aws s3 cp "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" - --region "${REGION}" |
    python3 -c 'import sys, json; print("yes" if "Stage" in json.load(sys.stdin)["resources"] else "no")'
}
plant_stage_record() {
  # Through files, never a pipe into `aws s3 cp -`: a python failure mid-pipe
  # would upload an EMPTY object over the parent state.
  local state_in="${PLANT_TMP}/state-in.json" state_out="${PLANT_TMP}/state-out.json"
  aws s3 cp "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" "${state_in}" --region "${REGION}" >/dev/null
  python3 -c '
import sys, json
with open(sys.argv[1]) as f:
    s = json.load(f)
rec = dict(s["resources"]["ParentParam"])
rec["physicalId"] = sys.argv[2]
rec["dependencies"] = []
s["resources"]["Stage"] = rec
with open(sys.argv[3], "w") as f:
    json.dump(s, f)' "${state_in}" "${PLANTED_ID}" "${state_out}"
  python3 -c 'import sys, json; json.load(open(sys.argv[1]))["resources"]["Stage"]' "${state_out}" ||
    { echo "[verify] FAIL: the planted state document is not valid JSON with a Stage record"; exit 1; }
  aws s3 cp "${state_out}" "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null
  rm -f "${state_in}" "${state_out}"
  [ "$(parent_has_stage_record)" = "yes" ] || { echo "[verify] FAIL: planted Stage record did not land"; exit 1; }
}

echo "[verify] step 5b: a planted parent record named like the parameter does not reach the child on deploy"
V=$(child_param_value)
[ "${V}" = "prod" ] || { echo "[verify] FAIL: child SSM value before the plant is '${V}', expected 'prod'"; exit 1; }
plant_stage_record
(cd "${TEST_DIR}" && ${CLI} deploy "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose)
V=$(child_param_value)
if [ "${V}" != "prod" ]; then
  echo "[verify] FAIL: child SSM value is '${V}' after the redeploy, expected the parameter value 'prod'"
  exit 1
fi
# The redeploy READ the planted record: as a state-only row it deleted it.
if [ "$(parent_has_stage_record)" != "no" ]; then
  echo "[verify] FAIL: the redeploy left the planted Stage record in parent state"
  exit 1
fi
echo "[verify] step 5b ok: child value stayed 'prod'"

echo "[verify] step 5c: plant the record again for the export (step 9b asserts the imported child parameter)"
plant_stage_record
echo "[verify] step 5c ok"

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

echo "[verify] step 9b: the child was imported with the parent PARAMETER value, not the planted record (go-to-k/cdkd#3916)"
CHILD_STAGE=$(echo "${CHILD_DESC}" | python3 -c \
  'import sys, json; p = json.load(sys.stdin)["Stacks"][0].get("Parameters", []); print(",".join(x["ParameterValue"] for x in p if x["ParameterKey"] == "StageParam"))')
if [ "${CHILD_STAGE}" != "prod" ]; then
  echo "[verify] FAIL: child CFn stack StageParam='${CHILD_STAGE}', expected 'prod'"
  exit 1
fi
echo "[verify] step 9b ok: child StageParam=prod"

echo "[verify] step 9c: the child was imported with the parent SSM parameter's VALUE, not its name (go-to-k/cdkd#3915)"
CHILD_SSM_STAGE=$(echo "${CHILD_DESC}" | python3 -c \
  'import sys, json; p = json.load(sys.stdin)["Stacks"][0].get("Parameters", []); print(",".join(x["ParameterValue"] for x in p if x["ParameterKey"] == "SsmStageParam"))')
if [ "${CHILD_SSM_STAGE}" != "${SSM_STAGE_VALUE}" ]; then
  echo "[verify] FAIL: child CFn stack SsmStageParam='${CHILD_SSM_STAGE}', expected the stored value '${SSM_STAGE_VALUE}' (not the name '${SSM_STAGE_NAME}')"
  exit 1
fi
echo "[verify] step 9c ok: child SsmStageParam=${SSM_STAGE_VALUE}"

echo "[verify] step 10: assert AWS resources survived the migration (export = no AWS change)"
aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}" >/dev/null
aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null
echo "[verify] step 10 ok: both SSM parameters still alive"

echo "[verify] step 11: assert cdkd state files GONE (per-stack leaf-first cleanup)"
assert_gone "parent cdkd state still present at s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}"
assert_gone "child cdkd state still present at s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}"
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
assert_gone "parent SSM parameter ${PARENT_PARAM_NAME} still exists after CFn delete-stack" aws ssm get-parameter --name "${PARENT_PARAM_NAME}" --region "${REGION}"
assert_gone "child SSM parameter ${CHILD_PARAM_NAME} still exists after CFn delete-stack" aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}"
echo "[verify] step 13 ok: both SSM parameters gone"

echo "[verify] step 14: delete the #3915 SSM parameter"
aws ssm delete-parameter --name "${SSM_STAGE_NAME}" --region "${REGION}" >/dev/null
SSM_STAGE_CREATED=""
assert_gone "SSM parameter ${SSM_STAGE_NAME} still exists" aws ssm get-parameter --name "${SSM_STAGE_NAME}" --region "${REGION}"
echo "[verify] step 14 ok"

trap - EXIT INT TERM
rm -rf "${PLANT_TMP}"
echo "[verify] PASS"
