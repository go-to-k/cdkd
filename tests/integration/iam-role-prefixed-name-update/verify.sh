#!/usr/bin/env bash
# verify.sh — cdkd in-place UPDATE of an IAM role whose user-supplied name
# starts with the stack name (`${stackName}-role`).
#
# Regression for the `--no-prefix-user-supplied-names` migration-check false
# positive: the check blindly stripped the `${stackName}-` prefix from the
# recorded physicalId, mis-predicted a rename (`MyStack-role` -> `role`), and
# raised a spurious REPLACEMENT confirm prompt that BLOCKED every routine
# in-place UPDATE in non-interactive runs. Post-fix the check only flags a
# genuine legacy auto-prefix (`physicalId === ${stackName}-${userName}`), so a
# verbatim user name that merely starts with the stack name is left alone.
#
# Phases (BOTH deploys intentionally omit -y — the absence of an auto-confirm
# flag is the regression guard: pre-fix Phase 2 hard-fails with the migration
# prompt's non-interactive error; post-fix it succeeds with no prompt):
#   1. Deploy baseline (role with 1 inline-policy statement). Capture RoleId.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds a 2nd statement) — an in-place
#      IAM update. Assert it succeeds WITHOUT -y, the RoleId is UNCHANGED (no
#      replacement), and the new statement reached AWS.
#   3. Destroy + assert the role and cdkd state are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdIamRolePrefixedNameUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="${STACK}-role"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

delete_role() {
  for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
    --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_role
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (NO -y) ---------------------------------
echo "==> Phase 1: deploy baseline role (name starts with stack name)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
echo "    role created, RoleId=${ROLE_ID_P1}"
STMTS_P1="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text 2>/dev/null || echo 0)"
if [ "${STMTS_P1}" != "1" ]; then
  echo "FAIL: expected 1 inline-policy statement after Phase 1, got ${STMTS_P1}" >&2
  exit 1
fi

# --- Phase 2: in-place UPDATE (NO -y — regression guard) --------------
echo "==> Phase 2: re-deploy adding an inline-policy statement (in-place, NO -y)"
# Pre-fix this hard-fails: "--no-prefix-user-supplied-names migration confirm
# prompt cannot run in a non-interactive environment. Pass --yes ...".
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P2="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_P1}" != "${ROLE_ID_P2}" ]; then
  echo "FAIL: role was REPLACED (RoleId ${ROLE_ID_P1} -> ${ROLE_ID_P2})" >&2
  exit 1
fi
echo "    role identity preserved (RoleId unchanged) — no replacement"

STMTS_P2="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text 2>/dev/null || echo 0)"
if [ "${STMTS_P2}" != "2" ]; then
  echo "FAIL: expected 2 inline-policy statements after the in-place UPDATE, got ${STMTS_P2}" >&2
  exit 1
fi
echo "    in-place UPDATE reached AWS (inline policy now has 2 statements), no migration prompt"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: role ${ROLE_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    role deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — in-place UPDATE of an IAM role whose name starts with the stack name is NOT blocked by a spurious prefix-migration replacement prompt"
