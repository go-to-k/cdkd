#!/usr/bin/env bash
#
# A resource NAMED from a `NoEcho` template parameter, read by ARN
# (go-to-k/cdkd#4849). AWS publishes a resource's name inside its ARN, so cdkd
# keeps every copy of that ARN in state as AWS returns it; masking it broke
# every later deploy that re-resolved a reader of the ARN.
#
# Phases:
#   1. `cdkd deploy` the producer: an SNS topic named from the `NoEcho` value,
#      an SQS subscription reading `Fn::GetAtt Topic.TopicArn`, an exported
#      `!Ref Topic` output and an output of the value itself. state.json holds
#      the ARN at the topic's physical id, its `TopicArn` attribute, the output
#      and its export, and `***` at the `TopicName` attribute and the value's
#      output. The exports index holds the ARN.
#   2. `cdkd deploy` the consumer in a separate process: it imports the export
#      from the persisted exports index into an SSM parameter, which holds the
#      ARN.
#   3. `cdkd deploy` the producer again with the subscription EDITED (raw
#      delivery on): the deploy re-resolves `Topic.TopicArn` from state and
#      succeeds (no `redaction mask` refusal), the topic's one live
#      subscription has raw delivery on, delivers to the queue, and is the one
#      state records. cdkd's SNS subscription provider replaces a subscription
#      on any update, so its ARN may change; that is not what this checks.
#   4. No object version under either stack's prefix carries the value outside
#      a copy of the topic's ARN.
#   5. Destroy both stacks, gone-probes, and the S3 version sweep.
#
# The value is generated per run and never printed outside the ARN.
#
# Pre-fix arm: with CDKD_TEST_NOECHO_PRODUCER_ARM=1, Phase 1's state checks
# warn instead of failing and Phase 2 is skipped (its import would read the
# masked export), so a binary without the go-to-k/cdkd#4849 fix reaches Phase
# 3 and fails THERE. The arm always exits non-zero: a pass would mean it no
# longer discriminates.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
set -euo pipefail
cd "$(dirname "$0")"

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

# Vendored cdk CLI (issue 1485): install the fixture's deps when absent.
[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install
export PATH="${PWD}/node_modules/.bin:${PATH}"

# Shared S3 VERSION-sweep helpers (issue #2096): the bucket is versioned.
. ../s3-versions.sh

STACK="CdkdNoEchoNamedProducerExample"
CONSUMER="CdkdNoEchoNamedProducerConsumer"
REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: built CLI not found at ${LOCAL_DIST} — run 'vp run build' from the repo root" >&2
  exit 1
fi
export AWS_PAGER=""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
RUN_HEX="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
# The NoEcho value, which IS the topic's name. Letters, digits and dashes.
TOKEN="cdkd-test-noecho-producer-${RUN_HEX}"
QUEUE_NAME="cdkd-test-noecho-producer-q-${RUN_HEX}"
PARAM_NAME="/cdkd-test/noecho-producer/${RUN_HEX}"
if [ "${#RUN_HEX}" -ne 16 ]; then
  echo "FAIL: premise: could not generate the per-run value" >&2
  exit 1
fi
export CDKD_TEST_NOECHO_PRODUCER_NAME="${TOKEN}"
export CDKD_TEST_NOECHO_PRODUCER_QUEUE="${QUEUE_NAME}"
export CDKD_TEST_NOECHO_PRODUCER_PARAM="${PARAM_NAME}"

TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOKEN}"
EXPORT_NAME="CdkdNoEchoNamedProducerTopicArn"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CONSUMER_STATE_PREFIX="$(s3_stack_prefix "${CONSUMER}" "${REGION}")"
INDEX_KEY="cdkd/_index/${REGION}/exports.json"

