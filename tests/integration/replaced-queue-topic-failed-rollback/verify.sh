#!/usr/bin/env bash
# verify.sh — a failed deploy keeps a replaced SQS queue and SNS topic whole
# (issue #6712).
#
# Phases: deploy -> premise: the QueuePolicy is recorded under the queue URL
# -> queue one message -> THE FAILURE: rename the queue and the topic (a
# create-first replacement) while Breaker is refused by SSM -> THE ARM: the old
# queue is the same queue with its message, the topic still delivers to it,
# the new copies are gone -> destroy + gone-probes.
#
# Before the fix the old queue and topic were deleted right after the new ones
# were created, and the rollback re-created them empty: no message, no
# subscription, while state still recorded the subscription.

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdReplacedQueueTopicFailedRollbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BREAKER_NAME="${STACK}-breaker"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ACCT=""
QUEUE_A_URL=""
QUEUE_A_ARN=""
TOPIC_A_ARN=""
TOPIC_B_ARN=""
QUEUE_B_NAME="${STACK}-q-b"

state_json() {
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}"
}

# The queue's CreatedTimestamp: a re-created queue has a new one.
queue_created() {
  aws sqs get-queue-attributes --queue-url "$1" --region "${REGION}" \
    --attribute-names CreatedTimestamp --query 'Attributes.CreatedTimestamp' --output text
}

# Whether the topic lists a subscription delivering to the queue ARN.
topic_lists_queue() {
  local rows
  rows=$(aws sns list-subscriptions-by-topic --topic-arn "$1" --region "${REGION}" \
    --query "Subscriptions[?Endpoint=='$2'].SubscriptionArn" --output text) || return 1
  printf '%s\n' "${rows}" | grep -c '^arn:' || true
}

# A queue deleted moments ago can still answer get-queue-url for about a
# minute: poll until it reports not-found, then assert it.
wait_queue_gone() { # usage: wait_queue_gone "<leak description>" <queue-name>
  local i
  for i in $(seq 1 18); do
    gone_probe aws sqs get-queue-url --queue-name "$2" --region "${REGION}" && return 0
    sleep 5
  done
  echo "FAIL: $1" >&2
  exit 1
}

