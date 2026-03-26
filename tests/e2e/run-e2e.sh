#!/usr/bin/env bash
#
# cdkd E2E Test Script
#
# Runs a full deploy -> diff -> update -> destroy cycle for any integration example.
# Exits immediately on any step failure and cleans up resources on interruption.
#
# Usage:
#   STATE_BUCKET=my-bucket ./run-e2e.sh [example-dir]
#
# Arguments:
#   example-dir  Path to an integration example (default: tests/integration/basic)
#
# Environment Variables:
#   STATE_BUCKET  (required) S3 bucket name for cdkd state storage
#   AWS_REGION    (optional) AWS region, default: us-east-1
#   CDKD_PATH     (optional) Path to cdkd CLI entry point, default: ../../dist/cli.js
#

set -euo pipefail

# --------------------------------------------------------------------------
# Colors and output helpers
# --------------------------------------------------------------------------
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

# --------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------
STATE_BUCKET="${STATE_BUCKET:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CDKD_PATH="${CDKD_PATH:-../../dist/cli.js}"

if [[ -z "${STATE_BUCKET}" ]]; then
  echo -e "${RED}ERROR: STATE_BUCKET environment variable is required.${RESET}"
  echo ""
  echo "Usage:"
  echo "  STATE_BUCKET=my-bucket ./run-e2e.sh [example-dir]"
  echo "  STATE_BUCKET=my-bucket ./run-e2e.sh ../integration/lambda"
  echo "  STATE_BUCKET=my-bucket AWS_REGION=ap-northeast-1 ./run-e2e.sh"
  echo "  STATE_BUCKET=my-bucket CDKD_PATH=/path/to/cli.js ./run-e2e.sh"
  exit 1
fi

