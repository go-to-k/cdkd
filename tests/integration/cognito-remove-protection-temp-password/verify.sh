#!/usr/bin/env bash
# verify.sh — `cdkd destroy --remove-protection` on a Cognito user pool whose
# password policy sets TemporaryPasswordValidityDays (issue #6548).
#
# DescribeUserPool returns the deprecated
# AdminCreateUserConfig.UnusedAccountValidityDays on every pool; on this pool
# AWS refuses an UpdateUserPool carrying it ("Please use
# TemporaryPasswordValidityDays in PasswordPolicy instead of
# UnusedAccountValidityDays"). cdkd's DeletionProtection flip echoes the pool's
# settings back, so before the fix it fell back to the DeletionProtection-only
# write, which keepOriginal makes AWS refuse too ("All attributes in
# AttributesRequireVerificationBeforeUpdate must exist in
# AutoVerifiedAttributes"): the guard stayed on and the destroy failed.
#
# Phases:
#   1. Deploy. Preconditions: the guard is ACTIVE and the pool reads back
#      UnusedAccountValidityDays (the member AWS refuses), plus the settings a
#      DeletionProtection-only write would reset.
#   2. An out-of-band hosted-UI domain makes DeleteUserPool refuse TERMINALLY.
#      destroy --remove-protection must fail ON THAT DOMAIN (so the flip-off
#      landed), and the compensation must turn the guard back ON (the re-enable
#      echo carries the same member) with every setting kept.
#   3. Remove the domain; destroy --remove-protection: exit 0, pool and state gone.

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdCognitoRemoveProtectionTempPasswordExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="${STACK}-pool"
# We are in the fixture dir, three levels below the repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
OOB_DOMAIN=""
DESTROY_LOG=""

pool_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text
}

pool_field() { # usage: pool_field <pool id> <JMESPath under UserPool>
  aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "$1" \
    --query "UserPool.$2" --output text
}

# DeleteUserPool keeps refusing until the pool no longer reports the domain.
wait_pool_domain_gone() { # usage: wait_pool_domain_gone <pool id>
  local left=""
  for _ in $(seq 1 24); do
    left="$(pool_field "$1" Domain)" || return 1
    if [ "${left}" = "None" ] || [ -z "${left}" ]; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] ${1} still reports domain '${left}' 2 min after delete-user-pool-domain" >&2
  return 1
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -n "${DESTROY_LOG}" ] && rm -f "${DESTROY_LOG}"
  local pid
  pid="$(pool_id 2>/dev/null)"
  if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
    # The domain as the POOL reports it, so one a killed earlier run left is
    # found too (OOB_DOMAIN is empty then).
    local domain
    domain="$(pool_field "${pid}" Domain 2>/dev/null)"
    [ "${domain}" = "None" ] && domain=""
    [ -n "${domain:-${OOB_DOMAIN}}" ] && aws cognito-idp delete-user-pool-domain --region "${REGION}" \
      --domain "${domain:-${OOB_DOMAIN}}" --user-pool-id "${pid}" >/dev/null 2>&1 && wait_pool_domain_gone "${pid}"
    # The guard off with the verification settings kept: a write omitting
    # AutoVerifiedAttributes is refused on this pool.
    aws cognito-idp update-user-pool --region "${REGION}" --user-pool-id "${pid}" \
      --deletion-protection INACTIVE --auto-verified-attributes email \
      --user-attribute-update-settings AttributesRequireVerificationBeforeUpdate=email >/dev/null 2>&1
    aws cognito-idp delete-user-pool --region "${REGION}" --user-pool-id "${pid}" >/dev/null 2>&1
  fi
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PID="$(pool_id)"
if [ -z "${PID}" ] || [ "${PID}" = "None" ]; then
  echo "FAIL: user pool '${POOL_NAME}' not found after deploy" >&2
  exit 1
fi

