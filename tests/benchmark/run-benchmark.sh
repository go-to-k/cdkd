#!/usr/bin/env bash
#
# run-benchmark.sh - Compare cdkd vs CloudFormation deployment speed
#
# Usage:
#   ./tests/benchmark/run-benchmark.sh [scenario]
#
# Scenarios:
#   bench-sdk    - 5 resources, all served by cdkd SDK providers (default)
#   bench-ccapi  - 5 resources, all fall through to Cloud Control API
#   basic        - single S3 bucket (legacy scenario)
#   all          - runs bench-sdk then bench-ccapi
#
# Environment variables:
#   STATE_BUCKET  - S3 bucket for cdkd state (optional: auto-resolved from STS account)
#   AWS_REGION    - AWS region (default: us-east-1)
#   CDKD_BIN      - Path to cdkd binary (default: ./dist/cli.js)
#   SKIP_CFN      - Set to "true" to skip CloudFormation benchmark
#   SKIP_CDKD     - Set to "true" to skip cdkd benchmark
#   RUNS          - Number of runs (last result is used) (default: 1)
#

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-1}"
CDKD_BIN="${CDKD_BIN:-$PROJECT_ROOT/dist/cli.js}"
SKIP_CFN="${SKIP_CFN:-false}"
SKIP_CDKD="${SKIP_CDKD:-false}"
RUNS="${RUNS:-1}"

SCENARIO="${1:-bench-sdk}"

# ─── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
phase() { echo -e "${CYAN}>>> $*${NC}"; }

# ─── Scenario configuration ──────────────────────────────────────────────────

# Resolves scenario name → (EXAMPLE_DIR, CDKD_STACK, CFN_STACK, LABEL).
# Sets globals: EXAMPLE_DIR, CDKD_STACK, CFN_STACK, SCENARIO_LABEL.
configure_scenario() {
  local name="$1"
  case "$name" in
    basic)
      EXAMPLE_DIR="$PROJECT_ROOT/tests/integration/basic"
      CDKD_STACK="CdkdBasicExample"
      CFN_STACK="CdkdBasicExampleCfn"
      SCENARIO_LABEL="basic (S3 bucket + SSM document)"
      ;;
    bench-sdk)
      EXAMPLE_DIR="$PROJECT_ROOT/tests/integration/bench-sdk"
      CDKD_STACK="CdkdBenchSdk"
      CFN_STACK="CdkdBenchSdk"
      SCENARIO_LABEL="bench-sdk (5 resources, SDK providers only)"
      ;;
    bench-ccapi)
      EXAMPLE_DIR="$PROJECT_ROOT/tests/integration/bench-ccapi"
      CDKD_STACK="CdkdBenchCcapi"
      CFN_STACK="CdkdBenchCcapi"
      SCENARIO_LABEL="bench-ccapi (5 resources, Cloud Control API only)"
      ;;
    *)
      err "Unknown scenario: $name"
      err "Valid scenarios: bench-sdk, bench-ccapi, basic, all"
      exit 1
      ;;
  esac
  CDK_APP="npx ts-node --prefer-ts-exts bin/app.ts"
}

# ─── Utility functions ───────────────────────────────────────────────────────

now_ms() {
  if [[ "$(uname)" == "Darwin" ]]; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    date +%s%3N
  fi
}

calc_speedup() {
  local cdkd_ms=$1
  local cfn_ms=$2
  if [[ "$cdkd_ms" -eq 0 ]] || [[ "$cfn_ms" -eq 0 ]]; then
    echo "N/A"
  else
    python3 -c "print(f'{$cfn_ms / $cdkd_ms:.1f}x')"
  fi
}

fmt_time() {
  local ms=$1
  if [[ "$ms" -eq 0 ]]; then
    echo "N/A"
  else
    python3 -c "print(f'{$ms / 1000:.1f}s')"
  fi
}

# ─── Prerequisite checks ────────────────────────────────────────────────────

check_prerequisites() {
  phase "Checking prerequisites"

  if ! aws sts get-caller-identity &>/dev/null; then
    err "AWS credentials not configured. Please configure AWS CLI."
    exit 1
  fi
  ok "AWS credentials valid"

  if [[ ! -f "$CDKD_BIN" ]]; then
    warn "cdkd binary not found at $CDKD_BIN. Building..."
    (cd "$PROJECT_ROOT" && pnpm run build)
  fi
  ok "cdkd binary available"

  if [[ "$SKIP_CFN" != "true" ]]; then
    if ! command -v cdk &>/dev/null; then
      warn "cdk CLI not found. Install with: npm install -g aws-cdk"
      warn "Skipping CloudFormation benchmark."
      SKIP_CFN="true"
    else
      ok "cdk CLI available ($(cdk --version 2>/dev/null | head -1))"
    fi
  fi

  if [[ ! -d "$EXAMPLE_DIR" ]]; then
    err "Example directory not found: $EXAMPLE_DIR"
    exit 1
  fi
  ok "Example directory found: $EXAMPLE_DIR"

  if [[ ! -d "$EXAMPLE_DIR/node_modules" ]]; then
    info "Installing example dependencies..."
    (cd "$EXAMPLE_DIR" && npm install)
  fi
  ok "Example dependencies installed"

  echo ""
}

