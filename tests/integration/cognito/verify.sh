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
#   - PolicyRemovalUserPool (issue #1979): a pool created with both Policies
#     sub-keys is re-deployed with SignInPolicy REMOVED (plus a companion
#     autoVerifiedAttributes change proving UpdateUserPool fired). No wire
#     input can express the removal (UpdateUserPool preserves an omitted
#     sub-key, issue #1968) and CloudFormation is the same no-op on the
#     identical edit (measured us-east-1 2026-09-02), so the assertions are
#     RETENTION of the live sign-in policy plus the announcement naming the
#     sub-key -- the pre-fix behavior was the same no-op with no announcement.
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
# The MFA pre-flight refusal arms (issues #1975 / #1977) live in their OWN
# stack: those arms need an UPDATE deploy that FAILS, while ${STACK}'s
# CDKD_TEST_UPDATE phase needs one that SUCCEEDS. See
# lib/cognito-preflight-stack.ts for why they cannot share a deploy.
PREFLIGHT_STACK="CognitoPreflightStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PREFLIGHT_STATE_KEY="cdkd/${PREFLIGHT_STACK}/${REGION}/state.json"

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
PREFLIGHT_LOG=""

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
  if [ -n "${PREFLIGHT_LOG}" ]; then
    rm -f "${PREFLIGHT_LOG}"
    PREFLIGHT_LOG=""
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
  # Same treatment for the pre-flight stack (#1975 / #1977). Its own key, and
  # its own `state destroy` rc gate -- a shared rc would let one stack's failure
  # suppress the other's object sweep. The rollback journal is swept explicitly
  # because this stack's phases deliberately FAIL a deploy, which is exactly
  # when a journal is written; `cdkd destroy` removes it on the happy path, but
  # cleanup also runs on the paths where destroy never got there.
  local preflight_destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${PREFLIGHT_STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
    preflight_destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${preflight_destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${PREFLIGHT_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PREFLIGHT_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PREFLIGHT_STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  # Name-based sweep for the two CDKD_TEST_UPDATE pools. `state destroy` drops
  # cdkd's record, not the AWS resource, so a run that died between the update
  # deploy and the destroy phase would otherwise strand them -- and their names
  # are fixed, so the next run would collide instead of failing cleanly.
  # The pre-flight pools (#1975 / #1977) are swept the same way and for a
  # sharper reason: two of this stack's phases END in a FAILED deploy on
  # purpose, so a run killed between them leaves pools behind that `state
  # destroy` would orphan rather than delete.
  if [ -n "${ACCOUNT_ID}" ]; then
    local stray
    for name in "cdkd-test-mfa-transition-${ACCOUNT_ID}" "cdkd-test-mfa-downgrade-${ACCOUNT_ID}" \
      "cdkd-test-policy-removal-${ACCOUNT_ID}" \
      "cdkd-test-mfa-preflight-off-${ACCOUNT_ID}" "cdkd-test-mfa-preflight-signin-${ACCOUNT_ID}" \
      "cdkd-test-mfa-preflight-optional-${ACCOUNT_ID}" "cdkd-test-mfa-preflight-webauthn-${ACCOUNT_ID}"; do
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

# --- Assertion 8b: policy-removal baseline (issue #1979) --------------
# Baseline-live rule: the retention assertion in Phase 2 is meaningless unless
# the sub-key demonstrably reached AWS first. Also pin the companion property's
# BEFORE state (no auto-verified attributes), so Phase 2's ["email"] readback
# proves the update call fired rather than reading back a pre-existing value.
POLICY_REMOVAL_NAME="cdkd-test-policy-removal-${ACCOUNT_ID}"
POLICY_REMOVAL_POOL_ID="$(pool_id_by_name "${POLICY_REMOVAL_NAME}")"
if [ -z "${POLICY_REMOVAL_POOL_ID}" ]; then
  echo "FAIL: no user pool named '${POLICY_REMOVAL_NAME}' after Phase 1" >&2
  exit 1
fi
echo "    Policy-removal UserPool id: ${POLICY_REMOVAL_POOL_ID}"

POLICY_REMOVAL_BEFORE=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${POLICY_REMOVAL_POOL_ID}" --region "${REGION}" --output json)
PR_FACTORS_BEFORE=$(echo "${POLICY_REMOVAL_BEFORE}" \
  | jq -c '.UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors // []')
if ! echo "${PR_FACTORS_BEFORE}" | jq -e 'index("EMAIL_OTP") != null and index("PASSWORD") != null' >/dev/null; then
  echo "FAIL: policy-removal pool baseline SignInPolicy.AllowedFirstAuthFactors is ${PR_FACTORS_BEFORE}, expected to contain PASSWORD and EMAIL_OTP (the base arm declares both)" >&2
  exit 1
fi
PR_AUTOVERIFY_BEFORE=$(echo "${POLICY_REMOVAL_BEFORE}" \
  | jq -c '.UserPool.AutoVerifiedAttributes // []')
if [ "${PR_AUTOVERIFY_BEFORE}" != "[]" ]; then
  echo "FAIL: policy-removal pool baseline AutoVerifiedAttributes is ${PR_AUTOVERIFY_BEFORE}, expected none (the base arm declares none; the update arm's ['email'] is the fired-call companion)" >&2
  exit 1
fi
echo "    OK: policy-removal pool baseline has SignInPolicy live and no auto-verified attributes"

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
#
# BOUND to this pool's id. The warning is emitted as `UserPool <id>: ...`, and
# this stack deploys seven pools whose MFA arms differ, so an unbound grep would
# be satisfied by another pool's message and this assertion would pass without
# the pool under test having warned at all.
if ! grep -q "UserPool ${DOWNGRADE_POOL_ID}: the template declares no MfaConfiguration" "${UPDATE_LOG}"; then
  echo "FAIL: the update turned MFA off on ${DOWNGRADE_POOL_ID} without announcing it (no 'UserPool ${DOWNGRADE_POOL_ID}: the template declares no MfaConfiguration' warning in the deploy output)" >&2
  exit 1
fi
# The message must name the value it is turning OFF, not just that it defaulted.
# A warning that cannot say what was lost is the one this assertion exists to
# reject. (It does NOT prove the read is ordered before UpdateUserPool: MEASURED
# us-east-1 2026-08-18, UpdateUserPool does not reset MfaConfiguration when the
# field is omitted, so either ordering would report OPTIONAL here. The ordering
# is defensive only -- see readLiveMfaConfiguration.)
if ! grep -q "UserPool ${DOWNGRADE_POOL_ID}: .*live value was OPTIONAL" "${UPDATE_LOG}"; then
  echo "FAIL: the downgrade warning for ${DOWNGRADE_POOL_ID} does not name the live value (expected 'UserPool ${DOWNGRADE_POOL_ID}: ... live value was OPTIONAL' in the deploy output)" >&2
  grep -i "MfaConfiguration" "${UPDATE_LOG}" >&2 || true
  exit 1
fi
echo "    OK: the undeclared downgrade to OFF was announced for ${DOWNGRADE_POOL_ID}, naming the live OPTIONAL"

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

# --- Assertion 11b: the SignInPolicy removal is ANNOUNCED (#1979) -----
# The load-bearing half: before the fix the removal deploy was byte-identical
# on the wire and printed nothing. BOUND to this pool's id (seven pools deploy in
# this stack) and to the exact producer wording the unit suite also pins, so a
# wording drift breaks the unit test loudly before it can blind this grep.
if ! grep -q "UserPool ${POLICY_REMOVAL_POOL_ID}: the desired configuration no longer declares Policies.SignInPolicy" "${UPDATE_LOG}"; then
  echo "FAIL: the SignInPolicy removal deployed without an announcement (no 'UserPool ${POLICY_REMOVAL_POOL_ID}: the desired configuration no longer declares Policies.SignInPolicy' in the deploy output — issue #1979)" >&2
  grep -i "SignInPolicy" "${UPDATE_LOG}" >&2 || true
  exit 1
fi
# Per-sub-key discrimination: PasswordPolicy stays declared on the update arm,
# so an announcement naming it would mean the detection fires per-container
# rather than per-sub-key.
if grep -q "UserPool ${POLICY_REMOVAL_POOL_ID}: the desired configuration no longer declares Policies.PasswordPolicy" "${UPDATE_LOG}"; then
  echo "FAIL: the removal announcement fired for Policies.PasswordPolicy, which the update arm still declares (per-sub-key detection broken — issue #1979)" >&2
  exit 1
fi
echo "    OK: the inexpressible SignInPolicy removal was announced for ${POLICY_REMOVAL_POOL_ID}"

# --- Assertion 11c: the live sign-in policy is RETAINED ---------------
# CFn parity (measured us-east-1 2026-09-02, issue #1979): CloudFormation's own
# UPDATE_COMPLETE on this edit leaves the live value untouched, so cdkd must
# NOT reset it. If a future change makes cdkd send a reset, this fails and the
# divergence has to be deliberate.
POLICY_REMOVAL_AFTER=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${POLICY_REMOVAL_POOL_ID}" --region "${REGION}" --output json)
PR_FACTORS_AFTER=$(echo "${POLICY_REMOVAL_AFTER}" \
  | jq -c '.UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors // []')
if ! echo "${PR_FACTORS_AFTER}" | jq -e 'index("EMAIL_OTP") != null and index("PASSWORD") != null' >/dev/null; then
  echo "FAIL: after the removal deploy, SignInPolicy.AllowedFirstAuthFactors is ${PR_FACTORS_AFTER}, expected PASSWORD and EMAIL_OTP retained (the wire cannot express the removal, and CFn is the same no-op — issue #1979)" >&2
  exit 1
fi
# The declared sub-key must still be forwarded untouched — a removal detection
# that also stopped forwarding PasswordPolicy would be a regression of #1380's
# forwarding fix, invisible to the retention assertion above.
PR_MINLEN_AFTER=$(echo "${POLICY_REMOVAL_AFTER}" \
  | jq -r '.UserPool.Policies.PasswordPolicy.MinimumLength // "null"')
if [ "${PR_MINLEN_AFTER}" != "12" ]; then
  echo "FAIL: after the removal deploy, PasswordPolicy.MinimumLength is '${PR_MINLEN_AFTER}', expected 12 (the still-declared sub-key must keep forwarding)" >&2
  exit 1
fi
# Fired-call companion (the nlb-source-nat rule): 'the sign-in policy is
# unchanged' passes vacuously when no call went out at all, so prove
# UpdateUserPool ran by the companion property it carried in the same request.
PR_AUTOVERIFY_AFTER=$(echo "${POLICY_REMOVAL_AFTER}" \
  | jq -c '.UserPool.AutoVerifiedAttributes // [] | sort')
if [ "${PR_AUTOVERIFY_AFTER}" != '["email"]' ]; then
  echo "FAIL: after the removal deploy, AutoVerifiedAttributes is ${PR_AUTOVERIFY_AFTER}, expected [\"email\"] (the companion change proving UpdateUserPool fired did not land)" >&2
  exit 1
fi
echo "    OK: sign-in policy retained (PASSWORD + EMAIL_OTP), PasswordPolicy still forwarded, companion change landed"

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

assert_gone "Policy-removal UserPool ${POLICY_REMOVAL_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${POLICY_REMOVAL_POOL_ID}" --region "${REGION}"
echo "    OK: Policy-removal UserPool is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# =====================================================================
# Phases 4-6: the MFA pre-flight refusal arms (issues #1975 / #1977)
# =====================================================================
# What is under test is a REFUSAL raised BEFORE the first AWS call on the
# UPDATE path. A create-only fixture cannot reach it: the harm it prevents is a
# PARTIAL APPLY, which only exists because `UpdateUserPool` lands before
# `SetUserPoolMfaConfig` is rejected. So each arm needs a real base deploy and
# then a real update deploy that must FAIL.
#
# The load-bearing assertion in each arm is NOT the message -- it is the CANARY
# read back from AWS. A message proves cdkd said something; only an unchanged
# canary proves nothing was SENT. Pre-fix, both canaries land at AWS and stay
# there (nothing unwinds a failed UPDATE: the failed op is journaled for
# `cdkd rollback --revert-failed`, and the engine's automatic rollback covers
# COMPLETED operations only).
#
# Each refusing arm gets its OWN deploy, selected by CDKD_TEST_PREFLIGHT_ARM.
# The engine cancels pending siblings on the first resource failure, so one
# deploy carrying both mutations could legitimately log one refusal and never
# attempt the other -- and would then "pass" with an arm unexercised.

echo "==> Phase 4: base deploy of ${PREFLIGHT_STACK} (pre-flight arms #1975 / #1977)"
# `env -u` both switches: an inherited CDKD_TEST_PREFLIGHT_ARM would deploy a
# refusing arm as the BASE, which fails here and collapses the whole sequence.
env -u CDKD_TEST_UPDATE -u CDKD_TEST_PREFLIGHT_ARM node "${LOCAL_DIST}" deploy "${PREFLIGHT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

PREFLIGHT_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PREFLIGHT_STATE_KEY}" - 2>/dev/null)
if [ -z "${PREFLIGHT_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${PREFLIGHT_STATE_KEY} after the pre-flight base deploy" >&2
  exit 1
fi

# Resolved by AWS-assigned NAME, like the #1925 arms above: a provider that
# wrote cdkd state without reaching AWS must not be able to satisfy these.
OFF_POOL_NAME="cdkd-test-mfa-preflight-off-${ACCOUNT_ID}"
SIGNIN_POOL_NAME="cdkd-test-mfa-preflight-signin-${ACCOUNT_ID}"
OPTIONAL_POOL_NAME="cdkd-test-mfa-preflight-optional-${ACCOUNT_ID}"
WEBAUTHN_POOL_NAME="cdkd-test-mfa-preflight-webauthn-${ACCOUNT_ID}"

OFF_POOL_ID="$(pool_id_by_name "${OFF_POOL_NAME}")"
SIGNIN_POOL_ID="$(pool_id_by_name "${SIGNIN_POOL_NAME}")"
OPTIONAL_POOL_ID="$(pool_id_by_name "${OPTIONAL_POOL_NAME}")"
WEBAUTHN_POOL_ID="$(pool_id_by_name "${WEBAUTHN_POOL_NAME}")"
for pair in "${OFF_POOL_NAME}=${OFF_POOL_ID}" "${SIGNIN_POOL_NAME}=${SIGNIN_POOL_ID}" \
  "${OPTIONAL_POOL_NAME}=${OPTIONAL_POOL_ID}" "${WEBAUTHN_POOL_NAME}=${WEBAUTHN_POOL_ID}"; do
  if [ -z "${pair#*=}" ]; then
    echo "FAIL: no user pool named '${pair%%=*}' after the pre-flight base deploy" >&2
    exit 1
  fi
done
echo "    Arm A (#1977) pool: ${OFF_POOL_ID}"
echo "    Arm B (#1975) pool: ${SIGNIN_POOL_ID}"
echo "    Arm C2 (OPTIONAL + EMAIL_OTP) pool: ${OPTIONAL_POOL_ID}"
echo "    Arm C3 (WEB_AUTHN) pool: ${WEBAUTHN_POOL_ID}"

# --- Assertion 12: arm A baseline -------------------------------------
# MFA really on, and the CANARY field genuinely absent. Both halves are
# load-bearing: without the first the update is not the OPTIONAL -> OFF
# transition the refusal is about, and without the second an
# AutoVerifiedAttributes seen after the refused update could have predated it.
ARM_A_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${OFF_POOL_ID}" --region "${REGION}" --output json)
ARM_A_MFA_BEFORE=$(echo "${ARM_A_MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
ARM_A_SOFTWARE_BEFORE=$(echo "${ARM_A_MFA}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${ARM_A_MFA_BEFORE}" != "OPTIONAL" ] || [ "${ARM_A_SOFTWARE_BEFORE}" != "true" ]; then
  echo "FAIL: arm A baseline is MfaConfiguration='${ARM_A_MFA_BEFORE}' / SoftwareTokenMfaConfiguration.Enabled='${ARM_A_SOFTWARE_BEFORE}', expected 'OPTIONAL' / 'true'" >&2
  echo "${ARM_A_MFA}" | jq . >&2 || true
  exit 1
fi
ARM_A_CANARY_BEFORE=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${OFF_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.AutoVerifiedAttributes' --output json)
if ! echo "${ARM_A_CANARY_BEFORE}" | jq -e '(. // []) | length == 0' >/dev/null; then
  echo "FAIL: arm A canary baseline AutoVerifiedAttributes is ${ARM_A_CANARY_BEFORE}, expected empty (the base template declares none)" >&2
  exit 1
fi
echo "    OK: arm A baseline == MfaConfiguration OPTIONAL + SOFTWARE_TOKEN_MFA, AutoVerifiedAttributes empty"

# --- Assertion 13: arm B baseline, and negative control C1 ------------
# This IS the C1 negative control: `MfaConfiguration` resolves to ON and a
# `SignInPolicy` is present, so the #1975 rule EVALUATES here -- and must not
# fire, because PASSWORD is an allowed member. A refusal keyed on "ON plus any
# SignInPolicy" fails this deploy instead of reaching this line.
ARM_B_FACTORS_BEFORE=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${SIGNIN_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors' --output json)
if ! echo "${ARM_B_FACTORS_BEFORE}" | jq -e '. == ["PASSWORD"]' >/dev/null; then
  echo "FAIL: arm B baseline AllowedFirstAuthFactors is ${ARM_B_FACTORS_BEFORE}, expected exactly [\"PASSWORD\"]" >&2
  exit 1
fi
ARM_B_MFA_BEFORE=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${SIGNIN_POOL_ID}" --region "${REGION}" --output json \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${ARM_B_MFA_BEFORE}" != "ON" ]; then
  echo "FAIL: arm B baseline MfaConfiguration is '${ARM_B_MFA_BEFORE}', expected 'ON'" >&2
  exit 1
fi
echo "    OK: arm B baseline == AllowedFirstAuthFactors [PASSWORD] + MfaConfiguration ON (negative control C1: the #1975 rule evaluates here and does NOT fire)"

# --- Assertion 14: negative control C2 --------------------------------
# A DENY-LISTED member (EMAIL_OTP) beside MfaConfiguration OPTIONAL. AWS
# ACCEPTS this (measured us-east-1 2026-08-19), which is why the rule is
# narrowed to `=== 'ON'`. Widening it to `!== 'OFF'` -- the obvious "be safe"
# edit -- refuses a template that deploys, and this assertion is what catches
# that: the deploy above would already have failed.
C2_FACTORS=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${OPTIONAL_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors' --output json)
if ! echo "${C2_FACTORS}" | jq -e 'index("EMAIL_OTP") != null and index("PASSWORD") != null' >/dev/null; then
  echo "FAIL: negative control C2 AllowedFirstAuthFactors is ${C2_FACTORS}, expected to contain PASSWORD and EMAIL_OTP" >&2
  exit 1
fi
C2_MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${OPTIONAL_POOL_ID}" --region "${REGION}" --output json \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${C2_MFA}" != "OPTIONAL" ]; then
  echo "FAIL: negative control C2 MfaConfiguration is '${C2_MFA}', expected 'OPTIONAL'" >&2
  exit 1
fi
echo "    OK: negative control C2 deployed clean (EMAIL_OTP allowed under MfaConfiguration OPTIONAL)"

# --- Assertion 15: negative control C3 --------------------------------
# WEB_AUTHN must not be treated as a denied member. MfaConfiguration is
# OPTIONAL rather than ON here, and that is an AWS limit, not a softened
# assertion: MEASURED us-east-1 2026-08-20, a pool whose sign-in policy allows
# WEB_AUTHN rejects SetUserPoolMfaConfig(ON) with "Cannot set WebAuthn factor
# configuration to SINGLE_FACTOR if MFA is required and WebAuthn is an allowed
# first auth factor" unless WebAuthnConfiguration.FactorConfiguration is
# MULTI_FACTOR_WITH_USER_VERIFICATION -- a field the pinned SDK does not have
# and the provider lists as unhandled-by-design. So ON + WEB_AUTHN is
# undeployable through cdkd today for a reason unrelated to this pre-flight.
C3_FACTORS=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${WEBAUTHN_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors' --output json)
if ! echo "${C3_FACTORS}" | jq -e 'index("WEB_AUTHN") != null and index("PASSWORD") != null' >/dev/null; then
  echo "FAIL: negative control C3 AllowedFirstAuthFactors is ${C3_FACTORS}, expected to contain PASSWORD and WEB_AUTHN" >&2
  exit 1
fi
C3_MFA_JSON=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${WEBAUTHN_POOL_ID}" --region "${REGION}" --output json)
C3_MFA=$(echo "${C3_MFA_JSON}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
C3_WA_RP=$(echo "${C3_MFA_JSON}" \
  | jq -r 'if (.WebAuthnConfiguration|has("RelyingPartyId")) then .WebAuthnConfiguration.RelyingPartyId else "null" end')
if [ "${C3_MFA}" != "OPTIONAL" ] || [ "${C3_WA_RP}" != "preflight.cdkd.example.com" ]; then
  echo "FAIL: negative control C3 is MfaConfiguration='${C3_MFA}' / WebAuthn RelyingPartyId='${C3_WA_RP}', expected 'OPTIONAL' / 'preflight.cdkd.example.com'" >&2
  echo "${C3_MFA_JSON}" | jq . >&2 || true
  exit 1
fi
echo "    OK: negative control C3 deployed clean (WEB_AUTHN allowed alongside a real MFA factor)"

# --- Phase 5: arm A (issue #1977) -- the update MUST be refused -------
echo "==> Phase 5: arm A (#1977) -- MfaConfiguration OFF beside a declared factor must be REFUSED"
PREFLIGHT_LOG="$(mktemp -t cdkd-cognito-preflight.XXXXXX)"
# The rc is captured EXPLICITLY rather than being left to `!` or a pipeline:
# a non-zero exit IS the assertion here, and reading it off a `tee` would
# report the pipe's status instead. (`set -e` is suspended for exactly this
# command, then restored -- an unguarded failing command would abort the run
# and report the expected failure as an error.)
set +e
CDKD_TEST_PREFLIGHT_ARM=A node "${LOCAL_DIST}" deploy "${PREFLIGHT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${PREFLIGHT_LOG}" 2>&1
ARM_A_RC=$?
set -e
cat "${PREFLIGHT_LOG}"

# --- Assertion 16: the deploy failed ----------------------------------
if [ "${ARM_A_RC}" -eq 0 ]; then
  echo "FAIL: arm A deploy exited 0 -- MfaConfiguration OFF beside EnabledMfas [SOFTWARE_TOKEN_MFA] must be REFUSED (issue #1977)" >&2
  exit 1
fi
echo "    OK: arm A deploy exited ${ARM_A_RC}"

# --- Assertion 17: the message is cdkd's own, and names both props ----
# Bound to the logical id, because the engine logs `Failed to update <id>: <msg>`
# on one line and this stack holds four pools whose MFA arms differ.
if ! grep -q "Failed to update PreflightOffPool: AWS::Cognito::UserPool MfaConfiguration is OFF while an MFA factor is configured" "${PREFLIGHT_LOG}"; then
  echo "FAIL: arm A did not produce cdkd's own pre-flight refusal for PreflightOffPool" >&2
  exit 1
fi
# It must name the OTHER property too -- a message naming only MfaConfiguration
# sends the user looking at the field they did change, not at the pair.
if ! grep -q "PreflightOffPool: .*SoftwareTokenMfaConfiguration.*EnabledMfas" "${PREFLIGHT_LOG}"; then
  echo "FAIL: arm A refusal does not name the factor block / EnabledMfas alongside MfaConfiguration" >&2
  grep -i "PreflightOffPool" "${PREFLIGHT_LOG}" >&2 || true
  exit 1
fi
# ... and it must be a PRE-FLIGHT refusal, not AWS's rejection relayed. AWS's
# own sentence is quoted INSIDE cdkd's message, so its presence proves nothing;
# the exception NAME is what only a real API round trip produces.
if grep -q "InvalidParameterException" "${PREFLIGHT_LOG}"; then
  echo "FAIL: arm A log contains InvalidParameterException -- the request reached AWS instead of being refused before the first call" >&2
  grep -n "InvalidParameterException" "${PREFLIGHT_LOG}" >&2 || true
  exit 1
fi
echo "    OK: arm A refused by cdkd before any AWS call, naming both properties"

# --- Assertion 18: THE CANARY -- no AWS call went out ------------------
# The load-bearing one. Pre-fix the ordering is UpdateUserPool (which carries
# AutoVerifiedAttributes) and only THEN SetUserPoolMfaConfig, so the canary
# would be sitting at AWS right now with nothing having unwound it.
ARM_A_CANARY_AFTER=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${OFF_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.AutoVerifiedAttributes' --output json)
if ! echo "${ARM_A_CANARY_AFTER}" | jq -e '(. // []) | length == 0' >/dev/null; then
  echo "FAIL: arm A canary AutoVerifiedAttributes is ${ARM_A_CANARY_AFTER} after the refused update, expected still empty -- UpdateUserPool WENT OUT and the update partly applied (issue #1977)" >&2
  exit 1
fi
echo "    OK: arm A canary AutoVerifiedAttributes still empty -- UpdateUserPool never went out"

# The MFA half must be untouched too: the pool still has MFA on, so the refusal
# did not half-disable it on the way past.
ARM_A_MFA_AFTER=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${OFF_POOL_ID}" --region "${REGION}" --output json)
ARM_A_MFA_CONFIG_AFTER=$(echo "${ARM_A_MFA_AFTER}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
ARM_A_SOFTWARE_AFTER=$(echo "${ARM_A_MFA_AFTER}" \
  | jq -r 'if (.SoftwareTokenMfaConfiguration|has("Enabled")) then .SoftwareTokenMfaConfiguration.Enabled|tostring else "null" end')
if [ "${ARM_A_MFA_CONFIG_AFTER}" != "OPTIONAL" ] || [ "${ARM_A_SOFTWARE_AFTER}" != "true" ]; then
  echo "FAIL: arm A MFA config after the refused update is '${ARM_A_MFA_CONFIG_AFTER}' / '${ARM_A_SOFTWARE_AFTER}', expected the untouched baseline 'OPTIONAL' / 'true'" >&2
  echo "${ARM_A_MFA_AFTER}" | jq . >&2 || true
  exit 1
fi
echo "    OK: arm A MFA config untouched (OPTIONAL + SOFTWARE_TOKEN_MFA)"

rm -f "${PREFLIGHT_LOG}"
PREFLIGHT_LOG=""

# --- Phase 6: arm B (issue #1975) -- the update MUST be refused -------
echo "==> Phase 6: arm B (#1975) -- EMAIL_OTP added to the sign-in policy under MfaConfiguration ON must be REFUSED"
PREFLIGHT_LOG="$(mktemp -t cdkd-cognito-preflight.XXXXXX)"
set +e
CDKD_TEST_PREFLIGHT_ARM=B node "${LOCAL_DIST}" deploy "${PREFLIGHT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${PREFLIGHT_LOG}" 2>&1
ARM_B_RC=$?
set -e
cat "${PREFLIGHT_LOG}"

# --- Assertion 19: the deploy failed ----------------------------------
if [ "${ARM_B_RC}" -eq 0 ]; then
  echo "FAIL: arm B deploy exited 0 -- EMAIL_OTP in AllowedFirstAuthFactors under MfaConfiguration ON must be REFUSED (issue #1975)" >&2
  exit 1
fi
echo "    OK: arm B deploy exited ${ARM_B_RC}"

# --- Assertion 20: cdkd's own message, naming both properties ---------
if ! grep -q "Failed to update PreflightSignInPool: AWS::Cognito::UserPool MfaConfiguration is ON while Policies.SignInPolicy.AllowedFirstAuthFactors allows EMAIL_OTP" "${PREFLIGHT_LOG}"; then
  echo "FAIL: arm B did not produce cdkd's own pre-flight refusal for PreflightSignInPool" >&2
  exit 1
fi
if grep -q "InvalidParameterException" "${PREFLIGHT_LOG}"; then
  echo "FAIL: arm B log contains InvalidParameterException -- the request reached AWS instead of being refused before the first call" >&2
  grep -n "InvalidParameterException" "${PREFLIGHT_LOG}" >&2 || true
  exit 1
fi
echo "    OK: arm B refused by cdkd before any AWS call, naming both properties"

# --- Assertion 21: THE CANARY -- the loosened policy never landed -----
# Here the canary IS the payload: `Policies.SignInPolicy` is what
# `UpdateUserPool` carries, and pre-fix it landed while `SetUserPoolMfaConfig`
# was rejected -- the pool left with authentication loosened and MFA not
# tightened. Nothing unwinds it: a FAILED update is journaled for
# `cdkd rollback --revert-failed`, not auto-reverted.
ARM_B_FACTORS_AFTER=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${SIGNIN_POOL_ID}" --region "${REGION}" \
  --query 'UserPool.Policies.SignInPolicy.AllowedFirstAuthFactors' --output json)
if ! echo "${ARM_B_FACTORS_AFTER}" | jq -e '. == ["PASSWORD"]' >/dev/null; then
  echo "FAIL: arm B canary AllowedFirstAuthFactors is ${ARM_B_FACTORS_AFTER} after the refused update, expected still exactly [\"PASSWORD\"] -- UpdateUserPool WENT OUT and the sign-in policy partly applied (issue #1975)" >&2
  exit 1
fi
echo "    OK: arm B canary AllowedFirstAuthFactors still [PASSWORD] -- UpdateUserPool never went out"

ARM_B_MFA_AFTER=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${SIGNIN_POOL_ID}" --region "${REGION}" --output json \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${ARM_B_MFA_AFTER}" != "ON" ]; then
  echo "FAIL: arm B MfaConfiguration after the refused update is '${ARM_B_MFA_AFTER}', expected the untouched baseline 'ON'" >&2
  exit 1
fi
echo "    OK: arm B MFA config untouched (ON)"

rm -f "${PREFLIGHT_LOG}"
PREFLIGHT_LOG=""

# --- Phase 7: destroy the pre-flight stack ----------------------------
# Two of the phases above END in a failed deploy, so this also exercises the
# destroy path on a stack carrying a rollback journal.
echo "==> Phase 7: destroy ${PREFLIGHT_STACK}"
node "${LOCAL_DIST}" destroy "${PREFLIGHT_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "arm A UserPool ${OFF_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${OFF_POOL_ID}" --region "${REGION}"
assert_gone "arm B UserPool ${SIGNIN_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${SIGNIN_POOL_ID}" --region "${REGION}"
assert_gone "control C2 UserPool ${OPTIONAL_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${OPTIONAL_POOL_ID}" --region "${REGION}"
assert_gone "control C3 UserPool ${WEBAUTHN_POOL_ID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${WEBAUTHN_POOL_ID}" --region "${REGION}"
echo "    OK: all four pre-flight UserPools are gone"

assert_gone "state file s3://${STATE_BUCKET}/${PREFLIGHT_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PREFLIGHT_STATE_KEY}"
echo "    OK: pre-flight state file is gone"

# The journal is a state-file SIBLING written by the two failed deploys above,
# and `cdkd destroy` is what sweeps it. Asserting it explicitly is what keeps
# "the run left nothing behind" honest for a fixture that fails on purpose.
assert_gone "rollback journal s3://${STATE_BUCKET}/cdkd/${PREFLIGHT_STACK}/${REGION}/rollback-journal.json still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${PREFLIGHT_STACK}/${REGION}/rollback-journal.json"
echo "    OK: rollback journal is gone"

echo ""
echo "==> cognito test passed (SignInPolicy #1380 / UserPoolTier / EnabledMfas(SOFTWARE_TOKEN) / WebAuthn* backfill (EMAIL_OTP-as-MFA unit-only) / MfaConfiguration defaulting both arms OFF+OPTIONAL #1920 / MFA update transitions: enable-on-update + announced undeclared downgrade #1925 / announced+retained Policies.SignInPolicy removal with fired-call companion #1979 / MFA pre-flight refusals on the UPDATE path with canaries proving no API call went out #1977 + #1975, plus three negative controls / clean destroy)"
