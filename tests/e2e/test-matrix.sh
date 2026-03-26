#!/usr/bin/env bash
#
# E2E Test Matrix
#
# Defines all integration tests and their specific configuration.
# Each entry specifies:
#   - Test directory
#   - CDKD_UPDATE_CONTEXT (optional context args for UPDATE step)
#
# Usage:
#   ./test-matrix.sh              # Run all tests
#   ./test-matrix.sh basic lambda # Run specific tests
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

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
)

# --------------------------------------------------------------------------
# Parse arguments: filter to specific tests if given
# --------------------------------------------------------------------------
FILTER=("$@")

# --------------------------------------------------------------------------
# Run tests
# --------------------------------------------------------------------------
PASSED=0
FAILED=0
FAILED_NAMES=()
TOTAL=0

for entry in "${TESTS[@]}"; do
  IFS='|' read -r name update_context <<< "${entry}"

  # Apply filter if specified
  if [[ ${#FILTER[@]} -gt 0 ]]; then
    match=false
    for f in "${FILTER[@]}"; do
      if [[ "${name}" == "${f}" ]]; then
        match=true
        break
      fi
    done
    if [[ "${match}" == "false" ]]; then
      continue
    fi
  fi

  TOTAL=$((TOTAL + 1))
  log_file="/tmp/e2e-matrix-${name}.log"

  echo -e "${BOLD}[${TOTAL}] Running: ${name}${RESET}"

  # Set update context if specified
  export CDKD_UPDATE_CONTEXT="${update_context}"

  if "${SCRIPT_DIR}/run-e2e.sh" "${SCRIPT_DIR}/../integration/${name}" > "${log_file}" 2>&1; then
    echo -e "  ${GREEN}✓ ${name}${RESET}"
    PASSED=$((PASSED + 1))
  else
    echo -e "  ${RED}✗ ${name}${RESET}"
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("${name}")
  fi

  unset CDKD_UPDATE_CONTEXT
done

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo -e "${BOLD}========== E2E Test Summary ==========${RESET}"
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
