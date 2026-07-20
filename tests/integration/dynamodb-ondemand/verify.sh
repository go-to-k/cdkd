#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB::Table #609 backfill integ test.
#
# Asserts that a single PAY_PER_REQUEST DynamoDB table whose template sets
# every #609 backfill property has all of them reach AWS after `cdkd deploy`
# (each was a silent-drop before the #609 backfill):
#
#   - OnDemandThroughput.MaxReadRequestUnits / MaxWriteRequestUnits
#     (via describe-table Table.OnDemandThroughput)
#   - ResourcePolicy (via get-resource-policy)
#   - KinesisStreamSpecification (via describe-kinesis-streaming-destination)
#   - ContributorInsightsSpecification (via describe-contributor-insights)
#
# Also asserts the table routes via the SDK provider (provisionedBy=sdk) so a
# silent-drop routing flip is caught, and that the destroy path cleans up the
# table, the Kinesis stream, and the cdkd state file.
#
# Phase 1.5 additionally exercises the BillingMode/ProvisionedThroughput
# in-place UPDATE path on a standalone PROVISIONED table: a re-deploy with
# CDKD_TEST_UPDATE=true flips its capacity (RCU 5->20 / WCU 5->10) and asserts
# AWS reflects the new ProvisionedThroughput. Before the fix update() issued no
# UpdateTable for ProvisionedThroughput, so the change was silently dropped.
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

STACK="CdkdDynamodbOndemandExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-ondemand-test-table"
STREAM_NAME="cdkd-ondemand-test-stream"
EXPECTED_READ=10
EXPECTED_WRITE=5
EXPECTED_CI_MODE="ACCESSED_AND_THROTTLED_KEYS"
# Standalone PROVISIONED table exercising the BillingMode/ProvisionedThroughput
# in-place UPDATE path (silent-drop fix).
PROV_TABLE_NAME="cdkd-ondemand-test-provisioned-table"
PROV_INITIAL_READ=5
PROV_INITIAL_WRITE=5
PROV_UPDATED_READ=20
PROV_UPDATED_WRITE=10

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws dynamodb delete-table --table-name "${PROV_TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Routing guard: table routed via the SDK provider -----------------
# Every top-level Table property the fixture sets is in the provider's
# handledProperties, so the resource MUST route via the SDK path (not the
# CC-API #614 silent-drop fallback). If provisionedBy flipped (e.g. an
# unhandled silent-drop sneaked in), the backfill closure being tested IS
# on the wrong code path.
PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DynamoDB::Table") | .value.provisionedBy] | first // "sdk"')
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::DynamoDB::Table routed via '${PROVISIONED_BY}', expected 'sdk' (silent-drop routing flip — backfill is on the wrong path)" >&2
  exit 1
fi
echo "    OK: AWS::DynamoDB::Table routed via SDK provider (provisionedBy=sdk)"

TABLE=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table' --output json 2>/dev/null)
TABLE_ARN=$(echo "${TABLE}" | jq -r '.TableArn')
EXPECTED_STREAM_ARN=$(aws kinesis describe-stream \
  --stream-name "${STREAM_NAME}" --region "${REGION}" \
  --query 'StreamDescription.StreamARN' --output text 2>/dev/null)

# --- Assertion 1: OnDemandThroughput caps reached AWS -----------------
# DescribeTable returns Table.OnDemandThroughput only on PAY_PER_REQUEST
# tables that set caps. Seeing the templated values proves the silent-drop
# is closed by the #609 backfill.
ODT=$(echo "${TABLE}" | jq -r '.OnDemandThroughput')
ACTUAL_READ=$(echo "${ODT}" | jq -r 'if has("MaxReadRequestUnits") then .MaxReadRequestUnits | tostring else "null" end')
ACTUAL_WRITE=$(echo "${ODT}" | jq -r 'if has("MaxWriteRequestUnits") then .MaxWriteRequestUnits | tostring else "null" end')

if [ "${ACTUAL_READ}" != "${EXPECTED_READ}" ]; then
  echo "FAIL: Table.OnDemandThroughput.MaxReadRequestUnits is '${ACTUAL_READ}', expected '${EXPECTED_READ}' (silent-drop NOT closed)" >&2
  echo "${ODT}" | jq .
  exit 1
fi
echo "    OK: Table.OnDemandThroughput.MaxReadRequestUnits == ${EXPECTED_READ} on AWS"

