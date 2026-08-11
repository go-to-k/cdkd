#!/usr/bin/env bash
# verify.sh — cdkd FIFO SQS queue as a Lambda event source integ.
#
# A `.fifo` queue (contentBasedDeduplication) wired to a Lambda via
# SqsEventSource synthesizes an AWS::Lambda::EventSourceMapping against a FIFO
# source. FIFO is barely covered by the integ suite. The consumer writes each
# received body + MessageGroupId to DynamoDB so the functional check can confirm
# the messages were actually delivered + processed.
#
# Phases:
#   1. Deploy. send 3 messages across 2 MessageGroupIds, then poll the DynamoDB
#      table until all 3 are recorded (proves the FIFO ESM fires end-to-end and
#      preserves the group ids).
#   1b. CDKD_TEST_REMOVAL=true redeploy DROPS contentBasedDeduplication,
#      deduplicationScope, and fifoThroughputLimit from the queue and asserts
#      ContentBasedDeduplication reads 'false', DeduplicationScope reads
#      'queue', and FifoThroughputLimit reads 'perQueue' IN PLACE (issue
#      #1237 updateable classification + the #1160 removal resets; the
#      baseline is the high-throughput pair messageGroup+perMessageGroupId,
#      removed together — the only removal shape AWS accepts), with an
#      unchanged CreatedTimestamp as the no-replacement guard (re issue
#      #1238 same-name deletion hazard). SetQueueAttributes documents up to
#      60s propagation, so the attribute read is a bounded retry loop.
#   2. Destroy + assert the queue / function / table are gone, the ESM is gone,
#      the cdkd state file is removed, and Lambda log groups are swept.
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

STACK="CdkdFifoSqsEventSourceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
QUEUE_NAME="cdkd-fifo-sqs-source.fifo"
FN_NAME="cdkd-fifo-sqs-consumer"
TABLE_NAME="cdkd-fifo-sqs-seen"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${FN_NAME}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

queue_url() {
  local out
  if gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
    echo ""
    return 0
  fi
  if ! out="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
      --query 'QueueUrl' --output text 2>&1)"; then
    # TOCTOU: the queue can vanish between gone_probe and this requery.
    printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && { echo ""; return 0; } \
      || { echo "FAIL: get-queue-url requery undetermined: ${out}" >&2; exit 1; }
  fi
  printf '%s\n' "${out}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN_NAME}" \
    --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  local url
  url="$(queue_url)"
  if [ -n "${url}" ] && [ "${url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  sweep_log_groups
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

# --- Phase 1: deploy + functional FIFO delivery -----------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

URL="$(queue_url)"
echo "==> Phase 1 functional: send 3 FIFO messages (2 groups) -> Lambda -> DynamoDB"
aws sqs send-message --queue-url "${URL}" --message-body "msg-A1" --message-group-id g1 --region "${REGION}" >/dev/null
aws sqs send-message --queue-url "${URL}" --message-body "msg-A2" --message-group-id g1 --region "${REGION}" >/dev/null
aws sqs send-message --queue-url "${URL}" --message-body "msg-B1" --message-group-id g2 --region "${REGION}" >/dev/null

# SQS->Lambda ESM first-fire (esp. cold start) can take 5-20s, so space the
# poll with a real wait (~90s budget). `sleep` is honored on CI/Linux; the
# `|| true` keeps the loop from aborting under `set -e` in environments where
# `sleep` is unavailable.
COUNT=0
for i in $(seq 1 18); do
  COUNT="$(aws dynamodb scan --table-name "${TABLE_NAME}" --select COUNT --region "${REGION}" \
    --query 'Count' --output text 2>/dev/null || echo 0)"
  echo "    poll ${i}: ${COUNT}/3 processed"
  if [ "${COUNT}" = "3" ]; then break; fi
  sleep 5 2>/dev/null || true
done
if [ "${COUNT}" != "3" ]; then
  echo "FAIL: expected 3 FIFO messages processed into DynamoDB, got ${COUNT}" >&2
  exit 1
fi

# Spot-check group-id preservation across BOTH groups: msg-A1 -> g1, msg-B1 -> g2.
GROUP_A1="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
  --key '{"id":{"S":"msg-A1"}}' --query 'Item.group.S' --output text)"
