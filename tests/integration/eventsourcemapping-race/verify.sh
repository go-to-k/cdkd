#!/usr/bin/env bash
# verify.sh - cdkd EventSourceMapping fresh-source race integ test.
#
# FAILURE-SEEKING test for `AWS::Lambda::EventSourceMapping` created
# against a FRESH SQS queue + a FRESH execution role in the SAME deploy.
#
# What it proves:
#   1. The ESM create does NOT race the fresh source / role: `cdkd deploy`
#      succeeds and the mapping exists + is Enabled on AWS
#      (list-event-source-mappings). A race would surface as an
#      InvalidParameterValueException at create; on deploy failure we
#      print the specifics.
#   2. The wiring actually delivers: a probe message sent to the queue is
#      processed by the Lambda (a `CDKD_ESM_PROCESSED <body>` marker line
#      appears in the function's CloudWatch logs).
#   3. The orphan-ESM-on-redeploy class is guarded: a PRE-FLIGHT orphan
#      scan (per the run-integ skill) aborts if a prior killed run left an
#      ESM bound to this stack's function; and after destroy we assert NO
#      orphan ESM survives (list-event-source-mappings filtered by the
#      function) plus the queue + state are gone.
#
# BSD-portable (no `grep -P`, no `date -d`). Real exit code via explicit
# rc capture in the standard run-integ flow; emits an explicit PASS line.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdEsmRaceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved from cdkd state after deploy.
FUNCTION_NAME=""
QUEUE_URL=""
QUEUE_ARN=""
ESM_UUID=""

# --- shared helper: list ESM UUIDs bound to a function -----------------
# Filters list-event-source-mappings by FunctionArn substring so it works
# whether $1 is a bare name or an ARN. Prints one UUID per line.
list_esms_for_function() {
  local fn="$1"
  [ -z "${fn}" ] && return 0
  aws lambda list-event-source-mappings \
    --region "${REGION}" \
    --query "EventSourceMappings[?contains(FunctionArn, \`${fn}\`)].UUID" \
    --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover ESM + state + AWS resources"
  # set +eu so an early-exit (e.g. STATE_BUCKET unset before deploy) does
  # not abort cleanup on the first unbound expansion - best-effort.
  set +eu
  # Delete any ESM still bound to our function (orphan or in-state).
  if [ -n "${FUNCTION_NAME}" ]; then
    for uuid in $(list_esms_for_function "${FUNCTION_NAME}"); do
      aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${QUEUE_URL}" ]; then
    aws sqs delete-queue --queue-url "${QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

# --- Pre-flight orphan scan (per the run-integ skill) ------------------
# The orphan-ESM-on-redeploy class: a prior run killed mid-deploy can
# leave an EventSourceMapping NOT in cdkd state. cdkd's diff would then
# CREATE a fresh ESM that collides (ResourceConflictException) on the
# (FunctionName, EventSourceArn) pair. Failing fast here is far cheaper
# than a CREATE-then-rollback. The function is CDK-auto-named with the
# stack-name prefix, so we scan list-event-source-mappings for any UUID
# whose FunctionArn contains the stack name.
echo "==> Pre-flight orphan scan (EventSourceMapping by stack name)"
PREFLIGHT_ESMS=$(list_esms_for_function "${STACK}")
if [ -n "${PREFLIGHT_ESMS}" ]; then
  echo "FAIL: pre-flight found orphan EventSourceMapping(s) bound to a '${STACK}' function:" >&2
  echo "${PREFLIGHT_ESMS}" >&2
  echo "  Clean them up first, e.g.:" >&2
  for uuid in ${PREFLIGHT_ESMS}; do
    echo "    aws lambda delete-event-source-mapping --uuid ${uuid} --region ${REGION}" >&2
  done
  echo "    node ${LOCAL_DIST} state destroy ${STACK} --region ${REGION} --yes" >&2
  exit 1
fi
echo "    OK: no orphan EventSourceMapping bound to '${STACK}'"

echo "==> Pre-run cleanup (state-only; orphan scan above already gates AWS)"
cleanup

# --- Phase 1: deploy ---------------------------------------------------
# The ESM create races the fresh queue + fresh role here. A race failure
# surfaces as a non-zero deploy exit; capture + print specifics.
echo "==> Phase 1: deploy with the local binary"
DEPLOY_LOG=$(mktemp)
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DEPLOY_LOG}" 2>&1; then
  echo "FAIL: cdkd deploy failed - possible EventSourceMapping fresh-source/role race." >&2
  echo "      Look for InvalidParameterValueException ('Cannot access queue' /" >&2
  echo "      'does not have permissions' / 'Function not found') below:" >&2
  echo "----- deploy output -----" >&2
  cat "${DEPLOY_LOG}" >&2
  echo "-------------------------" >&2
  # Surface any ESM-specific error line explicitly (BSD grep -E, no -P).
  grep -E -i "EventSourceMapping|InvalidParameterValue|does not have permissions|Cannot access|Function not found|ResourceConflict" "${DEPLOY_LOG}" >&2 || true
  rm -f "${DEPLOY_LOG}"
  exit 1
fi
cat "${DEPLOY_LOG}"
rm -f "${DEPLOY_LOG}"
echo "    OK: deploy succeeded (ESM created without a fresh-source/role race)"

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

FUNCTION_NAME=$(echo "${STATE}" | jq -r '.outputs.FunctionName // ""')
QUEUE_URL=$(echo "${STATE}" | jq -r '.outputs.QueueUrl // ""')
QUEUE_ARN=$(echo "${STATE}" | jq -r '.outputs.QueueArn // ""')
ESM_UUID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .value.physicalId] | first // ""')

