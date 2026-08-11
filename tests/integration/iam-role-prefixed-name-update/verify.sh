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
# Phases (all three deploys intentionally omit -y — the absence of an
# auto-confirm flag is the regression guard: pre-fix Phase 2 hard-fails with
# the migration prompt's non-interactive error; post-fix it succeeds with no
# prompt):
#   1. Deploy baseline (role with 1 inline-policy statement). Capture RoleId.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds a 2nd statement) — an in-place
#      IAM update. Assert it succeeds WITHOUT -y, the RoleId is UNCHANGED (no
#      replacement), and the new statement reached AWS.
#   3. Re-deploy with CDKD_TEST_REMOVAL=true (keeps the phase-2 policy, DROPS
#      description + maxSessionDuration — issue #1160 iam-role batch). Assert
#      the live role resets to the CFn defaults ('' / 3600) instead of silently
#      keeping the old values (IAM UpdateRole merges absent fields).
#   4. Destroy + assert the role and cdkd state are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

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
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_role
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
echo "    role created, RoleId=${ROLE_ID_P1}"
DESC_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Description' --output text)"
MAX_P1="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.MaxSessionDuration' --output text)"
if [ "${DESC_P1}" != "cdkd f1160 removal-reset probe" ] || [ "${MAX_P1}" != "7200" ]; then
  echo "FAIL: expected Description='cdkd f1160 removal-reset probe' / MaxSessionDuration=7200 after Phase 1, got '${DESC_P1}' / '${MAX_P1}'" >&2
  exit 1
fi
echo "    description + maxSessionDuration set (7200)"
STMTS_P1="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text)"
if [ "${STMTS_P1}" != "1" ]; then
  echo "FAIL: expected 1 inline-policy statement after Phase 1, got ${STMTS_P1}" >&2
  exit 1
fi

# --- Phase 2: in-place UPDATE (NO -y — regression guard) --------------
echo "==> Phase 2: re-deploy adding an inline-policy statement (in-place, NO -y)"
# Pre-fix this hard-fails: "--no-prefix-user-supplied-names migration confirm
# prompt cannot run in a non-interactive environment. Pass --yes ...".
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P2="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_P1}" != "${ROLE_ID_P2}" ]; then
  echo "FAIL: role was REPLACED (RoleId ${ROLE_ID_P1} -> ${ROLE_ID_P2})" >&2
  exit 1
fi
echo "    role identity preserved (RoleId unchanged) — no replacement"

STMTS_P2="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name own \
  --query 'length(PolicyDocument.Statement)' --output text)"
if [ "${STMTS_P2}" != "2" ]; then
  echo "FAIL: expected 2 inline-policy statements after the in-place UPDATE, got ${STMTS_P2}" >&2
  exit 1
fi
echo "    in-place UPDATE reached AWS (inline policy now has 2 statements), no migration prompt"

# --- Phase 3: removal-reset (issue #1160 iam-role batch) ----------------
echo "==> Phase 3: re-deploy dropping description + maxSessionDuration (removal reset)"
CDKD_TEST_REMOVAL=true CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"

ROLE_ID_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_P1}" != "${ROLE_ID_P3}" ]; then
  echo "FAIL: role was REPLACED during the removal redeploy (RoleId ${ROLE_ID_P1} -> ${ROLE_ID_P3})" >&2
  exit 1
fi
# Cleared Description comes back as absent (text output 'None'); MaxSessionDuration
# must be back at the IAM/CFn default 3600 — pre-fix both silently kept the
# phase-1 values because UpdateRole merges absent input fields.
DESC_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Description' --output text)"
MAX_P3="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.MaxSessionDuration' --output text)"
if { [ "${DESC_P3}" != "None" ] && [ -n "${DESC_P3}" ]; } || [ "${MAX_P3}" != "3600" ]; then
  echo "FAIL: expected Description cleared / MaxSessionDuration=3600 after removal redeploy, got '${DESC_P3}' / '${MAX_P3}'" >&2
  exit 1
fi
echo "    removal reset reached AWS (description cleared, maxSessionDuration back to 3600), role identity preserved"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    role deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — in-place UPDATE of an IAM role whose name starts with the stack name is NOT blocked by a spurious prefix-migration replacement prompt"
