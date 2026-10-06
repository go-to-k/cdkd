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
# Then re-deploys with CDKD_TEST_REMOVAL=true (drops SqsManagedSseEnabled from
# the SSE-removal queue — issue #1160 sqs batch — AND the DeliveryStatusLogging
# block from the delivery-status topic — issue #1160 sns batch) and asserts the
# live queue resets to the SQS/CFn default (SSE on) and the topic's
# per-protocol feedback attributes reset (RoleArns cleared, SampleRate 0 — the
# CFn-parity removal shape, live A/B'd 2026-08-10) instead of silently keeping
# the old values. Then destroys and confirms a clean teardown.
#
# go-to-k/cdkd#4610: a TopicPolicy naming two topics this script creates
# outside the stack. The removal redeploy narrows it to the first topic, which
# must reset the dropped topic to SNS's default policy; the destroy must reset
# both (SNS rejects an empty Policy, so a delete that sends one clears nothing).
#
# go-to-k/cdkd#4612 (Phase 2b): a TopicPolicy over two more out-of-stack
# topics, C and D, and a missing one fails under --no-rollback after writing C
# and D. A write from outside cdkd then replaces D's policy, and
# `cdkd rollback --revert-failed` must reset C (still the failed document) to
# SNS's default and leave D's, exiting 2.
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

STACK="CdkdSnsSqsEventExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

TOPIC_NAME="cdkd-sns-sqs-test-topic"
DLQ_NAME="cdkd-sns-sqs-test-dlq"
PRIMARY_QUEUE_NAME="cdkd-sns-sqs-test-primary"
SECONDARY_QUEUE_NAME="cdkd-sns-sqs-test-secondary"
SSE_QUEUE_NAME="cdkd-sns-sqs-test-sse-removal"
DS_TOPIC_NAME="cdkd-sns-sqs-test-delivery-status"
# go-to-k/cdkd#4610: created and deleted by this script, never by the stack.
POLICY_TOPIC_A_NAME="cdkd-sns-sqs-test-policy-a"
POLICY_TOPIC_B_NAME="cdkd-sns-sqs-test-policy-b"
POLICY_SID="CdkdIssue4610"
ORPHAN_TOPIC_C_NAME="cdkd-sns-sqs-test-orphan-c"
ORPHAN_TOPIC_D_NAME="cdkd-sns-sqs-test-orphan-d"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
# The stack declares the two-topic TopicPolicy only with this set.
export CDKD_TEST_POLICY_TOPICS=true

