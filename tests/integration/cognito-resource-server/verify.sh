#!/usr/bin/env bash
# verify.sh — cdkd Cognito resource-server compound-id Ref integ test.
#
# Regression guard for the bug-hunt finding (2026-06-28): the Cognito
# UserPool-child family (UserPoolResourceServer / UserPoolGroup /
# UserPoolDomain) has no SDK provider and routes through Cloud Control, whose
# physical id is the compound `<userPoolId>|<child>`. CFn `Ref` of these returns
# only the trailing `<child>` segment, but cdkd's intrinsic resolver returned
# the whole compound id until UserPoolResourceServer/Group/IdentityProvider/
# Domain were added to REF_RETURNS_SEGMENT_AFTER_PIPE.
#
# The load-bearing assertion: the UserPoolClient's AllowedOAuthScopes resolves to
# `api/read` (the resource-server identifier `api` + scope `read`), NOT the
# compound `<userPoolId>|api/read` which Cognito rejects with
# "Invalid scope requested" at client-create time. Without the fix this deploy
# FAILS at the client and never reaches the assertions.
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

STACK="CognitoResourceServerStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

POOL_ID=$(echo "${STATE}" | jq -r '.outputs.UserPoolId // empty')
CLIENT_ID=$(echo "${STATE}" | jq -r '.outputs.ClientId // empty')
if [ -z "${POOL_ID}" ] || [ -z "${CLIENT_ID}" ]; then
  echo "FAIL: UserPoolId / ClientId output missing from state" >&2
  exit 1
fi
echo "    UserPool id: ${POOL_ID}"
echo "    Client id:   ${CLIENT_ID}"

# --- Assertion 1: AllowedOAuthScopes == api/read (the compound-id Ref fix) ---
SCOPES=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "${POOL_ID}" --client-id "${CLIENT_ID}" --region "${REGION}" \
  --query 'UserPoolClient.AllowedOAuthScopes' --output json)
SCOPE_COUNT=$(echo "${SCOPES}" | jq 'length')
SCOPE_VAL=$(echo "${SCOPES}" | jq -r '.[0] // empty')
if [ "${SCOPE_COUNT}" != "1" ] || [ "${SCOPE_VAL}" != "api/read" ]; then
  echo "FAIL: AllowedOAuthScopes is '${SCOPES}', expected exactly ['api/read']" >&2
  echo "      (a compound '<userPoolId>|api/read' here means the resource-server Ref leaked the CC compound id)" >&2
  exit 1
fi
echo "    OK: AllowedOAuthScopes == [\"api/read\"] (resource-server Ref resolved to the bare identifier)"

# --- Assertion 2: the resource server exists with identifier 'api' ----
RS_ID=$(aws cognito-idp list-resource-servers \
  --user-pool-id "${POOL_ID}" --max-results 10 --region "${REGION}" \
  --query "ResourceServers[?Identifier=='api'].Identifier | [0]" --output text)
if [ "${RS_ID}" != "api" ]; then
  echo "FAIL: resource server with identifier 'api' not found (got '${RS_ID}')" >&2
  exit 1
fi
echo "    OK: resource server 'api' present"

# --- Assertion 3: the group exists ------------------------------------
GROUP=$(aws cognito-idp list-groups \
  --user-pool-id "${POOL_ID}" --region "${REGION}" \
  --query "Groups[?GroupName=='${STACK}-admins'].GroupName | [0]" --output text)
if [ "${GROUP}" != "${STACK}-admins" ]; then
  echo "FAIL: group '${STACK}-admins' not found (got '${GROUP}')" >&2
  exit 1
fi
echo "    OK: group '${STACK}-admins' present"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "UserPool ${POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}"
echo "    OK: UserPool is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cognito-resource-server test passed (compound-id Ref -> bare scope + clean destroy)"