# ─── cdkd benchmark ─────────────────────────────────────────────────────────

cdkd_synth() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" synth --app "$CDK_APP" "$CDKD_STACK" >/dev/null 2>&1)
  end=$(now_ms)
  echo $((end - start))
}

cdkd_deploy() {
  local -a state_bucket_args=()
  if [[ -n "${STATE_BUCKET:-}" ]]; then
    state_bucket_args=(--state-bucket "$STATE_BUCKET")
  fi

  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" deploy --app "$CDK_APP" "${state_bucket_args[@]+"${state_bucket_args[@]}"}" "$CDKD_STACK" >>"$DEPLOY_LOG" 2>&1) || true
  end=$(now_ms)
  echo $((end - start))
}

cdkd_destroy() {
  local -a state_bucket_args=()
  if [[ -n "${STATE_BUCKET:-}" ]]; then
    state_bucket_args=(--state-bucket "$STATE_BUCKET")
  fi

  info "Destroying cdkd stack..."
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" destroy --app "$CDK_APP" "${state_bucket_args[@]+"${state_bucket_args[@]}"}" --force "$CDKD_STACK" 2>&1) || {
    warn "cdkd destroy failed (stack may not exist)"
  }
}

run_cdkd_benchmark() {
  phase "Running cdkd benchmark (run $1/$RUNS)"

  cdkd_destroy >/dev/null 2>&1 || true

  info "Measuring synthesis time..."
  local synth_ms
  synth_ms=$(cdkd_synth)
  ok "Synthesis: $(fmt_time "$synth_ms")"

  info "Measuring deploy time..."
  local deploy_ms
  deploy_ms=$(cdkd_deploy)
  ok "Deploy: $(fmt_time "$deploy_ms")"

  info "Cleaning up..."
  cdkd_destroy >/dev/null 2>&1 || true

  CDKD_SYNTH_MS=$synth_ms
  CDKD_DEPLOY_MS=$deploy_ms
  CDKD_TOTAL_MS=$((synth_ms + deploy_ms))

  echo ""
}

# ─── CloudFormation benchmark ────────────────────────────────────────────────

cfn_synth() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && npx cdk synth "$CFN_STACK" >/dev/null 2>&1)
  end=$(now_ms)
  echo $((end - start))
}

cfn_deploy() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && npx cdk deploy "$CFN_STACK" --require-approval never >>"$DEPLOY_LOG" 2>&1) || true
  end=$(now_ms)
  echo $((end - start))
}

cfn_destroy() {
  info "Destroying CloudFormation stack..."
  (cd "$EXAMPLE_DIR" && npx cdk destroy "$CFN_STACK" --force 2>&1) || {
    warn "cdk destroy failed (stack may not exist)"
  }
}

run_cfn_benchmark() {
  phase "Running CloudFormation benchmark (run $1/$RUNS)"

  cfn_destroy >/dev/null 2>&1 || true

  info "Measuring synthesis time..."
  local synth_ms
  synth_ms=$(cfn_synth)
  ok "Synthesis: $(fmt_time "$synth_ms")"

  info "Measuring deploy time (this will take a while due to CloudFormation)..."
  local deploy_ms
  deploy_ms=$(cfn_deploy)
  ok "Deploy: $(fmt_time "$deploy_ms")"

  info "Cleaning up..."
  cfn_destroy >/dev/null 2>&1 || true

  CFN_SYNTH_MS=$synth_ms
  CFN_DEPLOY_MS=$deploy_ms
  CFN_TOTAL_MS=$((synth_ms + deploy_ms))

  echo ""
}

# ─── Results output ──────────────────────────────────────────────────────────

