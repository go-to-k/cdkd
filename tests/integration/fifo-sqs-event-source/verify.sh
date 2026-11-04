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
#   1a. Wait for the event source mapping to settle to `Enabled`, then assert the
#      observedProperties baseline recorded `Enabled: true` and `cdkd drift`
#      reports the mapping clean (issue #5737: the baseline read while the
#      mapping was still `Creating` recorded `Enabled: false`).
#   1c. Write that old `Enabled: false` baseline into state (lock-free, ETag-
#      guarded put, one field), then assert `cdkd drift` still reports the
#      mapping clean and `cdkd drift --revert --yes` leaves it `Enabled`
#      (issue #5749: a pre-#5737 baseline healed at read time, no --accept).
#   1b. CDKD_TEST_REMOVAL=true redeploy DROPS contentBasedDeduplication,
#      deduplicationScope, and fifoThroughputLimit from the queue and asserts
#      ContentBasedDeduplication reads 'false' (reset, as CloudFormation does)
#      while DeduplicationScope stays 'messageGroup' and FifoThroughputLimit
#      stays 'perMessageGroupId' (CloudFormation KEEPS both on removal, issue
#      #5004 A/B), all IN PLACE (issue #1237 updateable classification + the
#      #1160 removal reset for ContentBasedDeduplication), with an
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
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}" \
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

# --- Phase 1a: no phantom Enabled drift once the mapping settles (#5737) -----
# The post-create observedProperties baseline is read while the mapping is
# still `Creating`; cdkd used to read that as `Enabled: false`, so once the
# mapping settled to `Enabled` every drift run reported `Enabled: false -> true`
# and `drift --revert` DISABLED the consumer. Wait for the settled state first:
# a drift run while it is still `Creating` reads the same wrong value on both
# sides and passes vacuously.
echo "==> Phase 1a: wait for the event source mapping to settle, then assert no Enabled drift (#5737)"
ESM_UUIDS="$(aws lambda list-event-source-mappings --function-name "${FN_NAME}" \
  --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text)"
ESM_COUNT="$(printf '%s\n' "${ESM_UUIDS}" | wc -w | tr -d ' ')"
if [ "${ESM_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 event source mapping on ${FN_NAME}, got ${ESM_COUNT} (${ESM_UUIDS})" >&2
  exit 1
fi
ESM_UUID="${ESM_UUIDS}"
ESM_STATE=""
for i in $(seq 1 12); do
  ESM_STATE="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
    --query 'State' --output text)"
  echo "    poll ${i}: mapping State=${ESM_STATE}"
  if [ "${ESM_STATE}" = "Enabled" ]; then break; fi
  if [ "${i}" -lt 12 ]; then sleep 10; fi
done
if [ "${ESM_STATE}" != "Enabled" ]; then
  echo "FAIL: event source mapping ${ESM_UUID} did not settle to Enabled within 120s (last State=${ESM_STATE})" >&2
  exit 1
fi

