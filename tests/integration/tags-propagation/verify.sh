#!/usr/bin/env bash
#
# Failure-seeking real-AWS validation that STACK-LEVEL tags
# (`cdk.Tags.of(app).add(k, v)` in bin/app.ts) propagate to ALL taggable
# resources across MANY types, on BOTH the cdkd SDK-provider path AND the
# Cloud Control API path.
#
# cdk.Tags.of(...) injects the same N tags into the CFn `Tags` property of
# every taggable resource. cdkd must forward them to AWS correctly for
# every type — but each AWS type accepts tags in a DIFFERENT wire shape
# ({Key,Value}[] list vs { k: v } map vs the CC-API forwarder). Per memory
# feedback_ssm_parameter_tags_is_a_map, AWS::SSM::Parameter.Tags is a MAP
# (not the list almost every other type uses) and a provider doing
# `Tags.map()` crashed deploy. This fixture deliberately tags an SSM
# Parameter so that regression is caught end-to-end.
#
# What this proves that no other fixture does: for EACH of 9 taggable
# types, the verify reads the live AWS-side tags via that type's
# type-specific list/describe API and asserts ALL 3 stack-level tags are
# present with the correct value. A type that DROPS a tag (or crashes on
# the wrong Tags shape at deploy time) FAILs the run NAMING the type.
#
# Also: post-deploy `cdkd drift` must report exit 0 — a tag-list REORDER
# from AWS (per issue #802 canonicalizeTagListsDeep) must NOT show as a
# false-positive drift.
#
# Path split asserted from state.json `provisionedBy`:
#   - SDK path: S3, SNS, SQS, SSM, IAM Role, Logs LogGroup, Lambda, DynamoDB
#   - CC-API path: Athena WorkGroup (no SDK provider -> Cloud Control)
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdTagsPropagationExample (a Tags-shape crash on any
#      type fails here with specifics)
#   3. read state.json; assert routing split (8 sdk + 1 cc-api)
#   4. for each type, read live AWS tags + assert all 3 stack tags present
#   5. cdkd drift -> assert exit 0 (no tag-order false positive, #802)
#   6. cdkd destroy --force
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
# BSD/macOS-portable (no `grep -P`, no `date -d`); real rc captured and an
# explicit `[verify] PASS` printed only on full success.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdTagsPropagationExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/tags-propagation"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The 3 stack-level tags — MUST match bin/app.ts exactly.
EXPECTED_KEYS=("CdkdTagOwner" "CdkdTagEnv" "CdkdTagCostCenter")
EXPECTED_VALS=("cdkd-integ" "test" "cc-1234")

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy (a wrong-Tags-shape crash on any type fails here)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: read state.json + assert routing split (8 sdk + 1 cc-api)"
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "[verify] FAIL: no state at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Helper: extract physicalId for a given resourceType from state.json.
physid_for_type() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""'
}
provisioned_for_type() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.provisionedBy // "sdk"] | first // ""'
}

# Athena WorkGroup must be CC-API-routed (no SDK provider). Everything
# else must be on the SDK path. A routing regression that pulls a tagged
# type onto the wrong path would change which read code runs.
WG_ROUTE="$(provisioned_for_type 'AWS::Athena::WorkGroup')"
if [ "${WG_ROUTE}" != "cc-api" ]; then
  echo "[verify] FAIL: Athena WorkGroup provisionedBy='${WG_ROUTE}', expected 'cc-api' (the CC-API tag-propagation path was not exercised)" >&2
  echo "${STATE}" | jq '.resources | to_entries[] | {type: .value.resourceType, by: .value.provisionedBy}'
  exit 1
fi
echo "[verify]   ok: Athena WorkGroup routed via cc-api"
for T in 'AWS::S3::Bucket' 'AWS::SNS::Topic' 'AWS::SQS::Queue' 'AWS::SSM::Parameter' \
         'AWS::IAM::Role' 'AWS::Logs::LogGroup' 'AWS::Lambda::Function' 'AWS::DynamoDB::Table'; do
  R="$(provisioned_for_type "${T}")"
  if [ "${R}" = "cc-api" ]; then
    echo "[verify] FAIL: ${T} provisionedBy='cc-api', expected 'sdk' (SDK tag path not exercised for this type)" >&2
    exit 1
  fi
done
echo "[verify]   ok: 8 SDK-path types routed via sdk"

# assert_tag <human-label> <newline-separated "key<TAB>value" pairs from AWS>
# Fails NAMING the type if any of the 3 stack tags is missing/wrong.
assert_all_tags() {
  local label="$1"
  local aws_pairs="$2"
  local i key val got
  for i in 0 1 2; do
    key="${EXPECTED_KEYS[$i]}"
    val="${EXPECTED_VALS[$i]}"
    # exact key match on the first field, emit the second field
    got="$(printf '%s\n' "${aws_pairs}" | awk -F'\t' -v k="${key}" '$1==k {print $2; found=1} END{if(!found) exit 0}')"
    if [ -z "${got}" ]; then
      echo "[verify] FAIL: ${label}: stack-level tag '${key}' is MISSING on AWS — this type DROPPED a propagated tag" >&2
      echo "[verify]   AWS-side tags were:" >&2
      printf '%s\n' "${aws_pairs}" >&2
      exit 1
    fi
    if [ "${got}" != "${val}" ]; then
      echo "[verify] FAIL: ${label}: tag '${key}' has value '${got}' on AWS, expected '${val}'" >&2
      exit 1
    fi
  done
  echo "[verify]   ok: ${label} carries all 3 stack-level tags"
}

