#!/usr/bin/env bash
# verify.sh — cdkd S3 -> Lambda event notification functional integ.
#
# A clean deploy is NOT proof the notification works: the existing
# `event-driven` fixture deploys an addEventNotification but never fires it.
# This test puts an object into the bucket and asserts the Lambda actually ran
# by checking it recorded the object key into DynamoDB — exercising the full
# S3 -> Custom::S3BucketNotifications -> Lambda::Permission -> Lambda chain.
#
# Phases:
#   1. Deploy. Assert the bucket carries a Lambda NotificationConfiguration
#      (the Custom::S3BucketNotifications CR actually PUT it). Then
#      `cdkd drift` must be clean and `drift --revert` must leave the
#      notification in place (issue #5736).
#      Then deploy the consumer stack, which imports a second (shared) bucket
#      by name and adds an SQS notification to it. The bucket stack's
#      `cdkd drift` must stay clean and a `drift --revert` that writes the
#      shared bucket must leave the consumer's notification in place
#      (issue #5741).
#   2. Functional: put an object, then poll the DynamoDB table until the key
#      appears (proves the notification delivered + the handler ran + the
#      grant worked end-to-end).
#   3. Destroy the consumer, then the bucket stack + assert the buckets,
#      queue, table and both state files are all gone.
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

# S3 bucket configuration reads are eventually consistent: poll an `aws` read
# until it prints the expected value, so an out-of-band change is visible
# before cdkd reads it and a cdkd write is visible before it is asserted.
await_value() { # usage: await_value <expected> aws <service> <read-verb> [args...]
  local want="$1" got=""
  shift
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    got="$("$@" 2>/dev/null || true)"
    [ "${got}" = "${want}" ] && return 0
    sleep 3 || true
  done
  # An empty read means the call itself failed: print its error instead. Not
  # merged into every read, where a stderr warning would break the match.
  [ -n "${got}" ] || got="$("$@" 2>&1 | tail -1 || true)"
  echo "${got}"
  return 1
}

cd "$(dirname "$0")"

STACK="CdkdS3EventNotificationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CONSUMER="CdkdS3EventNotificationConsumer"
CONSUMER_STATE_KEY="cdkd/${CONSUMER}/${REGION}/state.json"
# A fixed name: a re-run within 60s of the previous run's queue deletion gets
# SQS QueueDeletedRecently on the create (cdkd retries it as transient).
QUEUE_NAME="cdkd-s3evt-consumer-q"
TABLE_NAME="cdkd-s3evt-events"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after we know the account id (bucket name embeds it).
BUCKET_NAME=""
SHARED_BUCKET=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # The consumer stack's BucketNotificationsHandler (#5741).
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${CONSUMER}-" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  QUEUE_URL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${QUEUE_URL}" ] && [ "${QUEUE_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${SHARED_BUCKET}" ]; then
    aws s3 rb "s3://${SHARED_BUCKET}" --force >/dev/null 2>&1 || true
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${BUCKET_NAME}" ]; then
    aws s3 rb "s3://${BUCKET_NAME}" --force >/dev/null 2>&1 || true
  fi
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-s3evt-${ACCOUNT_ID}-${REGION}"
SHARED_BUCKET="cdkd-s3evt-shared-${ACCOUNT_ID}-${REGION}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The Custom::S3BucketNotifications CR must have PUT a Lambda notification.
NOTIFY_COUNT="$(aws s3api get-bucket-notification-configuration \
  --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(LambdaFunctionConfigurations || `[]`)' --output text)"
if [ "${NOTIFY_COUNT}" = "0" ] || [ "${NOTIFY_COUNT}" = "None" ]; then
  echo "FAIL: bucket ${BUCKET_NAME} has no Lambda notification configuration after deploy" >&2
  exit 1
fi
echo "    OK: bucket carries ${NOTIFY_COUNT} Lambda notification configuration(s)"

# --- Phase 1a: the cross-stack consumer (issue #5741) -----------------
# The consumer imports the shared bucket by name, so ITS state holds the
# Custom::S3BucketNotifications (Managed: false) and the bucket stack's state
# holds none naming the shared bucket.
echo "==> Phase 1a: deploy the consumer stack that adds a notification by bucket name (#5741)"
node "${LOCAL_DIST}" deploy "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# The consumer declares exactly one SQS destination.
SHARED_QUEUE_COUNT=1
if ! SHARED_QUEUE_SEEN="$(await_value "${SHARED_QUEUE_COUNT}" aws s3api get-bucket-notification-configuration \
    --bucket "${SHARED_BUCKET}" --region "${REGION}" \
    --query 'length(QueueConfigurations || `[]`)' --output text)"; then
  echo "FAIL: shared bucket ${SHARED_BUCKET} does not carry the consumer's ${SHARED_QUEUE_COUNT} SQS notification after its deploy (last read: ${SHARED_QUEUE_SEEN})" >&2
  exit 1
