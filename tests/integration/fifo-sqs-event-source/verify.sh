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
  aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
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
  --key '{"id":{"S":"msg-A1"}}' --query 'Item.group.S' --output text 2>/dev/null || true)"
GROUP_B1="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
  --key '{"id":{"S":"msg-B1"}}' --query 'Item.group.S' --output text 2>/dev/null || true)"
if [ "${GROUP_A1}" != "g1" ]; then
  echo "FAIL: msg-A1 expected MessageGroupId g1, got '${GROUP_A1}'" >&2
  exit 1
fi
if [ "${GROUP_B1}" != "g2" ]; then
  echo "FAIL: msg-B1 expected MessageGroupId g2, got '${GROUP_B1}'" >&2
  exit 1
fi
echo "    all 3 FIFO messages processed; MessageGroupId preserved (msg-A1 -> g1, msg-B1 -> g2)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
LEFT_ESM="$(aws lambda list-event-source-mappings --region "${REGION}" \
  --query "length(EventSourceMappings[?contains(FunctionArn, '${FN_NAME}')])" --output text 2>/dev/null || echo 0)"
if [ "${LEFT_ESM}" != "0" ]; then
  echo "FAIL: ${LEFT_ESM} event source mapping(s) left after destroy" >&2
  exit 1
fi
echo "    function + event source mapping deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

sweep_log_groups

echo "[verify] PASS — FIFO SQS Lambda event source delivers + preserves MessageGroupId, destroy clean, all phases passed"