if [ -z "${FUNCTION_NAME}" ] || [ "${FUNCTION_NAME}" = "null" ]; then
  echo "FAIL: could not resolve FunctionName output from state" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
if [ -z "${QUEUE_URL}" ] || [ "${QUEUE_URL}" = "null" ]; then
  echo "FAIL: could not resolve QueueUrl output from state" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
if [ -z "${ESM_UUID}" ] || [ "${ESM_UUID}" = "null" ]; then
  echo "FAIL: could not resolve EventSourceMapping UUID from state" >&2
  echo "${STATE}" | jq '.resources'
  exit 1
fi
echo "    resolved function: ${FUNCTION_NAME}"
echo "    resolved queue:    ${QUEUE_URL}"
echo "    resolved ESM UUID: ${ESM_UUID}"

# --- Assertion: the ESM exists + is Enabled on AWS ---------------------
# list-event-source-mappings (filtered by the queue ARN) must return our
# UUID. SQS ESMs report State 'Enabled' (or briefly 'Creating') once
# active; poll until it reaches Enabled.
echo "==> Asserting ESM exists + reaches Enabled"
ESM_STATE=""
for _ in $(seq 1 24); do
  ESM_JSON=$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" 2>/dev/null || true)
  ESM_STATE=$(echo "${ESM_JSON}" | jq -r '.State // ""')
  if [ "${ESM_STATE}" = "Enabled" ]; then
    break
  fi
  sleep 5
done
if [ "${ESM_STATE}" != "Enabled" ]; then
  echo "FAIL: ESM ${ESM_UUID} never reached State=Enabled (last state: '${ESM_STATE}')" >&2
  aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" 2>/dev/null | jq . >&2 || true
  exit 1
fi
echo "    OK: ESM is Enabled on AWS"

# Cross-check that list-event-source-mappings filtered by the queue ARN
# returns exactly our UUID (proves the EventSourceArn wiring).
LISTED=$(aws lambda list-event-source-mappings \
  --event-source-arn "${QUEUE_ARN}" \
  --region "${REGION}" \
  --query 'EventSourceMappings[].UUID' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
if ! echo "${LISTED}" | grep -qx "${ESM_UUID}"; then
  echo "FAIL: list-event-source-mappings by queue ARN did not return ${ESM_UUID}" >&2
  echo "      got: ${LISTED}" >&2
  exit 1
fi
echo "    OK: list-event-source-mappings by queue ARN returns the ESM"

# --- Assertion: wiring delivers (send message -> Lambda processes) -----
PROBE="cdkd-esm-probe-$$-$(date -u +%Y%m%d%H%M%S)"
echo "==> Sending probe message to the queue: ${PROBE}"
aws sqs send-message --queue-url "${QUEUE_URL}" --message-body "${PROBE}" --region "${REGION}" >/dev/null

LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
echo "==> Polling CloudWatch logs for the processed marker"
PROCESSED=""
for _ in $(seq 1 36); do
  # filter-log-events surfaces the handler's `CDKD_ESM_PROCESSED <body>`
  # print line once the ESM polls + invokes. The log group / stream may
  # not exist until the first invocation, so tolerate errors and retry.
  HITS=$(aws logs filter-log-events \
    --log-group-name "${LOG_GROUP}" \
    --region "${REGION}" \
    --filter-pattern "CDKD_ESM_PROCESSED" \
    --query 'events[].message' --output text 2>/dev/null || true)
  if echo "${HITS}" | grep -qF "${PROBE}"; then
    PROCESSED=1
    break
  fi
  sleep 5
done
if [ -z "${PROCESSED}" ]; then
  echo "FAIL: Lambda never logged 'CDKD_ESM_PROCESSED ${PROBE}' within ~3min" >&2
  echo "      (the ESM exists + is Enabled, but the queue -> ESM -> Lambda" >&2
  echo "       delivery is not working)" >&2
  exit 1
fi
echo "    OK: Lambda processed the probe message (wiring verified)"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Assert NO orphan ESM survives. The mapping delete is effectively
# immediate, but get-event-source-mapping can briefly report 'Deleting';
# poll until list-by-function returns empty.
echo "==> Asserting no orphan EventSourceMapping survives"
ESM_GONE=""
for _ in $(seq 1 24); do
  REMAINING=$(list_esms_for_function "${FUNCTION_NAME}")
  if [ -z "${REMAINING}" ]; then
    ESM_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${ESM_GONE}" ]; then
  echo "FAIL: orphan EventSourceMapping(s) still bound to ${FUNCTION_NAME} ~2min after destroy:" >&2
  list_esms_for_function "${FUNCTION_NAME}" >&2
  exit 1
fi
echo "    OK: no orphan EventSourceMapping remains"

# Queue gone.
if aws sqs get-queue-url --queue-name "$(basename "${QUEUE_URL}")" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SQS queue ${QUEUE_URL} still exists after destroy" >&2
  exit 1
fi
# get-queue-url by name above can lag; the direct URL check is the
# authoritative one.
if aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SQS queue ${QUEUE_URL} still reachable after destroy" >&2
  exit 1
fi
QUEUE_URL=""
echo "    OK: SQS queue is gone"

# State gone.
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> eventsourcemapping-race test PASSED (fresh-source/role ESM create + message processing + no-orphan-ESM destroy)"
