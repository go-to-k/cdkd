#!/usr/bin/env bash
# verify.sh — cdkd AWS::CloudWatch::AnomalyDetector SDK provider integ test
# (issue #1304).
#
# The type was NON_PROVISIONABLE in the CloudFormation registry when the SDK
# provider was written (AWS has since added Cloud Control handlers; cdkd keeps
# the SDK route, #4668). This test proves the full lifecycle against real AWS:
#
#   Phase 1 (create): deploy an SQS queue + an anomaly detection model on its
#     NumberOfMessagesSent metric; assert DescribeAnomalyDetectors returns it.
#   Phase 2 (update, CDKD_TEST_UPDATE=true): re-deploy with a Configuration
#     (MetricTimeZone + ExcludedTimeRanges) — the only in-place-mutable
#     property per the registry schema; assert the configuration landed, and
#     (deployed under TZ=Asia/Tokyo) that the offset-less range landed as UTC
#     (go-to-k/cdkd#5311).
#   Phase 2b (drift, go-to-k/cdkd#6769): drift clean with the detector
#     compared (exit 0) -> an out-of-band Configuration change is drift (exit 1)
#     -> `drift --revert` restores it in place, clean again.
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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

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
  # Phase 2b's scratch file. Removed HERE rather than under its own
  # `trap ... EXIT`, because bash replaces a signal's handler instead of
  # chaining one: a second EXIT trap would disarm everything below it.
  rm -f "${DRIFT_OUT:-}"
  [ -n "${REVERT_WORK:-}" ] && rm -rf "${REVERT_WORK}"
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
  --strict-getatt \
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
# AWS has also published the attribute as AnomalyDetectorId (#4668): it must
# resolve from the cached attributes too, to the same value.
OUTPUT_ADID=$(printf '%s' "${STATE}" | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['outputs'].get('AnomalyDetectorId',''))")
if [ "${OUTPUT_ADID}" != "${PHYS_ID_1}" ]; then
  echo "FAIL: GetAtt AnomalyDetectorId output (${OUTPUT_ADID}) does not match the detector physical id (${PHYS_ID_1})" >&2
  exit 1
fi
echo "    OK: GetAtt AnomalyDetectorId output resolves to the physical id (${PHYS_ID_1})"

# --- Phase 2: update (add Configuration — the only mutable property) -------
# NOTE: the Describe output field is `MetricTimezone` (lowercase z, the SDK /
# wire casing) even though the CFn property is `MetricTimeZone` — the
# provider re-keys it on write; asserting the readback here is what catches
# a client-side silent drop of the miscased key (found live 2026-07-31).
echo "==> Phase 2: update (add Configuration: MetricTimeZone + ExcludedTimeRanges)"
# TZ=Asia/Tokyo: the template's offset-less ExcludedTimeRanges must reach AWS
# as UTC, not shifted by the deployer's offset (go-to-k/cdkd#5311).
TZ=Asia/Tokyo CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --strict-getatt \
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

# go-to-k/cdkd#5311: the EXACT instants, normalized to UTC (the CLI renders
# timestamps in its own zone, so compare instants, not strings). Pre-fix, the
# JST deploy above sent 2025-12-31T15:00:00Z for `2026-01-01T00:00:00`.
RANGES_JSON=$(aws cloudwatch describe-anomaly-detectors \
  --namespace "${NAMESPACE}" --metric-name "${METRIC}" --region "${REGION}" \
  --query "AnomalyDetectors[?SingleMetricAnomalyDetector.Dimensions[?Name=='QueueName' && Value=='${QUEUE_NAME}']] | [0].Configuration.ExcludedTimeRanges" \
  --output json)
RANGES_UTC=$(printf '%s' "${RANGES_JSON}" | python3 -c "
import json, sys
from datetime import datetime, timezone
def utc(s):
    d = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if d.tzinfo is None:
        sys.exit('naive timestamp from the CLI: ' + s)
    return d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
rs = json.load(sys.stdin) or []
print(','.join(sorted(utc(r['StartTime']) + '/' + utc(r['EndTime']) for r in rs)))
")
EXPECTED_RANGES='2026-01-01T00:00:00Z/2026-01-02T00:00:00Z,2026-03-01T00:00:00Z/2026-03-02T00:00:00Z'
if [ "${RANGES_UTC}" != "${EXPECTED_RANGES}" ]; then
  echo "FAIL: ExcludedTimeRanges read back as '${RANGES_UTC}', expected '${EXPECTED_RANGES}' -- an offset-less template time was not read as UTC (go-to-k/cdkd#5311)" >&2
  exit 1
fi
echo "    OK: ExcludedTimeRanges landed as UTC instants under a TZ=Asia/Tokyo deploy (${RANGES_UTC})"

# In-place means IN PLACE: the descriptor-derived physical id must survive
# the Configuration update unchanged (a replacement would mint a new record).
PHYS_ID_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin); print(s['resources']['Detector']['physicalId'])")
if [ "${PHYS_ID_2}" != "${PHYS_ID_1}" ]; then
  echo "FAIL: physical id changed across the in-place update (${PHYS_ID_1} -> ${PHYS_ID_2})" >&2
  exit 1
fi
echo "    OK: physical id stable across the in-place update"

