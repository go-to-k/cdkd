#!/usr/bin/env bash
# verify.sh — cdkd LogGroup KmsKeyId in-place update integ (issue #958 item 1).
#
# Regression coverage for the bug where changing a log group's KmsKeyId on
# redeploy was silently dropped: ReplacementRulesRegistry classifies the
# property as updateable, but logs-loggroup-provider.update() had no KmsKeyId
# branch, so the association reported deploy success while AWS kept the log
# group unencrypted (state recorded the key, so the next diff saw no change
# and it could never self-heal). CloudFormation applies it in place via
# AssociateKmsKey / DisassociateKmsKey.
#
# Phases:
#   1. Deploy a log group WITHOUT a key (the stack's KMS key exists but is
#      not associated). Assert AWS reports no kmsKeyId.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (associate the key). Assert AWS
#      now reports the key ARN (the association reached AWS, not just state).
#   3. Re-deploy phase 1 again (remove the reference). Assert AWS reports no
#      kmsKeyId (the DISASSOCIATE direction also reaches AWS).
#   4. Destroy + assert the log group is gone and cdkd state removed. The KMS
#      key enters its AWS-mandated 7-day pending-deletion window (not an
#      orphan).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLoggroupKmsAssociateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
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

state_output() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c "import json,sys; s=json.load(sys.stdin); print(s['outputs']['$1'])"
}

lg_kms() {
  # kmsKeyId is omitted when no key is associated — normalize to NONE.
  local kid
  kid="$(aws logs describe-log-groups --log-group-name-prefix "$1" --region "${REGION}" \
    --query "logGroups[?logGroupName=='$1'] | [0].kmsKeyId" --output text)"
  if [ "${kid}" = "None" ]; then
    echo "NONE"
  else
    echo "${kid}"
  fi
}

# --- Phase 1: deploy without a key --------------------------------------
echo "==> Phase 1: deploy log group WITHOUT a KMS key"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LG="$(state_output LgName)"
KEY_ARN="$(state_output KeyArn)"
echo "    log group: ${LG}"
echo "    key: ${KEY_ARN}"

KMS_P1="$(lg_kms "${LG}")"
echo "    AWS kmsKeyId (Phase 1): ${KMS_P1}"
if [ "${KMS_P1}" != "NONE" ]; then
  echo "FAIL: expected no kmsKeyId after Phase 1, got '${KMS_P1}'" >&2
  exit 1
fi

# --- Phase 2: associate the key (must reach AWS) --------------------------
echo "==> Phase 2: re-deploy associating the key (AssociateKmsKey)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

KMS_P2="$(lg_kms "${LG}")"
echo "    AWS kmsKeyId (Phase 2): ${KMS_P2}"
if [ "${KMS_P2}" != "${KEY_ARN}" ]; then
  echo "FAIL: expected kmsKeyId '${KEY_ARN}' after Phase 2 (association silently dropped?), got '${KMS_P2}'" >&2
  exit 1
fi
echo "    key associated (reached AWS, not just cdkd state)"

# --- Phase 3: remove the key (disassociate must reach AWS) ----------------
echo "==> Phase 3: re-deploy removing the key reference (DisassociateKmsKey)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

KMS_P3="$(lg_kms "${LG}")"
echo "    AWS kmsKeyId (Phase 3): ${KMS_P3}"
if [ "${KMS_P3}" != "NONE" ]; then
  echo "FAIL: expected no kmsKeyId after Phase 3 (disassociation silently dropped?), got '${KMS_P3}'" >&2
  exit 1
fi
echo "    key disassociated (reached AWS)"

# --- Phase 4: destroy ------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FOUND="$(aws logs describe-log-groups --log-group-name-prefix "${LG}" --region "${REGION}" \
  --query 'length(logGroups)' --output text)"
if [ "${FOUND}" != "0" ]; then
  echo "FAIL: log group ${LG} still exists after destroy" >&2
  exit 1
fi
echo "    log group deleted"

# NotFoundException -> GONE; any OTHER failure (throttle, creds) must surface
# as a hard failure rather than masquerading as a deleted key.
KEY_STATE="$(aws kms describe-key --key-id "${KEY_ARN}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text 2>&1)" || {
  if echo "${KEY_STATE}" | grep -q "NotFoundException"; then
    KEY_STATE="GONE"
  else
    echo "FAIL: describe-key failed unexpectedly: ${KEY_STATE}" >&2
    exit 1
  fi
}
if [ "${KEY_STATE}" != "PendingDeletion" ] && [ "${KEY_STATE}" != "GONE" ]; then
  echo "FAIL: expected the KMS key to be PendingDeletion after destroy, got '${KEY_STATE}'" >&2
  exit 1
fi
echo "    KMS key state: ${KEY_STATE} (7-day pending window is AWS-mandated, not an orphan)"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — LogGroup KmsKeyId associate + disassociate both reach AWS, all 4 phases passed"