# Receive one message whose body is $2 from queue $1, waiting up to ~60 s.
receive_body() {
  local url="$1" want="$2" body i
  for i in 1 2 3; do
    body=$(aws sqs receive-message --queue-url "${url}" --region "${REGION}" \
      --wait-time-seconds 20 --max-number-of-messages 10 --visibility-timeout 0 \
      --query "Messages[?Body=='${want}'] | [0].Body" --output text) || return 1
    [ "${body}" = "${want}" ] && return 0
  done
  return 1
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${BREAKER_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  local acct s
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [ -n "${acct}" ]; then
    for s in a b; do
      aws sqs delete-queue --queue-url "https://sqs.${REGION}.amazonaws.com/${acct}/${STACK}-q-${s}" --region "${REGION}" >/dev/null 2>&1 || true
      aws sns delete-topic --topic-arn "arn:aws:sns:${REGION}:${acct}:${STACK}-t-${s}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

ACCT=$(aws sts get-caller-identity --query Account --output text)
QUEUE_A_URL="https://sqs.${REGION}.amazonaws.com/${ACCT}/${STACK}-q-a"
QUEUE_A_ARN="arn:aws:sqs:${REGION}:${ACCT}:${STACK}-q-a"
TOPIC_A_ARN="arn:aws:sns:${REGION}:${ACCT}:${STACK}-t-a"
TOPIC_B_ARN="arn:aws:sns:${REGION}:${ACCT}:${STACK}-t-b"

echo "==> Phase 1: Deploy"
env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

QUEUE_KEY=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::Queue") | .key')
TOPIC_KEY=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::Topic") | .key')
POLICY_ID=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::QueuePolicy") | .value.physicalId')
TOPIC_POLICY_ID=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::TopicPolicy") | .value.physicalId')
# PREMISE: the queue policy's record holds the queue URL, the shape that took
# the immediate delete before the fix.
[ "${POLICY_ID}" = "${QUEUE_A_URL}" ] || { echo "FAIL: premise: the QueuePolicy is recorded as '${POLICY_ID}', not the queue URL; this run would not reach issue #6712" >&2; exit 1; }
[ "${TOPIC_POLICY_ID}" = "${TOPIC_A_ARN}" ] || { echo "FAIL: premise: the TopicPolicy is recorded as '${TOPIC_POLICY_ID}', not the topic ARN; this run would not reach issue #6712 for the topic" >&2; exit 1; }
CREATED0=$(queue_created "${QUEUE_A_URL}")
[ "$(topic_lists_queue "${TOPIC_A_ARN}" "${QUEUE_A_ARN}")" = "1" ] || { echo "FAIL: phase 1: topic ${TOPIC_A_ARN} does not list the queue's subscription" >&2; exit 1; }
aws sqs send-message --queue-url "${QUEUE_A_URL}" --region "${REGION}" --message-body "kept-before-6712" >/dev/null
echo "    OK: queue ${QUEUE_A_URL} (created ${CREATED0}) subscribed to ${TOPIC_A_ARN}; one message queued"

echo "==> Phase 2: replace the queue and the topic while Breaker fails (the deploy must fail)"
set +e
FAIL_OUT=$(env CDKD_TEST_PHASE=fail node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
FAIL_RC=$?
set -e
printf '%s\n' "${FAIL_OUT}"
[ "${FAIL_RC}" -ne 0 ] || { echo "FAIL: premise: the phase 2 deploy succeeded; Breaker was meant to fail it" >&2; exit 1; }
grep -q 'Breaker: ParameterPatternMismatchException\|Failed to create SSM parameter Breaker' <<<"${FAIL_OUT}" || {
  echo "FAIL: premise: the phase 2 deploy failed for another reason than Breaker's refused value" >&2
  exit 1
}
# PREMISE: both replacements ran before the failure.
for pair in "${QUEUE_KEY}|${QUEUE_A_URL}" "${TOPIC_KEY}|${TOPIC_A_ARN}"; do
  key="${pair%%|*}"; old="${pair#*|}"
  grep -qF "Old ${key} (${old}) is deleted after the rest of the deploy succeeds" <<<"${FAIL_OUT}" && continue
  # Sentinel: a replacement line for the key that is not the deferral.
  grep -qF "Replacing ${key} " <<<"${FAIL_OUT}" && { echo "FAIL: ${key}'s old copy was replaced but not deferred to the cleanup phase (issue #6712)" >&2; exit 1; }
  echo "FAIL: premise: ${key} was not replaced before the failure in the phase 2 output (wording drift?)" >&2
  exit 1
done

echo "==> Phase 3: THE ARM -- the old queue and topic survived whole"
CREATED1=$(queue_created "${QUEUE_A_URL}")
[ "${CREATED1}" = "${CREATED0}" ] || { echo "FAIL: queue ${QUEUE_A_URL} was re-created (CreatedTimestamp ${CREATED0} -> ${CREATED1}); its messages are gone (issue #6712)" >&2; exit 1; }
receive_body "${QUEUE_A_URL}" "kept-before-6712" || { echo "FAIL: the message queued before the failed deploy is gone (issue #6712)" >&2; exit 1; }
[ "$(topic_lists_queue "${TOPIC_A_ARN}" "${QUEUE_A_ARN}")" = "1" ] || { echo "FAIL: topic ${TOPIC_A_ARN} lost the queue's subscription across the failed deploy (issue #6712)" >&2; exit 1; }
aws sns publish --topic-arn "${TOPIC_A_ARN}" --region "${REGION}" --message "delivered-after-6712" >/dev/null
receive_body "${QUEUE_A_URL}" "delivered-after-6712" || { echo "FAIL: a message published after the rollback did not reach the queue (issue #6712)" >&2; exit 1; }
STATE_Q=$(state_json | jq -r --arg k "${QUEUE_KEY}" '.resources[$k].physicalId')
[ "${STATE_Q}" = "${QUEUE_A_URL}" ] || { echo "FAIL: state records the queue as ${STATE_Q}, expected ${QUEUE_A_URL}" >&2; exit 1; }
# The new copies were deleted by the rollback.
assert_gone "the new topic ${TOPIC_B_ARN} survived the rollback" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_B_ARN}" --region "${REGION}"
wait_queue_gone "the new queue ${QUEUE_B_NAME} survived the rollback" "${QUEUE_B_NAME}"
echo "    OK: same queue (created ${CREATED1}), message kept, subscription delivering, new copies deleted"

echo "==> Phase 4: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_queue_gone "queue ${QUEUE_A_URL} survived destroy" "${STACK}-q-a"
assert_gone "topic ${TOPIC_A_ARN} survived destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_A_ARN}" --region "${REGION}"
assert_gone "SSM parameter ${BREAKER_NAME} exists" \
  aws ssm get-parameter --name "${BREAKER_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — replaced-queue-topic-failed-rollback (a failed deploy keeps a replaced queue and topic whole)"
