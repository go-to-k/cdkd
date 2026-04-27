#!/usr/bin/env bash
#
# cdkd Failure-Injection E2E Test
#
# Verifies the dispatcher's rollback path against real AWS by deploying the
# `basic` stack with CDKD_TEST_FAIL=true. The stack adds an SQS Queue with an
# out-of-range MessageRetentionPeriod that AWS rejects on CreateQueue. The good
# resources (S3 bucket + SSM Document) succeed in parallel, then rollback must
# delete them — verified by checking the state bucket and the AWS account.
#
# Usage:
#   ./run-failure-injection.sh
#   STATE_BUCKET=my-bucket AWS_REGION=us-east-1 ./run-failure-injection.sh
#
# Exits 0 on success (deploy failed AS EXPECTED + rollback cleaned up).
# Exits 1 if anything else (deploy unexpectedly succeeded, rollback left
# resources, etc.).

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "${GREEN}✓ $*${RESET}"; }
fail() { echo -e "${RED}✗ $*${RESET}"; }
info() { echo -e "${CYAN}→ $*${RESET}"; }
header() { echo -e "\n${BOLD}========== $* ==========${RESET}\n"; }

STATE_BUCKET="${STATE_BUCKET:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CDKD_PATH="${CDKD_PATH:-../../dist/cli.js}"
STACK_NAME="CdkdBasicExample"

if [[ -z "${STATE_BUCKET}" ]]; then
  info "STATE_BUCKET not set, auto-resolving from AWS account..."
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    fail "STATE_BUCKET not set and could not resolve AWS account ID"
    exit 1
  }
  STATE_BUCKET="cdkd-state-${ACCOUNT_ID}-${AWS_REGION}"
  info "Using default state bucket: ${STATE_BUCKET}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="${SCRIPT_DIR}/../integration/basic"
CDKD_BIN="$(cd "${SCRIPT_DIR}" && node -e "const p = require('path'); console.log(p.resolve('${CDKD_PATH}'))")"

if [[ ! -f "${CDKD_BIN}" ]]; then
  fail "cdkd CLI not found at: ${CDKD_BIN}"
  echo "  Hint: Run 'pnpm run build' in the project root first."
  exit 1
fi

CDKD_ARGS=(
  --app "npx ts-node --prefer-ts-exts bin/app.ts"
  --state-bucket "${STATE_BUCKET}"
  --region "${AWS_REGION}"
)

run_cdkd() {
  (cd "${EXAMPLE_DIR}" && node "${CDKD_BIN}" "$@")
}

cleanup_on_exit() {
  # Best-effort cleanup so a failed assertion doesn't leak resources.
  echo ""
  info "Cleanup pass (best-effort destroy)..."
  run_cdkd destroy "${CDKD_ARGS[@]}" "${STACK_NAME}" --force >/dev/null 2>&1 || true
}
trap cleanup_on_exit EXIT

header "Pre-flight"
info "cdkd binary: ${CDKD_BIN}"
info "Example dir:  ${EXAMPLE_DIR}"
info "State bucket: ${STATE_BUCKET}"
info "AWS region:   ${AWS_REGION}"

if [[ ! -d "${EXAMPLE_DIR}/node_modules" ]]; then
  info "Installing dependencies..."
  (cd "${EXAMPLE_DIR}" && npm install --silent)
fi

# Make sure no leftover from a previous run.
info "Pre-cleanup destroy (in case a prior run left state)..."
run_cdkd destroy "${CDKD_ARGS[@]}" "${STACK_NAME}" --force >/dev/null 2>&1 || true

# --------------------------------------------------------------------------
# Step 1: Deploy with CDKD_TEST_FAIL=true — must FAIL.
# --------------------------------------------------------------------------
header "Step 1: Deploy with CDKD_TEST_FAIL=true (expect failure)"

DEPLOY_LOG=$(mktemp)
if (cd "${EXAMPLE_DIR}" && CDKD_TEST_FAIL=true node "${CDKD_BIN}" deploy \
      --app "npx ts-node --prefer-ts-exts bin/app.ts" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${AWS_REGION}" "${STACK_NAME}" 2>&1) > "${DEPLOY_LOG}"; then
  fail "Deploy unexpectedly SUCCEEDED — failure injection did not work"
  cat "${DEPLOY_LOG}"
  rm -f "${DEPLOY_LOG}"
  exit 1
fi
pass "Deploy failed as expected"

if grep -q "Rolling back .* completed operation" "${DEPLOY_LOG}"; then
  pass "Rollback was triggered"
else
  fail "Rollback message not found in deploy output"
  cat "${DEPLOY_LOG}"
  rm -f "${DEPLOY_LOG}"
  exit 1
fi

if grep -q "FailingQueue" "${DEPLOY_LOG}"; then
  pass "FailingQueue was the failed resource (expected)"
fi
rm -f "${DEPLOY_LOG}"

# --------------------------------------------------------------------------
# Step 2: Verify state file is empty (rollback cleaned everything up).
# --------------------------------------------------------------------------
header "Step 2: Verify state has no live resources"

# State may have been removed by destroy on rollback path; both empty-state and
# state-with-zero-resources count as success.
STATE_OBJ="s3://${STATE_BUCKET}/stacks/${STACK_NAME}/state.json"
if aws s3 ls "${STATE_OBJ}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  STATE_BODY=$(aws s3 cp "${STATE_OBJ}" - --region "${AWS_REGION}" 2>/dev/null)
  RES_COUNT=$(echo "${STATE_BODY}" | node -e "
    let s='';
    process.stdin.on('data', c => s+=c);
    process.stdin.on('end', () => {
      try { const j = JSON.parse(s); console.log(Object.keys(j.resources||{}).length); }
      catch(e) { console.log('-1'); }
    });
  ")
  if [[ "${RES_COUNT}" == "0" ]]; then
    pass "State has 0 resources after rollback"
  else
    fail "State still has ${RES_COUNT} resource(s) after rollback"
    exit 1
  fi
else
  pass "State file does not exist (clean)"
fi

# --------------------------------------------------------------------------
# Step 3: Verify AWS has no leftover S3 bucket / SSM Document.
# --------------------------------------------------------------------------
header "Step 3: Verify no leftover AWS resources"

LEAK=0

LEFTOVER_BUCKETS=$(aws s3api list-buckets \
  --query "Buckets[?contains(Name, 'cdkdbasicexample')].Name" \
  --output text 2>/dev/null || true)
if [[ -n "${LEFTOVER_BUCKETS}" ]]; then
  fail "Leftover S3 bucket(s): ${LEFTOVER_BUCKETS}"
  LEAK=1
else
  pass "No leftover S3 buckets"
fi

LEFTOVER_DOCS=$(aws ssm list-documents --region "${AWS_REGION}" \
  --filters "Key=Owner,Values=Self" \
  --query "DocumentIdentifiers[?starts_with(Name, '${STACK_NAME}-')].Name" \
  --output text 2>/dev/null || true)
if [[ -n "${LEFTOVER_DOCS}" ]]; then
  fail "Leftover SSM Document(s): ${LEFTOVER_DOCS}"
  LEAK=1
else
  pass "No leftover SSM Documents"
fi

if [[ ${LEAK} -ne 0 ]]; then
  fail "Rollback left resources behind"
  exit 1
fi

header "All assertions passed"
pass "Failure-injection rollback verified end-to-end"