echo "[verify] step 4: read live AWS tags per type + assert all 3 stack tags present"

# --- S3 Bucket: get-bucket-tagging -> TagSet[{Key,Value}] ---
S3_ID="$(physid_for_type 'AWS::S3::Bucket')"
S3_TAGS="$(aws s3api get-bucket-tagging --bucket "${S3_ID}" --region "${REGION}" \
  --query 'TagSet' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "S3 Bucket (${S3_ID})" "${S3_TAGS}"

# --- SNS Topic: list-tags-for-resource -> Tags[{Key,Value}] ---
SNS_ARN="$(physid_for_type 'AWS::SNS::Topic')"
SNS_TAGS="$(aws sns list-tags-for-resource --resource-arn "${SNS_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "SNS Topic (${SNS_ARN})" "${SNS_TAGS}"

# --- SQS Queue: list-queue-tags -> Tags{ k: v } map ---
SQS_URL="$(physid_for_type 'AWS::SQS::Queue')"
SQS_TAGS="$(aws sqs list-queue-tags --queue-url "${SQS_URL}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "SQS Queue (${SQS_URL})" "${SQS_TAGS}"

# --- SSM Parameter: list-tags-for-resource -> TagList[{Key,Value}]
#     (CFn Tags is a MAP -> the historical crash type) ---
SSM_NAME="$(physid_for_type 'AWS::SSM::Parameter')"
SSM_TAGS="$(aws ssm list-tags-for-resource --resource-type Parameter --resource-id "${SSM_NAME}" \
  --region "${REGION}" --query 'TagList' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "SSM Parameter (${SSM_NAME})" "${SSM_TAGS}"

# --- IAM Role: list-role-tags -> Tags[{Key,Value}] (IAM is global) ---
IAM_ROLE="$(physid_for_type 'AWS::IAM::Role')"
IAM_TAGS="$(aws iam list-role-tags --role-name "${IAM_ROLE}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "IAM Role (${IAM_ROLE})" "${IAM_TAGS}"

# --- Logs LogGroup: list-tags-for-resource -> tags{ k: v } map ---
LOG_NAME="$(physid_for_type 'AWS::Logs::LogGroup')"
LOG_ARN="arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_NAME}"
LOG_TAGS="$(aws logs list-tags-for-resource --resource-arn "${LOG_ARN}" --region "${REGION}" \
  --query 'tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "Logs LogGroup (${LOG_NAME})" "${LOG_TAGS}"

# --- Lambda Function: list-tags -> Tags{ k: v } map ---
FN_NAME="$(physid_for_type 'AWS::Lambda::Function')"
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FN_NAME}"
FN_TAGS="$(aws lambda list-tags --resource "${FN_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r 'to_entries[] | "\(.key)\t\(.value)"')"
assert_all_tags "Lambda Function (${FN_NAME})" "${FN_TAGS}"

# --- DynamoDB Table: list-tags-of-resource -> Tags[{Key,Value}] ---
DDB_NAME="$(physid_for_type 'AWS::DynamoDB::Table')"
DDB_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DDB_NAME}"
DDB_TAGS="$(aws dynamodb list-tags-of-resource --resource-arn "${DDB_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "DynamoDB Table (${DDB_NAME})" "${DDB_TAGS}"

# --- Athena WorkGroup (CC-API path): list-tags-for-resource -> Tags[{Key,Value}] ---
WG_NAME="$(physid_for_type 'AWS::Athena::WorkGroup')"
WG_ARN="arn:aws:athena:${REGION}:${ACCOUNT_ID}:workgroup/${WG_NAME}"
WG_TAGS="$(aws athena list-tags-for-resource --resource-arn "${WG_ARN}" --region "${REGION}" \
  --query 'Tags' --output json | jq -r '.[] | "\(.Key)\t\(.Value)"')"
assert_all_tags "Athena WorkGroup [CC-API] (${WG_NAME})" "${WG_TAGS}"

echo "[verify] step 5: cdkd drift immediately after deploy (expect exit 0, no #802 tag-order false positive)"
set +e
${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: a clean deploy reported drift (exit ${rc}) — likely a tag-list reorder false positive (#802 canonicalizeTagListsDeep) or a tag-shape readback mismatch" >&2
  exit 1
fi
echo "[verify]   ok: clean deploy is drift-free (no tag-order false positive)"

echo "[verify] step 6: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

trap - EXIT INT TERM
echo "[verify] PASS"
