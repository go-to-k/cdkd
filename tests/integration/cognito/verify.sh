#!/usr/bin/env bash
# verify.sh — cdkd Cognito::UserPool #609 backfill integ test.
#
# Asserts that the BackfillUserPool (an L1 CfnUserPool) lands the issue #609
# backfill properties on AWS after `cdkd deploy`:
#   - UserPoolTier                  -> DescribeUserPool.UserPool.UserPoolTier
#   - EnabledMfas (SOFTWARE_TOKEN_MFA)
#                                   -> GetUserPoolMfaConfig (per-factor blocks)
#   - WebAuthnRelyingPartyID/UserVerification
#                                   -> GetUserPoolMfaConfig.WebAuthnConfiguration
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

# --- Assertion 1: UserPoolTier (DescribeUserPool) ---------------------
TIER=$(aws cognito-idp describe-user-pool \
  --user-pool-id "${POOL_ID}" --region "${REGION}" \
  --query 'UserPool.UserPoolTier' --output text 2>/dev/null || echo "")
if [ "${TIER}" != "ESSENTIALS" ]; then
  echo "FAIL: UserPool.UserPoolTier is '${TIER}', expected 'ESSENTIALS'" >&2
  exit 1
fi
echo "    OK: UserPoolTier == ESSENTIALS"

# --- Assertion 2..5: MFA config (GetUserPoolMfaConfig) ----------------
MFA=$(aws cognito-idp get-user-pool-mfa-config \
  --user-pool-id "${POOL_ID}" --region "${REGION}" --output json 2>/dev/null || echo "{}")

# MfaConfiguration MUST be ON/OPTIONAL (not OFF). SetUserPoolMfaConfig is a
# full-replace: if cdkd omitted MfaConfiguration the pool would reset to OFF and
# the per-factor sub-blocks below would be silently dropped. This is the
# load-bearing assertion guarding the #609-review blocker fix.
MFA_CONFIG=$(echo "${MFA}" \
  | jq -r 'if has("MfaConfiguration") then .MfaConfiguration else "null" end')
if [ "${MFA_CONFIG}" != "OPTIONAL" ] && [ "${MFA_CONFIG}" != "ON" ]; then
  echo "FAIL: MfaConfiguration is '${MFA_CONFIG}', expected ON or OPTIONAL (pool reset to OFF would drop the factors)" >&2
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

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Backfill UserPool ${POOL_ID} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Backfill UserPool is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> cognito test passed (UserPoolTier / EnabledMfas(SOFTWARE_TOKEN) / WebAuthn* backfill (EMAIL_OTP unit-only) closed + clean destroy)"