# ISO-8601 UTC, comparable as a string with S3's LastModified; five minutes
# earlier so local clock skew cannot drop this run's own writes (the Phase 4
# floor on index versions catches it if it does).
RUN_STARTED_AT=$(date -u -v-5M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)
SCRATCH_FILES=()
cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ "${#SCRATCH_FILES[@]}" -gt 0 ]; then
    rm -f "${SCRATCH_FILES[@]}" || true
  fi
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # Deleting a topic deletes its subscriptions; delete-topic is idempotent.
  aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  local queue_url
  queue_url=$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)
  if [ -n "${queue_url}" ] && [ "${queue_url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${queue_url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${CONSUMER_STATE_PREFIX:-}" noncurrent || true
  # The shared exports index: KEY-scoped and noncurrent only, never `all` --
  # other stacks share it.
  s3_purge_key_versions "${STATE_BUCKET:-}" "${INDEX_KEY:-}" noncurrent || true
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# The value may appear only inside a copy of the topic's ARN (the physical id,
# the subscription's ARN, the `TopicArn` attribute, the output and its export),
# which AWS publishes. Drop every ARN occurrence, then the value must be gone.
# A captured output must never be echoed when it may carry the value bare.
assert_value_only_in_arn() { # assert_value_only_in_arn <label> <text>
  local stripped="${2//"${TOPIC_ARN}"/}"
  if [[ "${stripped}" == *"${TOKEN}"* ]]; then
    echo "FAIL: $1 carries the NoEcho value outside the topic's ARN (go-to-k/cdkd#4849)" >&2
    exit 1
  fi
}

echo "==> Pre-flight: no leftovers from an earlier run"
assert_gone "premise: state file ${STATE_KEY} already exists — clean it up first" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "premise: state file ${CONSUMER_STATE_KEY} already exists — clean it up first" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"

deploy_stack() { # deploy_stack <label> <stack> [env assignments...]; sets DEPLOY_OUT
  local label="$1" stack="$2"
  shift 2
  set +e
  DEPLOY_OUT=$(env -u CDKD_TEST_UPDATE "$@" node "${LOCAL_DIST}" deploy "${stack}" --exclusively \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
  local rc=$?
  set -e
  assert_value_only_in_arn "the ${label} output" "${DEPLOY_OUT}"
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: the ${label} exited ${rc}" >&2
    printf '%s\n' "${DEPLOY_OUT}" >&2
    exit 1
  fi
}

# --- Phase 1 ------------------------------------------------------------------
echo "==> Phase 1: deploy the producer"
deploy_stack "first producer deploy" "${STACK}"
if [ "$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query Attributes.TopicArn --output text)" != "${TOPIC_ARN}" ]; then
  echo "FAIL: premise: AWS does not hold the topic named from the NoEcho value" >&2
  exit 1
fi
STATE_P1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")
assert_value_only_in_arn "state.json after the first deploy" "${STATE_P1}"
P1_SHAPE=$(jq -c --arg arn "${TOPIC_ARN}" --arg exp "${EXPORT_NAME}" '[
  .resources.Topic.physicalId == $arn,
  .resources.Topic.attributes.TopicArn == $arn,
  .resources.Topic.attributes.TopicName,
  .outputs.TopicArnOut == $arn,
  .outputs[$exp] == $arn,
  .outputs.NameOut,
  .resources.Sub.properties.TopicArn == $arn
]' <<< "${STATE_P1}")
ARM="${CDKD_TEST_NOECHO_PRODUCER_ARM:-}"
arm_or_fail() { # arm_or_fail <message>: a warning under the pre-fix arm, else FAIL
  if [ "${ARM}" = "1" ]; then
    echo "    ARM: $1 (continuing to Phase 3)"
  else
    echo "FAIL: $1" >&2
    exit 1
  fi
}
if [ "${P1_SHAPE}" != '[true,true,"***",true,true,"***",true]' ]; then
  arm_or_fail "state.json after the first deploy does not keep the topic's ARN at its physical id, TopicArn attribute, output, export and the reader, with *** at the TopicName attribute and the value's output (got ${P1_SHAPE})"
fi
INDEX_P1=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - --region "${REGION}")
assert_value_only_in_arn "the exports index" "${INDEX_P1}"
if [[ "${INDEX_P1}" != *"\"${TOPIC_ARN}\""* ]]; then
  arm_or_fail "the exports index does not hold the topic's ARN (it was stored masked)"
fi
echo "    OK: Phase 1 state checked"

# --- Phase 2 ------------------------------------------------------------------
if [ "${ARM}" = "1" ]; then
  echo "==> Phase 2: skipped under the pre-fix arm"
else
  echo "==> Phase 2: deploy the consumer in a separate process (reads the export from the index)"
  deploy_stack "consumer deploy" "${CONSUMER}"
  if [ "$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query Parameter.Value --output text)" != "${TOPIC_ARN}" ]; then
    echo "FAIL: the consumer's SSM parameter does not hold the imported topic ARN" >&2
    exit 1
  fi
  echo "    OK: the consumer imported the ARN"
fi

# --- Phase 3 ------------------------------------------------------------------
echo "==> Phase 3: edit the Fn::GetAtt Topic.TopicArn reader and redeploy the producer"
SUB_ARN=$(jq -r '.resources.Sub.physicalId' <<< "${STATE_P1}")
if [[ "${SUB_ARN}" != "${TOPIC_ARN}:"* ]]; then
  echo "FAIL: premise: the subscription's recorded physical id is not a subscription of the topic" >&2
  exit 1
fi
if [ "$(aws sns get-subscription-attributes --subscription-arn "${SUB_ARN}" --region "${REGION}" \
  --query Attributes.RawMessageDelivery --output text)" != "false" ]; then
  echo "FAIL: premise: raw delivery is already on before the edit" >&2
  exit 1
fi
# Not `deploy_stack`: the refusal this phase exists for must be named.
set +e
DEPLOY_OUT=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --exclusively \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_RC=$?
set -e
assert_value_only_in_arn "the edited producer deploy output" "${DEPLOY_OUT}"
if grep -q 'redaction mask' <<< "${DEPLOY_OUT}"; then
  echo "FAIL: the edited deploy was refused reading Topic.TopicArn from state as the redaction mask (go-to-k/cdkd#4849); exit ${DEPLOY_RC}" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: the edited producer deploy exited ${DEPLOY_RC}" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
if [ "${ARM}" = "1" ]; then
  echo "FAIL: pre-fix arm: Phase 3 passed, so the arm no longer discriminates" >&2
  exit 1
fi
STATE_P3=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")
assert_value_only_in_arn "state.json after the edited deploy" "${STATE_P3}"
SUB_ARN_P3=$(jq -r '.resources.Sub.physicalId' <<< "${STATE_P3}")
# What AWS holds on the topic: exactly one subscription (the provider replaces
# delete-first, so a leftover would be a second one), delivering to the queue,
# and the one state records.
QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"
LIVE_SUBS=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --output json | jq -c '[.Subscriptions[] | [.SubscriptionArn, .Protocol, .Endpoint]]')
if [ "$(jq -c --arg sub "${SUB_ARN_P3}" --arg q "${QUEUE_ARN}" '. == [[$sub, "sqs", $q]]' <<< "${LIVE_SUBS}")" != "true" ]; then
  echo "FAIL: the topic's live subscriptions are not exactly the recorded one, to the queue (got ${LIVE_SUBS}, state ${SUB_ARN_P3})" >&2
  exit 1
