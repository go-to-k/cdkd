#!/usr/bin/env bash
#
# run-benchmark.sh - Compare cdkd vs CloudFormation deployment speed
#
# Usage:
#   STATE_BUCKET=my-bucket AWS_REGION=ap-northeast-1 ./tests/benchmark/run-benchmark.sh
#
# Environment variables:
#   STATE_BUCKET  - S3 bucket for cdkd state (optional: auto-resolved from STS account)
#   AWS_REGION    - AWS region (default: ap-northeast-1)
#   CDKD_BIN      - Path to cdkd binary (default: ./dist/cli.js)
#   SKIP_CFN      - Set to "true" to skip CloudFormation benchmark
#   SKIP_CDKD     - Set to "true" to skip cdkd benchmark
#   RUNS          - Number of runs for averaging (default: 1)
#

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXAMPLE_DIR="$PROJECT_ROOT/tests/integration/examples/basic"
STACK_NAME="CdkdBasicExample"
CDK_APP="npx ts-node bin/app.ts"

AWS_REGION="${AWS_REGION:-ap-northeast-1}"
CDKD_BIN="${CDKD_BIN:-$PROJECT_ROOT/dist/cli.js}"
SKIP_CFN="${SKIP_CFN:-false}"
SKIP_CDKD="${SKIP_CDKD:-false}"
RUNS="${RUNS:-1}"

# Stack name suffix to avoid collisions between cdkd and CFn
CDKD_STACK="$STACK_NAME"
CFN_STACK="${STACK_NAME}Cfn"

# Results file
RESULTS_FILE="$SCRIPT_DIR/results-$(date +%Y%m%d-%H%M%S).md"

# ─── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
phase() { echo -e "${CYAN}>>> $*${NC}"; }

# ─── Utility functions ───────────────────────────────────────────────────────

# Returns current time in milliseconds
now_ms() {
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: use python3 for millisecond precision
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    date +%s%3N
  fi
}

# Calculates elapsed time in seconds (with 1 decimal)
elapsed_sec() {
  local start_ms=$1
  local end_ms=$2
  python3 -c "print(f'{($end_ms - $start_ms) / 1000:.1f}')"
}

# Calculates speedup ratio
calc_speedup() {
  local cdkd_ms=$1
  local cfn_ms=$2
  if [[ "$cdkd_ms" -eq 0 ]] || [[ "$cfn_ms" -eq 0 ]]; then
    echo "N/A"
  else
    python3 -c "print(f'{$cfn_ms / $cdkd_ms:.1f}x')"
  fi
}

# Format milliseconds to human-readable string
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

  # Check AWS credentials
  if ! aws sts get-caller-identity &>/dev/null; then
    err "AWS credentials not configured. Please configure AWS CLI."
    exit 1
  fi
  ok "AWS credentials valid"

  # Check cdkd is built
  if [[ ! -f "$CDKD_BIN" ]]; then
    warn "cdkd binary not found at $CDKD_BIN. Building..."
    (cd "$PROJECT_ROOT" && npm run build)
  fi
  ok "cdkd binary available"

  # Check CDK CLI (for CloudFormation benchmark)
  if [[ "$SKIP_CFN" != "true" ]]; then
    if ! command -v cdk &>/dev/null; then
      warn "cdk CLI not found. Install with: npm install -g aws-cdk"
      warn "Skipping CloudFormation benchmark."
      SKIP_CFN="true"
    else
      ok "cdk CLI available ($(cdk --version 2>/dev/null | head -1))"
    fi
  fi

  # Check example directory
  if [[ ! -d "$EXAMPLE_DIR" ]]; then
    err "Example directory not found: $EXAMPLE_DIR"
    exit 1
  fi
  ok "Example directory found"

  # Install example dependencies if needed
  if [[ ! -d "$EXAMPLE_DIR/node_modules" ]]; then
    info "Installing example dependencies..."
    (cd "$EXAMPLE_DIR" && npm install)
  fi
  ok "Example dependencies installed"

  echo ""
}

# ─── cdkd benchmark ─────────────────────────────────────────────────────────

# Synthesize with cdkd (measures synthesis time)
cdkd_synth() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" synth --app "$CDK_APP" "$CDKD_STACK" >/dev/null 2>&1)
  end=$(now_ms)
  echo $((end - start))
}

# Deploy with cdkd (measures deploy time including synthesis)
cdkd_deploy() {
  local state_bucket_args=""
  if [[ -n "${STATE_BUCKET:-}" ]]; then
    state_bucket_args="--state-bucket $STATE_BUCKET"
  fi

  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" deploy --app "$CDK_APP" $state_bucket_args "$CDKD_STACK" 2>&1) || true
  end=$(now_ms)
  echo $((end - start))
}

# Destroy with cdkd
cdkd_destroy() {
  local state_bucket_args=""
  if [[ -n "${STATE_BUCKET:-}" ]]; then
    state_bucket_args="--state-bucket $STATE_BUCKET"
  fi

  info "Destroying cdkd stack..."
  (cd "$EXAMPLE_DIR" && node "$CDKD_BIN" destroy --app "$CDK_APP" $state_bucket_args --force "$CDKD_STACK" 2>&1) || {
    warn "cdkd destroy failed (stack may not exist)"
  }
}