# The baseline itself: the template never declares Enabled, so the recorded
# observedProperties must read true (the pre-fix binary recorded false here).
ESM_STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
ESM_LIDS="$(printf '%s' "${ESM_STATE_JSON}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .key')"
ESM_LID_COUNT="$(printf '%s\n' "${ESM_LIDS}" | wc -w | tr -d ' ')"
if [ "${ESM_LID_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 AWS::Lambda::EventSourceMapping record in state, got ${ESM_LID_COUNT} (${ESM_LIDS})" >&2
  exit 1
fi
ESM_LID="${ESM_LIDS}"
ESM_OBSERVED_ENABLED="$(printf '%s' "${ESM_STATE_JSON}" | jq -r --arg l "${ESM_LID}" '.resources[$l].observedProperties.Enabled | tostring')"
if [ "${ESM_OBSERVED_ENABLED}" != "true" ]; then
  echo "FAIL (#5737): ${ESM_LID} observedProperties.Enabled is '${ESM_OBSERVED_ENABLED}', expected 'true' (the mapping was created enabled; a false baseline makes drift --revert disable it)" >&2
  exit 1
fi

# And the comparison drift makes from it, read for THIS resource only (the
# stack's other resources are not this arm's subject).
DRIFT_JSON_OUT=""
DRIFT_RC=0
DRIFT_JSON_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || DRIFT_RC=$?
ESM_CLEAN="$(printf '%s' "${DRIFT_JSON_OUT}" | jq --arg l "${ESM_LID}" '[.[].clean[] | select(.logicalId == $l)] | length' 2>/dev/null || echo "?")"
ESM_DRIFTED="$(printf '%s' "${DRIFT_JSON_OUT}" | jq --arg l "${ESM_LID}" '[.[].drifted[] | select(.logicalId == $l)] | length' 2>/dev/null || echo "?")"
if [ "${ESM_CLEAN}" != "1" ] || [ "${ESM_DRIFTED}" != "0" ]; then
  echo "FAIL (#5737): expected ${ESM_LID} compared and CLEAN in cdkd drift after the mapping settled (clean=${ESM_CLEAN} drifted=${ESM_DRIFTED} rc=${DRIFT_RC}). Report: ${DRIFT_JSON_OUT}" >&2
  exit 1
fi
echo "    OK: mapping settled to Enabled; baseline Enabled=true; cdkd drift reports ${ESM_LID} clean (drift rc=${DRIFT_RC})"

# --- Phase 1c: a pre-#5737 Enabled: false baseline heals in drift (#5749) -----
# A mapping deployed by an older cdkd still holds observedProperties.Enabled:
# false. Write that old baseline into state (guarded: no lock held, and the put
# carries the read's ETag), then assert cdkd drift reports the mapping clean and
# drift --revert leaves it Enabled (the pre-fix binary reported false -> true
# and the revert DISABLED the consumer). Only that one field is rewritten.
echo "==> Phase 1c: inject the pre-#5737 Enabled: false baseline, assert drift is clean and --revert keeps the mapping Enabled (#5749)"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"; then
  echo "FAIL (#5749): ${LOCK_KEY} exists -- refusing to rewrite state while a lock is held" >&2
  exit 1
fi
INJECT_DIR="$(mktemp -d)"
INJECT_IN="${INJECT_DIR}/state.json"
INJECT_OUT="${INJECT_DIR}/state.injected.json"
if ! INJECT_ETAG="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
    --query 'ETag' --output text "${INJECT_IN}" 2>/dev/null)" || [ -z "${INJECT_ETAG}" ] || [ "${INJECT_ETAG}" = "None" ]; then
  echo "FAIL (#5749): could not read ${STATE_KEY} with its ETag" >&2
  rm -rf "${INJECT_DIR}"
  exit 1
fi
jq --arg l "${ESM_LID}" '.resources[$l].observedProperties.Enabled = false' "${INJECT_IN}" >"${INJECT_OUT}"
# Exactly one field changed, from true: with it deleted, the documents match.
INJECT_SAME="$(jq -n --arg l "${ESM_LID}" --slurpfile a "${INJECT_IN}" --slurpfile b "${INJECT_OUT}" \
  '($a[0].resources[$l].observedProperties.Enabled == true)
   and (($a[0] | del(.resources[$l].observedProperties.Enabled)) == ($b[0] | del(.resources[$l].observedProperties.Enabled)))')"
if [ "${INJECT_SAME}" != "true" ]; then
  echo "FAIL (#5749): the injection would change more than ${ESM_LID}.observedProperties.Enabled (true -> false)" >&2
  rm -rf "${INJECT_DIR}"
  exit 1
fi
if ! aws s3api put-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
    --body "${INJECT_OUT}" --content-type application/json --if-match "${INJECT_ETAG}" >/dev/null; then
  echo "FAIL (#5749): the guarded state rewrite was refused or failed" >&2
  rm -rf "${INJECT_DIR}"
  exit 1
