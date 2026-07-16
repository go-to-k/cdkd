#!/usr/bin/env bash
# verify.sh — cdkd SES EmailIdentity + ConfigurationSet integ.
#
# First SES coverage in the integ suite. Both types route via Cloud Control
# (no SDK provider), so this guards the CC-API CREATE / UPDATE-patch / DELETE
# path on SES. Confirmed-clean /hunt-bugs pattern; regression guard.
#
# Phases:
#   1. Deploy; assert the identity exists, is bound to the ConfigurationSet,
#      and reputation metrics are OFF.
#   2. Re-deploy with CDKD_TEST_UPDATE=true; assert reputation metrics flip ON
#      (ConfigurationSet UPDATE) and the Mail-From domain attaches
#      (EmailIdentity UPDATE).
#   3. Destroy + assert identity + config set are gone and the cdkd state is
#      removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdSesIdentityExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IDENTITY="cdkd-integ-ses.example.com"
CONFIG_SET="cdkd-integ-ses-config-set"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws sesv2 delete-email-identity --email-identity "${IDENTITY}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sesv2 delete-configuration-set --configuration-set-name "${CONFIG_SET}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

# --- Phase 1: deploy baseline (reputation off, no Mail-From) ------------
echo "==> Phase 1: deploy SES identity + configuration set"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BOUND_CONFIG_SET="$(aws sesv2 get-email-identity --email-identity "${IDENTITY}" --region "${REGION}" \
  --query 'ConfigurationSetName' --output text)"
if [ "${BOUND_CONFIG_SET}" != "${CONFIG_SET}" ]; then
  echo "FAIL: identity not bound to ${CONFIG_SET}, got '${BOUND_CONFIG_SET}'" >&2
  exit 1
fi
REPUTATION_P1="$(aws sesv2 get-configuration-set --configuration-set-name "${CONFIG_SET}" --region "${REGION}" \
  --query 'ReputationOptions.ReputationMetricsEnabled' --output text)"
if [ "${REPUTATION_P1}" != "False" ] && [ "${REPUTATION_P1}" != "false" ]; then
  echo "FAIL: expected reputation metrics off after Phase 1, got '${REPUTATION_P1}'" >&2
  exit 1
fi
echo "    identity bound to config set; reputation metrics off"

# --- Phase 2: flip reputation on + attach Mail-From ----------------------
echo "==> Phase 2: re-deploy flipping reputation metrics + attaching Mail-From"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

REPUTATION_P2="$(aws sesv2 get-configuration-set --configuration-set-name "${CONFIG_SET}" --region "${REGION}" \
  --query 'ReputationOptions.ReputationMetricsEnabled' --output text)"
if [ "${REPUTATION_P2}" != "True" ] && [ "${REPUTATION_P2}" != "true" ]; then
  echo "FAIL: expected reputation metrics ON after update, got '${REPUTATION_P2}'" >&2
  exit 1
fi
MAIL_FROM="$(aws sesv2 get-email-identity --email-identity "${IDENTITY}" --region "${REGION}" \
  --query 'MailFromAttributes.MailFromDomain' --output text)"
if [ "${MAIL_FROM}" != "mail.${IDENTITY}" ]; then
  echo "FAIL: expected Mail-From mail.${IDENTITY}, got '${MAIL_FROM}'" >&2
  exit 1
fi
echo "    reputation metrics on; Mail-From attached — both in-place updates OK"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws sesv2 get-email-identity --email-identity "${IDENTITY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: email identity ${IDENTITY} still exists after destroy" >&2
  exit 1
fi
if aws sesv2 get-configuration-set --configuration-set-name "${CONFIG_SET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: configuration set ${CONFIG_SET} still exists after destroy" >&2
  exit 1
fi
echo "    identity + configuration set deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — SES EmailIdentity + ConfigurationSet deploy/update/destroy, all 3 phases passed"
