#!/usr/bin/env bash
# verify.sh — cdkd Cognito::UserPool #609 backfill integ test.
#
# Asserts that the L2 TestUserPool's Policies.SignInPolicy (passwordless
# first-auth factors, issue #1380) lands on AWS after `cdkd deploy`, and that
# the BackfillUserPool (an L1 CfnUserPool) lands the issue #609
# backfill properties:
#   - UserPoolTier                  -> DescribeUserPool.UserPool.UserPoolTier
#   - EnabledMfas (SOFTWARE_TOKEN_MFA)
#                                   -> GetUserPoolMfaConfig (per-factor blocks)
#   - WebAuthnRelyingPartyID/UserVerification
#                                   -> GetUserPoolMfaConfig.WebAuthnConfiguration
# Also asserts BOTH arms of the MfaConfiguration defaulting rule (issue #1920):
#   - PasskeyOnlyUserPool: a WebAuthn pool with NO MFA factor and NO
#     MfaConfiguration must deploy at all (cdkd used to send OPTIONAL, which
#     AWS rejects with no factor enabled) and land as OFF, matching CFn.
#   - FactorDefaultUserPool: a pool that DECLARES a factor with no
#     MfaConfiguration must still land as OPTIONAL -- the inverse regression,
#     where the fix would silently disable MFA on a pool that asked for it.
# Then asserts the destroy path removes the pools and the state file.
#
# All four properties route through the SDK CognitoUserPoolProvider (the
# template sets no silent-drop top-level property), and the MFA-config family
# is applied via the post-create SetUserPoolMfaConfig control-plane call.
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

STACK="CognitoStack"
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
    # `state destroy` rejects `--force`; the confirmation skip flag is `--yes`.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
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

POOL_ID=$(echo "${STATE}" | jq -r '.outputs.BackfillUserPoolId // empty')
if [ -z "${POOL_ID}" ]; then
  echo "FAIL: BackfillUserPoolId output missing from state" >&2
  exit 1
fi
echo "    Backfill UserPool id: ${POOL_ID}"

# --- Assertion 0: SignInPolicy on the L2 pool (issue #1380) -----------
# The L2 TestUserPool sets signInPolicy (PASSWORD + EMAIL_OTP). Before the
# #1380 fix the provider forwarded only Policies.PasswordPolicy, so the
# deployed pool silently fell back to the PASSWORD-only default.
L2_POOL_ID=$(echo "${STATE}" | jq -r '.outputs.UserPoolId // empty')
if [ -z "${L2_POOL_ID}" ]; then
  echo "FAIL: UserPoolId output missing from state" >&2
  exit 1
