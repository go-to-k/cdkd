#!/usr/bin/env bash
# verify.sh — cdkd un-named FIFO SQS queue (and SNS topic) integ (issue #6100).
#
# `new sqs.Queue(this, 'Q', { fifo: true })` synthesizes `FifoQueue: true` and
# no `QueueName`, so cdkd generates the name. SQS refuses a FIFO queue whose
# name does not end with `.fifo` (1-80 characters), and cdkd used to send the
# standard generated name, so the deploy failed with InvalidParameterValue.
#
# Phases:
#   1. Deploy three un-named queues: FifoQueue (`fifo: true`), FifoStringQueue
#      (`FifoQueue: 'TRUE'`, an upper-case string CloudFormation coerces) and StandardQueue
#      (the negative control). Assert each FIFO queue's name ends with `.fifo`,
#      is at most 80 characters, starts with `<stack>-<logicalId>-`, matches the
#      recorded QueueName attribute, resolves by name through get-queue-url to
#      the recorded URL, and reads FifoQueue=true. The standard queue's name has
#      no suffix and no FifoQueue attribute. FifoTopic (an L1 CfnTopic with
#      FifoTopic: true, no TopicName) is named `<stack>-FifoTopic-<suffix>.fifo`
#      (SNS refuses a FIFO topic without the suffix too) and reads FifoTopic=true.
#   2. CDKD_TEST_UPDATE=true redeploy changes FifoQueue's VisibilityTimeout
#      (30 -> 45). Assert it reached AWS IN PLACE: the same URL in state and an
#      unchanged CreatedTimestamp.
#   3. Destroy, assert all three queues, the topic and the state file are gone.
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

STACK="CdkdSqsFifoUnnamedExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
QUEUE_IDS="FifoQueue FifoStringQueue StandardQueue"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The queue names are generated (a stack-instance suffix), so the cleanup reads
# the URLs from the state record, then sweeps by the stack-name prefix for a
# queue a crashed run created but never recorded. ListQueues is eventually
# consistent, so the sweep is best effort; the assertions never use it.
cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local state url
  if [ -n "${STATE_BUCKET:-}" ]; then
    state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
    if [ -n "${state}" ]; then
      for url in $(printf '%s' "${state}" | jq -r '.resources[]? | select(.resourceType == "AWS::SQS::Queue") | .physicalId // empty' 2>/dev/null); do
        aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      for arn in $(printf '%s' "${state}" | jq -r '.resources[]? | select(.resourceType == "AWS::SNS::Topic") | .physicalId // empty' 2>/dev/null); do
        aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 || true
      done
    fi
  fi
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdSqsFifoUnnamed?*)
      for url in $(aws sqs list-queues --queue-name-prefix "${STACK}-" --region "${REGION}" \
        --query 'QueueUrls[]' --output text 2>/dev/null); do
        [ "${url}" = "None" ] && continue
        aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      for arn in $(aws sns list-topics --region "${REGION}" \
        --query "Topics[?contains(TopicArn, ':${STACK}-')].TopicArn" --output text 2>/dev/null); do
        [ "${arn}" = "None" ] && continue
        aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' is outside CdkdSqsFifoUnnamed?*" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
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

# The recorded field `<field>` of logical id `<id>` (empty when absent).
state_field() { # usage: state_field <logicalId> <jq path under the record>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${state}" | jq -r --arg l "$1" ".resources[\$l]${2} // empty"
}

queue_attr() { # usage: queue_attr <url> <attribute>
  aws sqs get-queue-attributes --queue-url "$1" --attribute-names "$2" --region "${REGION}" \
    --query "Attributes.$2" --output text
}

# --- Phase 1: deploy -----------------------------------------------------
echo "==> Phase 1: deploy (un-named FIFO, FIFO-as-string and standard queues)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for id in ${QUEUE_IDS}; do
  URL="$(state_field "${id}" '.physicalId')"
  if [ -z "${URL}" ]; then
    echo "FAIL: no recorded physicalId for ${id} in ${STATE_KEY}" >&2
    exit 1
  fi
  NAME="${URL##*/}"
  echo "    ${id}: ${NAME} (${#NAME} characters)"
  case "${NAME}" in
    "${STACK}-${id}-"?*) ;;
    *)
      echo "FAIL: ${id}'s generated name '${NAME}' does not start with '${STACK}-${id}-'" >&2
      exit 1
      ;;
  esac
  if [ "${#NAME}" -gt 80 ]; then
    echo "FAIL: ${id}'s name '${NAME}' is ${#NAME} characters, over SQS's 80" >&2
    exit 1
  fi
  RECORDED_NAME="$(state_field "${id}" '.attributes.QueueName')"
  if [ "${RECORDED_NAME}" != "${NAME}" ]; then
    echo "FAIL: ${id}'s recorded QueueName '${RECORDED_NAME}' is not its URL's name '${NAME}'" >&2
    exit 1
  fi
  # Resolve by NAME (exact, never the eventually consistent ListQueues).
  BY_NAME="$(aws sqs get-queue-url --queue-name "${NAME}" --region "${REGION}" --query 'QueueUrl' --output text)"
  if [ "${BY_NAME##*/}" != "${NAME}" ]; then
    echo "FAIL: get-queue-url --queue-name ${NAME} returned '${BY_NAME}'" >&2
    exit 1
  fi
  if [ "${id}" = "StandardQueue" ]; then
    # SQS refuses `--attribute-names FifoQueue` on a standard queue
    # (InvalidAttributeName), so read every attribute and look for the key.
    FIFO_ATTR="$(aws sqs get-queue-attributes --queue-url "${URL}" --attribute-names All \
      --region "${REGION}" --query 'Attributes.FifoQueue' --output text)"
    case "${NAME}" in
      *.fifo)
        echo "FAIL: the standard queue's name '${NAME}' ends with .fifo" >&2
        exit 1
        ;;
    esac
    if [ "${FIFO_ATTR}" != "None" ]; then
      echo "FAIL: the standard queue reads FifoQueue='${FIFO_ATTR}', expected no attribute" >&2
      exit 1
    fi
  else
    FIFO_ATTR="$(queue_attr "${URL}" FifoQueue)"
    case "${NAME}" in
      *.fifo) ;;
      *)
        echo "FAIL (#6100): ${id}'s generated name '${NAME}' does not end with .fifo" >&2
        exit 1
        ;;
    esac
    if [ "${FIFO_ATTR}" != "true" ]; then
      echo "FAIL (#6100): ${id} reads FifoQueue='${FIFO_ATTR}', expected 'true'" >&2
      exit 1
    fi
  fi
