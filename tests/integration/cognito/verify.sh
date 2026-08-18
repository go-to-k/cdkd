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
# Then, under CDKD_TEST_UPDATE=true, asserts the two MFA UPDATE transitions
# (issue #1925):
#   - MfaTransitionUserPool: a pool created with NO MfaConfiguration and NO
#     EnabledMfas is re-deployed with MfaConfiguration ON + SOFTWARE_TOKEN_MFA.
#     update() used to forward MfaConfiguration to UpdateUserPool ungated, which
#     runs BEFORE the SetUserPoolMfaConfig that enables the factor -- the same
#     "MFA required/optional with no factor enabled" rejection the create path
#     has always gated against. The fix applies that gate on update too.
#   - MfaDowngradeUserPool: a pool created with MFA OPTIONAL + a factor is
#     re-deployed with BOTH removed, leaving only its WebAuthn config. The
#     full-replace SetUserPoolMfaConfig then resets it to OFF -- template-is-truth
#     parity that is deliberately UNCHANGED -- and cdkd must ANNOUNCE the
#     downgrade naming the live value, instead of doing it silently.
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

# Resolve a pool by its AWS-assigned NAME, paginating ListUserPools.
#
# Assertions below look pools up THIS way rather than by cdkd's logical id: the
# logical id matching a name is a coincidence of this fixture, and reading the
# id back out of cdkd's own state would let a provider that never talked to AWS
# satisfy the assertion. Failures are tri-state like `gone_probe`: an API error
# hard-FAILs rather than being reported as "no such pool", which would read as a
# missing resource and send the reader hunting in the wrong place.
#
# `exit 1` inside the command substitution aborts the caller under `set -e`
# (the assignment inherits the subshell's status); `cleanup` runs under
# `set +eu`, where the same failure degrades to an empty result and the
# best-effort sweep simply skips.
pool_id_by_name() { # usage: pool_id_by_name <exact pool name>
  local want="$1" token="" out id rc
  if [ -z "${want}" ]; then
    echo "FAIL: pool_id_by_name called with an empty pool name" >&2
    return 1
  fi
  while :; do
    # Status captured explicitly rather than left to errexit: errexit is CLEARED
    # inside `$( )`, so in `V="$(pool_id_by_name ...)"` an intermediate failure
    # here would not abort the body and the empty result would read as "no such
    # pool" -- the gone-probe rule's failure mode one layer up (#1120).
    if [ -z "${token}" ]; then
      out="$(aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" --output json 2>&1)"; rc=$?
    else
      out="$(aws cognito-idp list-user-pools --max-results 60 --next-token "${token}" --region "${REGION}" --output json 2>&1)"; rc=$?
    fi
    if [ "${rc}" -ne 0 ]; then
      echo "FAIL: list-user-pools failed while resolving '${want}': ${out}" >&2
      return 1
    fi
    id="$(printf '%s' "${out}" | jq -r --arg n "${want}" '[.UserPools[] | select(.Name == $n) | .Id][0] // empty')"
    if [ -n "${id}" ]; then
      printf '%s' "${id}"
      return 0
    fi
    token="$(printf '%s' "${out}" | jq -r '.NextToken // empty')"
    [ -n "${token}" ] || return 0
  done
}

# Populated after the STATE_BUCKET / binary guards below. Empty until then, so
# a signal arriving during `npm install` leaves the name-based sweep a no-op
# rather than deleting a pool named "cdkd-test-mfa-transition-".
ACCOUNT_ID=""
UPDATE_LOG=""

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  # Seed from the caller's status BEFORE anything here can overwrite it, so a
  # signal trap that ran `(exit 130)` first still reports 130. Teardown itself
  # is unconditional -- rc never gates it -- so a lost status can never skip a
  # sweep; it is preserved only so the final exit code stays honest.
  local rc=$?
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -n "${UPDATE_LOG}" ]; then
    rm -f "${UPDATE_LOG}"
    UPDATE_LOG=""
  fi
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
  # Name-based sweep for the two CDKD_TEST_UPDATE pools. `state destroy` drops
  # cdkd's record, not the AWS resource, so a run that died between the update
  # deploy and the destroy phase would otherwise strand them -- and their names
  # are fixed, so the next run would collide instead of failing cleanly.
  if [ -n "${ACCOUNT_ID}" ]; then
    local stray
    for name in "cdkd-test-mfa-transition-${ACCOUNT_ID}" "cdkd-test-mfa-downgrade-${ACCOUNT_ID}"; do
      stray="$(pool_id_by_name "${name}")"
      if [ -n "${stray}" ] && [ "${stray}" != "None" ]; then
        aws cognito-idp delete-user-pool --user-pool-id "${stray}" --region "${REGION}" >/dev/null 2>&1 || true
      fi
    done
  fi
  set -eu
  return "${rc}"
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

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [ -z "${ACCOUNT_ID}" ] || [ "${ACCOUNT_ID}" = "None" ]; then
  echo "FAIL: could not resolve the AWS account id (needed to build the pool names)" >&2
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
# `env -u` so a CDKD_TEST_UPDATE inherited from the caller cannot silently make
# Phase 1 deploy the UPDATE arm, which would collapse both arms into one.
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
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

