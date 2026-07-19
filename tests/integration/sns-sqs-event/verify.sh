#!/usr/bin/env bash
# verify.sh — cdkd SNS/SQS messaging-attribute backfill integ test
# (issue #609).
#
# Asserts that the messaging attributes wired by the #609 backfill actually
# reach AWS on deploy:
#   - AWS::SQS::Queue RedriveAllowPolicy on the dead-letter queue
#     (redrivePermission=allowAll), via SetQueueAttributes / CreateQueue.
#   - AWS::SNS::Subscription RawMessageDelivery on the primary subscription
#     (true) and RedrivePolicy on the secondary subscription (a
#     deadLetterQueue), both via the Subscribe Attributes map.
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSnsSqsEventExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

TOPIC_NAME="cdkd-sns-sqs-test-topic"
DLQ_NAME="cdkd-sns-sqs-test-dlq"
PRIMARY_QUEUE_NAME="cdkd-sns-sqs-test-primary"
SECONDARY_QUEUE_NAME="cdkd-sns-sqs-test-secondary"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
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

# --- Assertion 1: SQS RedriveAllowPolicy reached AWS on the DLQ -----------
DLQ_URL=$(aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}" \
  --query 'QueueUrl' --output text)
RDAP=$(aws sqs get-queue-attributes \
  --queue-url "${DLQ_URL}" \
  --attribute-names RedriveAllowPolicy \
  --region "${REGION}" \
  --query 'Attributes.RedriveAllowPolicy' --output text 2>/dev/null)
# The SQS API returns RedriveAllowPolicy as a JSON string; parse the
# redrivePermission field with jq.
PERMISSION=$(echo "${RDAP}" | jq -r '.redrivePermission // empty')
if [ "${PERMISSION}" != "allowAll" ]; then
  echo "FAIL: DLQ RedriveAllowPolicy redrivePermission is '${PERMISSION}', expected 'allowAll'" >&2
  echo "      raw RedriveAllowPolicy: ${RDAP}" >&2
  exit 1
fi
echo "    OK: DLQ RedriveAllowPolicy.redrivePermission == 'allowAll' on AWS (SQS backfill CLOSED)"

# --- Resolve the topic + subscription ARNs --------------------------------
TOPIC_ARN=$(aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
  --output text)
if [ -z "${TOPIC_ARN}" ] || [ "${TOPIC_ARN}" = "None" ]; then
  echo "FAIL: could not resolve topic ARN for ${TOPIC_NAME}" >&2
  exit 1
fi

# Endpoints are the subscribed queue ARNs.
PRIMARY_QUEUE_URL=$(aws sqs get-queue-url --queue-name "${PRIMARY_QUEUE_NAME}" \
  --region "${REGION}" --query 'QueueUrl' --output text)
PRIMARY_QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "${PRIMARY_QUEUE_URL}" \
  --attribute-names QueueArn --region "${REGION}" \
  --query 'Attributes.QueueArn' --output text)
SECONDARY_QUEUE_URL=$(aws sqs get-queue-url --queue-name "${SECONDARY_QUEUE_NAME}" \
  --region "${REGION}" --query 'QueueUrl' --output text)
SECONDARY_QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "${SECONDARY_QUEUE_URL}" \
  --attribute-names QueueArn --region "${REGION}" \
  --query 'Attributes.QueueArn' --output text)

SUBS=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}")
PRIMARY_SUB_ARN=$(echo "${SUBS}" | jq -r \
  --arg ep "${PRIMARY_QUEUE_ARN}" \
  '.Subscriptions[] | select(.Endpoint == $ep) | .SubscriptionArn')
SECONDARY_SUB_ARN=$(echo "${SUBS}" | jq -r \
  --arg ep "${SECONDARY_QUEUE_ARN}" \
  '.Subscriptions[] | select(.Endpoint == $ep) | .SubscriptionArn')

if [ -z "${PRIMARY_SUB_ARN}" ] || [ "${PRIMARY_SUB_ARN}" = "null" ]; then
  echo "FAIL: could not resolve primary subscription ARN (endpoint ${PRIMARY_QUEUE_ARN})" >&2
  echo "${SUBS}" | jq .
  exit 1
fi
if [ -z "${SECONDARY_SUB_ARN}" ] || [ "${SECONDARY_SUB_ARN}" = "null" ]; then
  echo "FAIL: could not resolve secondary subscription ARN (endpoint ${SECONDARY_QUEUE_ARN})" >&2
  echo "${SUBS}" | jq .
  exit 1
fi

# --- Assertion 2: SNS RawMessageDelivery reached AWS on the primary sub ---
RMD=$(aws sns get-subscription-attributes --subscription-arn "${PRIMARY_SUB_ARN}" \
  --region "${REGION}" \
  --query 'Attributes.RawMessageDelivery' --output text 2>/dev/null)
if [ "${RMD}" != "true" ]; then
  echo "FAIL: primary subscription RawMessageDelivery is '${RMD}', expected 'true'" >&2
  exit 1
fi
echo "    OK: primary subscription RawMessageDelivery == 'true' on AWS (SNS backfill CLOSED)"

# --- Assertion 3: SNS RedrivePolicy reached AWS on the secondary sub ------
# The secondary subscription's deadLetterQueue synthesizes a RedrivePolicy on
# the subscription. AWS returns it as a JSON string carrying deadLetterTargetArn.
SUB_RDP=$(aws sns get-subscription-attributes --subscription-arn "${SECONDARY_SUB_ARN}" \
  --region "${REGION}" \
  --query 'Attributes.RedrivePolicy' --output text 2>/dev/null)
DLT_ARN=$(echo "${SUB_RDP}" | jq -r '.deadLetterTargetArn // empty')
if [ -z "${DLT_ARN}" ]; then
  echo "FAIL: secondary subscription has no RedrivePolicy.deadLetterTargetArn on AWS" >&2
  echo "      raw RedrivePolicy: ${SUB_RDP}" >&2
  exit 1
fi
echo "    OK: secondary subscription RedrivePolicy.deadLetterTargetArn is set on AWS (SNS backfill CLOSED)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: DLQ ${DLQ_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: DLQ is gone"

if aws sns get-subscription-attributes --subscription-arn "${PRIMARY_SUB_ARN}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: primary subscription still exists after destroy" >&2
  exit 1
fi
echo "    OK: subscriptions are gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> sns-sqs-event test passed (messaging-attribute backfill closed + clean destroy)"
