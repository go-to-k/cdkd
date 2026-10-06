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
#   1b. go-to-k/cdkd#4594: a QueuePolicy naming two RETAINED queues. Assert
#      both carry the policy; redeploy with CDKD_TEST_UPDATE=shrink (the list
#      drops queue B) and assert B's policy was CLEARED while A keeps it;
#      redeploy the full list and assert B carries it again.
#   2. Destroy + assert the topic, queue and state file are gone, and that the
#      policy was cleared from BOTH retained queues (verify.sh deletes them).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdSnsSubscriptionFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TOPIC_NAME="cdkd-sns-filter-topic"
QUEUE_NAME="cdkd-sns-filter-queue"
POLICY_QUEUE_A="cdkd-sns-filter-policy-a"
POLICY_QUEUE_B="cdkd-sns-filter-policy-b"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  ARN="$(aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text 2>/dev/null)"
  if [ -n "${ARN}" ] && [ "${ARN}" != "None" ]; then
    aws sns delete-topic --topic-arn "${ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # The two policy queues are RETAINED by the stack, so this is their only
  # teardown, on the success path too.
  for QNAME in "${QUEUE_NAME}" "${POLICY_QUEUE_A}" "${POLICY_QUEUE_B}"; do
    QURL="$(aws sqs get-queue-url --queue-name "${QNAME}" --region "${REGION}" \
      --query QueueUrl --output text 2>/dev/null)"
    if [ -n "${QURL}" ] && [ "${QURL}" != "None" ]; then
      aws sqs delete-queue --queue-url "${QURL}" --region "${REGION}" >/dev/null 2>&1 || true
    fi
  done
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

# --- Phase 1b: multi-queue QueuePolicy (go-to-k/cdkd#4594) --------------
POLICY_QUEUE_A_URL="$(aws sqs get-queue-url --queue-name "${POLICY_QUEUE_A}" --region "${REGION}" \
  --query QueueUrl --output text)"
POLICY_QUEUE_B_URL="$(aws sqs get-queue-url --queue-name "${POLICY_QUEUE_B}" --region "${REGION}" \
  --query QueueUrl --output text)"

# Prints the queue's Policy attribute, or "None" when it carries none.
queue_policy() { # usage: queue_policy <queue-url>
  aws sqs get-queue-attributes --queue-url "$1" --region "${REGION}" \
    --attribute-names Policy --query 'Attributes.Policy' --output text
}
# SQS documents up to 60s for an attribute change to propagate, so each
# assertion polls (90s) before failing; a probe error fails at once.
policy_has_topic_send() { # usage: policy_has_topic_send <policy-json>
  [ "$(printf '%s' "$1" | jq -r '[.Statement[]?.Sid] | index("TopicSend") != null' 2>/dev/null)" = "true" ]
}
assert_policy_held() { # usage: assert_policy_held <label> <queue-url> <phase>
  local policy i
  for i in $(seq 1 18); do
    policy="$(queue_policy "$2")"
    if policy_has_topic_send "${policy}"; then return 0; fi
    sleep 5
  done
  echo "FAIL: ${3}: queue ${1} does not carry the TopicSend policy (Policy: ${policy})" >&2
  exit 1
}
# Three consecutive reads 5s apart must all hold the policy: a single read
# can return a stale value from before a wrong clear propagated.
assert_policy_held_steadily() { # usage: assert_policy_held_steadily <label> <queue-url> <phase>
  local policy i
  for i in 1 2 3; do
    policy="$(queue_policy "$2")"
    if ! policy_has_topic_send "${policy}"; then
      echo "FAIL: ${3}: queue ${1} does not carry the TopicSend policy on read ${i} (Policy: ${policy})" >&2
      exit 1
    fi
    sleep 5
  done
}
assert_policy_cleared() { # usage: assert_policy_cleared <label> <queue-url> <phase>
  local policy i
  for i in $(seq 1 18); do
    policy="$(queue_policy "$2")"
    if [ "${policy}" = "None" ] || [ -z "${policy}" ]; then return 0; fi
    sleep 5
  done
  echo "FAIL: ${3}: queue ${1} still carries a policy (Policy: ${policy})" >&2
  exit 1
}

assert_policy_held A "${POLICY_QUEUE_A_URL}" "after deploy"
assert_policy_held B "${POLICY_QUEUE_B_URL}" "after deploy"
echo "    OK: the two-queue QueuePolicy reached both queues"

# The provider clears a listed queue no record names only while its live
# Policy equals the recorded PolicyDocument by content (go-to-k/cdkd#4594):
# pin the premise that SQS hands the document back unchanged.
RECORDED_POLICY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -S '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::SQS::QueuePolicy" and (.key | startswith("MultiQueuePolicy")))
  | .value.properties.PolicyDocument][0]')"
LIVE_POLICY="$(queue_policy "${POLICY_QUEUE_A_URL}" | jq -S .)"
if [ -z "${RECORDED_POLICY}" ] || [ "${RECORDED_POLICY}" = "null" ]; then
  echo "FAIL: no MultiQueuePolicy PolicyDocument recorded in ${STATE_KEY}" >&2
  exit 1
fi
if [ "${LIVE_POLICY}" != "${RECORDED_POLICY}" ]; then
  echo "FAIL: queue A's live Policy differs from the recorded PolicyDocument" >&2
  echo "      live:     ${LIVE_POLICY}" >&2
  echo "      recorded: ${RECORDED_POLICY}" >&2
  exit 1
fi
echo "    OK: queue A's live Policy equals the recorded PolicyDocument (jq -S)"

echo "==> Phase 1b: shrink the QueuePolicy to queue A (CDKD_TEST_UPDATE=shrink)"
CDKD_TEST_UPDATE=shrink node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_policy_cleared B "${POLICY_QUEUE_B_URL}" "after shrink (the update must clear a dropped queue)"
# Read A only once B's clear has propagated, so a stale read cannot hide an
# update that wrongly cleared A too.
assert_policy_held_steadily A "${POLICY_QUEUE_A_URL}" "after shrink"
echo "    OK: shrink cleared the dropped queue B and kept queue A"

echo "==> Phase 1c: grow the QueuePolicy back to both queues"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_policy_held A "${POLICY_QUEUE_A_URL}" "after grow"
assert_policy_held B "${POLICY_QUEUE_B_URL}" "after grow (the update must apply to an added queue)"
echo "    OK: grow re-applied the policy to queue B"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

MATCHED_TOPIC="$(aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" --output text)" || {
  echo "FAIL: could not list SNS topics to verify ${TOPIC_NAME} deletion" >&2
  exit 1
}
if [ "${MATCHED_TOPIC}" != "None" ]; then
  echo "FAIL: topic ${TOPIC_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: topic is gone"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    OK: queue is gone"

# The retained policy queues outlive the destroy; their policy must not.
assert_policy_cleared A "${POLICY_QUEUE_A_URL}" "after destroy"
assert_policy_cleared B "${POLICY_QUEUE_B_URL}" "after destroy"
echo "    OK: destroy cleared the QueuePolicy from both retained queues"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cdkd state removed"

echo "[verify] PASS — SNS subscription filterPolicy reached AWS intact, a two-queue QueuePolicy shrank, grew and was cleared from both queues, clean destroy"