GROUP_B1="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
  --key '{"id":{"S":"msg-B1"}}' --query 'Item.group.S' --output text)"
if [ "${GROUP_A1}" != "g1" ]; then
  echo "FAIL: msg-A1 expected MessageGroupId g1, got '${GROUP_A1}'" >&2
  exit 1
fi
if [ "${GROUP_B1}" != "g2" ]; then
  echo "FAIL: msg-B1 expected MessageGroupId g2, got '${GROUP_B1}'" >&2
  exit 1
fi
echo "    all 3 FIFO messages processed; MessageGroupId preserved (msg-A1 -> g1, msg-B1 -> g2)"

# --- Phase 1b: in-place removal of FIFO attributes (issues #1237 / #1160) ----
echo "==> Phase 1b: capture baseline queue attributes"
BASE_CBD="$(aws sqs get-queue-attributes --queue-url "${URL}" \
  --attribute-names ContentBasedDeduplication --region "${REGION}" \
  --query 'Attributes.ContentBasedDeduplication' --output text)"
if [ "${BASE_CBD}" != "true" ]; then
  echo "FAIL: baseline ContentBasedDeduplication expected 'true', got '${BASE_CBD}'" >&2
  exit 1
fi
BASE_SCOPE="$(aws sqs get-queue-attributes --queue-url "${URL}" \
  --attribute-names DeduplicationScope --region "${REGION}" \
  --query 'Attributes.DeduplicationScope' --output text)"
if [ "${BASE_SCOPE}" != "messageGroup" ]; then
  echo "FAIL: baseline DeduplicationScope expected 'messageGroup', got '${BASE_SCOPE}'" >&2
  exit 1
fi
BASE_LIMIT="$(aws sqs get-queue-attributes --queue-url "${URL}" \
  --attribute-names FifoThroughputLimit --region "${REGION}" \
  --query 'Attributes.FifoThroughputLimit' --output text)"
if [ "${BASE_LIMIT}" != "perMessageGroupId" ]; then
  echo "FAIL: baseline FifoThroughputLimit expected 'perMessageGroupId', got '${BASE_LIMIT}'" >&2
  exit 1
fi
BASE_CREATED="$(aws sqs get-queue-attributes --queue-url "${URL}" \
  --attribute-names CreatedTimestamp --region "${REGION}" \
  --query 'Attributes.CreatedTimestamp' --output text)"

echo "==> Phase 1b: redeploy with contentBasedDeduplication + deduplicationScope + fifoThroughputLimit DROPPED (CDKD_TEST_REMOVAL=true)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# SetQueueAttributes documents up to 60s propagation for attribute reads, so
# poll bounded (~60s budget) until ALL THREE attributes read their defaults.
# The if/then/break form (not `[ ... ] && break`) keeps a failed test from
# ever being the loop body's trailing && list.
CBD_AFTER=""
SCOPE_AFTER=""
LIMIT_AFTER=""
for i in $(seq 1 6); do
  # One API call per poll, one consistent snapshot for all three reads.
  ATTRS_JSON="$(aws sqs get-queue-attributes --queue-url "${URL}" \
    --attribute-names ContentBasedDeduplication DeduplicationScope FifoThroughputLimit \
    --region "${REGION}" --query 'Attributes' --output json)"
  CBD_AFTER="$(printf '%s' "${ATTRS_JSON}" | jq -r '.ContentBasedDeduplication // "None"')"
  SCOPE_AFTER="$(printf '%s' "${ATTRS_JSON}" | jq -r '.DeduplicationScope // "None"')"
  LIMIT_AFTER="$(printf '%s' "${ATTRS_JSON}" | jq -r '.FifoThroughputLimit // "None"')"
  echo "    poll ${i}: ContentBasedDeduplication=${CBD_AFTER} DeduplicationScope=${SCOPE_AFTER} FifoThroughputLimit=${LIMIT_AFTER}"
  if [ "${CBD_AFTER}" = "false" ] && [ "${SCOPE_AFTER}" = "queue" ] && [ "${LIMIT_AFTER}" = "perQueue" ]; then
    break
  fi
  # No sleep after the final poll — it would only delay the failure report.
  if [ "${i}" -lt 6 ]; then sleep 10; fi