# --- Assertion 8: MFA update-arm baselines (issue #1925) --------------
# Both pools are resolved by their AWS-assigned NAME (see pool_id_by_name), so
# a provider that wrote cdkd state without reaching AWS cannot satisfy these.
TRANSITION_NAME="cdkd-test-mfa-transition-${ACCOUNT_ID}"
DOWNGRADE_NAME="cdkd-test-mfa-downgrade-${ACCOUNT_ID}"

TRANSITION_POOL_ID="$(pool_id_by_name "${TRANSITION_NAME}")"
if [ -z "${TRANSITION_POOL_ID}" ]; then
  echo "FAIL: no user pool named '${TRANSITION_NAME}' after Phase 1" >&2
  exit 1
fi
echo "    MFA-transition UserPool id: ${TRANSITION_POOL_ID}"

DOWNGRADE_POOL_ID="$(pool_id_by_name "${DOWNGRADE_NAME}")"
if [ -z "${DOWNGRADE_POOL_ID}" ]; then
  echo "FAIL: no user pool named '${DOWNGRADE_NAME}' after Phase 1" >&2
  exit 1
fi
echo "    MFA-downgrade UserPool id: ${DOWNGRADE_POOL_ID}"

# The transition pool starts with MFA genuinely OFF. Pinned so Phase 2's
# OFF -> ON assertion is a real transition rather than a value that was already
# there -- without this, a provider that ignored the update entirely could pass
# Phase 2 if the pool had somehow been created ON.
TRANSITION_MFA_BEFORE=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${TRANSITION_POOL_ID}" --region "${REGION}" --output json \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${TRANSITION_MFA_BEFORE}" != "OFF" ]; then
  echo "FAIL: MFA-transition pool starts at MfaConfiguration '${TRANSITION_MFA_BEFORE}', expected 'OFF' (the base arm declares neither MfaConfiguration nor EnabledMfas)" >&2
  exit 1
fi
echo "    OK: MFA-transition pool baseline MfaConfiguration == OFF"

