#!/usr/bin/env bash
# verify.sh — cdkd Cognito Identity Pool (CC-API) integ.
# Asserts the identity pool reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

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

STACK="CdkdCognitoIdentityPoolExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IDP_NAME="${STACK}_idp"
UP_NAME="${STACK}-up"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolve the identity pool id by its name (list is paginated; grep ours).
idp_id() {
  aws cognito-identity list-identity-pools --max-results 60 --region "${REGION}" \
    --query "IdentityPools[?IdentityPoolName=='${IDP_NAME}'].IdentityPoolId | [0]" --output text 2>/dev/null
}
up_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${UP_NAME}'].Id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  local id; id=$(idp_id)
  [ -n "${id}" ] && [ "${id}" != "None" ] && aws cognito-identity delete-identity-pool --identity-pool-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  local up; up=$(up_id)
  [ -n "${up}" ] && [ "${up}" != "None" ] && aws cognito-idp delete-user-pool --user-pool-id "${up}" --region "${REGION}" >/dev/null 2>&1 || true
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

ID=$(idp_id)
if [ -z "${ID}" ] || [ "${ID}" = "None" ]; then
  echo "FAIL: identity pool '${IDP_NAME}' not found on AWS after deploy" >&2
  exit 1
fi
echo "    OK: identity pool reached AWS (id: ${ID})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

REMAIN=$(idp_id)
if [ -n "${REMAIN}" ] && [ "${REMAIN}" != "None" ]; then
  echo "FAIL: identity pool '${IDP_NAME}' still exists after destroy (id: ${REMAIN})" >&2
  exit 1
fi
echo "    OK: identity pool gone"
UPREMAIN=$(up_id)
if [ -n "${UPREMAIN}" ] && [ "${UPREMAIN}" != "None" ]; then
  echo "FAIL: user pool '${UP_NAME}' still exists after destroy (id: ${UPREMAIN})" >&2
  exit 1
fi
echo "    OK: user pool gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> cognito-identity-pool test passed"
