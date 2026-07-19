#!/usr/bin/env bash
# verify.sh — cdkd SNS inline Subscription integ test (issue #980).
#
# Proves that the inline `AWS::SNS::Topic` `Subscription` property reaches AWS
# on both create() and update(). CDK's L1 `CfnTopic` with `subscription: [...]`
# (and migrated CloudFormation templates) declare subscriptions INLINE on the
# Topic — cdkd previously dropped them silently.
#
#   Phase 1 (create): deploy with the topic subscribed to queue A; assert
#     `list-subscriptions-by-topic` is NON-empty and the endpoint is A.
#   Phase 2 (update, CDKD_TEST_UPDATE=true): re-deploy with the endpoint
#     switched to queue B; assert B is now subscribed and A is gone.
#   Phase 3 (destroy): tear down and confirm nothing is left.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSnsInlineSubscriptionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

TOPIC_NAME="cdkd-sns-inline-sub-topic"
QUEUE_A_NAME="cdkd-sns-inline-sub-queue-a"
QUEUE_B_NAME="cdkd-sns-inline-sub-queue-b"

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
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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

# Resolve the topic ARN by name.
resolve_topic_arn() {
  aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
    --output text
}

# Resolve a queue's ARN by name.
queue_arn() {
  local name="$1"
  local url
  url=$(aws sqs get-queue-url --queue-name "${name}" --region "${REGION}" \
    --query 'QueueUrl' --output text)
  aws sqs get-queue-attributes --queue-url "${url}" --attribute-names QueueArn \
    --region "${REGION}" --query 'Attributes.QueueArn' --output text
}

# --- Phase 1: create (subscribe to queue A) -------------------------------
echo "==> Phase 1: deploy (inline subscription -> queue A)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

TOPIC_ARN=$(resolve_topic_arn)
if [ -z "${TOPIC_ARN}" ] || [ "${TOPIC_ARN}" = "None" ]; then
  echo "FAIL: could not resolve topic ARN for ${TOPIC_NAME}" >&2
  exit 1
fi

QUEUE_A_ARN=$(queue_arn "${QUEUE_A_NAME}")
QUEUE_B_ARN=$(queue_arn "${QUEUE_B_NAME}")

# Assertion 1: the topic has at least one subscription (inline sub reached AWS).
SUB_COUNT=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
  --region "${REGION}" \
  --query 'length(Subscriptions || `[]`)' --output text)
if [ "${SUB_COUNT}" -lt 1 ]; then
  echo "FAIL: topic ${TOPIC_NAME} has ${SUB_COUNT} subscriptions after create, expected >= 1" >&2
  echo "      (inline Subscription property was silently dropped — issue #980)" >&2
  exit 1
fi
echo "    OK: inline subscription reached AWS on create (${SUB_COUNT} subscription(s))"

# Assertion 2: the subscribed endpoint is queue A.
A_SUBBED=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
  --region "${REGION}" \
  --query "length(Subscriptions[?Endpoint=='${QUEUE_A_ARN}'] || \`[]\`)" --output text)
if [ "${A_SUBBED}" -lt 1 ]; then
  echo "FAIL: queue A (${QUEUE_A_ARN}) is not subscribed after create" >&2
  exit 1
fi
echo "    OK: queue A is the subscribed endpoint after create"

# --- Phase 2: update (switch subscription endpoint to queue B) ------------
echo "==> Phase 2: update (inline subscription -> queue B)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Assertion 3: queue B is now subscribed.
B_SUBBED=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
  --region "${REGION}" \
  --query "length(Subscriptions[?Endpoint=='${QUEUE_B_ARN}'] || \`[]\`)" --output text)
if [ "${B_SUBBED}" -lt 1 ]; then
  echo "FAIL: queue B (${QUEUE_B_ARN}) is not subscribed after update" >&2
  echo "      (inline Subscription add on UPDATE was dropped — issue #980)" >&2
  exit 1
fi
echo "    OK: queue B was subscribed on update"

# Assertion 4: queue A's subscription was removed (not PendingConfirmation).
A_STILL=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
  --region "${REGION}" \
  --query "length(Subscriptions[?Endpoint=='${QUEUE_A_ARN}' && SubscriptionArn!='PendingConfirmation'] || \`[]\`)" \
  --output text)
if [ "${A_STILL}" -ne 0 ]; then
  echo "FAIL: queue A is still subscribed after update, expected it to be unsubscribed" >&2
  exit 1
fi
echo "    OK: queue A was unsubscribed on update"

# --- Phase 3: destroy -----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1; then
  REMAINING=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
    --region "${REGION}" --query 'length(Subscriptions || `[]`)' --output text 2>/dev/null || echo 0)
  if [ "${REMAINING}" != "0" ]; then
    echo "FAIL: topic still has ${REMAINING} subscriptions after destroy" >&2
    exit 1
  fi
fi
echo "    OK: topic + subscriptions are gone"

if aws sqs get-queue-url --queue-name "${QUEUE_A_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: queue A ${QUEUE_A_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: queues are gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> sns-inline-subscription test passed (inline subscription create + update + clean destroy)"
