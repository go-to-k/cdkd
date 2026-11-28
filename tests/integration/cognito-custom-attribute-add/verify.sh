#!/usr/bin/env bash
# verify.sh — cdkd Cognito add-custom-attribute (Schema in-place update) integ.
#
# Regression coverage for the bug where adding a custom attribute to an existing
# Cognito User Pool on redeploy was silently dropped: cdkd's
# cognito-provider.update() ignored the Schema property entirely, so the deploy
# reported success while AWS kept the old schema, and the next diff saw the
# change again with nothing applied. AWS supports adding a custom attribute in
# place via AddCustomAttributes; the fix wires that into update().
#
# Phases:
#   1. Deploy a pool with custom attributes tenantId + level. Assert AWS reports
#      exactly those two custom attributes.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (adds custom:region and renames the
#      pool). Assert AWS now reports all three custom attributes (the added
#      attribute reached AWS, not just cdkd state), and that the SAME pool id
#      now carries the new name (issue #5358: update() never sent PoolName).
#      The same phase also removes the pool's tag, its OPTIONAL software-token
#      MFA and its ADMIN_ONLY account recovery (issue #1160). Assert, as a
#      CloudFormation A/B measured: the tag is untagged, MFA is OFF, and the
#      account recovery setting is kept with a warning naming it.
#   2b. Re-deploy with CDKD_TEST_USERNAME_CHANGE=true too (adds
#      UsernameConfiguration, which UpdateUserPool has no member for). Assert
#      the deploy is REFUSED naming UsernameConfiguration, as CloudFormation
#      refuses it (issue #5358: the change used to deploy "successfully" and
#      be dropped; UpdateUserPool cannot carry it, so the live value is not
#      re-read here — the refusal is the whole assertion).
#   2c. Re-deploy with CDKD_TEST_MFA=optional (OPTIONAL software-token MFA).
#   2d. Re-deploy with CDKD_TEST_MFA=off (`mfa: OFF`: EnabledMfas removed,
#      MfaConfiguration OFF declared). Assert MFA is OFF with the software
#      token NOT enabled, as CloudFormation ends, and `cdkd drift` is clean
#      (issue #7128: UpdateUserPool OFF kept the factor enabled). A WebAuthn
#      relying party set out of band in 2c must survive the reset.
#   2e. Seed the pre-#7128 leftover out of band (OPTIONAL + software token,
#      then UpdateUserPool OFF, which keeps the factor) and its baseline
#      (written into state.json: over 2d's `[]` baseline the leftover is not
#      drift, which a plain drift asserts, so `--accept` cannot seed it).
#      Assert `cdkd drift` reports EnabledMfas (issue #7134: it compared
#      the factor against itself, clean), `drift --revert` clears the factor
#      and keeps the WebAuthn relying party, and drift is clean afterwards.
#   2f. Re-deploy with CDKD_TEST_MFA=off-sms (`enableSmsRole: true` under OFF:
#      an SmsConfiguration, so the pool reads `EnabledMfas: [SMS_MFA]` back).
#      Flip a declared member (AllowAdminCreateUserOnly) out of band and
#      assert `drift --revert` reverts it and drift is clean after (issue
#      #7175: the revert sent SMS_MFA under OFF and the MFA pre-flight refused
#      every revert of such a pool). Then seed the pre-#7128 leftover beside
#      SMS (OPTIONAL + SMS + token, then UpdateUserPool OFF) and its baseline
#      `[SMS_MFA, SOFTWARE_TOKEN_MFA]`; assert drift reports EnabledMfas (issue
#      #7172: the token was only stripped from a token-only baseline), the
#      revert clears the token and keeps SMS and the WebAuthn relying party,
#      and drift is clean afterwards.
#   3. Destroy + assert the pool is gone and the cdkd state file is removed.
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

STACK="CdkdCognitoCustomAttributeAddExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="cdkd-cognito-attr-add-test"
RENAMED_POOL_NAME="cdkd-cognito-attr-add-test-renamed"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Either name: Phase 2 renames the pool, and cleanup / the destroy check must
# find it under whichever name it holds.
pool_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}' || Name=='${RENAMED_POOL_NAME}'].Id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local pid
  pid="$(pool_id)"
  if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
    aws cognito-idp delete-user-pool --user-pool-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  [ -n "${P2_LOG:-}" ] && rm -f "${P2_LOG}"
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