print_results() {
  local cdkd_synth_s cfn_synth_s cdkd_deploy_s cfn_deploy_s cdkd_total_s cfn_total_s
  local synth_speedup deploy_speedup total_speedup

  cdkd_synth_s=$(fmt_time "${CDKD_SYNTH_MS:-0}")
  cfn_synth_s=$(fmt_time "${CFN_SYNTH_MS:-0}")
  cdkd_deploy_s=$(fmt_time "${CDKD_DEPLOY_MS:-0}")
  cfn_deploy_s=$(fmt_time "${CFN_DEPLOY_MS:-0}")
  cdkd_total_s=$(fmt_time "${CDKD_TOTAL_MS:-0}")
  cfn_total_s=$(fmt_time "${CFN_TOTAL_MS:-0}")

  synth_speedup=$(calc_speedup "${CDKD_SYNTH_MS:-0}" "${CFN_SYNTH_MS:-0}")
  deploy_speedup=$(calc_speedup "${CDKD_DEPLOY_MS:-0}" "${CFN_DEPLOY_MS:-0}")
  total_speedup=$(calc_speedup "${CDKD_TOTAL_MS:-0}" "${CFN_TOTAL_MS:-0}")

  local output
  output=$(cat <<EOF
## Benchmark Results: $SCENARIO_LABEL

**Date**: $(date '+%Y-%m-%d %H:%M:%S')
**Region**: $AWS_REGION
**Scenario**: $SCENARIO

| Phase          | cdkd           | CloudFormation  | Speedup        |
|----------------|----------------|-----------------|----------------|
| Synthesis      | $cdkd_synth_s  | $cfn_synth_s    | $synth_speedup |
| Deploy (total) | $cdkd_deploy_s | $cfn_deploy_s   | $deploy_speedup|
| **Total**      | **$cdkd_total_s** | **$cfn_total_s** | **$total_speedup** |

### Environment

- Node.js: $(node --version)
- cdkd: $(node "$CDKD_BIN" --version 2>/dev/null || echo "dev")
- CDK CLI: $(cdk --version 2>/dev/null || echo "not installed")
EOF
)

  echo ""
  echo "================================================================"
  echo ""
  echo "$output"
  echo ""
  echo "================================================================"

  echo "$output" >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"
  info "Results saved to: $RESULTS_FILE"
}

print_single_results() {
  local tool=$1
  local synth_s deploy_s total_s

  if [[ "$tool" == "cdkd" ]]; then
    synth_s=$(fmt_time "${CDKD_SYNTH_MS:-0}")
    deploy_s=$(fmt_time "${CDKD_DEPLOY_MS:-0}")
    total_s=$(fmt_time "${CDKD_TOTAL_MS:-0}")
  else
    synth_s=$(fmt_time "${CFN_SYNTH_MS:-0}")
    deploy_s=$(fmt_time "${CFN_DEPLOY_MS:-0}")
    total_s=$(fmt_time "${CFN_TOTAL_MS:-0}")
  fi

  local output
  output=$(cat <<EOF
## Benchmark Results: $SCENARIO_LABEL - $tool only

**Date**: $(date '+%Y-%m-%d %H:%M:%S')
**Region**: $AWS_REGION
**Scenario**: $SCENARIO

| Phase          | $tool          |
|----------------|----------------|
| Synthesis      | $synth_s       |
| Deploy (total) | $deploy_s      |
| **Total**      | **$total_s**   |
EOF
)

  echo ""
  echo "================================================================"
  echo ""
  echo "$output"
  echo ""
  echo "================================================================"

  echo "$output" >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"
  info "Results saved to: $RESULTS_FILE"
}

# ─── Cleanup on exit ────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    warn "Benchmark interrupted. Cleaning up..."
    cdkd_destroy >/dev/null 2>&1 || true
    if [[ "$SKIP_CFN" != "true" ]]; then
      cfn_destroy >/dev/null 2>&1 || true
    fi
  fi
  exit $exit_code
}

trap cleanup INT TERM

# ─── Scenario run ────────────────────────────────────────────────────────────

run_scenario() {
  local scenario_name="$1"
  configure_scenario "$scenario_name"

  echo ""
  echo "============================================"
  echo "  cdkd vs CloudFormation Benchmark"
  echo "  Scenario: $SCENARIO_LABEL"
  echo "============================================"
  echo ""

  check_prerequisites

  CDKD_SYNTH_MS=0
  CDKD_DEPLOY_MS=0
  CDKD_TOTAL_MS=0
  CFN_SYNTH_MS=0
  CFN_DEPLOY_MS=0
  CFN_TOTAL_MS=0

  if [[ "$SKIP_CDKD" != "true" ]]; then
    for i in $(seq 1 "$RUNS"); do
      run_cdkd_benchmark "$i"
    done
  fi

  if [[ "$SKIP_CFN" != "true" ]]; then
    for i in $(seq 1 "$RUNS"); do
      run_cfn_benchmark "$i"
    done
  fi

  if [[ "$SKIP_CDKD" == "true" ]]; then
    print_single_results "CloudFormation"
  elif [[ "$SKIP_CFN" == "true" ]]; then
    print_single_results "cdkd"
  else
    print_results
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  RESULTS_FILE="$SCRIPT_DIR/results-$timestamp.md"
  DEPLOY_LOG="$SCRIPT_DIR/deploy-$timestamp.log"
  : > "$RESULTS_FILE"
  : > "$DEPLOY_LOG"

  if [[ "$SCENARIO" == "all" ]]; then
    SCENARIO="bench-sdk"
    run_scenario "bench-sdk"
    SCENARIO="bench-ccapi"
    run_scenario "bench-ccapi"
  else
    run_scenario "$SCENARIO"
  fi

  echo ""
  ok "Benchmark complete!"
  info "Results: $RESULTS_FILE"
  info "Deploy log (for debugging): $DEPLOY_LOG"
}

main "$@"