if [ "${ACTUAL_WRITE}" != "${EXPECTED_WRITE}" ]; then
  echo "FAIL: Table.OnDemandThroughput.MaxWriteRequestUnits is '${ACTUAL_WRITE}', expected '${EXPECTED_WRITE}' (silent-drop NOT closed)" >&2
  echo "${ODT}" | jq .
  exit 1
fi
echo "    OK: Table.OnDemandThroughput.MaxWriteRequestUnits == ${EXPECTED_WRITE} on AWS (silent-drop CLOSED by #609)"

# --- Assertion 2: ResourcePolicy reached AWS --------------------------
# GetResourcePolicy returns the attached policy document as a JSON string.
# Seeing a non-empty policy with our dynamodb:GetItem action proves the
# silent-drop is closed.
POLICY=$(aws dynamodb get-resource-policy \
  --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query 'Policy' --output text 2>/dev/null || echo "")
if [ -z "${POLICY}" ] || [ "${POLICY}" = "None" ]; then
  echo "FAIL: no ResourcePolicy attached to ${TABLE_NAME} (silent-drop NOT closed)" >&2
  exit 1
fi
HAS_GETITEM=$(echo "${POLICY}" | jq -r '
  [.Statement[]?.Action] | flatten | map(select(. == "dynamodb:GetItem")) | length > 0
')
if [ "${HAS_GETITEM}" != "true" ]; then
  echo "FAIL: ResourcePolicy does not contain the templated dynamodb:GetItem action" >&2
  echo "${POLICY}" | jq .
  exit 1
fi
echo "    OK: ResourcePolicy with dynamodb:GetItem reached AWS (silent-drop CLOSED by #609)"

# --- Assertion 3: KinesisStreamSpecification reached AWS --------------
# DescribeKinesisStreamingDestination lists the active destination(s).
KDS=$(aws dynamodb describe-kinesis-streaming-destination \
  --table-name "${TABLE_NAME}" --region "${REGION}" --output json 2>/dev/null)
ACTUAL_STREAM_ARN=$(echo "${KDS}" | jq -r '
  [.KinesisDataStreamDestinations[]? | select(.DestinationStatus == "ACTIVE" or .DestinationStatus == "ENABLING")][0]
  | if has("StreamArn") then .StreamArn else "null" end
')
if [ "${ACTUAL_STREAM_ARN}" = "null" ] || [ -z "${ACTUAL_STREAM_ARN}" ]; then
  echo "FAIL: no ACTIVE/ENABLING Kinesis streaming destination on ${TABLE_NAME} (silent-drop NOT closed)" >&2
  echo "${KDS}" | jq .
  exit 1
fi
if [ "${ACTUAL_STREAM_ARN}" != "${EXPECTED_STREAM_ARN}" ]; then
  echo "FAIL: Kinesis destination StreamArn is '${ACTUAL_STREAM_ARN}', expected '${EXPECTED_STREAM_ARN}'" >&2
  exit 1
fi
echo "    OK: KinesisStreamSpecification.StreamArn reached AWS (silent-drop CLOSED by #609)"

# --- Assertion 4: ContributorInsightsSpecification reached AWS --------
# DescribeContributorInsights returns the status + mode. ENABLING is a
# valid transient terminal-bound state shortly after deploy.
CI=$(aws dynamodb describe-contributor-insights \
  --table-name "${TABLE_NAME}" --region "${REGION}" --output json 2>/dev/null)
CI_STATUS=$(echo "${CI}" | jq -r 'if has("ContributorInsightsStatus") then .ContributorInsightsStatus else "null" end')
if [ "${CI_STATUS}" != "ENABLED" ] && [ "${CI_STATUS}" != "ENABLING" ]; then
  echo "FAIL: ContributorInsightsStatus is '${CI_STATUS}', expected ENABLED/ENABLING (silent-drop NOT closed)" >&2
  echo "${CI}" | jq .
  exit 1
fi
echo "    OK: ContributorInsightsSpecification.Enabled reached AWS (status=${CI_STATUS}, silent-drop CLOSED by #609)"

CI_MODE=$(echo "${CI}" | jq -r 'if has("ContributorInsightsMode") then .ContributorInsightsMode else "null" end')
if [ "${CI_MODE}" != "${EXPECTED_CI_MODE}" ]; then
  echo "FAIL: ContributorInsightsMode is '${CI_MODE}', expected '${EXPECTED_CI_MODE}'" >&2
  echo "${CI}" | jq .
  exit 1
fi
echo "    OK: ContributorInsightsSpecification.Mode == ${EXPECTED_CI_MODE} on AWS"

# --- Assertion 5: PROVISIONED table initial capacity reached AWS ------
# A helper that reads the provisioned table's ProvisionedThroughput from AWS
# and asserts the RCU/WCU match the expected pair.
assert_provisioned_capacity() {
  local expected_read="$1" expected_write="$2" phase="$3"
  local pt actual_read actual_write
  pt=$(aws dynamodb describe-table \
    --table-name "${PROV_TABLE_NAME}" --region "${REGION}" \
    --query 'Table.ProvisionedThroughput' --output json 2>/dev/null)
  actual_read=$(echo "${pt}" | jq -r 'if has("ReadCapacityUnits") then .ReadCapacityUnits | tostring else "null" end')
  actual_write=$(echo "${pt}" | jq -r 'if has("WriteCapacityUnits") then .WriteCapacityUnits | tostring else "null" end')
  if [ "${actual_read}" != "${expected_read}" ]; then
    echo "FAIL (${phase}): ProvisionedThroughput.ReadCapacityUnits is '${actual_read}', expected '${expected_read}'" >&2
    echo "${pt}" | jq .
    exit 1
  fi
  if [ "${actual_write}" != "${expected_write}" ]; then
    echo "FAIL (${phase}): ProvisionedThroughput.WriteCapacityUnits is '${actual_write}', expected '${expected_write}'" >&2
    echo "${pt}" | jq .
    exit 1
  fi
  echo "    OK (${phase}): ProvisionedThroughput RCU=${expected_read} / WCU=${expected_write} on AWS"
}

assert_provisioned_capacity "${PROV_INITIAL_READ}" "${PROV_INITIAL_WRITE}" "Phase 1"

# --- Phase 1.5: in-place ProvisionedThroughput UPDATE -----------------
# Re-deploy with CDKD_TEST_UPDATE=true, which flips the provisioned table's
# capacity from RCU=5/WCU=5 to RCU=20/WCU=10. Before the fix, update() issued
# NO UpdateTable for ProvisionedThroughput, so the change was silently dropped
# (state recorded the new value, AWS stayed at 5/5). This assertion is the
# real-AWS proof the silent drop is closed: AWS must report the NEW capacity.
echo "==> Phase 1.5: re-deploy with CDKD_TEST_UPDATE=true (BillingMode/ProvisionedThroughput in-place update)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# UpdateTable is async; the table briefly reports UPDATING. Poll until ACTIVE
# (and the new capacity is reflected) rather than racing the async update.
UPDATE_OK=""
for _ in $(seq 1 24); do
  STATUS=$(aws dynamodb describe-table --table-name "${PROV_TABLE_NAME}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>/dev/null || echo "")
  READ_NOW=$(aws dynamodb describe-table --table-name "${PROV_TABLE_NAME}" --region "${REGION}" \
    --query 'Table.ProvisionedThroughput.ReadCapacityUnits' --output text 2>/dev/null || echo "")
  if [ "${STATUS}" = "ACTIVE" ] && [ "${READ_NOW}" = "${PROV_UPDATED_READ}" ]; then
    UPDATE_OK=1
    break
  fi
  sleep 5
done
if [ -z "${UPDATE_OK}" ]; then
  echo "FAIL: provisioned table did not reflect the updated capacity within ~2min after CDKD_TEST_UPDATE re-deploy (silent-drop NOT closed)" >&2
  exit 1
fi
assert_provisioned_capacity "${PROV_UPDATED_READ}" "${PROV_UPDATED_WRITE}" "Phase 1.5"
echo "    OK: ProvisionedThroughput in-place UPDATE reached AWS (silent-drop CLOSED)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
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

# The standalone PROVISIONED table is async-deleted too.
PROV_TABLE_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws dynamodb describe-table --table-name "${PROV_TABLE_NAME}" --region "${REGION}"; then
    PROV_TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${PROV_TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${PROV_TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: provisioned DynamoDB table is gone"

# Kinesis DeleteStream is async too.
STREAM_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws kinesis describe-stream --stream-name "${STREAM_NAME}" --region "${REGION}"; then
    STREAM_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${STREAM_GONE}" ]; then
  echo "FAIL: Kinesis stream ${STREAM_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: Kinesis stream is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-ondemand test passed (OnDemandThroughput + ResourcePolicy + KinesisStreamSpecification + ContributorInsightsSpecification backfill closed + BillingMode/ProvisionedThroughput in-place UPDATE + clean destroy)"