custom_attr_count() {
  local pid="$1"
  aws cognito-idp describe-user-pool --user-pool-id "${pid}" --region "${REGION}" \
    --query "length(UserPool.SchemaAttributes[?starts_with(Name, 'custom:')])" --output text
}

has_custom_attr() {
  local pid="$1" name="$2"
  aws cognito-idp describe-user-pool --user-pool-id "${pid}" --region "${REGION}" \
    --query "UserPool.SchemaAttributes[?Name=='custom:${name}'].Name | [0]" --output text
}

# --- Phase 1: deploy baseline (tenantId + level) ----------------------
echo "==> Phase 1: deploy pool with custom attributes tenantId + level"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PID="$(pool_id)"
if [ -z "${PID}" ] || [ "${PID}" = "None" ]; then
  echo "FAIL: pool ${POOL_NAME} not found after Phase 1" >&2
  exit 1
fi
COUNT_P1="$(custom_attr_count "${PID}")"
echo "    custom attribute count (Phase 1): ${COUNT_P1}"
if [ "${COUNT_P1}" != "2" ]; then
  echo "FAIL: expected 2 custom attributes after Phase 1, got '${COUNT_P1}'" >&2
  exit 1
fi
echo "    pool has tenantId + level"

# Read once, and checked: an empty --resource-arn would hang the AWS CLI.
POOL_ARN="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" \
  --query 'UserPool.Arn' --output text)"
case "${POOL_ARN}" in
  arn:*) ;;
  *) echo "FAIL: could not read the ARN of pool ${PID}, got '${POOL_ARN}'" >&2; exit 1 ;;
esac
removed_tag_value() {
  aws cognito-idp list-tags-for-resource --resource-arn "${POOL_ARN}" --region "${REGION}" \
    --query "Tags.\"cdkd-1160-removed\"" --output text
}
mfa_state() {
  aws cognito-idp get-user-pool-mfa-config --user-pool-id "$1" --region "${REGION}" \
    --query '[MfaConfiguration, SoftwareTokenMfaConfiguration.Enabled]' --output text
}
recovery_names() {
  aws cognito-idp describe-user-pool --user-pool-id "$1" --region "${REGION}" \
    --query 'UserPool.AccountRecoverySetting.RecoveryMechanisms[].Name' --output text
}

# Issue #1160 baseline: the three members Phase 2 removes are really there.
TAG_P1="$(removed_tag_value "${PID}")"
MFA_P1="$(mfa_state "${PID}")"
REC_P1="$(recovery_names "${PID}")"
echo "    tag / MFA / recovery (Phase 1): '${TAG_P1}' / '${MFA_P1}' / '${REC_P1}'"
if [ "${TAG_P1}" != "phase1" ] || [ "$(echo "${MFA_P1}" | awk '{print $1}')" != "OPTIONAL" ] \
  || [ "${REC_P1}" != "admin_only" ]; then
  echo "FAIL: Phase 1 baseline for the #1160 removal arm is not in place" >&2
  exit 1
fi

# --- Phase 2: add custom:region (must actually reach AWS) -------------
echo "==> Phase 2: re-deploy adding custom:region (AddCustomAttributes)"
P2_LOG="$(mktemp -t cdkd-cognito-attr-add-p2.XXXXXX)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P2_LOG}" 2>&1
P2_RC=$?
set -e
cat "${P2_LOG}"
if [ "${P2_RC}" -ne 0 ]; then
  echo "FAIL: Phase 2 deploy failed (rc=${P2_RC})" >&2
  exit 1
fi

# Issue #1160: the removals. Before the fix all three stayed silently.
TAG_P2="$(removed_tag_value "${PID}")"
if [ "${TAG_P2}" != "None" ]; then
  echo "FAIL: tag cdkd-1160-removed still on the pool after its removal (issue #1160), got '${TAG_P2}'" >&2
  exit 1
fi
echo "    removed tag untagged"
MFA_P2="$(mfa_state "${PID}")"
if [ "$(echo "${MFA_P2}" | awk '{print $1}')" != "OFF" ] || [ "$(echo "${MFA_P2}" | awk '{print $2}')" = "True" ]; then
  echo "FAIL: MFA not turned off after MfaConfiguration + EnabledMfas were removed (issue #1160), got '${MFA_P2}'" >&2
  exit 1
