#!/usr/bin/env bash
# verify.sh — cdkd AWS::CloudWatch::AnomalyDetector SDK provider integ test
# (issue #1304).
#
# The type is NON_PROVISIONABLE in the CloudFormation registry (no Cloud
# Control handlers) — before the SDK provider, cdkd's pre-flight rejected any
# template declaring it. This test proves the full lifecycle against real AWS:
#
#   Phase 1 (create): deploy an SQS queue + an anomaly detection model on its
#     NumberOfMessagesSent metric; assert DescribeAnomalyDetectors returns it.
#   Phase 2 (update, CDKD_TEST_UPDATE=true): re-deploy with a Configuration
#     (MetricTimeZone) — the only in-place-mutable property per the registry
#     schema; assert the configuration landed.
#   Phase 3 (destroy): tear down; assert the detector, queue, and state file
#     are gone.
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

STACK="CdkdCloudWatchAnomalyDetectorExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

QUEUE_NAME="cdkd-anomaly-detector-queue"
NAMESPACE="AWS/SQS"
METRIC="NumberOfMessagesSent"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Count the fixture's anomaly detectors currently on AWS (strict capture —
# a probe failure aborts the run under `set -e` rather than reading as 0).
detector_count() {
  aws cloudwatch describe-anomaly-detectors \
    --namespace "${NAMESPACE}" --metric-name "${METRIC}" --region "${REGION}" \
    --query "length(AnomalyDetectors[?SingleMetricAnomalyDetector.Dimensions[?Name=='QueueName' && Value=='${QUEUE_NAME}']] || \`[]\`)" \
    --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Direct sweep in case state-based teardown could not run: the detector
  # (addressed by descriptor) and the queue.
  aws cloudwatch delete-anomaly-detector \
    --single-metric-anomaly-detector "{\"Namespace\":\"${NAMESPACE}\",\"MetricName\":\"${METRIC}\",\"Stat\":\"Sum\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"${QUEUE_NAME}\"}]}" \
    --region "${REGION}" >/dev/null 2>&1
  local qurl
  qurl=$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)
  if [ -n "${qurl}" ] && [ "${qurl}" != "None" ]; then
    aws sqs delete-queue --queue-url "${qurl}" --region "${REGION}" >/dev/null 2>&1
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

# --- Phase 1: create -------------------------------------------------------
echo "==> Phase 1: deploy (queue + single-metric anomaly detector)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

COUNT=$(detector_count)
if [ "${COUNT}" -lt 1 ]; then
  echo "FAIL: DescribeAnomalyDetectors returned no detector for ${NAMESPACE}/${METRIC} on ${QUEUE_NAME} after create" >&2
  exit 1
fi
echo "    OK: anomaly detector exists on AWS after create"

# The provider mints a deterministic descriptor-derived physical id and the
# GetAtt Id output must resolve to it.
PHYS_ID_1=$(printf '%s' "${STATE}" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['resources']['Detector']['physicalId'])")
OUTPUT_ID=$(printf '%s' "${STATE}" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['outputs'].get('DetectorId',''))")
if [ -z "${PHYS_ID_1}" ] || [ "${OUTPUT_ID}" != "${PHYS_ID_1}" ]; then
  echo "FAIL: GetAtt Id output (${OUTPUT_ID}) does not match the detector physical id (${PHYS_ID_1})" >&2
  exit 1
fi
echo "    OK: GetAtt Id output resolves to the physical id (${PHYS_ID_1})"

# --- Phase 2: update (add Configuration — the only mutable property) -------
# NOTE: the Describe output field is `MetricTimezone` (lowercase z, the SDK /
# wire casing) even though the CFn property is `MetricTimeZone` — the
# provider re-keys it on write; asserting the readback here is what catches
# a client-side silent drop of the miscased key (found live 2026-07-31).
echo "==> Phase 2: update (add Configuration: MetricTimeZone + ExcludedTimeRanges)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

CONFIG_SET=$(aws cloudwatch describe-anomaly-detectors \
  --namespace "${NAMESPACE}" --metric-name "${METRIC}" --region "${REGION}" \
  --query "length(AnomalyDetectors[?SingleMetricAnomalyDetector.Dimensions[?Name=='QueueName' && Value=='${QUEUE_NAME}'] && Configuration.MetricTimezone=='UTC' && length(Configuration.ExcludedTimeRanges || \`[]\`) > \`0\`] || \`[]\`)" \
  --output text)
if [ "${CONFIG_SET}" -lt 1 ]; then
  echo "FAIL: Configuration (MetricTimezone=UTC + ExcludedTimeRanges) did not land on the detector after update" >&2
  exit 1
fi
echo "    OK: Configuration update landed in-place (MetricTimezone + ExcludedTimeRanges read back)"

# In-place means IN PLACE: the descriptor-derived physical id must survive
# the Configuration update unchanged (a replacement would mint a new record).
PHYS_ID_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['resources']['Detector']['physicalId'])")
if [ "${PHYS_ID_2}" != "${PHYS_ID_1}" ]; then
  echo "FAIL: physical id changed across the in-place update (${PHYS_ID_1} -> ${PHYS_ID_2})" >&2
  exit 1
fi
echo "    OK: physical id stable across the in-place update"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

REMAINING=$(detector_count)
if [ "${REMAINING}" != "0" ]; then
  echo "FAIL: ${REMAINING} anomaly detector(s) still exist for ${QUEUE_NAME} after destroy" >&2
  exit 1
fi
echo "    OK: anomaly detector is gone"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    OK: queue is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cloudwatch-anomaly-detector test passed (create + in-place Configuration update + clean destroy)"