done
if [ "${CBD_AFTER}" != "false" ]; then
  echo "FAIL: ContentBasedDeduplication expected 'false' after removal redeploy, got '${CBD_AFTER}'" >&2
  exit 1
fi
if [ "${SCOPE_AFTER}" != "queue" ]; then
  echo "FAIL: DeduplicationScope expected 'queue' after removal redeploy, got '${SCOPE_AFTER}'" >&2
  exit 1
fi
if [ "${LIMIT_AFTER}" != "perQueue" ]; then
  echo "FAIL: FifoThroughputLimit expected 'perQueue' after removal redeploy, got '${LIMIT_AFTER}'" >&2
  exit 1
fi

# Replacement guard (re issue #1238): the SAME queue must survive the update —
# a replacement would mint a new CreatedTimestamp (and lose queued messages).
CREATED_AFTER="$(aws sqs get-queue-attributes --queue-url "${URL}" \
  --attribute-names CreatedTimestamp --region "${REGION}" \
  --query 'Attributes.CreatedTimestamp' --output text)"
if [ "${CREATED_AFTER}" != "${BASE_CREATED}" ]; then
  echo "FAIL: CreatedTimestamp changed (${BASE_CREATED} -> ${CREATED_AFTER}) — queue was REPLACED, not updated in place" >&2
  exit 1
fi
echo "    FIFO attrs removed in place (CBD 'false', scope 'queue', limit 'perQueue', CreatedTimestamp unchanged)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    OK: queue is gone"

# DynamoDB DeleteTable is async — the table lingers in DELETING state (and
# describe-table still succeeds) for a short window after the destroy
# reports success, so poll bounded (~60s) instead of reading once (observed
# flake 2026-07-27; same class as the ESM Deleting-state lag above).
TABLE_GONE=""
for i in $(seq 1 6); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    TABLE_GONE="yes"
    break
  fi
  echo "    poll ${i}: table ${TABLE_NAME} still listed (DELETING-state lag)"
  if [ "${i}" -lt 6 ]; then sleep 10; fi
done
if [ "${TABLE_GONE}" != "yes" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists after destroy (waited 60s)" >&2
  exit 1
fi
echo "    OK: table is gone"
# A just-deleted ESM lingers in `Deleting` state and still appears in
# list-event-source-mappings for up to ~1 min after DeleteEventSourceMapping
# returns, so poll bounded (~60s) instead of reading once — a single
# immediate read flakes as a false leak (observed 2026-07-27).
LEFT_ESM="1"
for i in $(seq 1 6); do
  LEFT_ESM="$(aws lambda list-event-source-mappings --region "${REGION}" \
    --query "length(EventSourceMappings[?contains(FunctionArn, '${FN_NAME}')])" --output text)"
  if [ "${LEFT_ESM}" = "0" ]; then break; fi
  echo "    poll ${i}: ${LEFT_ESM} event source mapping(s) still listed (Deleting-state lag)"
  if [ "${i}" -lt 6 ]; then sleep 10; fi
done
if [ "${LEFT_ESM}" != "0" ]; then
  echo "FAIL: ${LEFT_ESM} event source mapping(s) left after destroy (waited 60s)" >&2
  exit 1
fi
echo "    function + event source mapping deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

sweep_log_groups

echo "[verify] PASS — FIFO SQS Lambda event source delivers + preserves MessageGroupId, destroy clean, all phases passed"
