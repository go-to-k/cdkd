#!/usr/bin/env bash
# verify.sh — cdkd Lambda Kinesis ESM FilterCriteria integ.
# Asserts the ESM FilterCriteria reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdKinesisEsmFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
STREAM="${STACK}-stream"
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
  aws kinesis delete-stream --stream-name "${STREAM}" --region "${REGION}" --enforce-consumer-deletion >/dev/null 2>&1 || true
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

# FilterCriteria.Filters[0].Pattern should be present (a non-empty JSON pattern).
PATTERN=$(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
  --query 'EventSourceMappings[0].FilterCriteria.Filters[0].Pattern' --output text 2>/dev/null)
if [ -z "${PATTERN}" ] || [ "${PATTERN}" = "None" ]; then
  echo "FAIL: ESM FilterCriteria.Filters[0].Pattern is empty (silent-drop?)" >&2
  exit 1
fi
echo "    OK: ESM FilterCriteria reached AWS (pattern: ${PATTERN})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  aws lambda get-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || { GONE=1; break; }
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
# Kinesis DeleteStream is async (DELETING -> gone).
SGONE=""
for _ in $(seq 1 18); do
  aws kinesis describe-stream-summary --stream-name "${STREAM}" --region "${REGION}" >/dev/null 2>&1 || { SGONE=1; break; }
  sleep 5
done
[ -z "${SGONE}" ] && { echo "FAIL: kinesis stream ${STREAM} still exists after destroy" >&2; exit 1; }
echo "    OK: kinesis stream gone"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && { echo "FAIL: state remains" >&2; exit 1; }
echo "    OK: state gone"
echo ""
echo "==> kinesis-esm-filter test passed"
