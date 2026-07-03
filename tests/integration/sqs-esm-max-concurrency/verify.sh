#!/usr/bin/env bash
# verify.sh — cdkd Lambda SQS ESM ScalingConfig.MaximumConcurrency integ.
# Base phase: asserts maxConcurrency + FilterCriteria reach AWS.
# UPDATE phase (issue #976): removes FilterCriteria + ScalingConfig from the
# template and asserts AWS actually CLEARS both (removal-on-UPDATE, not a
# silent drop). Then destroys clean.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdSqsEsmMaxConcurrencyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
QUEUE="${STACK}-queue"
EXPECTED_MAXCONC=5
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  Q=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${Q}" ] && [ "${Q}" != "None" ] && aws sqs delete-queue --queue-url "${Q}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# Reads the ESM's ScalingConfig.MaximumConcurrency (or "None" when unset).
esm_maxconc() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query 'EventSourceMappings[0].ScalingConfig.MaximumConcurrency' --output text 2>/dev/null
}
# Reads the ESM's FilterCriteria.Filters count (0 / None when cleared / unset).
esm_filter_count() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query 'length(EventSourceMappings[0].FilterCriteria.Filters)' --output text 2>/dev/null
}

echo "==> Deploy (base: FilterCriteria + ScalingConfig set)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXCONC=$(esm_maxconc)
if [ "${MAXCONC}" != "${EXPECTED_MAXCONC}" ]; then
  echo "FAIL: base ScalingConfig.MaximumConcurrency is '${MAXCONC}', expected '${EXPECTED_MAXCONC}' (silent-drop?)" >&2
  exit 1
fi
echo "    OK: base ScalingConfig.MaximumConcurrency == ${EXPECTED_MAXCONC} on AWS"

FILTERS=$(esm_filter_count)
if [ "${FILTERS}" == "None" ] || [ "${FILTERS}" == "0" ] || [ -z "${FILTERS}" ]; then
  echo "FAIL: base FilterCriteria has no filters ('${FILTERS}'), expected >= 1 (silent-drop?)" >&2
  exit 1
fi
echo "    OK: base FilterCriteria has ${FILTERS} filter(s) on AWS"

echo "==> Deploy (UPDATE: FilterCriteria + ScalingConfig removed from template)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Removal must CLEAR the cap on AWS — ScalingConfig.MaximumConcurrency gone.
MAXCONC_AFTER=$(esm_maxconc)
if [ "${MAXCONC_AFTER}" != "None" ] && [ -n "${MAXCONC_AFTER}" ]; then
  echo "FAIL: after removal, ScalingConfig.MaximumConcurrency is still '${MAXCONC_AFTER}', expected cleared (None) — removal silently dropped (issue #976)" >&2
  exit 1
fi
echo "    OK: ScalingConfig.MaximumConcurrency CLEARED on AWS after removal"

# Removal must CLEAR the filter on AWS — no Filters remain.
FILTERS_AFTER=$(esm_filter_count)
if [ "${FILTERS_AFTER}" != "None" ] && [ "${FILTERS_AFTER}" != "0" ] && [ -n "${FILTERS_AFTER}" ]; then
  echo "FAIL: after removal, FilterCriteria still has '${FILTERS_AFTER}' filter(s), expected cleared — removal silently dropped (issue #976)" >&2
  exit 1
fi
echo "    OK: FilterCriteria CLEARED on AWS after removal"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  aws lambda get-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || { GONE=1; break; }
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && { echo "FAIL: state remains" >&2; exit 1; }
echo "    OK: state gone"
echo ""
echo "==> sqs-esm-max-concurrency test passed"