fi
FACTORS=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${L2_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors' --output json)
if ! echo "${FACTORS}" | jq -e 'index("EMAIL_OTP") != null and index("PASSWORD") != null' >/dev/null; then
  echo "FAIL: SignInPolicy.AllowedFirstAuthFactors is ${FACTORS}, expected to contain PASSWORD and EMAIL_OTP (SignInPolicy dropped — issue #1380)" >&2
  exit 1
fi
echo "    OK: SignInPolicy.AllowedFirstAuthFactors == ${FACTORS}"

# --- Assertion 1: UserPoolTier (DescribeUserPool) ---------------------
TIER=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${POOL_ID}" --region "${REGION}" \
  --query 'UserPool.UserPoolTier' --output text)
if [ "${TIER}" != "ESSENTIALS" ]; then
  echo "FAIL: UserPool.UserPoolTier is '${TIER}', expected 'ESSENTIALS'" >&2
  exit 1
fi
echo "    OK: UserPoolTier == ESSENTIALS"

# --- Assertion 2..5: MFA config (GetUserPoolMfaConfig) ----------------
MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${POOL_ID}" --region "${REGION}" --output json)

# MfaConfiguration MUST be ON/OPTIONAL (not OFF). SetUserPoolMfaConfig is a
# full-replace: if cdkd omitted MfaConfiguration the pool would reset to OFF and
# the per-factor sub-blocks below would be silently dropped. This is the
# load-bearing assertion guarding the #609-review blocker fix.
MFA_CONFIG=$(echo "${MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
# Pinned to the EXACT templated value, not "ON or OPTIONAL": the pool declares
# ON, while OPTIONAL is what the no-value default would produce for a pool with
# a factor. Accepting either could not tell a threaded explicit value from a
# fired default, so the slack is what made this assertion non-discriminating.
if [ "${MFA_CONFIG}" != "ON" ]; then
  echo "FAIL: MfaConfiguration is '${MFA_CONFIG}', expected exactly 'ON' (the template's explicit value; OPTIONAL here would mean the explicit value was dropped and the default fired)" >&2
  echo "${MFA}" | jq . >&2 || true
  exit 1
fi
echo "    OK: MfaConfiguration == ${MFA_CONFIG}"

# SOFTWARE_TOKEN_MFA factor enabled.
SOFTWARE_ENABLED=$(echo "${MFA}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${SOFTWARE_ENABLED}" != "true" ]; then
  echo "FAIL: SoftwareTokenMfaConfiguration.Enabled is '${SOFTWARE_ENABLED}', expected 'true' (SOFTWARE_TOKEN_MFA not enabled)" >&2
  echo "${MFA}" | jq . >&2 || true
  exit 1
fi
echo "    OK: SOFTWARE_TOKEN_MFA enabled"

# NOTE: EMAIL_OTP + EmailAuthenticationMessage/Subject are NOT asserted here —
# AWS rejects EmailMfaConfiguration unless the pool uses a real SES sender
# (EmailSendingAccount=DEVELOPER + verified identity), which a portable
# automated integ cannot provision. Those props stay unit-test-only; the
# provider wiring is correct and exercised by the unit suite.

# WebAuthn config.
WA_RP=$(echo "${MFA}" \
  | jq -r 'if (.WebAuthnConfiguration|has("RelyingPartyId")) then .WebAuthnConfiguration.RelyingPartyId else "null" end')
WA_UV=$(echo "${MFA}" \
  | jq -r 'if (.WebAuthnConfiguration|has("UserVerification")) then .WebAuthnConfiguration.UserVerification else "null" end')
if [ "${WA_RP}" != "auth.cdkd.example.com" ]; then
  echo "FAIL: WebAuthnConfiguration.RelyingPartyId is '${WA_RP}', expected 'auth.cdkd.example.com' (WebAuthnRelyingPartyID not wired)" >&2
  exit 1
fi
if [ "${WA_UV}" != "preferred" ]; then
  echo "FAIL: WebAuthnConfiguration.UserVerification is '${WA_UV}', expected 'preferred' (WebAuthnUserVerification not wired)" >&2
  exit 1
fi
echo "    OK: WebAuthnRelyingPartyID + WebAuthnUserVerification landed"

# --- Assertion 6: passkey-only pool defaults to OFF (issue #1920) -----
# The deploy above is itself most of this assertion: before the fix, cdkd sent
# MfaConfiguration=OPTIONAL for this pool, AWS rejected the
# SetUserPoolMfaConfig call, and the post-create atomicity path deleted the
# pool — so Phase 1 failed outright and never reached here.
PASSKEY_POOL_ID=$(echo "${STATE}" | jq -r '.outputs.PasskeyOnlyUserPoolId // empty')
if [ -z "${PASSKEY_POOL_ID}" ]; then
  echo "FAIL: PasskeyOnlyUserPoolId output missing from state" >&2
  exit 1
fi
echo "    Passkey-only UserPool id: ${PASSKEY_POOL_ID}"

PASSKEY_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${PASSKEY_POOL_ID}" --region "${REGION}" --output json)

# CloudFormation's default for MfaConfiguration is OFF. Anything else here
# means cdkd invented a value the template never asked for.
PASSKEY_MFA_CONFIG=$(echo "${PASSKEY_MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${PASSKEY_MFA_CONFIG}" != "OFF" ]; then
  echo "FAIL: passkey-only pool MfaConfiguration is '${PASSKEY_MFA_CONFIG}', expected 'OFF' (CloudFormation's default for an omitted MfaConfiguration — issue #1920)" >&2
  echo "${PASSKEY_MFA}" | jq . >&2 || true
  exit 1
fi
echo "    OK: passkey-only MfaConfiguration == OFF"

# The WebAuthn block must still land — OFF must not have cost us the config
# the template DID ask for.
PASSKEY_WA_RP=$(echo "${PASSKEY_MFA}" \
  | jq -r 'if (.WebAuthnConfiguration|has("RelyingPartyId")) then .WebAuthnConfiguration.RelyingPartyId else "null" end')
PASSKEY_WA_UV=$(echo "${PASSKEY_MFA}" \
  | jq -r 'if (.WebAuthnConfiguration|has("UserVerification")) then .WebAuthnConfiguration.UserVerification else "null" end')
if [ "${PASSKEY_WA_RP}" != "passkey.cdkd.example.com" ]; then
  echo "FAIL: passkey-only WebAuthnConfiguration.RelyingPartyId is '${PASSKEY_WA_RP}', expected 'passkey.cdkd.example.com'" >&2
  exit 1
fi
if [ "${PASSKEY_WA_UV}" != "required" ]; then
  echo "FAIL: passkey-only WebAuthnConfiguration.UserVerification is '${PASSKEY_WA_UV}', expected 'required'" >&2
  exit 1
fi
echo "    OK: passkey-only WebAuthn config landed under MfaConfiguration OFF"

# --- Assertion 7: factor pool defaults to OPTIONAL (issue #1920) ------
# The inverse of assertion 6, and the direction that actually matters for
# security: a pool that DECLARES a factor but no MfaConfiguration must still
# land as OPTIONAL. If the defaulting rule ever over-reaches to OFF here, MFA
# would be silently disabled on a pool whose template asked for it.
FACTOR_POOL_ID=$(echo "${STATE}" | jq -r '.outputs.FactorDefaultUserPoolId // empty')
if [ -z "${FACTOR_POOL_ID}" ]; then
  echo "FAIL: FactorDefaultUserPoolId output missing from state" >&2
  exit 1
fi
echo "    Factor-default UserPool id: ${FACTOR_POOL_ID}"

FACTOR_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${FACTOR_POOL_ID}" --region "${REGION}" --output json)

FACTOR_MFA_CONFIG=$(echo "${FACTOR_MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${FACTOR_MFA_CONFIG}" != "OPTIONAL" ]; then
  echo "FAIL: factor-default pool MfaConfiguration is '${FACTOR_MFA_CONFIG}', expected 'OPTIONAL' (a declared MFA factor must not deploy with MFA disabled — issue #1920)" >&2
  echo "${FACTOR_MFA}" | jq . >&2 || true
  exit 1
fi

FACTOR_SOFTWARE=$(echo "${FACTOR_MFA}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${FACTOR_SOFTWARE}" != "true" ]; then
  echo "FAIL: factor-default pool SoftwareTokenMfaConfiguration.Enabled is '${FACTOR_SOFTWARE}', expected 'true'" >&2
  echo "${FACTOR_MFA}" | jq . >&2 || true
  exit 1
fi
echo "    OK: factor-default MfaConfiguration == OPTIONAL with SOFTWARE_TOKEN_MFA enabled"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "Backfill UserPool ${POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}"
echo "    OK: Backfill UserPool is gone"

assert_gone "Passkey-only UserPool ${PASSKEY_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${PASSKEY_POOL_ID}" --region "${REGION}"
echo "    OK: Passkey-only UserPool is gone"

assert_gone "Factor-default UserPool ${FACTOR_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${FACTOR_POOL_ID}" --region "${REGION}"
echo "    OK: Factor-default UserPool is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cognito test passed (SignInPolicy #1380 / UserPoolTier / EnabledMfas(SOFTWARE_TOKEN) / WebAuthn* backfill (EMAIL_OTP-as-MFA unit-only) / MfaConfiguration defaulting both arms OFF+OPTIONAL #1920 closed + clean destroy)"
