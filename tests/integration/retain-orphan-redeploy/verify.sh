#!/usr/bin/env bash
# verify.sh — cdkd retain-orphan-redeploy integ test (issue #2902).
#
# The reported loop: a rollback leaves a `DeletionPolicy: Retain` resource in
# AWS and drops its state record (CloudFormation semantics, deliberate), and
# cdkd's generated names carry no random component — so the next deploy asks
# AWS for a name the orphan still holds, fails, rolls back, and repeats. The
# reporter's only way out was hand-deleting resources through the AWS API.
#
# PASS CONDITION is not "the deploy succeeds" — a redeploy over an orphan MUST
# fail. What this asserts is that cdkd NAMES the cause and that the remedy it
# prints actually WORKS:
#
#   1. deploy               — a role under a cdkd-GENERATED name
#   2. state orphan         — drop the record, leave the role in AWS
#   3. redeploy             — must FAIL, and must print the diagnosis + command
#   4. run THAT command     — parsed out of the message, not hand-written
#   5. redeploy             — must now SUCCEED (the loop is broken)
#   6. destroy + gone probe
#
# Step 4 is the point. A message naming a remedy whose precondition the code
# never checks is issue #2610's defect class, so this runs the command the
# message emitted rather than a command the fixture author believed in.
#
# `cdkd state orphan` is used rather than an injected rollback: it reaches the
# same end state (resource live, record gone) deterministically, where a
# failure injection's timing would decide what got created.
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

export AWS_PAGER=""

STACK="CdkdRetainOrphanRedeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved post-deploy; used by assertions + cleanup.
ROLE_NAME=""
ROLE_LOGICAL_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders: the whole point of this fixture is a state record that
  # no longer names the live role, so `state destroy` can legitimately miss it.
  if [ -n "${ROLE_NAME}" ]; then
    for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" \
      --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1
    done
    for a in $(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${a}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET is required" >&2
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (role under a cdkd-GENERATED name)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
# Resolved from state by TYPE, never hardcoded: CDK appends a path-derived hash
# to the construct id (`OrphanedRole` synthesizes as `OrphanedRole<8 hex>`), so
# a literal would break the moment the construct or stack id changes -- and it
# would break as a confusing "not found" rather than as a clear failure. The
# stack declares exactly one role, which is what makes the by-type read exact.
ROLE_LOGICAL_ID=$(echo "${STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .key] | first // ""')
ROLE_NAME=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ -z "${ROLE_LOGICAL_ID}" ] || [ -z "${ROLE_NAME}" ] || [ "${ROLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the role's logical id / physical id from state" >&2
  echo "${STATE}" | jq '{resources: (.resources | keys)}' >&2
  exit 1
fi
echo "    logicalId=${ROLE_LOGICAL_ID} role=${ROLE_NAME}"

# The diagnosis under test only fires for a name cdkd DERIVED, so a fixture
# whose role came out template-named would assert nothing. Pin the premise.
case "${ROLE_NAME}" in
  "${STACK}-${ROLE_LOGICAL_ID}"*) ;;
  *)
    echo "FAIL: '${ROLE_NAME}' is not the cdkd derivation of ${STACK}/${ROLE_LOGICAL_ID} —" >&2
    echo "      the collision diagnosis under test would not fire for it" >&2
    exit 1
    ;;
esac

# --- Phase 2: manufacture the orphan -----------------------------------
echo "==> Phase 2: drop the state record, leave the role in AWS"
node "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "FAIL: 'cdkd state orphan' deleted the AWS role — it must only drop state" >&2
  exit 1
fi
echo "    OK: role still live, state record gone"

# --- Phase 3: the redeploy must FAIL, and must explain itself ----------
echo "==> Phase 3: redeploy over the orphan (must fail WITH a diagnosis)"
REDEPLOY_LOG="$(mktemp)"
if node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${REDEPLOY_LOG}" 2>&1; then
  echo "FAIL: the redeploy SUCCEEDED over a live orphan — expected an already-exists failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi

# Sentinel: distinguishes "cdkd said nothing" from "this grep stopped parsing".
# The AWS sentence is the independent marker — it is not the string under test,
# and a redeploy that reached AWS at all must carry it.
if ! grep -q "already exists" "${REDEPLOY_LOG}"; then
  echo "FAIL: the redeploy failed WITHOUT an already-exists error — wrong failure" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
if ! grep -q "is one cdkd DERIVED from" "${REDEPLOY_LOG}"; then
  echo "FAIL: cdkd printed no orphan diagnosis for a collision on its own generated name." >&2
  echo "      The AWS error IS present, so this is a missing/reworded diagnosis," >&2
  echo "      not an absent condition (issue #2902)." >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: redeploy failed AND named the cause"

# --- Phase 4: run the command the MESSAGE printed ----------------------
echo "==> Phase 4: follow cdkd's own remedy"
# Parsed out of the message rather than hand-written: this is what makes the
# assertion about the ADVICE and not about a command the author believed in.
IMPORT_ARG=$(grep -o -- "--resource ${ROLE_LOGICAL_ID}=[A-Za-z0-9_+=,.@-]*" "${REDEPLOY_LOG}" | head -1)
if [ -z "${IMPORT_ARG}" ]; then
  echo "FAIL: the diagnosis carried no '--resource ${ROLE_LOGICAL_ID}=<name>' argument to run" >&2
  cat "${REDEPLOY_LOG}" >&2
  exit 1
fi
echo "    running: cdkd import ${STACK} ${IMPORT_ARG} --yes"
# shellcheck disable=SC2086 # IMPORT_ARG is two shell words by construction
node "${LOCAL_DIST}" import "${STACK}" ${IMPORT_ARG} \
  --state-bucket "${STATE_BUCKET}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
REIMPORTED=$(echo "${STATE}" | jq -r --arg k "${ROLE_LOGICAL_ID}" '.resources[$k].physicalId // ""')
if [ "${REIMPORTED}" != "${ROLE_NAME}" ]; then
  echo "FAIL: after the advised import, state names '${REIMPORTED}', expected '${ROLE_NAME}'" >&2
  exit 1
fi
echo "    OK: the advised command adopted the orphan back into state"

# --- Phase 5: the loop is broken ---------------------------------------
echo "==> Phase 5: redeploy again (must now SUCCEED)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the deploy still fails after following cdkd's own remedy — the remedy does not work" >&2
  exit 1
fi
echo "    OK: deploy succeeds; the redeploy loop is broken"

# --- Phase 6: destroy --------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
echo "    OK: role gone"

# Nothing left for the cleanup trap to delete.
ROLE_NAME=""

cleanup
trap - EXIT INT TERM

echo ""
echo "=== PASS: retain-orphan-redeploy integ (orphan diagnosed, advised remedy verified to recover) ==="