# --- Phase 2b: drift reads the detector back ------------------------------
# go-to-k/cdkd#6769: the SDK provider reads the detector back through
# DescribeAnomalyDetectors, filtered by the recorded descriptor (its physicalId
# is a cdkd descriptor Cloud Control cannot address, #4668). The fresh deploy
# drifts clean with both rows compared (exit 0); an out-of-band
# Configuration change (PutAnomalyDetector with another MetricTimezone and no
# exclusions) is drift (exit 1); `drift --revert` puts the deployed
# Configuration back in place and drift is clean again.
echo "==> Phase 2b: drift compares the detector (clean -> out-of-band change -> restored)"
# NOT given its own `trap ... EXIT`: bash REPLACES a signal's handler rather
# than chaining, so a second one would disarm the AWS teardown. The file is
# removed by `cleanup` instead.
DRIFT_OUT="$(mktemp)"
run_drift() {
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" > "${DRIFT_OUT}" 2>&1
  DRIFT_RC=$?
  set -e
  cat "${DRIFT_OUT}"
}
assert_clean() { # usage: assert_clean <label>
  # The FULL parenthetical, anchored: a bare `2 resources checked` is a
  # substring of the `0 of 2 resources checked` warning (go-to-k/cdkd#2154).
  if [ "${DRIFT_RC}" -ne 0 ] || ! grep -qF "✓ ${STACK} (${REGION}): no drift detected (2 resources checked, 0 unsupported)" "${DRIFT_OUT}"; then
    echo "FAIL: drift after $1 is not clean with both rows compared (rc=${DRIFT_RC}) (go-to-k/cdkd#6769)" >&2
    exit 1
  fi
  if grep -qE '^ +\? ' "${DRIFT_OUT}"; then
    echo "FAIL: drift after $1 reported a drift-unknown row; Detector must be compared (go-to-k/cdkd#6769)" >&2
    exit 1
  fi
  echo "    OK: drift clean after $1, Detector and the queue compared"
}
DETECTOR_JSON="{\"Namespace\":\"${NAMESPACE}\",\"MetricName\":\"${METRIC}\",\"Stat\":\"Sum\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"${QUEUE_NAME}\"}]}"

run_drift
assert_clean "the Configuration update"

# Out of band: another time zone and no exclusions.
aws cloudwatch put-anomaly-detector \
  --single-metric-anomaly-detector "${DETECTOR_JSON}" \
  --configuration '{"MetricTimezone":"Asia/Tokyo","ExcludedTimeRanges":[]}' \
  --region "${REGION}"
TZ_OOB=$(aws cloudwatch describe-anomaly-detectors \
  --namespace "${NAMESPACE}" --metric-name "${METRIC}" --region "${REGION}" \
  --query "AnomalyDetectors[?SingleMetricAnomalyDetector.Dimensions[?Name=='QueueName' && Value=='${QUEUE_NAME}']] | [0].Configuration.MetricTimezone" \
  --output text)
[ "${TZ_OOB}" = "Asia/Tokyo" ] || { echo "FAIL: premise: the out-of-band put-anomaly-detector did not land (MetricTimezone=${TZ_OOB})" >&2; exit 1; }
run_drift
if [ "${DRIFT_RC}" -ne 1 ] || ! grep -qF '~ Detector (AWS::CloudWatch::AnomalyDetector)' "${DRIFT_OUT}"; then
  echo "FAIL: drift did not report the out-of-band Configuration change on Detector, exit 1 (rc=${DRIFT_RC}) (go-to-k/cdkd#6769)" >&2
  exit 1
fi
if ! grep -qE '^ +[-+~] Configuration' "${DRIFT_OUT}"; then
  echo "FAIL: drift did not name Configuration as Detector's drifted property (go-to-k/cdkd#6769)" >&2
  exit 1
fi
echo "    OK: drift reports the out-of-band Configuration change (exit 1)"

# `drift --revert` puts the deployed Configuration back IN PLACE
# (PutAnomalyDetector on the same descriptor): same physical id, the detector
# still there, the two ranges and the time zone restored (go-to-k/cdkd#6638).
REVERT_WORK="$(mktemp -d)"
revert_identity_snapshot "${REVERT_WORK}/revert-ids-before" "${STACK}" Detector || exit 1
REVERT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes > "${REVERT_WORK}/revert.log" 2>&1 || REVERT_RC=$?
cat "${REVERT_WORK}/revert.log"
revert_identity_verify "${REVERT_WORK}/revert-ids-before" "${REVERT_WORK}/revert-ids-after" 1 "${REVERT_WORK}/revert.log" || exit 1
[ "${REVERT_RC}" -eq 0 ] || { echo "FAIL: drift --revert exited ${REVERT_RC} (go-to-k/cdkd#6769)" >&2; exit 1; }
RESTORED=$(aws cloudwatch describe-anomaly-detectors \
  --namespace "${NAMESPACE}" --metric-name "${METRIC}" --region "${REGION}" \
  --query "AnomalyDetectors[?SingleMetricAnomalyDetector.Dimensions[?Name=='QueueName' && Value=='${QUEUE_NAME}']] | [0].Configuration.[MetricTimezone, length(ExcludedTimeRanges)]" \
  --output text)
[ "${RESTORED}" = "$(printf 'UTC\t2')" ] || { echo "FAIL: drift --revert did not restore MetricTimezone UTC and the two ranges (got '${RESTORED}') (go-to-k/cdkd#6769)" >&2; exit 1; }
echo "    OK: drift --revert restored the Configuration in place"
run_drift
assert_clean "the revert"

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