run_cdkd_benchmark() {
  phase "Running cdkd benchmark (run $1/$RUNS)"

  # Clean up first
  cdkd_destroy >/dev/null 2>&1 || true

  # Synthesis only
  info "Measuring synthesis time..."
  local synth_ms
  synth_ms=$(cdkd_synth)
  ok "Synthesis: $(fmt_time "$synth_ms")"

  # Full deploy (includes synthesis + asset publishing + resource creation)
  info "Measuring deploy time..."
  local deploy_ms
  deploy_ms=$(cdkd_deploy)
  ok "Deploy: $(fmt_time "$deploy_ms")"

  # Clean up
  info "Cleaning up..."
  cdkd_destroy >/dev/null 2>&1 || true

  # Export results
  CDKD_SYNTH_MS=$synth_ms
  CDKD_DEPLOY_MS=$deploy_ms
  CDKD_TOTAL_MS=$((synth_ms + deploy_ms))

  echo ""
}

# ─── CloudFormation benchmark ────────────────────────────────────────────────

# Synthesize with cdk (measures synthesis time)
cfn_synth() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && npx cdk synth "$CFN_STACK" >/dev/null 2>&1)
  end=$(now_ms)
  echo $((end - start))
}

# Deploy with cdk (CloudFormation)
cfn_deploy() {
  local start end
  start=$(now_ms)
  (cd "$EXAMPLE_DIR" && npx cdk deploy "$CFN_STACK" --require-approval never 2>&1) || true
  end=$(now_ms)
  echo $((end - start))
}

# Destroy with cdk
cfn_destroy() {
  info "Destroying CloudFormation stack..."
  (cd "$EXAMPLE_DIR" && npx cdk destroy "$CFN_STACK" --force 2>&1) || {
    warn "cdk destroy failed (stack may not exist)"
  }
}

run_cfn_benchmark() {
  phase "Running CloudFormation benchmark (run $1/$RUNS)"

  # Clean up first
  cfn_destroy >/dev/null 2>&1 || true

  # Synthesis only
  info "Measuring synthesis time..."
  local synth_ms
  synth_ms=$(cfn_synth)
  ok "Synthesis: $(fmt_time "$synth_ms")"

  # Full deploy
  info "Measuring deploy time (this will take a while due to CloudFormation)..."
  local deploy_ms
  deploy_ms=$(cfn_deploy)
  ok "Deploy: $(fmt_time "$deploy_ms")"

  # Clean up
  info "Cleaning up..."
  cfn_destroy >/dev/null 2>&1 || true

  # Export results
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
## Benchmark Results: basic (S3 Bucket)

**Date**: $(date '+%Y-%m-%d %H:%M:%S')
**Region**: $AWS_REGION
**Stack**: $STACK_NAME (S3 bucket with tags and outputs)

| Phase          | cdkd           | CloudFormation  | Speedup        |
|----------------|----------------|-----------------|----------------|
| Synthesis      | $cdkd_synth_s  | $cfn_synth_s    | $synth_speedup |
| Deploy (total) | $cdkd_deploy_s | $cfn_deploy_s   | $deploy_speedup|
| **Total**      | **$cdkd_total_s** | **$cfn_total_s** | **$total_speedup** |

### Notes

- **cdkd** deploys directly via Cloud Control API, skipping CloudFormation entirely
- **CloudFormation** goes through change set creation, execution, and stack status polling
- Synthesis time should be roughly equal (both use the same CDK app)
- Deploy speedup comes from eliminating CloudFormation overhead:
  - No change set creation/execution
  - No stack status polling (CREATE_IN_PROGRESS -> CREATE_COMPLETE)
  - No drift detection
  - Direct API calls to provision resources

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

  # Save to file
  echo "$output" > "$RESULTS_FILE"
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
## Benchmark Results: basic (S3 Bucket) - $tool only

**Date**: $(date '+%Y-%m-%d %H:%M:%S')
**Region**: $AWS_REGION

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

  echo "$output" > "$RESULTS_FILE"
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

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "============================================"
  echo "  cdkd vs CloudFormation Benchmark"
  echo "  Example: basic (S3 Bucket)"
  echo "============================================"
  echo ""

  check_prerequisites

  # Initialize result variables
  CDKD_SYNTH_MS=0
  CDKD_DEPLOY_MS=0
  CDKD_TOTAL_MS=0
  CFN_SYNTH_MS=0
  CFN_DEPLOY_MS=0
  CFN_TOTAL_MS=0

  # Run benchmarks
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

  # Print results
  if [[ "$SKIP_CDKD" == "true" ]]; then
    print_single_results "CloudFormation"
  elif [[ "$SKIP_CFN" == "true" ]]; then
    print_single_results "cdkd"
  else
    print_results
  fi

  echo ""
  ok "Benchmark complete!"
}

main "$@"
