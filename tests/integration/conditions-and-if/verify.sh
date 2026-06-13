#!/usr/bin/env bash
# verify.sh - cdkd conditions-and-if integ.
#
# SURFACES bugs in cdkd's CloudFormation Conditions + Fn::If handling. cdkd
# must itself evaluate the Conditions section + the resource-level
# `Condition:` key + Fn::If / Fn::Equals / Fn::And / Fn::Or / Fn::Not (there
# is no CloudFormation engine underneath it).
#
# Two deploys flip the `tier` CDK context (-c tier=premium|basic), which
# flips the Tier CfnParameter Default at synth time (cdkd has no deploy-time
# --parameter flag; parameters resolve from the template Default). The same
# stack is asserted against AWS in BOTH settings:
#
#   Phase 1 (premium): condition-gated resources PRESENT, Fn::If premium
#     branches reached AWS, Fn::If DisplayName SET (not NoValue).
#   Phase 2 (basic, redeploy in place): condition-gated resources now
#     ABSENT, Fn::If basic branches reached AWS, Fn::If DisplayName OMITTED
#     (AWS::NoValue -> property genuinely missing on AWS).
#   Phase 3: destroy + clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
#
# BSD/macOS portable: no `grep -P`, no `date -d`. Real rc + explicit PASS.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdConditionsIfExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

TIER_LABEL_PARAM="/cdkd-conditions-if/${ACCOUNT_ID}/tier-label"
PREMIUM_ONLY_PARAM="/cdkd-conditions-if/${ACCOUNT_ID}/premium-only"
PREMIUM_PRIMARY_PARAM="/cdkd-conditions-if/${ACCOUNT_ID}/premium-primary"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# Captured at deploy time so cleanup / absence checks can find the topic.
TOPIC_ARN=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Defensive direct cleanup in case destroy did not run / left orphans.
  aws ssm delete-parameter --name "${TIER_LABEL_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PREMIUM_ONLY_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PREMIUM_PRIMARY_PARAM}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Helper: read an SSM parameter Value, or print empty if the parameter does
# not exist. Never aborts under set -e.
ssm_value() {
  local name="$1"
  local out
  out=$(aws ssm get-parameter --name "${name}" --region "${REGION}" \
    --query 'Parameter.Value' --output text 2>/dev/null) || out=""
  echo "${out}"
}

# Helper: does an SSM parameter exist? rc 0 = yes, 1 = no.
ssm_exists() {
  aws ssm get-parameter --name "$1" --region "${REGION}" >/dev/null 2>&1
}

# Helper: fetch a single tag value from the topic's SNS tags, or empty.
topic_tag_value() {
  local key="$1"
  aws sns list-tags-for-resource --resource-arn "${TOPIC_ARN}" --region "${REGION}" \
    --query "Tags[?Key=='${key}'].Value | [0]" --output text 2>/dev/null
}

# ====================================================================
# Phase 1: deploy premium tier
# ====================================================================
echo ""
echo "==> Phase 1: deploy with -c tier=premium (premium + primary region)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c tier=premium \
  --yes

# --- Fn::If branch on the always-created parameter (premium branch) ---
LABEL=$(ssm_value "${TIER_LABEL_PARAM}")
if [ "${LABEL}" != "tier-is-premium" ]; then
  echo "FAIL: TierLabelParam Value is '${LABEL}', expected 'tier-is-premium' (Fn::If premium branch)" >&2
  exit 1
fi
echo "    OK: Fn::If property branch reached AWS == 'tier-is-premium'"

# --- Condition-gated resource creation: PRESENT in premium ------------
if ! ssm_exists "${PREMIUM_ONLY_PARAM}"; then
  echo "FAIL: PremiumOnlyParam '${PREMIUM_ONLY_PARAM}' is ABSENT but should exist in premium tier" >&2
  exit 1
fi
echo "    OK: condition-gated PremiumOnlyParam (Fn::Equals) PRESENT in premium"

# --- Compound (Fn::And) condition-gated resource: PRESENT -------------
if ! ssm_exists "${PREMIUM_PRIMARY_PARAM}"; then
  echo "FAIL: PremiumPrimaryParam '${PREMIUM_PRIMARY_PARAM}' is ABSENT but should exist (premium AND primary)" >&2
  exit 1
fi
echo "    OK: Fn::And condition-gated PremiumPrimaryParam PRESENT in premium+primary"

# --- Resolve the topic ARN from cdkd state for SNS assertions ---------
TOPIC_ARN=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
  | jq -r '.outputs.TopicArn // empty')
if [ -z "${TOPIC_ARN}" ]; then
  echo "FAIL: could not resolve TopicArn from cdkd state output" >&2
  exit 1