# --------------------------------------------------------------------------
# Resolve paths
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Accept optional example directory as first argument (default: basic)
if [[ -n "${1:-}" ]]; then
  # If absolute path, use as-is; otherwise resolve relative to script dir
  if [[ "${1}" = /* ]]; then
    EXAMPLE_DIR="${1}"
  else
    EXAMPLE_DIR="$(cd "${SCRIPT_DIR}" && cd "${1}" 2>/dev/null && pwd)" || EXAMPLE_DIR="${SCRIPT_DIR}/${1}"
  fi
else
  EXAMPLE_DIR="${SCRIPT_DIR}/../integration/basic"
fi

# Normalize path
EXAMPLE_DIR="$(cd "${EXAMPLE_DIR}" 2>/dev/null && pwd)" || true
EXAMPLE_NAME="$(basename "${EXAMPLE_DIR}")"

CDKD_BIN="$(cd "${SCRIPT_DIR}" && node -e "const p = require('path'); console.log(p.resolve('${CDKD_PATH}'))")"

if [[ ! -d "${EXAMPLE_DIR}" ]]; then
  fail "Example directory not found: ${EXAMPLE_DIR}"
  exit 1
fi

if [[ ! -f "${CDKD_BIN}" ]]; then
  fail "cdkd CLI not found at: ${CDKD_BIN}"
  echo "  Hint: Run 'npm run build' in the project root first."
  exit 1
fi

# --------------------------------------------------------------------------
# Common cdkd arguments
# --------------------------------------------------------------------------
APP_CMD="npx ts-node --prefer-ts-exts bin/app.ts"
CDKD_COMMON_ARGS=(
  --app "${APP_CMD}"
  --state-bucket "${STATE_BUCKET}"
  --region "${AWS_REGION}"
)

run_cdkd() {
  # Run cdkd from the example directory
  (cd "${EXAMPLE_DIR}" && node "${CDKD_BIN}" "$@")
}

# --------------------------------------------------------------------------
# Timer helpers
# --------------------------------------------------------------------------
START_TIME="${EPOCHSECONDS:-$(date +%s)}"

elapsed() {
  local now="${EPOCHSECONDS:-$(date +%s)}"
  local diff=$(( now - START_TIME ))
  local mins=$(( diff / 60 ))
  local secs=$(( diff % 60 ))
  printf '%dm%02ds' "${mins}" "${secs}"
}

# --------------------------------------------------------------------------
# Cleanup trap – always attempt destroy on interruption
# --------------------------------------------------------------------------
CLEANUP_NEEDED=false

cleanup() {
  if [[ "${CLEANUP_NEEDED}" == "true" ]]; then
    echo ""
    echo -e "${YELLOW}Interrupted – running cleanup destroy...${RESET}"
    run_cdkd destroy "${CDKD_COMMON_ARGS[@]}" --force --verbose 2>&1 || true
    echo -e "${YELLOW}Cleanup complete.${RESET}"
  fi
  echo ""
  echo -e "${BOLD}Total time: $(elapsed)${RESET}"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

# --------------------------------------------------------------------------
# Pre-flight: install dependencies if needed
# --------------------------------------------------------------------------
header "Pre-flight checks [${EXAMPLE_NAME}]"

info "cdkd binary: ${CDKD_BIN}"
info "Example dir:  ${EXAMPLE_DIR}"
info "Example name: ${EXAMPLE_NAME}"
info "State bucket: ${STATE_BUCKET}"
info "AWS region:   ${AWS_REGION}"

if [[ ! -d "${EXAMPLE_DIR}/node_modules" ]]; then
  info "Installing dependencies for ${EXAMPLE_NAME} example..."
  (cd "${EXAMPLE_DIR}" && npm install --silent)
  pass "Dependencies installed"
else
  pass "Dependencies already installed"
fi

STEP=0
TOTAL_STEPS=5

step_header() {
  STEP=$(( STEP + 1 ))
  header "Step ${STEP}/${TOTAL_STEPS}: $* [${EXAMPLE_NAME}]"
}

# --------------------------------------------------------------------------
# Step 1: Initial deploy (CREATE)
# --------------------------------------------------------------------------
step_header "Deploy (CREATE)"

info "Running: cdkd deploy"
CLEANUP_NEEDED=true

run_cdkd deploy "${CDKD_COMMON_ARGS[@]}" --verbose
pass "Initial deploy succeeded [$(elapsed)]"

# --------------------------------------------------------------------------
# Step 2: Diff after create (expect no changes)
# --------------------------------------------------------------------------
step_header "Diff after CREATE (expect no changes)"

info "Running: cdkd diff"
DIFF_OUTPUT=$(run_cdkd diff "${CDKD_COMMON_ARGS[@]}" 2>&1) || true

if echo "${DIFF_OUTPUT}" | grep -q "No changes detected"; then
  pass "Diff shows no changes as expected [$(elapsed)]"
else
  echo "${DIFF_OUTPUT}"
  fail "Diff unexpectedly shows changes after clean deploy"
  exit 1
fi

# --------------------------------------------------------------------------
# Step 3: Update deploy (add UpdateTest tag)
# --------------------------------------------------------------------------
step_header "Deploy (UPDATE with CDKD_TEST_UPDATE=true)"

info "Running: CDKD_TEST_UPDATE=true cdkd deploy"
CDKD_TEST_UPDATE=true run_cdkd deploy "${CDKD_COMMON_ARGS[@]}" --verbose
pass "Update deploy succeeded [$(elapsed)]"

# --------------------------------------------------------------------------
# Step 4: Diff after update (expect no changes)
# --------------------------------------------------------------------------
step_header "Diff after UPDATE (expect no changes)"

info "Running: CDKD_TEST_UPDATE=true cdkd diff"
DIFF_OUTPUT=$(CDKD_TEST_UPDATE=true run_cdkd diff "${CDKD_COMMON_ARGS[@]}" 2>&1) || true

if echo "${DIFF_OUTPUT}" | grep -q "No changes detected"; then
  pass "Diff shows no changes as expected [$(elapsed)]"
else
  echo "${DIFF_OUTPUT}"
  fail "Diff unexpectedly shows changes after update deploy"
  exit 1
fi

# --------------------------------------------------------------------------
# Step 5: Destroy
# --------------------------------------------------------------------------
step_header "Destroy"

info "Running: cdkd destroy --force"
run_cdkd destroy "${CDKD_COMMON_ARGS[@]}" --force --verbose
pass "Destroy succeeded [$(elapsed)]"

CLEANUP_NEEDED=false

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
header "E2E Test Complete [${EXAMPLE_NAME}]"
pass "All ${TOTAL_STEPS} steps passed successfully!"
echo -e "${BOLD}Total time: $(elapsed)${RESET}"