fi
echo "    MFA turned off (${MFA_P2})"
if ! grep -qF "cdkd turned MFA OFF" "${P2_LOG}"; then
  echo "FAIL: no warning announcing that the removal turned MFA off (issue #1160)" >&2
  exit 1
fi
REC_P2="$(recovery_names "${PID}")"
if [ "${REC_P2}" != "admin_only" ]; then
  echo "FAIL: account recovery changed after its removal (CloudFormation keeps it, issue #1160), got '${REC_P2}'" >&2
  exit 1
fi
if ! grep -qF "no longer declares AccountRecoverySetting," "${P2_LOG}"; then
  echo "FAIL: no warning naming the kept AccountRecoverySetting (issue #1160)" >&2
  exit 1
fi
echo "    account recovery kept, with the warning"
rm -f "${P2_LOG}"

NAME_P2="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" \
  --query 'UserPool.Name' --output text)"
echo "    pool name (Phase 2): ${NAME_P2}"
if [ "${NAME_P2}" != "${RENAMED_POOL_NAME}" ]; then
  echo "FAIL: expected pool ${PID} renamed to ${RENAMED_POOL_NAME} in place (rename dropped? issue #5358), got '${NAME_P2}'" >&2
  exit 1
fi
echo "    pool renamed in place (same id ${PID})"

COUNT_P2="$(custom_attr_count "${PID}")"
echo "    custom attribute count (Phase 2): ${COUNT_P2}"
if [ "${COUNT_P2}" != "3" ]; then
  echo "FAIL: expected 3 custom attributes after Phase 2 (add silently dropped?), got '${COUNT_P2}'" >&2
  exit 1
fi
REGION_ATTR="$(has_custom_attr "${PID}" region)"
if [ "${REGION_ATTR}" != "custom:region" ]; then
  echo "FAIL: expected custom:region to be added, got '${REGION_ATTR}'" >&2
  exit 1
fi
echo "    custom:region added (reached AWS, not just cdkd state)"

# --- Phase 2b: a UsernameConfiguration change must be REFUSED ---------
echo "==> Phase 2b: re-deploy adding UsernameConfiguration (must be refused, issue #5358)"
P2B_LOG="$(mktemp -t cdkd-cognito-attr-add-p2b.XXXXXX)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_USERNAME_CHANGE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P2B_LOG}" 2>&1
P2B_RC=$?
set -e
if [ "${P2B_RC}" -eq 0 ]; then
  tail -20 "${P2B_LOG}" >&2
  echo "FAIL: Phase 2b deploy succeeded — the UsernameConfiguration change was dropped instead of refused (issue #5358)" >&2
  exit 1
fi
if ! grep -qF "UsernameConfiguration cannot be changed on an existing user pool" "${P2B_LOG}"; then
  tail -20 "${P2B_LOG}" >&2
  echo "FAIL: Phase 2b deploy failed (rc=${P2B_RC}) but not with the UsernameConfiguration refusal" >&2
  exit 1
fi
echo "    deploy refused (rc=${P2B_RC}) naming UsernameConfiguration"
rm -f "${P2B_LOG}"

# --- Phase 2c/2d: drop the MFA factor under an explicit OFF (issue #7128) ---
echo "==> Phase 2c: re-deploy with OPTIONAL software-token MFA"
CDKD_TEST_UPDATE=true CDKD_TEST_MFA=optional node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
MFA_P2C="$(mfa_state "${PID}")"
if [ "${MFA_P2C}" != "$(printf 'OPTIONAL\tTrue')" ]; then
  echo "FAIL: Phase 2c baseline: expected OPTIONAL with the software token enabled, got '${MFA_P2C}'" >&2
  exit 1
fi
echo "    MFA OPTIONAL with the software token (${MFA_P2C})"
# A WebAuthn relying party set out of band (the template declares none): the
# Phase 2d reset must carry it, since a bare SetUserPoolMfaConfig OFF drops
# the whole WebAuthnConfiguration (measured for #7128) and CloudFormation
# keeps it. The call re-sends the deployed TOTP + OPTIONAL so only WebAuthn
# changes.
aws cognito-idp set-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --mfa-configuration OPTIONAL --software-token-mfa-configuration Enabled=true \
  --web-authn-configuration RelyingPartyId=example.com,UserVerification=required >/dev/null

