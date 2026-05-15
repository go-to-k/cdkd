#!/usr/bin/env bash
#
# End-to-end real-AWS test for cdkd's AWS::DynamoDB::GlobalTable SDK
# Provider (Issue #383). Verifies that a `dynamodb.TableV2` deployment
# produces a `${StackName}-X<hash>` AWS-side table name (not a CC-API
# auto-generated random string), that subsequent in-place UPDATE deploys
# round-trip cleanly through cdkd's serialized UpdateTable / TagResource
# / UpdateTimeToLive pipeline, and that destroy cleans up the table.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDynamoDBGlobalTableExample
#   3. read the deployed table name from cdkd state and assert it starts
#      with the cdkd `${StackName}-` prefix
#   4. assert the deployed table exists on AWS via DescribeTable
#   5. cdkd deploy with CDKD_TEST_UPDATE=ttl,tags — in-place update
#   6. assert TTL is now ENABLED and the UpdateTest tag is present
#   7. cdkd destroy --force
#   8. assert the AWS-side table is gone and cdkd state is empty
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDynamoDBGlobalTableExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/dynamodb-globaltable"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    # Retry once on dependency errors (AWS DynamoDB delete can lag briefly).
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || \
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy (baseline — no UPDATE flags)"
unset CDKD_TEST_UPDATE
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: read deployed table name from cdkd state"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
TABLE_NAME="$(echo "${STATE_JSON}" | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable":
        print(resource["physicalId"])
        break
')"
if [ -z "${TABLE_NAME}" ]; then
  echo "[verify] FAIL: no AWS::DynamoDB::GlobalTable resource in cdkd state"
  exit 1
fi
echo "[verify] step 3 ok: deployed table name = ${TABLE_NAME}"

# The canonical bug fix assertion: pre-PR the name was an opaque random
# string (`yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV`-style); post-PR it
# MUST start with `${StackName}-`. Allow case-insensitive match because
# `generateResourceName`'s sanitize pipeline may lowercase / dash-replace
# characters.
case "${TABLE_NAME}" in
  "${STACK}-"*)
    echo "[verify] step 3 ok: name has the expected '${STACK}-' prefix"
    ;;
  *)
    echo "[verify] FAIL: deployed table name '${TABLE_NAME}' does not start with '${STACK}-'"
    echo "[verify]   (pre-PR bug: CC API auto-generated random names; the new SDK Provider must apply cdkd's stack-name prefix)"
    exit 1
    ;;
esac

echo "[verify] step 4: assert table exists on AWS"
aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null
echo "[verify] step 4 ok: DescribeTable succeeded"

echo "[verify] step 5: cdkd deploy with CDKD_TEST_UPDATE=ttl,tags (in-place update)"
CDKD_TEST_UPDATE=ttl,tags ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 6: assert TTL is now ENABLED and UpdateTest tag is present"
TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)"
if [ "${TTL_STATUS}" != "ENABLED" ] && [ "${TTL_STATUS}" != "ENABLING" ]; then
  echo "[verify] FAIL: TimeToLive on '${TABLE_NAME}' is '${TTL_STATUS}' after the UPDATE deploy (expected ENABLED / ENABLING)"
  exit 1
fi
echo "[verify] step 6a ok: TTL = ${TTL_STATUS}"

TABLE_ARN="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.TableArn' --output text)"
TAG_VALUE="$(aws dynamodb list-tags-of-resource --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query "Tags[?Key=='UpdateTest'].Value | [0]" --output text)"
if [ "${TAG_VALUE}" != "true" ]; then
  echo "[verify] FAIL: UpdateTest tag was not applied (got '${TAG_VALUE}')"
  exit 1
fi
echo "[verify] step 6b ok: UpdateTest tag present"

echo "[verify] step 7: cdkd destroy --force"
unset CDKD_TEST_UPDATE
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 8: assert table is gone on AWS"
if aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: table '${TABLE_NAME}' still exists after destroy"
  exit 1
fi
echo "[verify] step 8 ok: table deleted"

echo "[verify] step 9: assert cdkd state is empty"
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state file still exists at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
echo "[verify] step 9 ok: cdkd state cleared"

trap - EXIT
echo "[verify] PASS"