# Each precondition is the value the phase-2 assertion reads again, so a
# post-destroy match is not vacuous.
expect_field() { # usage: expect_field <label> <JMESPath> <expected>
  local got
  got="$(pool_field "${PID}" "$2")" || { echo "FAIL: could not read $2 of ${PID}" >&2; exit 1; }
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $1 -- ${2} is '${got}', expected '$3'" >&2
    exit 1
  fi
}
check_settings() { # usage: check_settings <label>
  expect_field "$1" 'DeletionProtection' 'ACTIVE'
  expect_field "$1" 'Policies.PasswordPolicy.TemporaryPasswordValidityDays' '3'
  expect_field "$1" 'AdminCreateUserConfig.AllowAdminCreateUserOnly' 'True'
  expect_field "$1" 'join(`,`, AutoVerifiedAttributes)' 'email'
  expect_field "$1" 'join(`,`, UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate)' 'email'
  expect_field "$1" 'DeviceConfiguration.ChallengeRequiredOnNewDevice' 'True'
}
check_settings "precondition"
# The member the pre-fix echo carried and AWS refused on this pool.
expect_field "precondition" 'AdminCreateUserConfig.UnusedAccountValidityDays' '3'
echo "    OK: pool ${PID} is protected and reads back UnusedAccountValidityDays"

echo "==> Phase 2: destroy --remove-protection with an out-of-band domain (delete refused terminally)"
# A hosted-UI prefix: lowercase letters, digits and hyphens, globally unique.
# Random rather than account-derived: it is publicly resolvable while it exists.
OOB_DOMAIN="cdkd-rptp-$(date +%s)-$(openssl rand -hex 4)"
aws cognito-idp create-user-pool-domain --region "${REGION}" \
  --domain "${OOB_DOMAIN}" --user-pool-id "${PID}" >/dev/null
DESTROY_LOG="$(mktemp)"
if node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --force --remove-protection --verbose >"${DESTROY_LOG}" 2>&1; then
  echo "FAIL: destroy succeeded although the pool has a domain" >&2
  exit 1
fi
# Sentinel: cdkd's own delete-failure line. Without it the two greps below
# would read a reworded or absent failure as "the flip worked".
if ! grep -q 'Failed to delete Cognito User Pool' "${DESTROY_LOG}"; then
  echo "FAIL: no 'Failed to delete Cognito User Pool' line in the destroy output" >&2
  tail -40 "${DESTROY_LOG}" >&2
  exit 1
fi
# cdkd's own warn when the flip-off was refused (the pre-fix failure, observed
# on 0.356.0), then AWS's own refusal texts (debug lines under --verbose,
# both observed): the domain refusal proves the flip-off landed; the
# protection refusal ("The user pool cannot be deleted because deletion
# protection is activated.") is the pre-fix delete failure.
if grep -q 'DeletionProtection was left on' "${DESTROY_LOG}"; then
  echo "FAIL: cdkd could not turn DeletionProtection off (issue #6548)" >&2
  grep -E 'UpdateUserPool|DeletionProtection' "${DESTROY_LOG}" >&2 || true
  exit 1
fi
if grep -q 'deletion protection is activated' "${DESTROY_LOG}"; then
  echo "FAIL: DeleteUserPool was refused for deletion protection: the flip-off did not land (issue #6548)" >&2
  grep -E 'UpdateUserPool|DeletionProtection' "${DESTROY_LOG}" >&2 || true
  exit 1
fi
if ! grep -q 'has a domain configured' "${DESTROY_LOG}"; then
  echo "FAIL: DeleteUserPool was not refused for the out-of-band domain" >&2
  tail -40 "${DESTROY_LOG}" >&2
  exit 1
fi
# The compensation's re-enable echoes the same member: the guard must be back
# ON (a refused re-enable would leave it OFF), and nothing reset.
check_settings "after the compensated failure"
echo "    OK: the flip-off landed, the delete failed on the domain, and the guard is back on with every setting kept"

echo "==> Phase 3: remove the domain, destroy --remove-protection"
aws cognito-idp delete-user-pool-domain --region "${REGION}" --domain "${OOB_DOMAIN}" --user-pool-id "${PID}" >/dev/null
wait_pool_domain_gone "${PID}"
OOB_DOMAIN=""
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --remove-protection

assert_gone "user pool ${PID} still exists after destroy" \
  aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "${PID}"
echo "    OK: user pool gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> cognito-remove-protection-temp-password test passed (--remove-protection flips and restores the guard on a pool with a temporary-password validity)"
