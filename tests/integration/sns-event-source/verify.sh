#!/usr/bin/env bash
# verify.sh — cdkd SNS -> Lambda (SnsEventSource) functional integ.
#
# `fn.addEventSource(new SnsEventSource(topic))` synthesizes an
# AWS::SNS::Subscription (Protocol=lambda) + an AWS::Lambda::Permission. The only
# prior SNS->Lambda coverage (event-driven) uses topic.addSubscription and has no
# verify.sh, so delivery was never proven. This test publishes a message and
# asserts the handler ran by checking it recorded the SNS MessageId in DynamoDB.
#
# Phases:
#   1. Deploy. Assert the topic has a confirmed lambda subscription.
#   2. Functional: publish a message, poll DynamoDB until the MessageId appears.
#   3. Destroy + assert the topic, table and state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSnsEventSourceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-sns-evt-msgs"
TOPIC_NAME="cdkd-sns-evt-topic"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

TOPIC_ARN=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  ARN="$(aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null)"
  if [ -n "${ARN}" ] && [ "${ARN}" != "None" ]; then
    aws sns delete-topic --topic-arn "${ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  sweep_log_groups
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TOPIC_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.TopicArn')"
if [ -z "${TOPIC_ARN}" ] || [ "${TOPIC_ARN}" = "null" ]; then
  echo "FAIL: could not resolve TopicArn output after deploy" >&2
  exit 1
fi

SUB_COUNT="$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query "length(Subscriptions[?Protocol=='lambda'])" --output text)"
if [ "${SUB_COUNT}" = "0" ] || [ "${SUB_COUNT}" = "None" ]; then
  echo "FAIL: topic ${TOPIC_ARN} has no lambda subscription after deploy" >&2
  exit 1
fi
echo "    OK: topic has a lambda subscription"

# --- Phase 2: functional — publish, prove the Lambda fired ------------
echo "==> Phase 2: publish a message and assert delivery"
MSG_ID="$(aws sns publish --topic-arn "${TOPIC_ARN}" --message "cdkd sns-event-source probe" \
  --region "${REGION}" --query MessageId --output text)"
echo "    published MessageId=${MSG_ID}"

RECORDED=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  RECORDED="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
    --key "{\"id\":{\"S\":\"${MSG_ID}\"}}" --query 'Item.id.S' --output text 2>/dev/null || echo "")"
  if [ "${RECORDED}" = "${MSG_ID}" ]; then break; fi
  echo "    waiting for delivery (attempt ${i})..."
  sleep 3 || true
done
if [ "${RECORDED}" != "${MSG_ID}" ]; then
  echo "FAIL: Lambda did not record MessageId '${MSG_ID}' (subscription never delivered)" >&2
  exit 1
fi
echo "    OK: SNS delivered — Lambda recorded MessageId in DynamoDB"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null | grep -q "${TOPIC_NAME}"; then
  echo "FAIL: topic ${TOPIC_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: topic is gone"

TBL_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.TableStatus' --output text 2>/dev/null || echo "GONE")"
if [ "${TBL_STATUS}" != "GONE" ] && [ "${TBL_STATUS}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${TBL_STATUS}) after destroy" >&2
  exit 1
fi
echo "    OK: table deleted (status: ${TBL_STATUS})"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — SNS -> Lambda (SnsEventSource) delivered end-to-end, all 3 phases passed"
