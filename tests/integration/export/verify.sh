#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd export` (cdkd → CloudFormation).
#
# Variants:
#   default          (no flag) — full 2-phase IMPORT+UPDATE flow
#   dry-run          — `cdkd export --dry-run` prints plan, no AWS write
#   cfn-stack-name   — `--cfn-stack-name <name>` exports under a non-default
#                      CFn stack name (cdkd stack name != CFn stack name)
#   parameter-override — `--parameter Key=Value` overrides the user-declared
#                      `Environment` CfnParameter; new CFn stack should
#                      carry the overridden value as a tag.
#
# Default flow (no variant):
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdExportExample
#   3. cdkd export CdkdExportExample --include-non-importable --yes
#   4. Verify CFn stack exists / has every imported type / has the CR
#   5. Verify cdkd state for the stack is GONE
#   6. aws cloudformation delete-stack → wait for delete-complete
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

VARIANT="${VARIANT:-default}"

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdExportExample"

# CFn stack name defaults to the cdkd stack name; the cfn-stack-name
# variant overrides it.
case "${VARIANT}" in
  cfn-stack-name)
    CFN_STACK="CdkdExportExampleCfnRenamed"
    ;;
  *)
    CFN_STACK="${STACK}"
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/export"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] variant=${VARIANT} region=${REGION} stack=${STACK} cfn-stack=${CFN_STACK} state-bucket=${STATE_BUCKET}"

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
    # If the CFn stack exists (export succeeded into CFn), delete via CFn.
    if aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] cleanup: aws cloudformation delete-stack ${CFN_STACK}"
      aws cloudformation delete-stack --stack-name "${CFN_STACK}" --region "${REGION}" || true
      aws cloudformation wait stack-delete-complete --stack-name "${CFN_STACK}" --region "${REGION}" || true
    fi
    # In every failure mode try cdkd destroy too — handles dry-run (state
    # never deleted), partial failures (state preserved), and the
    # variant where export ran against a different CFn name.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/state.json" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
  fi
  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# Per-variant export command + post-export assertions.
