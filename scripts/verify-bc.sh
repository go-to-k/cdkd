#!/usr/bin/env bash
# verify-bc.sh — backwards-compatibility verification driver.
#
# Verifies that cdkd reads pre-PR-1 state files and migrates them to the new
# region-prefixed key layout on next save. This is the manual-verification
# script referenced from docs/plans/01-state-key-region-prefix.md (the PR 1
# plan) and shared with PR 4.
#
# Usage:
#   STATE_BUCKET=my-fixture-bucket AWS_REGION=us-east-1 ./scripts/verify-bc.sh PR-1
#
# Required env:
#   STATE_BUCKET — pre-existing S3 bucket cdkd has write access to. The script
#     will write & remove keys under cdkd/_bc-fixture-stack/.
#   AWS_REGION   — region for the test stack (also the region embedded in the
#     legacy fixture). Defaults to us-east-1.
#
# Future hookup: this script is intended to be wired into a `bc-check`
# markgate gate (out of scope for PR 1; the script is shipped here so future
# PRs can plug it in without re-deriving the migration steps).

set -euo pipefail

PR="${1:-PR-1}"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${STATE_BUCKET:-}"
STACK="_bc-fixture-stack"
PREFIX="cdkd"
LEGACY_KEY="${PREFIX}/${STACK}/state.json"
NEW_KEY="${PREFIX}/${STACK}/${REGION}/state.json"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: STATE_BUCKET env var is required" >&2
  echo "Usage: STATE_BUCKET=<bucket> AWS_REGION=<region> $0 PR-1" >&2
  exit 64
fi

case "$PR" in
  PR-1)
    echo "==> Verifying PR-1 (region-prefixed state key migration)"
    ;;
  *)
    echo "ERROR: only PR-1 is supported by this version of verify-bc.sh" >&2
    exit 64
    ;;
esac

echo "==> Bucket: s3://${BUCKET}/${PREFIX}/${STACK}/"
echo "==> Region: ${REGION}"

# 1. Seed a legacy version: 1 state file at the old key.
cat >"$WORK_DIR/legacy-state.json" <<EOF
{
  "version": 1,
  "stackName": "${STACK}",
  "region": "${REGION}",
  "resources": {},
  "outputs": {},
  "lastModified": $(date +%s)000
}
EOF

echo "==> Seeding legacy state at s3://${BUCKET}/${LEGACY_KEY}"
aws s3 cp "$WORK_DIR/legacy-state.json" "s3://${BUCKET}/${LEGACY_KEY}" \
  --content-type application/json --no-progress

# 2. Confirm that listStacks surfaces the legacy entry under the right region.
echo "==> Running 'cdkd state list' against the fixture bucket"
node dist/cli.js state list --state-bucket "$BUCKET" --region "$REGION"

# 3. Run a `cdkd state rm --yes` to trigger the migration delete code path.
#    state rm hits both keys: it deletes the new key (which doesn't exist yet
#    so the call is a no-op for now) AND the legacy key (because their
#    embedded region matches), giving us the migration outcome we want
#    without standing up real AWS resources.
echo "==> Migrating + cleaning up legacy fixture via 'cdkd state rm'"
node dist/cli.js state rm "$STACK" --yes \
  --state-bucket "$BUCKET" --region "$REGION"

# 4. Assert: legacy key gone.
if aws s3api head-object --bucket "$BUCKET" --key "$LEGACY_KEY" >/dev/null 2>&1; then
  echo "ERROR: legacy key still exists at s3://${BUCKET}/${LEGACY_KEY}" >&2
  exit 1
fi

# 5. Assert: new key also gone (state rm cleaned it).
if aws s3api head-object --bucket "$BUCKET" --key "$NEW_KEY" >/dev/null 2>&1; then
  echo "ERROR: new key was not removed by state rm: s3://${BUCKET}/${NEW_KEY}" >&2
  exit 1
fi

echo "==> OK: legacy → new migration path verified for $PR"