# The ARN of an SNS topic by name, or empty when there is none.
topic_arn_by_name() {
  local arn
  arn=$(aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${1}')].TopicArn | [0]" --output text) || return 1
  [ "${arn}" = "None" ] && arn=""
  printf '%s' "${arn}"
}

# How many statements of a topic's live Policy carry POLICY_SID. A failed read
# returns non-zero with no count, which no caller accepts as "no statement".
policy_sid_count() {
  local policy
  policy=$(aws sns get-topic-attributes --topic-arn "${1}" --region "${REGION}" \
    --query 'Attributes.Policy' --output text) || return 1
  printf '%s' "${policy}" | jq --arg sid "${POLICY_SID}" '[.Statement[] | select(.Sid == $sid)] | length'
}

# "true" when a POLICY_SID statement of a topic's live Policy carries the
# action $2 (lower-case; Action may be a string or a list), else "false". A
# failed read returns non-zero with no answer.
policy_sid_has_action() {
  local policy
  policy=$(aws sns get-topic-attributes --topic-arn "${1}" --region "${REGION}" \
    --query 'Attributes.Policy' --output text) || return 1
  printf '%s' "${policy}" | jq -r --arg sid "${POLICY_SID}" --arg action "${2}" \
    '[.Statement[] | select(.Sid == $sid) | (.Action | if type == "array" then .[] else . end) | ascii_downcase] | index($action) != null'
}

# A topic's live Policy as canonical JSON (keys sorted, each Action list
# sorted), so two documents compare by content.
policy_canonical() {
  aws sns get-topic-attributes --topic-arn "${1}" --region "${REGION}" \
    --query 'Attributes.Policy' --output text \
    | jq -cS '.Statement |= map(if (.Action | type) == "array" then .Action |= sort else . end)'
}

# Wait (bounded) for a topic's policy to carry exactly one POLICY_SID
# statement; $2 names the phase in the failure.
assert_policy_present() {
  local arn="$1" phase="$2" n=""
  for _i in 1 2 3 4 5 6; do
    n=$(policy_sid_count "${arn}") || n=""
    [ "${n}" = "1" ] && return 0
    sleep 5
  done
  echo "FAIL: ${phase}: ${arn} does not carry the ${POLICY_SID} statement (count '${n}')" >&2
  exit 1
}

# Wait (bounded) for a topic's policy to drop POLICY_SID, then require the
# policy to equal $3, the policy SNS gave the topic at creation (captured
# before any deploy); $2 names the phase in the failure. The equality also
# proves the policy cdkd writes is no broader than SNS's own default.
assert_policy_reset() {
  local arn="$1" phase="$2" baseline="$3" n=""
  for _i in 1 2 3 4 5 6; do
    n=$(policy_sid_count "${arn}") || n=""
    [ "${n}" = "0" ] && break
    sleep 5
  done
  if [ "${n}" != "0" ]; then
    echo "FAIL: ${phase}: ${arn} still carries the ${POLICY_SID} statement (go-to-k/cdkd#4610: the TopicPolicy was not removed from it)" >&2
    exit 1
  fi
  local current
  current=$(policy_canonical "${arn}") || current=""
  if [ -z "${baseline}" ] || [ "${current}" != "${baseline}" ]; then
    echo "FAIL: ${phase}: ${arn} policy is not the one SNS gave it at creation" >&2
    echo "      expected: ${baseline}" >&2
    echo "      actual:   ${current}" >&2
    exit 1
  fi
}

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
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
  fi
  # go-to-k/cdkd#4610 / #4612: the out-of-stack policy topics, after the state.
  for _name in "${POLICY_TOPIC_A_NAME}" "${POLICY_TOPIC_B_NAME}" "${ORPHAN_TOPIC_C_NAME}" "${ORPHAN_TOPIC_D_NAME}"; do
    _arn=$(topic_arn_by_name "${_name}" 2>/dev/null)
    if [ -n "${_arn}" ]; then
      if ! _err=$(aws sns delete-topic --topic-arn "${_arn}" --region "${REGION}" 2>&1 >/dev/null); then
        echo "WARN: could not delete the policy topic ${_arn}; delete it by hand: ${_err}" >&2
      fi
    fi
  done
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

# go-to-k/cdkd#4610: the TopicPolicy's two topics live outside the stack.
echo "==> Creating the out-of-stack policy topics"
POLICY_TOPIC_A_ARN=$(aws sns create-topic --name "${POLICY_TOPIC_A_NAME}" --region "${REGION}" \
  --query 'TopicArn' --output text)
POLICY_TOPIC_B_ARN=$(aws sns create-topic --name "${POLICY_TOPIC_B_NAME}" --region "${REGION}" \
  --query 'TopicArn' --output text)
# The policy SNS itself gives each new topic: what a removed TopicPolicy must
# leave behind.
POLICY_A_BASELINE=$(policy_canonical "${POLICY_TOPIC_A_ARN}")
POLICY_B_BASELINE=$(policy_canonical "${POLICY_TOPIC_B_ARN}")
if [ -z "${POLICY_A_BASELINE}" ] || [ -z "${POLICY_B_BASELINE}" ]; then
  echo "FAIL: could not read the default policy of the freshly created policy topics" >&2
  exit 1
fi
# The baseline must not already carry the statement under test, or the
# "reset to the baseline" checks below would pass on a policy never removed.
for _arn in "${POLICY_TOPIC_A_ARN}" "${POLICY_TOPIC_B_ARN}"; do
  _n=$(policy_sid_count "${_arn}") || _n=""
  if [ -z "${_n}" ]; then
    echo "FAIL: could not read the policy of ${_arn} before Phase 1" >&2
    exit 1
  fi
  if [ "${_n}" != "0" ]; then
    echo "FAIL: ${_arn} already carries the ${POLICY_SID} statement before Phase 1" >&2
    exit 1
  fi
done

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

# --- Assertion 1b: SSE-removal queue starts with SSE off (issue #1160) ----
SSE_QUEUE_URL=$(aws sqs get-queue-url --queue-name "${SSE_QUEUE_NAME}" --region "${REGION}" \
  --query 'QueueUrl' --output text)
SSE_P1=$(aws sqs get-queue-attributes --queue-url "${SSE_QUEUE_URL}" \
  --attribute-names SqsManagedSseEnabled --region "${REGION}" \
  --query 'Attributes.SqsManagedSseEnabled' --output text)
SSE_CREATED_P1=$(aws sqs get-queue-attributes --queue-url "${SSE_QUEUE_URL}" \
  --attribute-names CreatedTimestamp --region "${REGION}" \
  --query 'Attributes.CreatedTimestamp' --output text)
if [ "${SSE_P1}" != "false" ]; then
  echo "FAIL: expected SqsManagedSseEnabled=false on ${SSE_QUEUE_NAME} after Phase 1, got '${SSE_P1}'" >&2
  exit 1
fi
echo "    OK: SSE-removal queue deployed with SqsManagedSseEnabled=false"

# --- Assertion 1c: DeliveryStatusLogging reached AWS (issue #1160 sns) ----
DS_TOPIC_ARN=$(aws sns list-topics --region "${REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${DS_TOPIC_NAME}')].TopicArn | [0]" \
  --output text)
if [ -z "${DS_TOPIC_ARN}" ] || [ "${DS_TOPIC_ARN}" = "None" ]; then
  echo "FAIL: could not resolve topic ARN for ${DS_TOPIC_NAME}" >&2
  exit 1
fi
DS_ATTRS_P1=$(aws sns get-topic-attributes --topic-arn "${DS_TOPIC_ARN}" \
  --region "${REGION}" --query 'Attributes' --output json)
DS_ROLE_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.LambdaSuccessFeedbackRoleArn // empty')
DS_RATE_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.LambdaSuccessFeedbackSampleRate // empty')
DS_FAIL_ROLE_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.LambdaFailureFeedbackRoleArn // empty')
if [ -z "${DS_ROLE_P1}" ] || [ -z "${DS_FAIL_ROLE_P1}" ] || [ "${DS_RATE_P1}" != "25" ]; then
  echo "FAIL: delivery-status topic missing baseline feedback attrs (role='${DS_ROLE_P1}', failRole='${DS_FAIL_ROLE_P1}', rate='${DS_RATE_P1}', expected rate 25)" >&2
  exit 1
fi
echo "    OK: delivery-status topic deployed with Lambda feedback attrs (rate 25)"

# --- Assertion 1d: the http/s protocol reached AWS (issue #1529) ----------
# The canonical CFn / CDK L2 HTTP-family spelling is `http/s`, and it lands
# under the `HTTP` attribute prefix. Pre-fix cdkd threw on `http/s` outright,
# so the deploy above would not even have completed; the `https` spelling it
# did accept emitted `HTTPS*` names AWS rejects with `InvalidParameter`.
# Asserting the HTTPS* names are ABSENT is what pins the second half — they
# are spelled out rather than matched by a `HTTPS` prefix test, because
# `HTTPSuccessFeedbackRoleArn` (HTTP + Success...) also starts with those
# five characters.
DS_HTTP_ROLE_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.HTTPSuccessFeedbackRoleArn // empty')
DS_HTTP_RATE_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.HTTPSuccessFeedbackSampleRate // empty')
DS_HTTP_FAIL_P1=$(echo "${DS_ATTRS_P1}" | jq -r '.HTTPFailureFeedbackRoleArn // empty')
if [ -z "${DS_HTTP_ROLE_P1}" ] || [ -z "${DS_HTTP_FAIL_P1}" ] || [ "${DS_HTTP_RATE_P1}" != "35" ]; then
  echo "FAIL: delivery-status topic missing http/s feedback attrs under the HTTP prefix (role='${DS_HTTP_ROLE_P1}', failRole='${DS_HTTP_FAIL_P1}', rate='${DS_HTTP_RATE_P1}', expected rate 35)" >&2
  exit 1
fi
for BAD_ATTR in HTTPSSuccessFeedbackRoleArn HTTPSSuccessFeedbackSampleRate HTTPSFailureFeedbackRoleArn; do
  BAD_VAL=$(echo "${DS_ATTRS_P1}" | jq -r --arg k "${BAD_ATTR}" '.[$k] // empty')
  if [ -n "${BAD_VAL}" ]; then
    echo "FAIL: nonexistent HTTPS-prefixed attribute ${BAD_ATTR} is set ('${BAD_VAL}') — AWS has no such attribute" >&2
    exit 1
  fi
done
echo "    OK: http/s mapped to the HTTP prefix (rate 35), no HTTPS* attributes"

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

# --- Assertion 4: the two-topic TopicPolicy reached both topics (#4610) ---
for _arn in "${POLICY_TOPIC_A_ARN}" "${POLICY_TOPIC_B_ARN}"; do
  assert_policy_present "${_arn}" "after Phase 1"
done
echo "    OK: the two-topic TopicPolicy is on both out-of-stack topics"

# --- Phase 2: removal-reset redeploy (issue #1160 sqs batch) --------------
echo "==> Phase 2: re-deploy dropping SqsManagedSseEnabled (removal reset)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Pre-fix the provider passed the absent attribute through and SQS kept SSE
# off (SetQueueAttributes merges); post-fix the removal sends the explicit
# reset and the queue returns to the SQS/CFn default (SSE-SQS on).
# SetQueueAttributes documents up to 60s propagation — poll with a bounded
# retry so a read-after-write lag cannot flake the run as a false FAIL.
SSE_P2=""
for _i in 1 2 3 4 5 6; do
  SSE_P2=$(aws sqs get-queue-attributes --queue-url "${SSE_QUEUE_URL}" \
    --attribute-names SqsManagedSseEnabled --region "${REGION}" \
    --query 'Attributes.SqsManagedSseEnabled' --output text)
  [ "${SSE_P2}" = "true" ] && break
  sleep 10
done
SSE_CREATED_P2=$(aws sqs get-queue-attributes --queue-url "${SSE_QUEUE_URL}" \
  --attribute-names CreatedTimestamp --region "${REGION}" \
  --query 'Attributes.CreatedTimestamp' --output text)
if [ "${SSE_P2}" != "true" ]; then
  echo "FAIL: expected SqsManagedSseEnabled=true after the removal redeploy (waited 60s), got '${SSE_P2}'" >&2
  exit 1
fi
# Replacement guard: the removal must be an in-place UPDATE. A replacement
# here would be doubly wrong — SqsManagedSseEnabled is not a create-only
# property, and a same-name replacement can silently delete the queue
# (issue #1238).
if [ "${SSE_CREATED_P1}" != "${SSE_CREATED_P2}" ]; then
  echo "FAIL: SSE-removal queue was REPLACED (CreatedTimestamp ${SSE_CREATED_P1} -> ${SSE_CREATED_P2})" >&2
  exit 1
fi
echo "    OK: SqsManagedSseEnabled reset to true in place (CreatedTimestamp unchanged)"

# --- Assertion 2b: DeliveryStatusLogging removal reset (issue #1160 sns) --
# Pre-fix the provider iterated only the (now empty) desired list and the
# per-protocol attributes silently kept their live values; post-fix the
# removal resets them: RoleArns cleared via '' (the attribute disappears
# from GetTopicAttributes), SampleRate explicitly reset to 0 — the exact
# shape a CloudFormation removal leaves (live A/B 2026-08-10).
DS_ATTRS_P2=$(aws sns get-topic-attributes --topic-arn "${DS_TOPIC_ARN}" \
  --region "${REGION}" --query 'Attributes' --output json)
DS_ROLE_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.LambdaSuccessFeedbackRoleArn // empty')
DS_RATE_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.LambdaSuccessFeedbackSampleRate // empty')
DS_FAIL_ROLE_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.LambdaFailureFeedbackRoleArn // empty')
if [ -n "${DS_ROLE_P2}" ] || [ -n "${DS_FAIL_ROLE_P2}" ]; then
  echo "FAIL: delivery-status feedback RoleArns survived the removal redeploy (role='${DS_ROLE_P2}', failRole='${DS_FAIL_ROLE_P2}')" >&2
  exit 1
fi
if [ "${DS_RATE_P2}" != "0" ]; then
  echo "FAIL: LambdaSuccessFeedbackSampleRate is '${DS_RATE_P2}' after removal, expected the CFn-parity reset '0'" >&2
  exit 1
fi
echo "    OK: delivery-status feedback attrs reset on removal (RoleArns cleared, rate 0)"

# --- Assertion 2c: the http/s entry resets too (issues #1160 + #1529) -----
# The removal reset must cover EVERY protocol the baseline declared, not just
# the first one — the http/s entry is the second element of the list.
DS_HTTP_ROLE_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.HTTPSuccessFeedbackRoleArn // empty')
DS_HTTP_RATE_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.HTTPSuccessFeedbackSampleRate // empty')
DS_HTTP_FAIL_P2=$(echo "${DS_ATTRS_P2}" | jq -r '.HTTPFailureFeedbackRoleArn // empty')
if [ -n "${DS_HTTP_ROLE_P2}" ] || [ -n "${DS_HTTP_FAIL_P2}" ]; then
  echo "FAIL: http/s feedback RoleArns survived the removal redeploy (role='${DS_HTTP_ROLE_P2}', failRole='${DS_HTTP_FAIL_P2}')" >&2
  exit 1
fi
if [ "${DS_HTTP_RATE_P2}" != "0" ]; then
  echo "FAIL: HTTPSuccessFeedbackSampleRate is '${DS_HTTP_RATE_P2}' after removal, expected the CFn-parity reset '0'" >&2
  exit 1
fi
echo "    OK: http/s feedback attrs reset on removal (RoleArns cleared, rate 0)"

# --- Assertion 4b: the narrowed TopicPolicy left the dropped topic (#4610) --
# Pre-fix update() wrote the new list and never touched the topic it dropped,
# so topic B kept granting events.amazonaws.com sns:Publish.
assert_policy_present "${POLICY_TOPIC_A_ARN}" "after narrowing Topics to the first topic (the kept topic)"
# The narrowed TopicPolicy also adds sns:GetTopicAttributes, so the kept
# topic must carry the Phase 2 statement, not a stale Phase 1 one.
_a_shape=""
for _i in 1 2 3 4 5 6; do
  _a_shape=$(policy_sid_has_action "${POLICY_TOPIC_A_ARN}" "sns:gettopicattributes") || _a_shape=""
  [ "${_a_shape}" = "true" ] && break
  sleep 5
done
if [ "${_a_shape}" != "true" ]; then
  echo "FAIL: after narrowing Topics, ${POLICY_TOPIC_A_ARN}'s ${POLICY_SID} statement lacks sns:GetTopicAttributes (got '${_a_shape}'): the update did not re-write the kept topic" >&2
  exit 1
fi
assert_policy_reset "${POLICY_TOPIC_B_ARN}" "after narrowing Topics to the first topic" "${POLICY_B_BASELINE}"
echo "    OK: the dropped topic is back on SNS's default policy; the kept one still carries the statement"

# --- Phase 2b: a failed TopicPolicy's topics are reset by content (#4612) ---
# "true" when a topic's live Policy has a statement with Sid $2 (bounded wait
# for $3 = "present" or a steady "present" over three reads for "steady").
topic_has_sid() {
  local policy
  policy=$(aws sns get-topic-attributes --topic-arn "${1}" --region "${REGION}" \
    --query 'Attributes.Policy' --output text) || return 1
  printf '%s' "${policy}" | jq -r --arg sid "${2}" '[.Statement[]?.Sid] | index($sid) != null'
}
assert_topic_sid() { # usage: assert_topic_sid <arn> <sid> <phase>
  local got=""
  for _i in 1 2 3 4 5 6; do
    got=$(topic_has_sid "${1}" "${2}") || got=""
    [ "${got}" = "true" ] && return 0
    sleep 5
  done
  echo "FAIL: ${3}: ${1} does not carry the ${2} statement" >&2
  exit 1
}
echo "==> Phase 2b: a TopicPolicy over C, D and a missing topic fails (--no-rollback)"
ORPHAN_TOPIC_C_ARN=$(aws sns create-topic --name "${ORPHAN_TOPIC_C_NAME}" --region "${REGION}" \
  --query 'TopicArn' --output text)
ORPHAN_TOPIC_D_ARN=$(aws sns create-topic --name "${ORPHAN_TOPIC_D_NAME}" --region "${REGION}" \
  --query 'TopicArn' --output text)
ORPHAN_C_BASELINE=$(policy_canonical "${ORPHAN_TOPIC_C_ARN}")
if [ -z "${ORPHAN_C_BASELINE}" ]; then
  echo "FAIL: could not read the default policy of ${ORPHAN_TOPIC_C_ARN}" >&2
  exit 1
fi
# "does not exist" is retried by the default schedule (about 47s, each attempt
# rewriting C and D) before the create gives up.
set +e
CDKD_TEST_FAILING_TOPIC_POLICY=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback
RC=$?
set -e
if [ "${RC}" -eq 0 ]; then
  echo "FAIL: Phase 2b: the deploy succeeded; FailingTopicPolicy names a topic that does not exist" >&2
  exit 1
fi
# PREMISE: the failed create wrote C and D, and the journal holds it, proven,
# under exactly those two topics.
assert_topic_sid "${ORPHAN_TOPIC_C_ARN}" CdkdIssue4612 "Phase 2b after the failed deploy"
assert_topic_sid "${ORPHAN_TOPIC_D_ARN}" CdkdIssue4612 "Phase 2b after the failed deploy"
if ! JOURNAL=$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - 2>&1); then
  echo "FAIL: Phase 2b: no rollback journal to read at ${JOURNAL_KEY}: ${JOURNAL}" >&2
  exit 1