fi
rm -rf "${INJECT_DIR}"
# The write LANDED: read back from S3.
INJECTED_ENABLED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "${ESM_LID}" '.resources[$l].observedProperties.Enabled | tostring')"
if [ "${INJECTED_ENABLED}" != "false" ]; then
  echo "FAIL (#5749): after the injection ${ESM_LID} observedProperties.Enabled reads '${INJECTED_ENABLED}', expected 'false'" >&2
  exit 1
fi

HEAL_JSON_OUT=""
HEAL_RC=0
HEAL_JSON_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)" || HEAL_RC=$?
HEAL_CLEAN="$(printf '%s' "${HEAL_JSON_OUT}" | jq --arg l "${ESM_LID}" '[.[].clean[] | select(.logicalId == $l)] | length' 2>/dev/null || echo "?")"
HEAL_DRIFTED="$(printf '%s' "${HEAL_JSON_OUT}" | jq --arg l "${ESM_LID}" '[.[].drifted[] | select(.logicalId == $l)] | length' 2>/dev/null || echo "?")"
if [ "${HEAL_CLEAN}" != "1" ] || [ "${HEAL_DRIFTED}" != "0" ]; then
  echo "FAIL (#5749): expected ${ESM_LID} CLEAN in cdkd drift over the pre-#5737 Enabled: false baseline (clean=${HEAL_CLEAN} drifted=${HEAL_DRIFTED} rc=${HEAL_RC}). Report: ${HEAL_JSON_OUT}" >&2
  exit 1
fi

# The destructive half: --revert must not send Enabled: false. Its rc is not
# this arm's subject (another resource's revert may fail); the mapping's live
# State is, read a few times so a Disabling transition cannot slip past.
# drift has no per-resource filter, so this reverts the WHOLE stack: any other
# resource drifted at this point is written back to its baseline before Phase 1b.
REVERT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes || REVERT_RC=$?
for i in 1 2 3; do
  ESM_STATE="$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" \
    --query 'State' --output text)"
  echo "    poll ${i}: after drift --revert, mapping State=${ESM_STATE}"
  if [ "${ESM_STATE}" != "Enabled" ]; then
    echo "FAIL (#5749): drift --revert left ${ESM_LID} (${ESM_UUID}) in State=${ESM_STATE}, expected Enabled (revert rc=${REVERT_RC})" >&2
    exit 1
  fi
  if [ "${i}" -lt 3 ]; then sleep 10; fi
done
echo "    OK: drift reports ${ESM_LID} clean over the old baseline; drift --revert left it Enabled (drift rc=${HEAL_RC}, revert rc=${REVERT_RC})"

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
# poll bounded (~60s budget) until ContentBasedDeduplication reads its default.
# DeduplicationScope / FifoThroughputLimit must read their BASELINE values
# throughout (retained, issue #5004), so the loop only waits on CBD.
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
  if [ "${CBD_AFTER}" = "false" ]; then
    break
  fi
  # No sleep after the final poll — it would only delay the failure report.
  if [ "${i}" -lt 6 ]; then sleep 10; fi
done
if [ "${CBD_AFTER}" != "false" ]; then
  echo "FAIL: ContentBasedDeduplication expected 'false' after removal redeploy, got '${CBD_AFTER}'" >&2
  exit 1
fi
if [ "${SCOPE_AFTER}" != "messageGroup" ]; then
  echo "FAIL: DeduplicationScope expected to be RETAINED as 'messageGroup' after removal redeploy (CloudFormation keeps it, issue #5004), got '${SCOPE_AFTER}'" >&2
  exit 1
fi
if [ "${LIMIT_AFTER}" != "perMessageGroupId" ]; then
  echo "FAIL: FifoThroughputLimit expected to be RETAINED as 'perMessageGroupId' after removal redeploy (CloudFormation keeps it, issue #5004), got '${LIMIT_AFTER}'" >&2
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
echo "    FIFO attrs removed in place (CBD reset to 'false'; scope 'messageGroup' and limit 'perMessageGroupId' retained; CreatedTimestamp unchanged)"

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
