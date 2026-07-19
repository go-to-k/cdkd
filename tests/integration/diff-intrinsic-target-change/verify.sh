#!/usr/bin/env bash
# verify.sh — Diff-calculator must detect IAM-policy Fn::GetAtt target rebinding.
#
# Reproduces the bug surfaced from cdk-sample's StaticSite refactor
# (2026-05-16): an IAM inline policy whose `Resource` is `Fn::GetAtt:
# [Bucket, Arn]` was silently NOT updated when the bucket's logical ID
# changed (refactor moved it into a Construct wrapper). The policy stayed
# pointed at the deleted old bucket's ARN, and any subsequent action
# against the new bucket failed with AccessDenied.
#
# Flow:
#   1. VARIANT=v1 deploy — bucket at stack root.
#   2. Snapshot role's inline DefaultPolicy: must reference v1 bucket's ARN.
#   3. VARIANT=v2 deploy — bucket moved into a Construct (logical ID changed).
#      The IAM Policy's logical ID is unchanged; only its PolicyDocument
#      should be UPDATEd to reference the v2 bucket's ARN.
#   4. Re-fetch the inline policy: must reference v2 bucket's ARN, NOT v1's.
#   5. cdkd destroy — clean removal.
#
# Run via: /run-integ diff-intrinsic-target-change
#         or: bash tests/integration/diff-intrinsic-target-change/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="CdkdDiffIntrinsicTargetChange"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Build cdkd (the binary we exec via $CDKD).
echo ""
echo "==> Building cdkd"
(cd ../../.. && vp run build) >/dev/null

# --------------------------------------------------------------------
# Step 1: VARIANT=v1 deploy.
# --------------------------------------------------------------------
echo ""
echo "==> Step 1: VARIANT=v1 deploy"
VARIANT=v1 ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes

# --------------------------------------------------------------------
# Step 2: Capture v1 bucket name + role's inline policy Resource list.
# --------------------------------------------------------------------
echo ""
echo "==> Step 2: capture v1 bucket and IAM policy Resource list"
V1_STATE=$(${CDKD} state show ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --json)
V1_BUCKET=$(echo "${V1_STATE}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for k, r in data["state"]["resources"].items():
    if r["resourceType"] == "AWS::S3::Bucket":
        print(r["physicalId"])
        break
')
ROLE_NAME=$(echo "${V1_STATE}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for k, r in data["state"]["resources"].items():
    if r["resourceType"] == "AWS::IAM::Role":
        print(r["physicalId"])
        break
')
POLICY_NAME=$(echo "${V1_STATE}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for k, r in data["state"]["resources"].items():
    if r["resourceType"] == "AWS::IAM::Policy":
        print(r["physicalId"])
        break
')
echo "  V1_BUCKET  = ${V1_BUCKET}"
echo "  ROLE_NAME  = ${ROLE_NAME}"
echo "  POLICY_NAME= ${POLICY_NAME}"

V1_POLICY_DOC=$(aws iam get-role-policy --region "${AWS_REGION}" --role-name "${ROLE_NAME}" --policy-name "${POLICY_NAME}" --query 'PolicyDocument' --output json)
if ! echo "${V1_POLICY_DOC}" | grep -q "${V1_BUCKET}"; then
  echo "FAIL: v1 sanity check — IAM policy does not reference v1 bucket ${V1_BUCKET}"
  echo "${V1_POLICY_DOC}"
  exit 1
fi
echo "  OK: v1 policy references v1 bucket"

# --------------------------------------------------------------------
# Step 3: VARIANT=v2 deploy — bucket moves into Wrapper.
# --------------------------------------------------------------------
echo ""
echo "==> Step 3: VARIANT=v2 deploy (bucket logical ID changes)"
VARIANT=v2 ${CDKD} deploy ${STACK} \
  --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes

# --------------------------------------------------------------------
# Step 4: Verify the policy was UPDATEd to reference v2 bucket.
# --------------------------------------------------------------------
echo ""
echo "==> Step 4: verify IAM policy reflects v2 bucket"
V2_STATE=$(${CDKD} state show ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --json)
V2_BUCKET=$(echo "${V2_STATE}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for k, r in data["state"]["resources"].items():
    if r["resourceType"] == "AWS::S3::Bucket":
        print(r["physicalId"])
        break
')
echo "  V2_BUCKET  = ${V2_BUCKET}"

if [[ "${V1_BUCKET}" == "${V2_BUCKET}" ]]; then
  echo "FAIL: bucket physical IDs identical across v1/v2 — refactor didn't change logical ID"
  exit 1
fi

V2_POLICY_DOC=$(aws iam get-role-policy --region "${AWS_REGION}" --role-name "${ROLE_NAME}" --policy-name "${POLICY_NAME}" --query 'PolicyDocument' --output json)

if echo "${V2_POLICY_DOC}" | grep -q "${V1_BUCKET}"; then
  echo "FAIL (bug): IAM policy still references v1 bucket ${V1_BUCKET} after v2 deploy"
  echo "${V2_POLICY_DOC}"
  exit 1
fi
if ! echo "${V2_POLICY_DOC}" | grep -q "${V2_BUCKET}"; then
  echo "FAIL: IAM policy does not reference v2 bucket ${V2_BUCKET} after v2 deploy"
  echo "${V2_POLICY_DOC}"
  exit 1
fi
echo "  OK: v2 policy correctly references v2 bucket only"

# --------------------------------------------------------------------
# Step 5: destroy.
# --------------------------------------------------------------------
echo ""
echo "==> Step 5: cdkd destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

# Verify state is gone.
if ${CDKD} state list --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1 | grep -q "${STACK}"; then
  echo "FAIL: cdkd state still has ${STACK} after destroy"
  exit 1
fi

echo ""
echo "==> PASS: diff-calculator detected Fn::GetAtt target rebinding"