fi
JOURNALED=$(printf '%s' "${JOURNAL}" | jq -r '[.segments[].failedOperations[]?
  | select(.logicalId == "FailingTopicPolicy") | select(.physicalIdRecoveredFromError == true) | .physicalId][0]')
if [ "${JOURNALED}" != "${ORPHAN_TOPIC_C_ARN},${ORPHAN_TOPIC_D_ARN}" ]; then
  echo "FAIL: Phase 2b: the journal does not hold FailingTopicPolicy, proven, under C,D (got: ${JOURNALED})" >&2
  exit 1
fi
# A writer outside cdkd replaces D's policy.
OUTSIDE_POLICY=$(jq -cn --arg t "${ORPHAN_TOPIC_D_ARN}" \
  '{Version: "2012-10-17", Statement: [{Sid: "OutsideWriter", Effect: "Allow", Principal: {Service: "s3.amazonaws.com"}, Action: "sns:Publish", Resource: $t}]}')
aws sns set-topic-attributes --topic-arn "${ORPHAN_TOPIC_D_ARN}" --region "${REGION}" \
  --attribute-name Policy --attribute-value "${OUTSIDE_POLICY}"
assert_topic_sid "${ORPHAN_TOPIC_D_ARN}" OutsideWriter "Phase 2b after the outside write"
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --revert-failed
RC=$?
set -e
if [ "${RC}" -ne 2 ]; then
  echo "FAIL: Phase 2b: cdkd rollback exited ${RC}; expected 2 (D left in place, warned)" >&2
  exit 1
