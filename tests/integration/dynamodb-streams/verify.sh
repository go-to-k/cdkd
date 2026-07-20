#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB WarmThroughput backfill (#609) + DynamoDB Streams
# StreamSpecification enable-on-UPDATE (#977) integ test.
#
# Phase 1 deploys a PROVISIONED DynamoDB table WITHOUT a stream and asserts:
#   - WarmThroughput (Read/Write UnitsPerSecond) reached AWS (silent-drop #609)
#   - the table has NO enabled stream yet
# The UPDATE phase (CDKD_TEST_UPDATE=true) enables `stream: NEW_AND_OLD_IMAGES`
# on the existing table (plus a Lambda + EventSourceMapping consumer) and
# asserts:
#   - StreamSpecification.StreamEnabled == true (the #977 silent-drop close:
#     StreamSpecification had NO update() branch before, so enabling a stream
#     on UPDATE was dropped — deploy reported green while AWS kept no stream)
#   - LatestStreamArn is non-null (the update-time enable materialized a stream
#     ARN, resolvable via `Fn::GetAtt [Table, StreamArn]`)
#   - the ESM 2-prop backfill (KmsKeyArn / MetricsConfig) reached AWS (#609)
# Also asserts the destroy path cleans up.
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

STACK="DynamodbStreamsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# AWS enforces minimums of 12000 read units / 4000 write units per second.
EXPECTED_READ=12000
EXPECTED_WRITE=4000

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The fixture's EventsTable has no explicit tableName, so CDK auto-generates
# the physical name; we resolve it from cdkd state after deploy.
TABLE_NAME=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS table"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    # Destroy under CDKD_TEST_UPDATE=true so the synthesized template matches
    # whatever phase the state was last written in (the stream-consumer subtree
    # only exists in the UPDATE phase).
    CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${TABLE_NAME}" ]; then
    aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
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