fi
echo "    OK: resolved topic ARN ${TOPIC_ARN}"

# --- Fn::If -> set DisplayName (premium): property PRESENT ------------
DISPLAY=$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text 2>/dev/null) || DISPLAY=""
if [ "${DISPLAY}" != "Premium Notifications" ]; then
  echo "FAIL: SNS DisplayName is '${DISPLAY}', expected 'Premium Notifications' (Fn::If set branch)" >&2
  exit 1
fi
echo "    OK: Fn::If DisplayName SET to 'Premium Notifications' in premium"

# --- Fn::If branch on a tag value (premium) ---------------------------
TIER_TAG=$(topic_tag_value "Tier")
if [ "${TIER_TAG}" != "premium" ]; then
  echo "FAIL: SNS Tier tag is '${TIER_TAG}', expected 'premium' (Fn::If tag branch)" >&2
  exit 1
fi
echo "    OK: Fn::If tag value branch reached AWS == 'premium'"

# --- Fn::Or condition reflected in a tag (premium arm true) -----------
OR_TAG=$(topic_tag_value "PremiumOrSecondary")
if [ "${OR_TAG}" != "yes" ]; then
  echo "FAIL: SNS PremiumOrSecondary tag is '${OR_TAG}', expected 'yes' (Fn::Or true)" >&2
  exit 1
fi
echo "    OK: Fn::Or condition branch reached AWS == 'yes'"

# ====================================================================
# Phase 2: redeploy basic tier (in place) -> conditions flip
# ====================================================================
echo ""
echo "==> Phase 2: redeploy with -c tier=basic (conditions flip)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c tier=basic \
  --yes

# --- Fn::If branch on the always-created parameter (basic branch) -----
LABEL=$(ssm_value "${TIER_LABEL_PARAM}")
if [ "${LABEL}" != "tier-is-basic" ]; then
  echo "FAIL: TierLabelParam Value is '${LABEL}', expected 'tier-is-basic' (Fn::If basic branch)" >&2
  exit 1
fi
echo "    OK: Fn::If property branch flipped on AWS == 'tier-is-basic'"

# --- Condition-gated resource creation: now ABSENT --------------------
if ssm_exists "${PREMIUM_ONLY_PARAM}"; then
  echo "FAIL: PremiumOnlyParam '${PREMIUM_ONLY_PARAM}' STILL EXISTS but should be removed in basic tier" >&2
  exit 1
fi
echo "    OK: condition-gated PremiumOnlyParam ABSENT in basic (resource removed)"

if ssm_exists "${PREMIUM_PRIMARY_PARAM}"; then
  echo "FAIL: PremiumPrimaryParam '${PREMIUM_PRIMARY_PARAM}' STILL EXISTS but should be removed (not premium+primary)" >&2
  exit 1
fi
echo "    OK: Fn::And condition-gated PremiumPrimaryParam ABSENT in basic"

# --- Fn::If -> AWS::NoValue (basic): DisplayName property OMITTED ------
# SNS get-topic-attributes simply does not include the DisplayName key when
# it was never set. `--output text` on a missing key prints "None".
DISPLAY=$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text 2>/dev/null) || DISPLAY=""
if [ -n "${DISPLAY}" ] && [ "${DISPLAY}" != "None" ]; then
  echo "FAIL: SNS DisplayName is '${DISPLAY}', expected ABSENT (Fn::If -> AWS::NoValue)" >&2
  exit 1
fi
echo "    OK: Fn::If -> AWS::NoValue OMITTED DisplayName on AWS in basic"

# --- Fn::If tag value flipped to basic --------------------------------
TIER_TAG=$(topic_tag_value "Tier")
if [ "${TIER_TAG}" != "basic" ]; then
  echo "FAIL: SNS Tier tag is '${TIER_TAG}', expected 'basic' after flip" >&2
  exit 1
fi
echo "    OK: Fn::If tag value flipped on AWS == 'basic'"

# --- Fn::Or now false (basic + primary): tag flips to 'no' ------------
OR_TAG=$(topic_tag_value "PremiumOrSecondary")
if [ "${OR_TAG}" != "no" ]; then
  echo "FAIL: SNS PremiumOrSecondary tag is '${OR_TAG}', expected 'no' (Fn::Or false)" >&2
  exit 1
fi
echo "    OK: Fn::Or condition flipped on AWS == 'no'"

# ====================================================================
# Phase 3: destroy + clean
# ====================================================================
echo ""
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ssm_exists "${TIER_LABEL_PARAM}"; then
  echo "FAIL: TierLabelParam still exists after destroy" >&2
  exit 1
fi
if aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SNS topic '${TOPIC_ARN}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: all AWS resources gone after destroy"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> conditions-and-if test passed (All 14 assertions passed)"