fi
if [ "$(aws sns get-subscription-attributes --subscription-arn "${SUB_ARN_P3}" --region "${REGION}" \
  --query 'Attributes.[RawMessageDelivery,TopicArn]' --output text)" != "true"$'\t'"${TOPIC_ARN}" ]; then
  echo "FAIL: the edit did not reach AWS (raw delivery is not on, or the subscription is on another topic)" >&2
  exit 1
fi
P3_SHAPE=$(jq -c --arg arn "${TOPIC_ARN}" '[
  .resources.Topic.physicalId == $arn,
  .resources.Topic.attributes.TopicArn == $arn,
  .resources.Topic.attributes.TopicName,
  .outputs.TopicArnOut == $arn,
  .resources.Sub.properties.TopicArn == $arn
]' <<< "${STATE_P3}")
if [ "${P3_SHAPE}" != '[true,true,"***",true,true]' ]; then
  echo "FAIL: state.json after the edited deploy lost the ARN or the TopicName mask (got ${P3_SHAPE})" >&2
  exit 1
fi
echo "    OK: the edited reader redeployed; the edit reached AWS on the topic's one subscription"

# --- Phase 4 ------------------------------------------------------------------
echo "==> Phase 4: no object version carries the value outside the ARN"
VERSIONS_SCANNED=0
INDEX_VERSIONS_SCANNED=0
# The two stack prefixes, and the versions of the shared exports index KEY this
# run wrote (`--prefix` on the key, an exact-key filter, and LastModified at or
# after the run's start, so other stacks' history is not downloaded).
for prefix in "${STATE_PREFIX}" "${CONSUMER_STATE_PREFIX}" "${INDEX_KEY}"; do
  VERSION_ROWS=$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
    --prefix "${prefix}" --output json \
    | jq -r --arg index "${INDEX_KEY}" --arg prefix "${prefix}" \
      --arg since "${RUN_STARTED_AT}" \
      '.Versions // [] | .[] | select($prefix != $index or (.Key == $index and .LastModified >= $since)) | "\(.Key)\t\(.VersionId)"')
  while IFS=$'\t' read -r version_key version_id || [ -n "${version_key}" ]; do
    [ -n "${version_key}" ] || continue
    VERSION_FILE=$(mktemp)
    SCRATCH_FILES+=("${VERSION_FILE}")
    aws s3api get-object --bucket "${STATE_BUCKET}" --key "${version_key}" \
      --version-id "${version_id}" "${VERSION_FILE}" >/dev/null
    VERSIONS_SCANNED=$((VERSIONS_SCANNED + 1))
    if [ "${version_key}" = "${INDEX_KEY}" ]; then INDEX_VERSIONS_SCANNED=$((INDEX_VERSIONS_SCANNED + 1)); fi
    assert_value_only_in_arn "an object version of ${version_key}" "$(cat "${VERSION_FILE}")"
  done < <(printf '%s\n' "${VERSION_ROWS}")
