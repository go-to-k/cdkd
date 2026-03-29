#!/usr/bin/env bash
#
# E2E Test Matrix
#
# Defines all integration tests and their specific configuration.
# Runs tests in parallel with configurable concurrency.
#
# Usage:
#   ./test-matrix.sh                    # Run all tests (parallel, default 4)
#   ./test-matrix.sh -j 8              # Run with 8 parallel jobs
#   ./test-matrix.sh basic lambda       # Run specific tests
#   ./test-matrix.sh -j 1 basic lambda  # Run specific tests sequentially
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

# --------------------------------------------------------------------------
# Parse -j option for parallelism
# --------------------------------------------------------------------------
MAX_PARALLEL=4

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -j)
      MAX_PARALLEL="$2"
      shift 2
      ;;
    -j*)
      MAX_PARALLEL="${1#-j}"
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

FILTER=("$@")

# --------------------------------------------------------------------------
# Test definitions: "name|update_context"
# update_context is optional (empty = use CDKD_TEST_UPDATE=true default)
# --------------------------------------------------------------------------
TESTS=(
  "basic|"
  "lambda|"
  "conditions|"
  "parameters|"
  "intrinsic-functions|"
  "multi-resource|"
  "cross-stack-references|"
  "eventbridge|"
  "sns-sqs-event|"
  "cloudwatch|"
  "stepfunctions|"
  "dynamodb-streams|"
  "ec2-vpc|"
  "ec2-instance|"
  "apigateway|"
  "composite-stack|"
  "full-stack-demo|"
  "s3-cloudfront|"
  "multi-stack-deps|"
  "alb|"
  "route53|"
  "wafv2|"
  "cognito|"
  "ecr|"
  "custom-resource-provider|"
  "ecs-fargate|"
  "rds-aurora|"
  "cloudfront-function-url|"
  "bedrock-agentcore|"
  "context-test|-c env=from-cli -c featureFlag=true"
  "serverless-api|"
  "event-driven|"
  "infra-security|"
  "monitoring|"
  "data-pipeline|"
  "scheduled-task|"
  "microservices|"
  "api-cognito|"
  "vpc-lambda|"
  "cache-streaming|"
  "alb-advanced|"
  "appsync|"
  "batch|"
  "efs-lambda|"
  "log-pipeline|"
  "data-analytics|"
  "lambda-versioning|"
  "kms-encryption|"
  "efs-standalone|"
  "ci-cd|"
  "s3-directory-bucket|"
  "s3-tables|"
  "s3-vectors|"
)

# --------------------------------------------------------------------------
# Build list of tests to run
# --------------------------------------------------------------------------
SELECTED=()
for entry in "${TESTS[@]}"; do
  IFS='|' read -r name _ctx <<< "${entry}"

  if [[ ${#FILTER[@]} -gt 0 ]]; then
    match=false
    for f in "${FILTER[@]}"; do
      [[ "${name}" == "${f}" ]] && match=true && break
    done
    [[ "${match}" == "false" ]] && continue
  fi

  SELECTED+=("${entry}")
done

TOTAL=${#SELECTED[@]}
if [[ ${TOTAL} -eq 0 ]]; then
  echo -e "${RED}No tests matched the filter.${RESET}"
  exit 1
fi

echo -e "${BOLD}Running ${TOTAL} tests (max ${MAX_PARALLEL} parallel)${RESET}"
echo ""

# --------------------------------------------------------------------------
# Run tests with controlled parallelism
# --------------------------------------------------------------------------
RUNNING=0
PIDS=()
PID_NAMES=()

run_test() {
  local name="$1"
  local update_context="$2"
  local log_file="/tmp/e2e-matrix-${name}.log"

  (
    export CDKD_UPDATE_CONTEXT="${update_context}"
    "${SCRIPT_DIR}/run-e2e.sh" "${SCRIPT_DIR}/../integration/${name}" > "${log_file}" 2>&1
  ) &

  PIDS+=($!)
  PID_NAMES+=("${name}")
  RUNNING=$((RUNNING + 1))
  echo -e "  ${YELLOW}▶ Started: ${name}${RESET}"
}

wait_for_slot() {
  # Wait for any one job to finish
  while [[ ${RUNNING} -ge ${MAX_PARALLEL} ]]; do
    for i in "${!PIDS[@]}"; do
      if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
        wait "${PIDS[$i]}" 2>/dev/null && true
        RUNNING=$((RUNNING - 1))
        unset 'PIDS[i]'
        unset 'PID_NAMES[i]'
        # Re-index arrays
        PIDS=("${PIDS[@]}")
        PID_NAMES=("${PID_NAMES[@]}")
        return
      fi
    done
    sleep 1
  done
}

# Launch tests with parallelism limit
for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name update_context <<< "${entry}"
  wait_for_slot
  run_test "${name}" "${update_context}"
done

# Wait for all remaining jobs
wait 2>/dev/null || true

# --------------------------------------------------------------------------
# Collect results
# --------------------------------------------------------------------------
PASSED=0
FAILED=0
FAILED_NAMES=()

echo ""
echo -e "${BOLD}========== Results ==========${RESET}"

for entry in "${SELECTED[@]}"; do
  IFS='|' read -r name _ctx <<< "${entry}"
  log_file="/tmp/e2e-matrix-${name}.log"

  if grep -q 'All 5 steps passed' "${log_file}" 2>/dev/null; then
    echo -e "  ${GREEN}✓ ${name}${RESET}"
    PASSED=$((PASSED + 1))
  else
    echo -e "  ${RED}✗ ${name}${RESET}"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("${name}")
  fi
done

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo -e "${BOLD}========== Summary ==========${RESET}"
echo -e "  Total:  ${TOTAL}"
echo -e "  ${GREEN}Passed: ${PASSED}${RESET}"
if [[ ${FAILED} -gt 0 ]]; then
  echo -e "  ${RED}Failed: ${FAILED}${RESET}"
  for name in "${FAILED_NAMES[@]}"; do
    echo -e "    ${RED}✗ ${name}${RESET} (see /tmp/e2e-matrix-${name}.log)"
  done
  exit 1
else
  echo -e "  ${GREEN}All tests passed!${RESET}"
fi
