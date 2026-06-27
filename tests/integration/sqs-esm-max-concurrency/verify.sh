#!/usr/bin/env bash
# verify.sh — cdkd Lambda SQS ESM ScalingConfig.MaximumConcurrency integ.
# Asserts the maxConcurrency ESM attribute reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXCONC=$(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
  --query 'EventSourceMappings[0].ScalingConfig.MaximumConcurrency' --output text 2>/dev/null)
if [ "${MAXCONC}" != "${EXPECTED_MAXCONC}" ]; then
  echo "FAIL: ScalingConfig.MaximumConcurrency is '${MAXCONC}', expected '${EXPECTED_MAXCONC}' (silent-drop?)" >&2
  exit 1
fi
echo "    OK: ScalingConfig.MaximumConcurrency == ${EXPECTED_MAXCONC} on AWS"

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
