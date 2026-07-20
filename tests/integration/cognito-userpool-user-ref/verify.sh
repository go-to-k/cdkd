#!/usr/bin/env bash
# verify.sh — cdkd Cognito UserPoolUser compound-id Ref regression integ.
#
# Asserts that `{Ref: <UserPoolUser>}` resolves to the bare `<username>` (not the
# compound `<userPoolId>|<username>`), proven end-to-end by a
# CfnUserPoolUserToGroupAttachment whose `username` consumes the user's Ref:
# without the fix the attachment's create fails (AWS rejects the compound
# username); with the fix the user lands in the group. Then destroys clean.

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

STACK="CdkdCognitoUserPoolUserRefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="${STACK}-pool"
USERNAME="admin"
GROUP="admins"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

pool_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  local pid; pid=$(pool_id)
  [ -n "${pid}" ] && [ "${pid}" != "None" ] && aws cognito-idp delete-user-pool --user-pool-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PID=$(pool_id)
[ -z "${PID}" ] || [ "${PID}" = "None" ] && { echo "FAIL: user pool '${POOL_NAME}' not found after deploy" >&2; exit 1; }
echo "    OK: user pool reached AWS (id: ${PID})"

# The proof: the user is a member of the group. This can only be true if the
# UserToGroupAttachment created successfully, which required {Ref: User} to
# resolve to the bare 'admin' (a compound '<poolId>|admin' is rejected by AWS).
INGROUP=$(aws cognito-idp admin-list-groups-for-user --user-pool-id "${PID}" --username "${USERNAME}" --region "${REGION}" \
  --query "Groups[?GroupName=='${GROUP}'].GroupName | [0]" --output text 2>/dev/null)
if [ "${INGROUP}" != "${GROUP}" ]; then
  echo "FAIL: user '${USERNAME}' is not in group '${GROUP}' (UserPoolUser Ref leaked the compound id?)" >&2
  exit 1
fi
echo "    OK: user '${USERNAME}' is in group '${GROUP}' -> {Ref: UserPoolUser} resolved to the bare username"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

REMAIN=$(pool_id)
if [ -n "${REMAIN}" ] && [ "${REMAIN}" != "None" ]; then
  echo "FAIL: user pool '${POOL_NAME}' still exists after destroy (id: ${REMAIN})" >&2
  exit 1
fi
echo "    OK: user pool gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> cognito-userpool-user-ref test passed (UserPoolUser Ref resolves to bare username; clean destroy)"
