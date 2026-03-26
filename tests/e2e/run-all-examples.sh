#!/bin/bash
# DEPRECATED: This script has been merged into run-e2e.sh.
# Use: STATE_BUCKET=my-bucket ./run-e2e.sh [example-dir]
#
# This wrapper is kept for backward compatibility and will be removed in a future release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="${1:?Usage: $0 <example-dir> [state-bucket] [region]}"
export STATE_BUCKET="${2:?STATE_BUCKET is required}"
export AWS_REGION="${3:-us-east-1}"

exec "${SCRIPT_DIR}/run-e2e.sh" "${EXAMPLE_DIR}"
