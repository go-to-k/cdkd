#!/usr/bin/env bash
# verify.sh — cdkd Bedrock AgentCore tools integ (issues #1038 / #1039 / #1058).
#
# Exercises the three AgentCore tool-side SDK Providers:
#   - AWS::BedrockAgentCore::Browser (adopt-only default singleton)
#   - AWS::BedrockAgentCore::CodeInterpreter (adopt-only default singleton)
#   - AWS::BedrockAgentCore::Evaluator (custom code-based evaluator)
#
# Phases:
#   1. Deploy; assert the default browser / code interpreter were adopted
#      (outputs carry their ARNs) and the evaluator exists at TRACE level.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (Description / Level / tags
#      change). Assert the changes reached AWS in-place: same evaluator id.
#   3. Destroy; assert the evaluator is gone, the AWS-managed defaults are
#      STILL there (no-op delete must not touch them), and state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdAgentcoreToolsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EVALUATOR_NAME="cdkd-integ-agentcore-evaluator"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolve the fixture evaluator's id by its fixed name prefix (the service
# appends a random 10-char suffix to EvaluatorName).
find_evaluator_id() {
  aws bedrock-agentcore-control list-evaluators --region "${REGION}" \
    --query "evaluators[?starts_with(evaluatorId, '${EVALUATOR_NAME}-')].evaluatorId | [0]" \
    --output text 2>/dev/null | grep -v '^None$' || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  LEFTOVER_ID="$(find_evaluator_id)"
  if [ -n "${LEFTOVER_ID}" ]; then
    aws bedrock-agentcore-control delete-evaluator --evaluator-id "${LEFTOVER_ID}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

# Pre-flight: AgentCore must be available in this region (the adopt-only
# providers resolve the AWS-managed defaults live).
if ! aws bedrock-agentcore-control get-browser --browser-id aws.browser.v1 \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Bedrock AgentCore control plane not reachable in ${REGION} (get-browser aws.browser.v1 failed)" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (evaluator at TRACE) ---------------------
echo "==> Phase 1: deploy AgentCore tools stack"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EVALUATOR_ID_P1="$(find_evaluator_id)"
if [ -z "${EVALUATOR_ID_P1}" ]; then
  echo "FAIL: evaluator ${EVALUATOR_NAME}-* not found after Phase 1" >&2
  exit 1
fi
LEVEL_P1="$(aws bedrock-agentcore-control get-evaluator --evaluator-id "${EVALUATOR_ID_P1}" \
  --region "${REGION}" --query 'level' --output text)"
if [ "${LEVEL_P1}" != "TRACE" ]; then
  echo "FAIL: expected level TRACE after Phase 1, got ${LEVEL_P1}" >&2
  exit 1
fi
echo "    evaluator ${EVALUATOR_ID_P1} created at level ${LEVEL_P1}"

# The adopted defaults must be surfaced through the stack outputs.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
for expected in "browser/aws.browser.v1" "code-interpreter/aws.codeinterpreter.v1"; do
  if ! echo "${STATE_JSON}" | grep -q "${expected}"; then
    echo "FAIL: state.json does not carry the adopted default (${expected})" >&2
    exit 1
  fi
done
echo "    default browser + code interpreter adopted into state"

# --- Phase 2: in-place UPDATE (Description / Level / tags) -------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (TRACE -> SESSION)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EVALUATOR_ID_P2="$(find_evaluator_id)"
LEVEL_P2="$(aws bedrock-agentcore-control get-evaluator --evaluator-id "${EVALUATOR_ID_P2}" \
  --region "${REGION}" --query 'level' --output text)"
DESC_P2="$(aws bedrock-agentcore-control get-evaluator --evaluator-id "${EVALUATOR_ID_P2}" \
  --region "${REGION}" --query 'description' --output text)"
if [ "${LEVEL_P2}" != "SESSION" ]; then
  echo "FAIL: expected level SESSION after Phase 2, got ${LEVEL_P2}" >&2
  exit 1
fi
if [ "${DESC_P2}" != "cdkd integ evaluator (updated)" ]; then
  echo "FAIL: expected updated description after Phase 2, got '${DESC_P2}'" >&2
  exit 1
fi
# In-place update: the evaluator id must not change (no replacement).
if [ "${EVALUATOR_ID_P1}" != "${EVALUATOR_ID_P2}" ]; then
  echo "FAIL: evaluator was REPLACED (${EVALUATOR_ID_P1} -> ${EVALUATOR_ID_P2})" >&2
  exit 1
fi
echo "    evaluator updated in-place (id unchanged, level ${LEVEL_P2})"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if [ -n "$(find_evaluator_id)" ]; then
  echo "FAIL: evaluator ${EVALUATOR_NAME}-* still exists after destroy" >&2
  exit 1
fi
echo "    evaluator deleted"

# The AWS-managed defaults must be untouched by the no-op deletes.
BROWSER_STATUS="$(aws bedrock-agentcore-control get-browser --browser-id aws.browser.v1 \
  --region "${REGION}" --query 'status' --output text)"
CI_STATUS="$(aws bedrock-agentcore-control get-code-interpreter \
  --code-interpreter-id aws.codeinterpreter.v1 \
  --region "${REGION}" --query 'status' --output text)"
if [ "${BROWSER_STATUS}" != "READY" ] || [ "${CI_STATUS}" != "READY" ]; then
  echo "FAIL: AWS-managed defaults not READY after destroy (browser=${BROWSER_STATUS}, ci=${CI_STATUS})" >&2
  exit 1
fi
echo "    AWS-managed defaults untouched (READY)"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AgentCore Browser/CodeInterpreter adopt + Evaluator CREATE/UPDATE/destroy, all 3 phases passed"