echo "==> Phase 2d: re-deploy with mfa: OFF (EnabledMfas removed, MfaConfiguration OFF)"
CDKD_TEST_UPDATE=true CDKD_TEST_MFA=off node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# `None` for the absent SoftwareTokenMfaConfiguration CloudFormation leaves;
# `OFF True` is the pre-fix result (UpdateUserPool OFF keeps the factor).
MFA_P2D="$(mfa_state "${PID}")"
if [ "$(echo "${MFA_P2D}" | awk '{print $1}')" != "OFF" ] || [ "$(echo "${MFA_P2D}" | awk '{print $2}')" = "True" ]; then
  echo "FAIL: the software-token factor is still enabled after EnabledMfas was removed under OFF (issue #7128), got '${MFA_P2D}'" >&2
  exit 1
fi
echo "    MFA OFF and the software token cleared (${MFA_P2D})"
RP_P2D="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query 'WebAuthnConfiguration.RelyingPartyId' --output text)"
if [ "${RP_P2D}" != "example.com" ]; then
  echo "FAIL: the MFA reset dropped the pool's WebAuthn relying party (issue #7128), got '${RP_P2D}'" >&2
  exit 1
fi
echo "    WebAuthn relying party kept through the reset"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift after Phase 2d exited ${DRIFT_RC} (1 = drift, 2 = command error)" >&2
  exit 1
fi
# Both phrases: an all-unsupported run also prints "no drift detected".
case "${DRIFT_OUT}" in
  *"no drift detected"*) ;;
  *) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift after Phase 2d did not report 'no drift detected'" >&2; exit 1 ;;
esac
case "${DRIFT_OUT}" in
  *"checked, 0 unsupported)"*) ;;
  *) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift after Phase 2d left the pool unsupported (compared nothing)" >&2; exit 1 ;;
esac
echo "    cdkd drift clean"

# --- Phase 2e: a pre-#7128 leftover factor is reported and reverted (issue #7134) ---
echo "==> Phase 2e: seed the pre-#7128 leftover (software token under OFF) and its baseline"
# The leftover as a pre-fix release left it: OPTIONAL + software token, then
# `UpdateUserPool` OFF, which keeps the factor (measured for #7128). The MFA
# call re-sends the WebAuthn relying party (it is a full replace); the
# UpdateUserPool call re-sends every member the pool describes with, since an
# omitted one resets to its default (AutoVerifiedAttributes is even refused).
aws cognito-idp set-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --mfa-configuration OPTIONAL --software-token-mfa-configuration Enabled=true \
  --web-authn-configuration RelyingPartyId=example.com,UserVerification=required >/dev/null
P2E_INPUT="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" --output json \
  | jq -c --arg id "${PID}" '.UserPool
      | {Policies, DeletionProtection, LambdaConfig, AutoVerifiedAttributes, SmsVerificationMessage,
         EmailVerificationMessage, EmailVerificationSubject, VerificationMessageTemplate,
         SmsAuthenticationMessage, UserAttributeUpdateSettings, DeviceConfiguration,
         EmailConfiguration, SmsConfiguration, UserPoolTags, AdminCreateUserConfig,
         UserPoolAddOns, AccountRecoverySetting, UserPoolTier, PoolName: .Name}
      | del(.AdminCreateUserConfig.UnusedAccountValidityDays)
      | (if .UserPoolTags then .UserPoolTags |= with_entries(select(.key | startswith("aws:") | not)) else . end)
      | with_entries(select(.value != null))
      | . + {UserPoolId: $id, MfaConfiguration: "OFF"}')"
aws cognito-idp update-user-pool --region "${REGION}" --cli-input-json "${P2E_INPUT}" >/dev/null
MFA_P2E="$(mfa_state "${PID}")"
if [ "${MFA_P2E}" != "$(printf 'OFF\tTrue')" ]; then
  echo "FAIL: Phase 2e could not seed the leftover (expected OFF with the software token enabled), got '${MFA_P2E}'" >&2
  exit 1
fi
echo "    leftover seeded (${MFA_P2E})"
# Over 2d's baseline (`EnabledMfas: []`, an undeclared key captured empty,
# which drift skips) the leftover is not drift, so `--accept` cannot seed the
# legacy baseline. This plain drift must be CLEAN: it also proves the
# UpdateUserPool re-send above changed nothing else on the pool.
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift after the out-of-band seed exited ${DRIFT_RC}, expected 0 (the UpdateUserPool re-send changed another property?)" >&2
  exit 1
