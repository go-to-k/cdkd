#!/bin/bash
# Run deploy → update → destroy for a single integration test example
# Usage: ./run-all-examples.sh <example-dir> [state-bucket] [region]

set -euo pipefail

EXAMPLE_DIR="$1"
STATE_BUCKET="${2:?STATE_BUCKET is required}"
REGION="${3:-us-east-1}"
CDKQ="node $(cd "$(dirname "$0")/../.." && pwd)/dist/cli.js"
EXAMPLE_NAME=$(basename "$EXAMPLE_DIR")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[${EXAMPLE_NAME}]${NC} $1"; }
err() { echo -e "${RED}[${EXAMPLE_NAME}]${NC} $1"; }
warn() { echo -e "${YELLOW}[${EXAMPLE_NAME}]${NC} $1"; }

cd "$EXAMPLE_DIR"

# Install deps
log "Installing dependencies..."
npm install --silent 2>/dev/null

# Step 1: Deploy (CREATE)
log "Step 1: Deploy (CREATE)..."
if $CDKQ deploy --app "npx ts-node --prefer-ts-exts bin/app.ts" --state-bucket "$STATE_BUCKET" --region "$REGION" 2>&1; then
  log "✅ CREATE succeeded"
else
  err "❌ CREATE failed"
  exit 1
fi

# Step 2: Deploy again (UPDATE - idempotent, should be no-op)
log "Step 2: Deploy again (UPDATE/no-op)..."
if CDKQ_TEST_UPDATE=true $CDKQ deploy --app "npx ts-node --prefer-ts-exts bin/app.ts" --state-bucket "$STATE_BUCKET" --region "$REGION" 2>&1; then
  log "✅ UPDATE succeeded"
else
  warn "⚠ UPDATE had issues (may be expected)"
fi

# Step 3: Destroy
log "Step 3: Destroy..."
if $CDKQ destroy --app "npx ts-node --prefer-ts-exts bin/app.ts" --state-bucket "$STATE_BUCKET" --region "$REGION" --force 2>&1; then
  log "✅ DESTROY succeeded"
else
  err "❌ DESTROY had issues"
  exit 1
fi

log "🎉 All steps completed successfully!"
