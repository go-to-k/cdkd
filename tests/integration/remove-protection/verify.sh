#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd destroy --remove-protection`.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdRemoveProtectionExample
#      (every resource created with deletion-protection ENABLED)
#   3. NEGATIVE: cdkd destroy --force (no --remove-protection)
#      -> expect non-zero exit; stack state must remain
#   4. cdkd state list  -> stack still listed (not stripped from state)
#   5. POSITIVE: cdkd destroy --remove-protection --force
#      -> expect exit 0
#   6. cdkd state list -> stack must be GONE
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
#
# This integ leaks expensive resources (ALB / EC2 / ASG) on a botched
# run — the cleanup trap re-attempts destroy WITH --remove-protection
# on any failure exit so a failing assertion does not orphan AWS
# resources.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdRemoveProtectionExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/remove-protection"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
pnpm --dir "${REPO_ROOT}" install
pnpm --dir "${REPO_ROOT}" run build

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# On failure, retry destroy with --remove-protection so we never leak
# expensive AWS resources. The trap is intentionally aggressive — the
# whole point of this integ is verifying the bypass path, so using it
# in cleanup is correct.
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy --remove-protection to clean up"
    ${CLI} destroy "${STACK}" --remove-protection \
      --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# ── NEGATIVE TEST ─────────────────────────────────────────────────
# Without --remove-protection cdkd must NOT silently strip protected
# resources. Every resource in the stack carries delete-protection in
# some form, so AWS will reject every per-resource delete and cdkd
# should surface that as PartialFailureError (exit 2 — see
# src/utils/error-handler.ts).
echo "[verify] step 3: cdkd destroy --force WITHOUT --remove-protection (expect non-zero)"
set +e
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
rc=$?
set -e
if [ "${rc}" -eq 0 ]; then
  echo "[verify] FAIL: bare destroy unexpectedly succeeded — protected resources were silently stripped."
  echo "[verify]       This is a regression in cdkd's --remove-protection gating."
  exit 1
fi
echo "[verify] step 3 ok: bare destroy rejected (exit ${rc})"

# State must still exist — destroy was rejected, not partially applied.
echo "[verify] step 4: cdkd state list (stack should still be listed)"
if ! ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state was stripped despite destroy failing"
  exit 1
fi
echo "[verify] step 4 ok: state preserved"

# ── POSITIVE TEST ─────────────────────────────────────────────────
echo "[verify] step 5: cdkd destroy --remove-protection --force (expect exit 0)"
${CLI} destroy "${STACK}" --remove-protection --state-bucket "${STATE_BUCKET}" --force

# State must be gone.
echo "[verify] step 6: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 6 ok: state cleared"

# AWS orphan verification is delegated to the parent agent's
# `/run-integ` flow (which runs `/cleanup` afterward). Inline orphan
# checks here would need per-service describe + tag-match logic that
# duplicates `/cleanup`'s coverage and risks false positives on
# tag-shape edge cases. The state-empty assertion above is the
# integ's own success signal; AWS-side orphan auditing belongs in
# `/cleanup`.

trap - EXIT
echo "[verify] PASS"