fi
# The baseline a pre-fix release captured after its OFF update, written into
# the record the way other fixtures seed legacy records. Assignments, so a
# failed read or jq aborts under `set -e` instead of uploading an empty file.
P2E_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
P2E_SEEDED="$(printf '%s' "${P2E_STATE}" | jq '(.resources[] | select(.resourceType == "AWS::Cognito::UserPool") | .observedProperties.EnabledMfas) = ["SOFTWARE_TOKEN_MFA"]')"
[ -n "${P2E_SEEDED}" ] || { echo "FAIL: Phase 2e: the seeded state is empty -- not uploading it" >&2; exit 1; }
printf '%s\n' "${P2E_SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --content-type application/json >/dev/null
P2E_BASELINE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -c '[.resources[] | select(.resourceType == "AWS::Cognito::UserPool") | .observedProperties.EnabledMfas][0]')"
if [ "${P2E_BASELINE}" != '["SOFTWARE_TOKEN_MFA"]' ]; then
  echo "FAIL: Phase 2e baseline: expected observedProperties.EnabledMfas [SOFTWARE_TOKEN_MFA], got '${P2E_BASELINE}'" >&2
  exit 1
fi

echo "==> Phase 2e: cdkd drift reports the leftover; --revert clears it"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 1 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift on the leftover exited ${DRIFT_RC}, expected 1 (drift): the software token under OFF went unreported (issue #7134)" >&2
  exit 1
fi
case "${DRIFT_OUT}" in
  *"EnabledMfas"*) ;;
  *) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift on the leftover did not name EnabledMfas (issue #7134)" >&2; exit 1 ;;
esac
echo "    drift reported on EnabledMfas"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
MFA_P2E_AFTER="$(mfa_state "${PID}")"
if [ "$(echo "${MFA_P2E_AFTER}" | awk '{print $1}')" != "OFF" ] || [ "$(echo "${MFA_P2E_AFTER}" | awk '{print $2}')" = "True" ]; then
  echo "FAIL: drift --revert left the software token enabled (issue #7134), got '${MFA_P2E_AFTER}'" >&2
  exit 1
fi
RP_P2E="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query 'WebAuthnConfiguration.RelyingPartyId' --output text)"
if [ "${RP_P2E}" != "example.com" ]; then
  echo "FAIL: drift --revert dropped the pool's WebAuthn relying party (issue #7134), got '${RP_P2E}'" >&2
  exit 1
fi
echo "    software token cleared, WebAuthn relying party kept (${MFA_P2E_AFTER})"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift after the Phase 2e revert exited ${DRIFT_RC}, expected 0" >&2
  exit 1
fi
echo "    cdkd drift clean after the revert"

# --- Phase 2f: an SMS-configured pool under OFF (issues #7175 / #7172) ------
echo "==> Phase 2f: re-deploy with mfa: OFF and an SMS caller role"
CDKD_TEST_UPDATE=true CDKD_TEST_MFA=off-sms node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# `SmsMfaConfiguration.SmsConfiguration.SnsCallerArn` is present on a pool
# with an SmsConfiguration even under OFF (measured for #7175).
SMS_P2F="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query 'SmsMfaConfiguration.SmsConfiguration.SnsCallerArn' --output text)"
case "${SMS_P2F}" in
  arn:aws*:iam::*:role/*) ;;
  *) echo "FAIL: Phase 2f: expected the pool to read an SmsMfaConfiguration back under OFF, got '${SMS_P2F}'" >&2; exit 1 ;;
esac
echo "    SMS configuration in place under OFF (${SMS_P2F})"
# The out-of-band change re-sends the pool in full, as 2e does (an omitted
# member resets to its default).
# A non-MFA drift on a member the template DECLARES. (A tag would not do: the
# template declares none, and an undeclared key captured empty is not
# compared.) CDK's `selfSignUpEnabled: true` declares
# AdminCreateUserConfig.AllowAdminCreateUserOnly false; flip it out of band.
P2F_OOB="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" --output json \
  | jq -c --arg id "${PID}" '.UserPool
      | {Policies, DeletionProtection, LambdaConfig, AutoVerifiedAttributes, SmsVerificationMessage,
         EmailVerificationMessage, EmailVerificationSubject, VerificationMessageTemplate,
         SmsAuthenticationMessage, UserAttributeUpdateSettings, DeviceConfiguration,
         EmailConfiguration, SmsConfiguration, UserPoolTags, AdminCreateUserConfig,
         UserPoolAddOns, AccountRecoverySetting, UserPoolTier, MfaConfiguration, PoolName: .Name}
      | del(.AdminCreateUserConfig.UnusedAccountValidityDays)
      | (if .UserPoolTags then .UserPoolTags |= with_entries(select(.key | startswith("aws:") | not)) else . end)
      | with_entries(select(.value != null))
      | . + {UserPoolId: $id}
      | .AdminCreateUserConfig.AllowAdminCreateUserOnly = true')"
[ -n "${P2F_OOB}" ] || { echo "FAIL: Phase 2f: could not build the out-of-band UpdateUserPool input" >&2; exit 1; }
aws cognito-idp update-user-pool --region "${REGION}" --cli-input-json "${P2F_OOB}" >/dev/null
ADMIN_ONLY_P2F="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" \
  --query 'UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' --output text)"
if [ "${ADMIN_ONLY_P2F}" != "True" ]; then
  echo "FAIL: Phase 2f could not seed the out-of-band change (AllowAdminCreateUserOnly), got '${ADMIN_ONLY_P2F}'" >&2
  exit 1
fi
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 1 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift on the out-of-band AllowAdminCreateUserOnly exited ${DRIFT_RC}, expected 1 (drift)" >&2
  exit 1
fi
case "${DRIFT_OUT}" in
  *"AllowAdminCreateUserOnly"*) ;;
  *) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift did not name AdminCreateUserConfig.AllowAdminCreateUserOnly" >&2; exit 1 ;;
esac
case "${DRIFT_OUT}" in
  *"EnabledMfas"*) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift reported EnabledMfas on the SMS pool before any MFA change" >&2; exit 1 ;;
esac
# Pre-fix: refused by the MFA pre-flight ("MfaConfiguration is OFF while an
# MFA factor is configured ... SmsMfaConfiguration"), exit non-zero.
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
ADMIN_ONLY_P2F_AFTER="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" \
  --query 'UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' --output text)"
if [ "${ADMIN_ONLY_P2F_AFTER}" != "False" ]; then
  echo "FAIL: drift --revert left AllowAdminCreateUserOnly out of band (issue #7175), got '${ADMIN_ONLY_P2F_AFTER}'" >&2
  exit 1
fi
SMS_P2F_AFTER="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query 'SmsMfaConfiguration.SmsConfiguration.SnsCallerArn' --output text)"
if [ "${SMS_P2F_AFTER}" != "${SMS_P2F}" ]; then
  echo "FAIL: drift --revert changed the pool's SMS configuration (issue #7175), got '${SMS_P2F_AFTER}'" >&2
  exit 1
fi
echo "    out-of-band AllowAdminCreateUserOnly reverted, SMS configuration kept"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift after the Phase 2f (#7175) revert exited ${DRIFT_RC}, expected 0" >&2
  exit 1
fi
echo "    cdkd drift clean after the revert"

echo "==> Phase 2f: seed the pre-#7128 leftover beside SMS and its baseline"
SMS_EXT_P2F="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" \
  --query 'UserPool.SmsConfiguration.ExternalId' --output text)"
aws cognito-idp set-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --mfa-configuration OPTIONAL \
  --sms-mfa-configuration "SmsConfiguration={SnsCallerArn=${SMS_P2F},ExternalId=${SMS_EXT_P2F}}" \
  --software-token-mfa-configuration Enabled=true \
  --web-authn-configuration RelyingPartyId=example.com,UserVerification=required >/dev/null
# The same full re-send as 2e (it now carries the SmsConfiguration too).
P2F_INPUT="$(aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}" --output json \
  | jq -c --arg id "${PID}" '.UserPool
      | {Policies, DeletionProtection, LambdaConfig, AutoVerifiedAttributes, SmsVerificationMessage,
         EmailVerificationMessage, EmailVerificationSubject, VerificationMessageTemplate,
         SmsAuthenticationMessage, UserAttributeUpdateSettings, DeviceConfiguration,
         EmailConfiguration, SmsConfiguration, UserPoolTags, AdminCreateUserConfig,
         UserPoolAddOns, AccountRecoverySetting, UserPoolTier, PoolName: .Name}
      | del(.AdminCreateUserConfig.UnusedAccountValidityDays)
      | (if .UserPoolTags then .UserPoolTags |= with_entries(select(.key | startswith("aws:") | not)) else . end)
      | with_entries(select(.value != null))
      | . + {UserPoolId: $id, MfaConfiguration: "OFF"}')"
aws cognito-idp update-user-pool --region "${REGION}" --cli-input-json "${P2F_INPUT}" >/dev/null
MFA_P2F="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query '[MfaConfiguration, SoftwareTokenMfaConfiguration.Enabled, SmsMfaConfiguration.SmsConfiguration.SnsCallerArn]' --output text)"
if [ "${MFA_P2F}" != "$(printf 'OFF\tTrue\t%s' "${SMS_P2F}")" ]; then
  echo "FAIL: Phase 2f could not seed the leftover (expected OFF with SMS and the software token), got '${MFA_P2F}'" >&2
  exit 1
fi
echo "    leftover seeded (OFF, SMS + software token)"
P2F_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
P2F_SEEDED="$(printf '%s' "${P2F_STATE}" | jq '(.resources[] | select(.resourceType == "AWS::Cognito::UserPool") | .observedProperties.EnabledMfas) = ["SMS_MFA", "SOFTWARE_TOKEN_MFA"]')"
[ -n "${P2F_SEEDED}" ] || { echo "FAIL: Phase 2f: the seeded state is empty -- not uploading it" >&2; exit 1; }
printf '%s\n' "${P2F_SEEDED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --content-type application/json >/dev/null
P2F_BASELINE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq -c '[.resources[] | select(.resourceType == "AWS::Cognito::UserPool") | .observedProperties.EnabledMfas][0]')"
if [ "${P2F_BASELINE}" != '["SMS_MFA","SOFTWARE_TOKEN_MFA"]' ]; then
  echo "FAIL: Phase 2f baseline: expected observedProperties.EnabledMfas [SMS_MFA,SOFTWARE_TOKEN_MFA], got '${P2F_BASELINE}'" >&2
  exit 1
fi

echo "==> Phase 2f: cdkd drift reports the leftover beside SMS; --revert clears it"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 1 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift on the leftover beside SMS exited ${DRIFT_RC}, expected 1 (drift): the software token went unreported (issue #7172)" >&2
  exit 1
fi
case "${DRIFT_OUT}" in
  *"EnabledMfas"*) ;;
  *) printf '%s\n' "${DRIFT_OUT}" >&2; echo "FAIL: cdkd drift on the leftover beside SMS did not name EnabledMfas (issue #7172)" >&2; exit 1 ;;
esac
echo "    drift reported on EnabledMfas"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
MFA_P2F_AFTER="$(aws cognito-idp get-user-pool-mfa-config --user-pool-id "${PID}" --region "${REGION}" \
  --query '[MfaConfiguration, SoftwareTokenMfaConfiguration.Enabled, SmsMfaConfiguration.SmsConfiguration.SnsCallerArn, WebAuthnConfiguration.RelyingPartyId]' --output text)"
if [ "${MFA_P2F_AFTER}" != "$(printf 'OFF\tNone\t%s\texample.com' "${SMS_P2F}")" ]; then
  echo "FAIL: drift --revert did not end at OFF with SMS and the relying party kept and no software token (issue #7172), got '${MFA_P2F_AFTER}'" >&2
  exit 1
fi
echo "    software token cleared, SMS and WebAuthn relying party kept"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  printf '%s\n' "${DRIFT_OUT}" >&2
  echo "FAIL: cdkd drift after the Phase 2f revert exited ${DRIFT_RC}, expected 0" >&2
  exit 1
fi
echo "    cdkd drift clean after the revert"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if [ -n "$(pool_id)" ] && [ "$(pool_id)" != "None" ]; then
  echo "FAIL: pool ${POOL_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    pool deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Cognito add-custom-attribute reaches AWS via AddCustomAttributes, the pool renames in place, a UsernameConfiguration change is refused, and removed tags / MFA / account recovery behave as CloudFormation; all phases passed"