# --- Phase 1: deploy WITHOUT a stream ---------------------------------
echo "==> Phase 1: deploy with the local binary (stream-less table)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the auto-generated table physical name from cdkd state.
TABLE_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DynamoDB::Table") | .value.physicalId] | first // ""')
if [ -z "${TABLE_NAME}" ] || [ "${TABLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve DynamoDB table physical name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved table name: ${TABLE_NAME}"

# --- Assertion: WarmThroughput reached AWS ----------------------------
# DescribeTable returns Table.WarmThroughput (ReadUnitsPerSecond /
# WriteUnitsPerSecond plus an AWS-managed status field) only on tables that
# set warm throughput. Seeing the templated read/write values proves the
# silent-drop is closed by the #609 backfill.
WT=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.WarmThroughput' --output json 2>/dev/null)

ACTUAL_READ=$(echo "${WT}" | jq -r '.ReadUnitsPerSecond // "null"')
ACTUAL_WRITE=$(echo "${WT}" | jq -r '.WriteUnitsPerSecond // "null"')

if [ "${ACTUAL_READ}" != "${EXPECTED_READ}" ]; then
  echo "FAIL: Table.WarmThroughput.ReadUnitsPerSecond is '${ACTUAL_READ}', expected '${EXPECTED_READ}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.ReadUnitsPerSecond == ${EXPECTED_READ} on AWS"

if [ "${ACTUAL_WRITE}" != "${EXPECTED_WRITE}" ]; then
  echo "FAIL: Table.WarmThroughput.WriteUnitsPerSecond is '${ACTUAL_WRITE}', expected '${EXPECTED_WRITE}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.WriteUnitsPerSecond == ${EXPECTED_WRITE} on AWS (silent-drop CLOSED by #609)"

# --- Assertion: NO stream yet (Phase 1 baseline) ----------------------
# DescribeTable's StreamSpecification.StreamEnabled is false (or the block is
# absent) on a stream-less table. Wrap length() on the possibly-null
# StreamSpecification so a null field does not abort under `set -e`.
STREAM_ENABLED_P1=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamEnabled' --output text 2>/dev/null || echo "None")
if [ "${STREAM_ENABLED_P1}" = "True" ]; then
  echo "FAIL: table has a stream enabled in Phase 1, expected none" >&2
  exit 1
fi
echo "    OK: no stream enabled in Phase 1 (StreamEnabled == '${STREAM_ENABLED_P1}')"

# --- UPDATE phase: enable the stream on the existing table (#977) ------
echo "==> UPDATE phase: enable DynamoDB Stream on the existing table"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Re-read state (now carries the stream + the Lambda / ESM consumer subtree).
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file after UPDATE-phase deploy" >&2
  exit 1
fi

# --- Assertion: stream is now enabled (#977 silent-drop close) --------
DT_JSON=$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" 2>/dev/null)

STREAM_ENABLED=$(echo "${DT_JSON}" | jq -r '.Table.StreamSpecification.StreamEnabled // false')
if [ "${STREAM_ENABLED}" != "true" ]; then
  echo "FAIL: Table.StreamSpecification.StreamEnabled is '${STREAM_ENABLED}', expected 'true' (StreamSpecification enable-on-UPDATE NOT applied — #977)" >&2
  echo "${DT_JSON}" | jq '.Table.StreamSpecification'
  exit 1
fi
echo "    OK: Table.StreamSpecification.StreamEnabled == true after UPDATE (silent-drop CLOSED by #977)"

STREAM_VIEW=$(echo "${DT_JSON}" | jq -r '.Table.StreamSpecification.StreamViewType // "null"')
if [ "${STREAM_VIEW}" != "NEW_AND_OLD_IMAGES" ]; then
  echo "FAIL: Table.StreamSpecification.StreamViewType is '${STREAM_VIEW}', expected 'NEW_AND_OLD_IMAGES'" >&2
  echo "${DT_JSON}" | jq '.Table.StreamSpecification'
  exit 1
fi
echo "    OK: Table.StreamSpecification.StreamViewType == NEW_AND_OLD_IMAGES"

# LatestStreamArn is the ARN the update-time enable materialized. Assert it is
# a non-null, non-empty string (also proves Fn::GetAtt [Table, StreamArn]
# had a real value to resolve to).
LATEST_STREAM_ARN=$(echo "${DT_JSON}" | jq -r '.Table.LatestStreamArn // "null"')
if [ -z "${LATEST_STREAM_ARN}" ] || [ "${LATEST_STREAM_ARN}" = "null" ]; then
  echo "FAIL: Table.LatestStreamArn is null/empty after UPDATE-phase enable (#977)" >&2
  echo "${DT_JSON}" | jq '{StreamSpecification: .Table.StreamSpecification, LatestStreamArn: .Table.LatestStreamArn}'
  exit 1
fi
echo "    OK: Table.LatestStreamArn is non-null (${LATEST_STREAM_ARN})"

# The StreamArn output (Fn::GetAtt [Table, StreamArn]) should equal AWS's
# LatestStreamArn — this proves the update() attribute-enrichment fed the
# freshly-enabled stream ARN back into cdkd state / outputs.
STREAM_ARN_OUTPUT=$(echo "${STATE}" | jq -r '.outputs.StreamArn // ""')
if [ "${STREAM_ARN_OUTPUT}" != "${LATEST_STREAM_ARN}" ]; then
  echo "FAIL: cdkd StreamArn output '${STREAM_ARN_OUTPUT}' != AWS LatestStreamArn '${LATEST_STREAM_ARN}' (attribute enrichment gap — #977)" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: cdkd StreamArn output matches AWS LatestStreamArn (attribute enrichment CLOSED by #977)"

# --- Assertion: Lambda::EventSourceMapping 2-props backfill (#609) -----
# The ESM only exists in the UPDATE phase (it needs the stream). Resolve its
# UUID from cdkd state, then GetEventSourceMapping and assert the 2
# universally-applicable props (KmsKeyArn / MetricsConfig) made it to AWS.
ESM_UUID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .value.physicalId] | first // ""')
if [ -z "${ESM_UUID}" ] || [ "${ESM_UUID}" = "null" ]; then
  echo "FAIL: could not resolve EventSourceMapping UUID from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved ESM UUID: ${ESM_UUID}"

EXPECTED_KMS_ARN=$(echo "${STATE}" | jq -r '.outputs.EsmFilterKeyArn // ""')
if [ -z "${EXPECTED_KMS_ARN}" ] || [ "${EXPECTED_KMS_ARN}" = "null" ]; then
  echo "FAIL: cdkd state did not emit an EsmFilterKeyArn output" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi

ESM_JSON=$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" 2>/dev/null)
if [ -z "${ESM_JSON}" ]; then
  echo "FAIL: GetEventSourceMapping returned empty for UUID ${ESM_UUID}" >&2
  exit 1
fi

# Assert KMSKeyArn (SDK casing is upper-case `MS`; CFn casing is lower-
# case `Ms`). The provider's create() does the flip — a missed flip would
# silently drop KmsKeyArn, exactly what #609 closes.
ACTUAL_KMS=$(echo "${ESM_JSON}" | jq -r '.KMSKeyArn // "null"')
if [ "${ACTUAL_KMS}" != "${EXPECTED_KMS_ARN}" ]; then
  echo "FAIL: ESM KMSKeyArn is '${ACTUAL_KMS}', expected '${EXPECTED_KMS_ARN}' (KmsKeyArn silent-drop NOT closed)" >&2
  echo "${ESM_JSON}" | jq .
  exit 1
fi
echo "    OK: ESM.KMSKeyArn matches the deployed key (KmsKeyArn silent-drop CLOSED by #609)"

# Assert MetricsConfig.Metrics contains 'EventCount'.
ACTUAL_METRICS=$(echo "${ESM_JSON}" | jq -r '.MetricsConfig.Metrics // [] | sort | join(",")')
if [ "${ACTUAL_METRICS}" != "EventCount" ]; then
  echo "FAIL: ESM MetricsConfig.Metrics is '${ACTUAL_METRICS}', expected 'EventCount' (MetricsConfig silent-drop NOT closed)" >&2
  echo "${ESM_JSON}" | jq .
  exit 1
fi
echo "    OK: ESM.MetricsConfig.Metrics == ['EventCount'] (MetricsConfig silent-drop CLOSED by #609)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# DynamoDB DeleteTable is async: the table lingers in DELETING for a few
# seconds before describe-table returns ResourceNotFoundException. Poll
# until it is truly gone rather than racing the async delete.
TABLE_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB table is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-streams test passed (WarmThroughput + ESM backfills #609 + StreamSpecification enable-on-UPDATE #977 + clean destroy)"