fi
# C carried the failed document: back on SNS's default. D carries the outside
# write: left (before the fix the rollback reset it too).
for _i in 1 2 3 4 5 6; do
  [ "$(policy_canonical "${ORPHAN_TOPIC_C_ARN}")" = "${ORPHAN_C_BASELINE}" ] && break
  sleep 5
done
if [ "$(policy_canonical "${ORPHAN_TOPIC_C_ARN}")" != "${ORPHAN_C_BASELINE}" ]; then
  echo "FAIL: Phase 2b: ${ORPHAN_TOPIC_C_ARN} is not back on SNS's default policy after cdkd rollback" >&2
  exit 1
fi
for _i in 1 2 3; do
  if [ "$(topic_has_sid "${ORPHAN_TOPIC_D_ARN}" OutsideWriter)" != "true" ]; then
    echo "FAIL: Phase 2b: ${ORPHAN_TOPIC_D_ARN} lost the outside write on read ${_i} after cdkd rollback" >&2
    exit 1
  fi
  sleep 5
done
assert_gone "Phase 2b: the journal ${JOURNAL_KEY} still exists after cdkd rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
echo "    OK: the rollback reset C to its default and left the outside write on D"

# --- Phase 3: destroy -----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "DLQ ${DLQ_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${DLQ_NAME}" --region "${REGION}"
echo "    OK: DLQ is gone"