# The downgrade pool starts with MFA really ON (OPTIONAL + a factor). Phase 2
# removes both from the template; this is the value the announcement must name.
DOWNGRADE_MFA_BEFORE=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${DOWNGRADE_POOL_ID}" --region "${REGION}" --output json)
DOWNGRADE_MFA_CONFIG_BEFORE=$(echo "${DOWNGRADE_MFA_BEFORE}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
DOWNGRADE_SOFTWARE_BEFORE=$(echo "${DOWNGRADE_MFA_BEFORE}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${DOWNGRADE_MFA_CONFIG_BEFORE}" != "OPTIONAL" ] || [ "${DOWNGRADE_SOFTWARE_BEFORE}" != "true" ]; then
  echo "FAIL: MFA-downgrade pool baseline is MfaConfiguration='${DOWNGRADE_MFA_CONFIG_BEFORE}' / SoftwareTokenMfaConfiguration.Enabled='${DOWNGRADE_SOFTWARE_BEFORE}', expected 'OPTIONAL' / 'true'" >&2
  echo "${DOWNGRADE_MFA_BEFORE}" | jq . >&2 || true
  exit 1
fi
echo "    OK: MFA-downgrade pool baseline MfaConfiguration == OPTIONAL with SOFTWARE_TOKEN_MFA enabled"

# --- Phase 2: update arm (issue #1925) --------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (MFA update transitions)"
UPDATE_LOG="$(mktemp -t cdkd-cognito-update.XXXXXX)"
# `tee` keeps the output visible in the run log while also making the
# announcement assertion below possible. Under `set -o pipefail` a failed
# deploy still aborts the script -- which is itself the item-1 assertion.
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${UPDATE_LOG}"

# --- Assertion 9: MFA enabled on update (issue #1925 item 1) ----------
# Reaching this line is already most of the assertion: before the fix, update()
# sent MfaConfiguration=ON to UpdateUserPool while the pool still had no factor
# enabled, and the deploy above would have exited non-zero (`set -o pipefail`
# aborts here).
#
# MEASURED us-east-1 2026-08-18, so this branch is not reasoning from the docs:
# `UpdateUserPool --mfa-configuration ON` against a pool with no factor enabled
# is REJECTED with `InvalidParameterException: Cannot turn MFA functionality ON,
# once the user pool has been created.`, while the same call AFTER
# SetUserPoolMfaConfig enabled software-token is ACCEPTED (as is OPTIONAL with a
# factor enabled). Note the message reads like a blanket prohibition and is not
# one -- the rejection is conditional on the factor existing, which is exactly
# what the gate reorders around.
TRANSITION_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${TRANSITION_POOL_ID}" --region "${REGION}" --output json)
TRANSITION_MFA_CONFIG=$(echo "${TRANSITION_MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
# Exactly ON: OPTIONAL is what the no-value default produces for a pool that
# declares a factor, so accepting it could not tell the template's explicit
# value from a fired default.
if [ "${TRANSITION_MFA_CONFIG}" != "ON" ]; then
  echo "FAIL: after the update, MFA-transition pool MfaConfiguration is '${TRANSITION_MFA_CONFIG}', expected exactly 'ON' (the update arm's explicit value)" >&2
  echo "${TRANSITION_MFA}" | jq . >&2 || true
  exit 1
fi
TRANSITION_SOFTWARE=$(echo "${TRANSITION_MFA}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${TRANSITION_SOFTWARE}" != "true" ]; then
  echo "FAIL: after the update, MFA-transition pool SoftwareTokenMfaConfiguration.Enabled is '${TRANSITION_SOFTWARE}', expected 'true' (the factor must be enabled in the same call that sets MfaConfiguration)" >&2
  echo "${TRANSITION_MFA}" | jq . >&2 || true
  exit 1
fi
echo "    OK: MFA-transition pool went OFF -> ON with SOFTWARE_TOKEN_MFA enabled"

# --- Assertion 10: the downgrade is ANNOUNCED (issue #1925 item 3) ----
# The load-bearing half. Before the fix there was no message at all, so this
# grep is what discriminates -- the wire behavior below is unchanged by design.
if ! grep -q "the template declares no MfaConfiguration" "${UPDATE_LOG}"; then
  echo "FAIL: the update turned MFA off on ${DOWNGRADE_POOL_ID} without announcing it (no 'the template declares no MfaConfiguration' warning in the deploy output)" >&2
  exit 1
fi
# The message must name the value it is turning OFF, not just that it defaulted.
# A warning that cannot say what was lost is the one this assertion exists to
# reject. (It does NOT prove the read is ordered before UpdateUserPool: MEASURED
# us-east-1 2026-08-18, UpdateUserPool does not reset MfaConfiguration when the
# field is omitted, so either ordering would report OPTIONAL here. The ordering
# is defensive only -- see readLiveMfaConfiguration.)
if ! grep -q "live value was OPTIONAL" "${UPDATE_LOG}"; then
  echo "FAIL: the downgrade warning does not name the live value (expected 'live value was OPTIONAL' in the deploy output)" >&2
  grep -i "MfaConfiguration" "${UPDATE_LOG}" >&2 || true
  exit 1
fi
echo "    OK: the undeclared downgrade to OFF was announced, naming the live OPTIONAL"

# --- Assertion 11: the downgrade actually happened, unchanged ---------
# Template-is-truth parity is DELIBERATELY not changed by #1925 item 3: the
# announcement is additive. Asserting the wire result pins that -- if a future
# change made the warning also PRESERVE the live value, this fails and the
# behavior change has to be deliberate.
DOWNGRADE_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${DOWNGRADE_POOL_ID}" --region "${REGION}" --output json)
DOWNGRADE_MFA_CONFIG=$(echo "${DOWNGRADE_MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${DOWNGRADE_MFA_CONFIG}" != "OFF" ]; then
  echo "FAIL: after the update, MFA-downgrade pool MfaConfiguration is '${DOWNGRADE_MFA_CONFIG}', expected 'OFF' (the template dropped MfaConfiguration, and SetUserPoolMfaConfig is a full replace)" >&2
  echo "${DOWNGRADE_MFA}" | jq . >&2 || true
  exit 1
fi
# The WebAuthn config is what kept this update routed through
# SetUserPoolMfaConfig at all, so it must survive -- otherwise the arm proves
# nothing about the OFF default and only shows the block being dropped.
DOWNGRADE_WA_RP=$(echo "${DOWNGRADE_MFA}" \
  | jq -r 'if (.WebAuthnConfiguration|has("RelyingPartyId")) then .WebAuthnConfiguration.RelyingPartyId else "null" end')
if [ "${DOWNGRADE_WA_RP}" != "downgrade.cdkd.example.com" ]; then
  echo "FAIL: after the update, MFA-downgrade pool WebAuthnConfiguration.RelyingPartyId is '${DOWNGRADE_WA_RP}', expected 'downgrade.cdkd.example.com'" >&2
  exit 1
fi
echo "    OK: MFA-downgrade pool went OPTIONAL -> OFF with its WebAuthn config intact"

rm -f "${UPDATE_LOG}"
UPDATE_LOG=""

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
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

assert_gone "MFA-transition UserPool ${TRANSITION_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${TRANSITION_POOL_ID}" --region "${REGION}"
echo "    OK: MFA-transition UserPool is gone"

assert_gone "MFA-downgrade UserPool ${DOWNGRADE_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${DOWNGRADE_POOL_ID}" --region "${REGION}"
echo "    OK: MFA-downgrade UserPool is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cognito test passed (SignInPolicy #1380 / UserPoolTier / EnabledMfas(SOFTWARE_TOKEN) / WebAuthn* backfill (EMAIL_OTP-as-MFA unit-only) / MfaConfiguration defaulting both arms OFF+OPTIONAL #1920 / MFA update transitions: enable-on-update + announced undeclared downgrade #1925 + clean destroy)"
