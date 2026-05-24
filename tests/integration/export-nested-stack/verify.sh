#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd export` recursive
# nested-stack state-tree walker (Issue #464 PR B1.5 — exercises
# PR B1's `buildCdkdStateStackTree` + the orchestrator hard-error
# path against a REAL cdkd-state nested tree).
#
# This fixture intentionally verifies the HARD-ERROR / DRY-RUN-WARN
# path, not actual CFn submission. The CFn-side
# `--include-nested-stacks` IMPORT changeset submission is deferred
# to a follow-up PR per 2 AWS-API constraints discovered 2026-05-24
# (see docs/design/464-nested-stacks-export-import.md §4 "AWS-API
# design constraints"). Once the follow-up PR lands with a working
# submission path, this verify.sh should be updated to assert the
# success path instead.
#
# Flow:
#   1. Build cdkd (so `dist/cli.js` is fresh).
#   2. `cdkd deploy` the parent + nested child (cdkd state under
#      both v6 keys: `cdkd/<Parent>/<region>/state.json` AND
#      `cdkd/<Parent>~Child/<region>/state.json`).
#   3. Run `cdkd export <Parent> --dry-run` → expect WARN
#      mentioning "PR B2" + the leaf-first migration scope, exit 0,
#      cdkd state unchanged.
#   4. Run `cdkd export <Parent> --yes` → expect hard-ERROR with
#      the SAME message, exit non-zero, cdkd state unchanged.
#   5. `cdkd destroy <Parent> --force` to clean up.
#   6. Assert: both SSM parameters are gone; both cdkd state files
#      are gone.
#
# Trap cleanup unconditionally tears down whatever state remains on
# any failure path so leftover orphans never persist.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/export-nested-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"

# CDK uses fixed stack names (the env above doesn't propagate
# per-run suffix into the synth template). We pin the names here and
# rely on the trap cleanup + post-PASS deletion to keep the AWS
# account clean across re-runs.
PARENT_STACK="CdkdExportNestedStack"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

PARENT_STATE_KEY="cdkd/${PARENT_STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${PARENT_STACK}~Child/${REGION}/state.json"

echo "[verify] region=${REGION} parent=${PARENT_STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  # If cdkd state survived (export was tested but destroy not yet
  # called), issue cdkd destroy to remove the AWS resources + state.
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" \
      --key "${PARENT_STATE_KEY}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${PARENT_STACK}"
    ${CLI} destroy "${PARENT_STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force 2>&1 || true
  fi
  # Belt-and-braces: scrub any leftover SSM parameters / cdkd state
  # even when destroy already cleaned up.
  for p in $(aws ssm describe-parameters --region "${REGION}" \
    --parameter-filters "Key=Name,Option=Contains,Values=CdkdExportNestedStack" \
    --query 'Parameters[].Name' --output text 2>/dev/null || true); do
    echo "[verify] cleanup: aws ssm delete-parameter ${p}"
    aws ssm delete-parameter --name "${p}" --region "${REGION}" || true
  done
  aws s3 rm "s3://${STATE_BUCKET}/${PARENT_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT INT TERM

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

echo "[verify] step 2: install fixture deps (aws-cdk-lib for synth)"
# pnpm at this repo's root ignores per-fixture package.json under
# tests/integration/* (no workspace registration), so the fixture's
# aws-cdk-lib + aws-cdk deps come from the global vp-managed npm
# environment instead. CDK CLI is `cdk` (global), and aws-cdk-lib is
# resolved via Node's parent-directory lookup against the repo-root
# install. No `pnpm install` round-trip needed.
echo "[verify] step 2 ok: using global cdk ($(which cdk))"

echo "[verify] step 3: pre-flight orphan scan"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${PARENT_STATE_KEY} already exists — clean up first"
  exit 1
fi

echo "[verify] step 4: cdkd deploy parent + nested child"
# cdkd deploy populates the v6 state keys for both stacks. The
# recursive NestedStackProvider.create writes the child's state
# under cdkd/<Parent>~Child/<region>/state.json with parentStack /
# parentLogicalId / parentRegion populated.
(cd "${TEST_DIR}" && ${CLI} deploy "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose)
echo "[verify] step 4 ok: cdkd deploy completed"

echo "[verify] step 5: assert both v6 state files exist before export"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null
echo "[verify] step 5 ok: parent + child state present"

echo "[verify] step 6: cdkd export ${PARENT_STACK} --dry-run (expect WARN + exit 0)"
DRY_RUN_OUT=$(cd "${TEST_DIR}" && ${CLI} export "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --dry-run 2>&1)
echo "${DRY_RUN_OUT}" | tail -20
# Assertion: output mentions "PR B2" (the deferred-submission marker)
# AND lists the leaf-first migration scope (both v6 state-key paths).
if ! echo "${DRY_RUN_OUT}" | grep -q "PR B2"; then
  echo "[verify] FAIL: --dry-run output does not mention 'PR B2'"
  exit 1
fi
if ! echo "${DRY_RUN_OUT}" | grep -q "${PARENT_STATE_KEY}"; then
  echo "[verify] FAIL: --dry-run output does not list parent state key"
  exit 1
fi
if ! echo "${DRY_RUN_OUT}" | grep -q "${CHILD_STATE_KEY}"; then
  echo "[verify] FAIL: --dry-run output does not list child state key"
  exit 1
fi
echo "[verify] step 6 ok: --dry-run warned with PR B2 pointer + leaf-first scope"

echo "[verify] step 7: cdkd export ${PARENT_STACK} --yes (expect hard-ERROR + exit non-zero)"
set +e
REAL_RUN_OUT=$( (cd "${TEST_DIR}" && ${CLI} export "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes) 2>&1 )
REAL_RC=$?
set -e
echo "${REAL_RUN_OUT}" | tail -20
if [ "${REAL_RC}" -eq 0 ]; then
  echo "[verify] FAIL: real-run unexpectedly succeeded (exit 0) — PR B2 submission is supposedly deferred"
  exit 1
fi
if ! echo "${REAL_RUN_OUT}" | grep -q "PR B2"; then
  echo "[verify] FAIL: real-run hard-error does not mention 'PR B2'"
  exit 1
fi
echo "[verify] step 7 ok: real-run hard-errored with PR B2 pointer (exit ${REAL_RC})"

echo "[verify] step 8: assert cdkd state files are STILL present (export was a no-op)"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null
echo "[verify] step 8 ok: both state files preserved (failed export did not mutate state)"

echo "[verify] step 9: cdkd destroy ${PARENT_STACK} --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${PARENT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  --verbose)
echo "[verify] step 9 ok: cdkd destroy exited 0"

echo "[verify] step 10: assert AWS resources are GONE"
for p in $(aws ssm describe-parameters --region "${REGION}" \
  --parameter-filters "Key=Name,Option=Contains,Values=CdkdExportNestedStack" \
  --query 'Parameters[].Name' --output text 2>/dev/null || true); do
  echo "[verify] FAIL: leftover SSM parameter ${p}"
  exit 1
done
echo "[verify] step 10 ok: SSM parameters gone"

echo "[verify] step 11: assert cdkd state files GONE (both parent and child)"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: parent cdkd state still present at s3://${STATE_BUCKET}/${PARENT_STATE_KEY}"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: child cdkd state still present at s3://${STATE_BUCKET}/${CHILD_STATE_KEY}"
  exit 1
fi
echo "[verify] step 11 ok: both cdkd state files cleared"

trap - EXIT INT TERM
echo "[verify] PASS"
