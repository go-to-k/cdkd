#!/usr/bin/env bash
# verify.sh — cdkd SNS -> SQS subscription with a filterPolicy integ.
#
# A daily CDK pattern: an SNS subscription carries a `FilterPolicy` (a nested
# JSON object). cdkd must forward it to SetSubscriptionAttributes exactly, not
# double-stringify or drop it.
#
# Phases:
#   1. Deploy. Assert the topic has a lambda... (sqs) subscription whose
#      FilterPolicy attribute, read back from AWS, matches the synthesized
#      allowlist/numeric filter.
#   2. Destroy + assert the topic, queue and state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSnsSubscriptionFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TOPIC_NAME="cdkd-sns-filter-topic"
QUEUE_NAME="cdkd-sns-filter-queue"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  ARN="$(aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null)"
  if [ -n "${ARN}" ] && [ "${ARN}" != "None" ]; then
    aws sns delete-topic --topic-arn "${ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  QURL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${QURL}" ] && [ "${QURL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${QURL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
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

# --- Resolve the subscription ARN -------------------------------------
SUB_ARN="$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query "Subscriptions[?Protocol=='sqs'].SubscriptionArn | [0]" --output text)"
if [ -z "${SUB_ARN}" ] || [ "${SUB_ARN}" = "None" ]; then
  echo "FAIL: topic ${TOPIC_ARN} has no sqs subscription after deploy" >&2
  exit 1
fi
echo "    Resolved subscription: ${SUB_ARN}"

# --- Assertion: FilterPolicy reached AWS intact -----------------------
# get-subscription-attributes returns FilterPolicy as a JSON-encoded STRING.
# Parse it and assert the synthesized allowlist + numeric filter survived
# cdkd's pass-through (a double-stringify / drop bug would change the shape).
FP_RAW="$(aws sns get-subscription-attributes --subscription-arn "${SUB_ARN}" --region "${REGION}" \
  --query 'Attributes.FilterPolicy' --output text)"
if [ -z "${FP_RAW}" ] || [ "${FP_RAW}" = "None" ]; then
  echo "FAIL: subscription has no FilterPolicy attribute on AWS" >&2
  exit 1
fi
COLOR="$(echo "${FP_RAW}" | jq -c '.color')"
WEIGHT="$(echo "${FP_RAW}" | jq -c '.weight')"
if [ "${COLOR}" != '["red","green"]' ]; then
  echo "FAIL: FilterPolicy.color is '${COLOR}', expected '[\"red\",\"green\"]'" >&2
  echo "      raw FilterPolicy: ${FP_RAW}" >&2
  exit 1
fi
if [ "${WEIGHT}" != '[{"numeric":[">",10]}]' ]; then
  echo "FAIL: FilterPolicy.weight is '${WEIGHT}', expected '[{\"numeric\":[\">\",10]}]'" >&2
  echo "      raw FilterPolicy: ${FP_RAW}" >&2
  exit 1
fi
echo "    OK: FilterPolicy {color allowlist, weight numeric>10} reached AWS intact"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null | grep -q "${TOPIC_NAME}"; then
  echo "FAIL: topic ${TOPIC_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: topic is gone"

if aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: queue ${QUEUE_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: queue is gone"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

echo "[verify] PASS — SNS subscription filterPolicy reached AWS intact, clean destroy"