assert_gone "SSE-removal queue ${SSE_QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${SSE_QUEUE_NAME}" --region "${REGION}"
echo "    OK: SSE-removal queue is gone"

assert_gone "primary subscription still exists after destroy" aws sns get-subscription-attributes --subscription-arn "${PRIMARY_SUB_ARN}" --region "${REGION}"
echo "    OK: subscriptions are gone"

assert_gone "delivery-status topic ${DS_TOPIC_NAME} still exists after destroy" aws sns get-topic-attributes --topic-arn "${DS_TOPIC_ARN}" --region "${REGION}"
echo "    OK: delivery-status topic is gone"

# go-to-k/cdkd#4610: the destroy resets every topic the TopicPolicy names.
# Pre-fix delete() sent an empty Policy, which SNS rejects; the rejection
# ("Invalid parameter") was read as already removed, so the policy stayed.
assert_policy_reset "${POLICY_TOPIC_A_ARN}" "after destroy" "${POLICY_A_BASELINE}"
assert_policy_reset "${POLICY_TOPIC_B_ARN}" "after destroy" "${POLICY_B_BASELINE}"
echo "    OK: destroy reset both out-of-stack topics to SNS's default policy"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> sns-sqs-event test passed (messaging-attribute backfill closed + clean destroy)"
