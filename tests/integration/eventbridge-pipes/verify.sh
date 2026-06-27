#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Pipes (SQS->SNS, CC-API) integ.
# Asserts the pipe reaches AWS (RUNNING) with the SQS source, then destroys
# clean. Confirmed-clean /hunt-bugs pattern; regression guard.

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEventbridgePipesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PIPE="${STACK}-pipe"
SRC="${STACK}-src"
TGT="${STACK}-tgt"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws pipes delete-pipe --name "${PIPE}" --region "${REGION}" >/dev/null 2>&1 || true
  Q=$(aws sqs get-queue-url --queue-name "${SRC}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${Q}" ] && [ "${Q}" != "None" ] && aws sqs delete-queue --queue-url "${Q}" --region "${REGION}" >/dev/null 2>&1 || true
  TARN=$(aws sns list-topics --region "${REGION}" --query "Topics[?ends_with(TopicArn, ':${TGT}')].TopicArn | [0]" --output text 2>/dev/null)
  [ -n "${TARN}" ] && [ "${TARN}" != "None" ] && aws sns delete-topic --topic-arn "${TARN}" --region "${REGION}" >/dev/null 2>&1 || true
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

# Pipe creation settles async (CREATING -> RUNNING). Accept RUNNING or CREATING
# as proof it reached AWS; assert the SQS source arn was wired.
STATE=""; SRCARN=""
for _ in $(seq 1 24); do
  STATE=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'CurrentState' --output text 2>/dev/null || echo "")
  SRCARN=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'Source' --output text 2>/dev/null || echo "")
  if [ "${STATE}" = "RUNNING" ]; then break; fi
  sleep 5
done
if [ "${STATE}" != "RUNNING" ] && [ "${STATE}" != "CREATING" ]; then
  echo "FAIL: pipe ${PIPE} CurrentState is '${STATE}', expected RUNNING/CREATING" >&2
  exit 1
fi
case "${SRCARN}" in
  *":${SRC}") : ;;
  *) echo "FAIL: pipe Source is '${SRCARN}', expected to end with ':${SRC}'" >&2; exit 1 ;;
esac
echo "    OK: pipe reached AWS (CurrentState=${STATE}, Source=${SRCARN})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Pipe delete is async (DELETING -> gone).
PGONE=""
for _ in $(seq 1 24); do
  aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" >/dev/null 2>&1 || { PGONE=1; break; }
  sleep 5
done
[ -z "${PGONE}" ] && { echo "FAIL: pipe ${PIPE} still exists after destroy" >&2; exit 1; }
echo "    OK: pipe gone"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && { echo "FAIL: state remains" >&2; exit 1; }
echo "    OK: state gone"
echo ""
echo "==> eventbridge-pipes test passed"