done
echo "    OK: both FIFO queues are named <stack>-<logicalId>-<suffix>.fifo and are FIFO; the standard queue is not"

TOPIC_ARN="$(state_field FifoTopic '.physicalId')"
TOPIC_NAME="${TOPIC_ARN##*:}"
echo "    FifoTopic: ${TOPIC_NAME} (${#TOPIC_NAME} characters)"
case "${TOPIC_NAME}" in
  "${STACK}-FifoTopic-"?*.fifo) ;;
  *)
    echo "FAIL (#6100): the FIFO topic's generated name '${TOPIC_NAME}' is not '${STACK}-FifoTopic-<suffix>.fifo' (ARN '${TOPIC_ARN}')" >&2
    exit 1
    ;;
esac
TOPIC_FIFO="$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query 'Attributes.FifoTopic' --output text)"
if [ "${TOPIC_FIFO}" != "true" ]; then
  echo "FAIL (#6100): the topic reads FifoTopic='${TOPIC_FIFO}', expected 'true'" >&2
  exit 1
fi
echo "    OK: the un-named FIFO topic is named <stack>-FifoTopic-<suffix>.fifo and is FIFO"

# --- Phase 2: in-place update of the FIFO queue -----------------------------
FIFO_URL="$(state_field FifoQueue '.physicalId')"
BASE_VT="$(queue_attr "${FIFO_URL}" VisibilityTimeout)"
if [ "${BASE_VT}" != "30" ]; then
  echo "FAIL: baseline VisibilityTimeout expected '30', got '${BASE_VT}'" >&2
  exit 1
fi
BASE_CREATED="$(queue_attr "${FIFO_URL}" CreatedTimestamp)"

echo "==> Phase 2: redeploy with FifoQueue's VisibilityTimeout 30 -> 45 (CDKD_TEST_UPDATE=true)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

UPDATED_URL="$(state_field FifoQueue '.physicalId')"
if [ "${UPDATED_URL}" != "${FIFO_URL}" ]; then
  echo "FAIL: FifoQueue's recorded URL changed (${FIFO_URL} -> ${UPDATED_URL}) — replaced, not updated in place" >&2
  exit 1
fi
# SetQueueAttributes documents up to 60s propagation, so poll bounded.
VT_AFTER=""
for i in $(seq 1 6); do
  VT_AFTER="$(queue_attr "${FIFO_URL}" VisibilityTimeout)"
  echo "    poll ${i}: VisibilityTimeout=${VT_AFTER}"
  if [ "${VT_AFTER}" = "45" ]; then
    break
  fi
  if [ "${i}" -lt 6 ]; then sleep 10; fi
done
if [ "${VT_AFTER}" != "45" ]; then
  echo "FAIL: VisibilityTimeout expected '45' after the update, got '${VT_AFTER}'" >&2
  exit 1
fi
CREATED_AFTER="$(queue_attr "${FIFO_URL}" CreatedTimestamp)"
if [ "${CREATED_AFTER}" != "${BASE_CREATED}" ]; then
  echo "FAIL: CreatedTimestamp changed (${BASE_CREATED} -> ${CREATED_AFTER}) — queue was REPLACED, not updated in place" >&2
  exit 1
fi
echo "    OK: VisibilityTimeout updated in place (same URL, CreatedTimestamp unchanged)"

# --- Phase 3: destroy -------------------------------------------------------
NAMES=""
for id in ${QUEUE_IDS}; do
  URL="$(state_field "${id}" '.physicalId')"
  NAMES="${NAMES} ${URL##*/}"
done
TOPIC_ARN="$(state_field FifoTopic '.physicalId')"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for name in ${NAMES}; do
  assert_gone "queue ${name} still exists after destroy" aws sqs get-queue-url --queue-name "${name}" --region "${REGION}"
done
echo "    OK: all three queues are gone"
assert_gone "topic ${TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: the topic is gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

trap - EXIT INT TERM

echo "[verify] PASS — un-named FIFO queues (boolean and string FifoQueue) and an un-named FIFO topic get a .fifo name, the queue updates in place, destroy clean"