fi
echo "    OK: shared bucket carries ${SHARED_QUEUE_COUNT} SQS notification configuration(s) from the consumer"

# --- Phase 1b: drift on the untouched stack (issue #5736, #5741) ------
# The bucket's observed baseline is captured BEFORE the CR writes the
# notification, so pre-fix `cdkd drift` reported the CR's LambdaConfigurations
# as bucket drift on every fresh deploy, and `drift --revert` deleted them.
# The shared bucket's stack holds NO custom resource naming it (the consumer's
# lives in the consumer's state), so #5740's same-stack rule did not apply and
# the consumer's QueueConfigurations showed as drift until #5741.
echo "==> Phase 1b: cdkd drift reports no drift on the fresh deploy (#5736, #5741)"
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 0 ]; then
  if grep -q 'SharedBucket' <<<"${DRIFT_OUT}" && grep -q 'NotificationConfiguration' <<<"${DRIFT_OUT}"; then
    echo "FAIL: #5741: cdkd drift reported the consumer stack's notification on the shared bucket as drift (rc ${DRIFT_RC}):" >&2
  elif grep -q 'NotificationConfiguration' <<<"${DRIFT_OUT}"; then
    echo "FAIL: #5736: cdkd drift reported the CR-owned bucket NotificationConfiguration as drift (rc ${DRIFT_RC}):" >&2
  else
    echo "FAIL: cdkd drift exited ${DRIFT_RC} on an untouched stack:" >&2
  fi
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
fi
echo "    OK: cdkd drift is clean"

# A revert of ANOTHER bucket key must leave the CR's notification in place: an
# out-of-band tag gives the revert a real write on the bucket, and the S3
# provider then receives the whole bag (the template declares only the
# autoDeleteObjects tag, which is put back with the injected one).
echo "==> Phase 1c: cdkd drift --revert of a tag keeps the bucket notification (#5736)"
aws s3api put-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --tagging 'TagSet=[{Key=aws-cdk:auto-delete-objects,Value=true},{Key=cdkd-integ-5736,Value=injected}]'
if ! await_value 1 aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" \
    --query "length(TagSet[?Key=='cdkd-integ-5736'])" --output text >/dev/null; then
  echo "FAIL: the injected tag never became visible on ${BUCKET_NAME}" >&2
  exit 1
fi
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
if ! INJECTED_AFTER="$(await_value 0 aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" \
    --region "${REGION}" --query "length(TagSet[?Key=='cdkd-integ-5736'])" --output text)"; then
  echo "FAIL: drift --revert did not remove the injected tag (count ${INJECTED_AFTER}) -- the revert never wrote the bucket" >&2
  exit 1
fi
NOTIFY_AFTER="$(aws s3api get-bucket-notification-configuration \
  --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'length(LambdaFunctionConfigurations || `[]`)' --output text)"
if [ "${NOTIFY_AFTER}" != "${NOTIFY_COUNT}" ]; then
  echo "FAIL: #5736: drift --revert changed the bucket's Lambda notifications (${NOTIFY_COUNT} -> ${NOTIFY_AFTER})" >&2
  exit 1
fi
echo "    OK: tag reverted; bucket still carries ${NOTIFY_AFTER} Lambda notification configuration(s)"

# A revert that WRITES the shared bucket must not delete the consumer stack's
# notification: suspend its declared versioning out of band, so the revert has
# a real write on it, then check the SQS notification survived.
echo "==> Phase 1d: cdkd drift --revert on the shared bucket keeps the consumer's notification (#5741)"
aws s3api put-bucket-versioning --bucket "${SHARED_BUCKET}" --region "${REGION}" \
  --versioning-configuration Status=Suspended
if ! await_value Suspended aws s3api get-bucket-versioning --bucket "${SHARED_BUCKET}" \
    --region "${REGION}" --query Status --output text >/dev/null; then
  echo "FAIL: the out-of-band versioning suspend never became visible on ${SHARED_BUCKET}" >&2
  exit 1
fi
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
if ! VERSIONING_AFTER="$(await_value Enabled aws s3api get-bucket-versioning \
    --bucket "${SHARED_BUCKET}" --region "${REGION}" --query Status --output text)"; then
  echo "FAIL: drift --revert did not restore the shared bucket's versioning (${VERSIONING_AFTER}) -- the revert never wrote the bucket" >&2
  exit 1