done
# Phase 1 wrote the index, so a zero here means the time filter dropped this
# run's own versions, not that they are clean.
if [ "${INDEX_VERSIONS_SCANNED}" -lt 1 ]; then
  echo "FAIL: the exports index scan read no version this run wrote (clock skew past ${RUN_STARTED_AT}?)" >&2
  exit 1
fi
if [ "${VERSIONS_SCANNED}" -lt 3 ]; then
  echo "FAIL: the version scan read ${VERSIONS_SCANNED} object version(s) -- the negative above passes for free" >&2
  exit 1
fi
echo "    OK: ${VERSIONS_SCANNED} versions scanned"

# --- Phase 5 ------------------------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "${PARAM_NAME} exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "topic ${TOPIC_ARN} exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
assert_gone "subscription ${SUB_ARN_P3} exists after destroy" \
  aws sns get-subscription-attributes --subscription-arn "${SUB_ARN_P3}" --region "${REGION}"
assert_gone "queue ${QUEUE_NAME} exists after destroy" \
  aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "state file ${CONSUMER_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" all || true
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
s3_assert_key_versions_swept "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent \
  "noecho-named-producer exports index teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "noecho-named-producer producer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CONSUMER_STATE_PREFIX}" "noecho-named-producer consumer state teardown"

echo "[verify] PASS - a resource named from a NoEcho parameter keeps its ARN in state, outputs, exports and readers; an edited Fn::GetAtt reader redeploys, a later consumer imports the ARN, and the name stays ***"