case "${VARIANT}" in
  dry-run)
    echo "[verify] step 3: cdkd export --dry-run (no AWS write expected)"
    ${CLI} export "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --include-non-importable \
      --dry-run \
      -y \
      --verbose 2>&1 | tee /tmp/verify-dry-run.log
    # The dry-run output should mention the import plan; assert at least one
    # of the imported types is in the printed plan.
    if ! grep -qE 'Bucket|Topic|Lambda|IAM' /tmp/verify-dry-run.log; then
      echo "[verify] FAIL: dry-run output does not mention any imported resource type"
      exit 1
    fi
    # Regression guard for the splitter-coverage class of bugs. The fixture
    # now contains composite-id resources (HttpApi: Integration / Route /
    # Lambda::Permission) and an IMPORT-unsupported resource (Stage), so the
    # dry-run plan output should NOT contain any "blocks migration" or
    # "composite primary identifier" message.
    if grep -qE 'block migration|composite primary identifier' /tmp/verify-dry-run.log; then
      echo "[verify] FAIL: dry-run reports unresolved composite-id resources"
      echo "[verify] (composite-id splitters in src/cli/commands/export.ts are missing entries)"
      exit 1
    fi
    # Assert the dry-run plan announces the Stage pre-delete + re-CREATE
    # path. Without this output, the plan-printer integration for
    # recreateBeforePhase2 silently regressed.
    if ! grep -q 'IMPORT-unsupported resource' /tmp/verify-dry-run.log; then
      echo "[verify] FAIL: dry-run plan does not mention IMPORT-unsupported resources"
      echo "[verify] (Stage pre-delete + re-CREATE announcement missed)"
      exit 1
    fi
    if ! grep -q 'AWS::ApiGatewayV2::Stage' /tmp/verify-dry-run.log; then
      echo "[verify] FAIL: dry-run plan does not list AWS::ApiGatewayV2::Stage as recreate target"
      exit 1
    fi
    echo "[verify] step 4: verify CFn stack does NOT exist (dry-run)"
    if aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] FAIL: dry-run created a CFn stack — should not happen"
      exit 1
    fi
    echo "[verify] step 4 ok: no CFn stack"
    echo "[verify] step 5: verify cdkd state still exists (dry-run preserves state)"
    if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/state.json" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] FAIL: dry-run deleted cdkd state — should preserve"
      exit 1
    fi
    echo "[verify] step 5 ok: cdkd state preserved"
    echo "[verify] step 6: cdkd destroy cleanup"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
    echo "[verify] step 6 ok"
    ;;

  cfn-stack-name)
    echo "[verify] step 3: cdkd export --cfn-stack-name ${CFN_STACK} -y"
    ${CLI} export "${STACK}" \
      --cfn-stack-name "${CFN_STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --include-non-importable \
      -y \
      --verbose
    echo "[verify] step 4: verify CFn stack ${CFN_STACK} (NOT ${STACK}) exists"
    STATUS="$(aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" \
      --query 'Stacks[0].StackStatus' --output text)"
    echo "[verify] CFn stack status: ${STATUS}"
    case "${STATUS}" in
      UPDATE_COMPLETE|IMPORT_COMPLETE) echo "[verify] step 4 ok" ;;
      *) echo "[verify] FAIL: expected UPDATE_COMPLETE / IMPORT_COMPLETE, got ${STATUS}"; exit 1 ;;
    esac
    # Default-name CFn stack must NOT exist (renamed-only assertion).
    if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] FAIL: default-name CFn stack '${STACK}' should not exist (--cfn-stack-name redirects)"
      exit 1
    fi
    echo "[verify] step 4b: cdkd state cleared"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/state.json" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] FAIL: cdkd state still present"
      exit 1
    fi
    echo "[verify] step 4b ok"
    echo "[verify] step 5: delete-stack ${CFN_STACK}"
    aws cloudformation delete-stack --stack-name "${CFN_STACK}" --region "${REGION}"
    aws cloudformation wait stack-delete-complete --stack-name "${CFN_STACK}" --region "${REGION}"
    echo "[verify] step 5 ok"
    ;;

  parameter-override)
    echo "[verify] step 3: cdkd export --parameter Environment=prod -y"
    ${CLI} export "${STACK}" \
      --parameter Environment=prod \
      --state-bucket "${STATE_BUCKET}" \
      --include-non-importable \
      -y \
      --verbose
    echo "[verify] step 4: verify CFn stack with overridden parameter"
    STATUS="$(aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" \
      --query 'Stacks[0].StackStatus' --output text)"
    if [[ "${STATUS}" != "UPDATE_COMPLETE" && "${STATUS}" != "IMPORT_COMPLETE" ]]; then
      echo "[verify] FAIL: status ${STATUS}"
      exit 1
    fi
    # Verify the override is recorded in CFn stack Parameters.
    PARAM_VALUE="$(aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" \
      --query "Stacks[0].Parameters[?ParameterKey=='Environment'].ParameterValue" --output text)"
    echo "[verify] CFn Environment parameter value: ${PARAM_VALUE}"
    if [ "${PARAM_VALUE}" != "prod" ]; then
      echo "[verify] FAIL: expected Environment=prod, got '${PARAM_VALUE}'"
      exit 1
    fi
    echo "[verify] step 4 ok"
    echo "[verify] step 5: delete-stack"
    aws cloudformation delete-stack --stack-name "${CFN_STACK}" --region "${REGION}"
    aws cloudformation wait stack-delete-complete --stack-name "${CFN_STACK}" --region "${REGION}"
    echo "[verify] step 5 ok"
    ;;

  default|"")
    echo "[verify] step 3: cdkd export --include-non-importable -y (expect exit 0)"
    ${CLI} export "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --include-non-importable \
      -y \
      --verbose

    echo "[verify] step 4: verify CFn stack exists"
    STATUS="$(aws cloudformation describe-stacks --stack-name "${CFN_STACK}" --region "${REGION}" \
      --query 'Stacks[0].StackStatus' --output text)"
    echo "[verify] CFn stack status: ${STATUS}"
    case "${STATUS}" in
      UPDATE_COMPLETE|IMPORT_COMPLETE) echo "[verify] step 4 ok" ;;
      *) echo "[verify] FAIL: expected UPDATE_COMPLETE / IMPORT_COMPLETE, got ${STATUS}"; exit 1 ;;
    esac

    echo "[verify] step 4b: verify imported resource types present"
    RESOURCES="$(aws cloudformation list-stack-resources --stack-name "${CFN_STACK}" --region "${REGION}" \
      --query 'StackResourceSummaries[].ResourceType' --output text)"
    echo "[verify] CFn resources: ${RESOURCES}"
    # Single-key imports (phase 1)
    for needed in 'AWS::S3::Bucket' 'AWS::SNS::Topic' 'AWS::Lambda::Function' 'AWS::IAM::Role'; do
      if ! echo "${RESOURCES}" | grep -q "${needed}"; then
        echo "[verify] FAIL: ${needed} not found in CFn stack"
        exit 1
      fi
    done
    # Composite-id imports (phase 1) — covers ApiGwV2 Api + Integration + Route
    # + Lambda::Permission, exercising COMPOSITE_ID_SPLITTERS end-to-end.
    for needed in 'AWS::ApiGatewayV2::Api' 'AWS::ApiGatewayV2::Integration' 'AWS::ApiGatewayV2::Route' 'AWS::Lambda::Permission'; do
      if ! echo "${RESOURCES}" | grep -q "${needed}"; then
        echo "[verify] FAIL: ${needed} not found in CFn stack (composite-id splitter regression)"
        exit 1
      fi
    done
    # IMPORT-unsupported re-CREATE (phase 2): AWS::ApiGatewayV2::Stage was
    # pre-deleted between phases, then CFn UPDATE re-CREATEd it fresh.
    # Closes cdkd issue #307.
    if ! echo "${RESOURCES}" | grep -q 'AWS::ApiGatewayV2::Stage'; then
      echo "[verify] FAIL: AWS::ApiGatewayV2::Stage not found in CFn stack (pre-delete + phase-2 CREATE missed)"
      exit 1
    fi
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
    STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
      echo "[verify] FAIL: cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}"
      exit 1
    fi
    echo "[verify] step 5 ok: cdkd state cleared"

    echo "[verify] step 6: aws cloudformation delete-stack (clean up CFn-managed resources)"
    aws cloudformation delete-stack --stack-name "${CFN_STACK}" --region "${REGION}"
    aws cloudformation wait stack-delete-complete --stack-name "${CFN_STACK}" --region "${REGION}"
    echo "[verify] step 6 ok: CFn stack deleted"
    ;;

  *)
    echo "[verify] FAIL: unknown VARIANT='${VARIANT}' (expected: default / dry-run / cfn-stack-name / parameter-override)"
    exit 1
    ;;
esac

trap - EXIT
echo "[verify] PASS (variant=${VARIANT})"