fi
# The count must HOLD across a settle window, not match once: a stale read
# could still show the queue config after a revert deleted it, and a single
# read would then pass a pre-fix build.
for i in 1 2 3 4 5 6 7; do
  SHARED_QUEUE_AFTER="$(aws s3api get-bucket-notification-configuration \
    --bucket "${SHARED_BUCKET}" --region "${REGION}" \
    --query 'length(QueueConfigurations || `[]`)' --output text)" \
    || SHARED_QUEUE_AFTER="read-error"
  if [ "${SHARED_QUEUE_AFTER}" != "${SHARED_QUEUE_COUNT}" ]; then
    echo "FAIL: #5741: drift --revert changed the consumer stack's SQS notifications on the shared bucket (${SHARED_QUEUE_COUNT} -> ${SHARED_QUEUE_AFTER}, read ${i} of 7)" >&2
    exit 1
  fi
  [ "${i}" = 7 ] || sleep 4 || true
done
echo "    OK: versioning reverted; shared bucket still carries ${SHARED_QUEUE_AFTER} SQS notification configuration(s)"

# --- Phase 2: functional — put object, prove the Lambda fired ---------
echo "==> Phase 2: put an object and assert the notification fired"
PROBE_KEY="probe-$(date -u +%Y%m%dT%H%M%SZ).txt"
echo "cdkd s3 event notification probe" > /tmp/cdkd-s3evt-probe.txt
aws s3 cp /tmp/cdkd-s3evt-probe.txt "s3://${BUCKET_NAME}/${PROBE_KEY}" --region "${REGION}" >/dev/null

RECORDED=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  RECORDED="$(aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
    --key "{\"key\":{\"S\":\"${PROBE_KEY}\"}}" \
    --query 'Item.key.S' --output text)"
  if [ "${RECORDED}" = "${PROBE_KEY}" ]; then
    break
  fi
  echo "    waiting for notification to fire (attempt ${i})..."
  sleep 3 || true
done
if [ "${RECORDED}" != "${PROBE_KEY}" ]; then
  echo "FAIL: Lambda did not record key '${PROBE_KEY}' in ${TABLE_NAME} (notification never fired)" >&2
  exit 1
fi
echo "    OK: notification fired — Lambda recorded '${PROBE_KEY}' in DynamoDB"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy the consumer, then the bucket stack"
node "${LOCAL_DIST}" destroy "${CONSUMER}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "consumer state file ${CONSUMER_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
# DeleteQueue is eventually consistent: get-queue-url can answer for a while.
QUEUE_GONE=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
    QUEUE_GONE=1
    break
  fi
  sleep 5 || true
done
if [ -z "${QUEUE_GONE}" ]; then
  echo "FAIL: queue ${QUEUE_NAME} still exists 60s after the consumer destroy" >&2
  exit 1
fi
if ! SHARED_QUEUE_LEFT="$(await_value 0 aws s3api get-bucket-notification-configuration \
    --bucket "${SHARED_BUCKET}" --region "${REGION}" \
    --query 'length(QueueConfigurations || `[]`)' --output text)"; then
  echo "FAIL: the consumer's destroy left ${SHARED_QUEUE_LEFT} SQS notification(s) on ${SHARED_BUCKET}" >&2
  exit 1
fi
echo "    OK: consumer destroyed; its notification is gone from the shared bucket"

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    OK: bucket is gone"
assert_gone "shared bucket ${SHARED_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${SHARED_BUCKET}" --region "${REGION}"
echo "    OK: shared bucket is gone"

if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
  TBL_STATUS="GONE"
elif ! TBL_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.TableStatus' --output text 2>&1)"; then
  # TOCTOU: the table can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${TBL_STATUS}" \
    && TBL_STATUS="GONE" \
    || { echo "FAIL: describe-table requery undetermined: ${TBL_STATUS}" >&2; exit 1; }
fi
if [ "${TBL_STATUS}" != "GONE" ] && [ "${TBL_STATUS}" != "DELETING" ]; then
  echo "FAIL: table ${TABLE_NAME} still exists (status ${TBL_STATUS}) after destroy" >&2
  exit 1
fi
echo "    OK: table deleted (status: ${TBL_STATUS})"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cdkd state removed"

# Lambda auto-creates /aws/lambda/* log groups on invoke; they are not
# stack-managed (CFn leaves them too). Sweep them so the run is orphan-zero.
sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — S3 -> Lambda notification fired end-to-end, all 3 phases passed"
