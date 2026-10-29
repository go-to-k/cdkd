#!/usr/bin/env bash
# verify.sh — cdkd destroy-then-immediate-redeploy of NAMED streams (issue #3872).
#
# Kinesis (`DeleteStream`) and Firehose (`DeleteDeliveryStream`) keep a stream's
# NAME while it is DELETING and refuse a create of that name with the same
# `ResourceInUseException ... already exists` text a live stream gets. Measured
# windows (us-east-1): Kinesis 4-7s, Firehose ~103-107s. cdkd's delete()
# returned the moment the delete call was accepted, so `cdkd destroy` followed
# by `cdkd deploy` failed on the Firehose create; CloudFormation, which reports
# a delete complete only once the stream is gone, converges. The fix polls
# until the stream is gone before delete() returns.
#
# Phases:
#   1. Deploy a named Kinesis stream + a named Firehose delivery stream
#      (ExtendedS3 destination). Assert both are ACTIVE on AWS, and that the
#      create applied FileExtension and CustomTimeZone (issue #1160). The
#      legacy-S3 stream must read ACTIVE too: deploy waits for it (issue #5509).
#   2. Destroy. Record whether each stream is ALREADY gone the moment destroy
#      returns (the fix's contract), then IMMEDIATELY redeploy the same stack
#      -- the arm that failed before the fix. Fail if the redeploy failed or if
#      either stream was still present after destroy.
#   3. Assert both streams (and the legacy-S3 stream) are ACTIVE again (the
#      redeploy really re-created them under the same names).
#   3b. Redeploy with a changed delivery stream tag: an in-place update, the
#      stream's CreateTimestamp unchanged (issue #2613).
#   3c. Redeploy with FileExtension changed and Prefix / ErrorOutputPrefix /
#      CustomTimeZone removed from the template (issue #1160): the change
#      applies in place, and the removed sub-fields stay live, as a measured
#      CloudFormation update leaves them.
#   3d. Redeploy adding DeliveryStreamEncryptionConfigurationInput (AWS-owned
#      key): encryption must read ENABLED the moment deploy returns (issue
#      #5357: update() never applied it, and the transition is asynchronous).
#   3e. Redeploy with the block removed: encryption must read DISABLED, as a
#      measured CloudFormation update leaves it.
#   3f. Redeploy changing BufferingHints, Prefix and CompressionFormat of the
#      second delivery stream, whose destination is the legacy
#      S3DestinationConfiguration (issue #5439: cdkd refused the update, while
#      a measured CloudFormation change set updates it in place). The change
#      must apply with the stream's CreateTimestamp unchanged.
#   3g. Redeploy adding the encryption block under a 30s Firehose deadline:
#      the Start is sent and the deploy fails mid-transition. The record must
#      name the key unsettled (and `cdkd drift --json` list it); once the
#      stream reads ENABLED, a redeploy of the unencrypted template must
#      converge it to DISABLED and clear the name (issue #5380: the record
#      kept the old block, so that redeploy diffed empty and sent nothing).
#   4. Destroy, assert the streams, both buckets, the role and the cdkd state
#      file are gone -- immediately, with no polling.
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

STACK="CdkdStreamDeleteRedeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Unique per run so a leftover from an earlier run (which would itself still be
# DELETING) can never collide with this one; stable across the run's phases so
# the redeploy re-creates the SAME names. The stack reads it via CDKD_SRD_RUN_ID.
RUN_ID="$(date +%s)"
export CDKD_SRD_RUN_ID="${RUN_ID}"
NAME="cdkd-stream-redeploy-${RUN_ID}"
LEGACY_NAME="cdkd-stream-redeploy-legacy-${RUN_ID}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_A="cdkd-stream-redeploy-${ACCOUNT}-${RUN_ID}-a"
BUCKET_B="cdkd-stream-redeploy-${ACCOUNT}-${RUN_ID}-b"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for s in "${NAME}" "${LEGACY_NAME}"; do
    aws firehose delete-delivery-stream --delivery-stream-name "${s}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws kinesis delete-stream --stream-name "${NAME}" --enforce-consumer-deletion \
    --region "${REGION}" >/dev/null 2>&1 || true
  for b in "${BUCKET_A}" "${BUCKET_B}"; do
    aws s3 rb "s3://${b}" --force --region "${REGION}" >/dev/null 2>&1 || true
  done
  for p in $(aws iam list-role-policies --role-name "${NAME}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${NAME}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${NAME}" >/dev/null 2>&1 || true
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

firehose_status() {
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query 'DeliveryStreamDescription.DeliveryStreamStatus' --output text
}
# The legacy-S3 stream is the one seen still CREATING when an earlier create
# returned (issue #5509): its status is read the moment deploy returns.
legacy_status() {
  aws firehose describe-delivery-stream --delivery-stream-name "${LEGACY_NAME}" --region "${REGION}" \
    --query 'DeliveryStreamDescription.DeliveryStreamStatus' --output text
}
kinesis_status() {
  aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text
}
# The consumer is named like the streams; Kinesis scopes it to the stream ARN,
# read from the stream itself so the partition is never assumed.
stream_arn() {
  aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamARN' --output text
}
consumer_status() {
  aws kinesis describe-stream-consumer --stream-arn "$(stream_arn)" \
    --consumer-name "${NAME}" --region "${REGION}" \
    --query 'ConsumerDescription.ConsumerStatus' --output text
}
assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}

# --- Phase 1: deploy ----------------------------------------------------
echo "==> Phase 1: deploy named Kinesis stream + Firehose delivery stream (${NAME})"
CDKD_SRD_PHASE=a node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_eq "Firehose status after Phase 1" "ACTIVE" "$(firehose_status)"
assert_eq "legacy-S3 Firehose status after Phase 1 (issue #5509: create returned while CREATING)" "ACTIVE" "$(legacy_status)"
assert_eq "Kinesis status after Phase 1" "ACTIVE" "$(kinesis_status)"
assert_eq "Kinesis consumer status after Phase 1" "ACTIVE" "$(consumer_status)"
echo "    both streams and the stream consumer ACTIVE"

# The ExtendedS3 sub-fields the create used to drop (issue #1160). One read,
# then one field per assertion, so a failed `aws` call trips `set -e`.
firehose_dest() { # usage: firehose_dest <ExtendedS3DestinationDescription field>
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query "DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription.$1" --output text
}
P1_EXT="$(firehose_dest FileExtension)"
assert_eq "Firehose FileExtension after Phase 1 (issue #1160: the create dropped it)" ".json" "${P1_EXT}"
P1_TZ="$(firehose_dest CustomTimeZone)"
assert_eq "Firehose CustomTimeZone after Phase 1 (issue #1160: the create dropped it)" "Asia/Tokyo" "${P1_TZ}"
echo "    FileExtension and CustomTimeZone applied at create"

# --- Phase 2: destroy, then IMMEDIATELY redeploy -------------------------
echo "==> Phase 2: destroy"
T0="$(date +%s)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
echo "    destroy took $(( $(date +%s) - T0 ))s"

# Recorded, not asserted yet: the redeploy below is the user-visible arm, so a
# pre-fix binary runs it too and the failure message carries BOTH facts.
STILL_PRESENT=""
if ! gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}"; then
  STILL_PRESENT="${STILL_PRESENT} firehose($(firehose_status || echo gone-now))"
fi
if ! gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${LEGACY_NAME}" --region "${REGION}"; then
  STILL_PRESENT="${STILL_PRESENT} legacy-firehose"
fi
if ! gone_probe aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}"; then
  STILL_PRESENT="${STILL_PRESENT} kinesis($(kinesis_status || echo gone-now))"
fi
echo "    streams still present right after destroy:${STILL_PRESENT:- none}"

echo "==> Phase 2: immediate redeploy of the same stream names"
if ! CDKD_SRD_PHASE=b node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the immediate redeploy failed (streams still present right after destroy:${STILL_PRESENT:- none}) — delete() returned before the stream name was released" >&2
  exit 1
fi
if [ -n "${STILL_PRESENT}" ]; then
  echo "FAIL: destroy returned while a stream was still present:${STILL_PRESENT} — delete() did not wait for the stream to disappear" >&2
  exit 1
fi
echo "    streams were gone when destroy returned, and the redeploy succeeded"

# --- Phase 3: the redeploy really re-created both ------------------------
assert_eq "Firehose status after the redeploy" "ACTIVE" "$(firehose_status)"
assert_eq "legacy-S3 Firehose status after the redeploy (issue #5509)" "ACTIVE" "$(legacy_status)"
assert_eq "Kinesis status after the redeploy" "ACTIVE" "$(kinesis_status)"
assert_eq "Kinesis consumer status after the redeploy" "ACTIVE" "$(consumer_status)"
echo "    both streams and the stream consumer ACTIVE again under the same names"

# --- Phase 3b: an in-place delivery stream update (issue #2613) ----------
# Only the delivery stream's tag changes, so the redeploy reaches the Firehose
# provider's update() and its recorded-region guard. CreateTimestamp pins that
# the stream was updated, not replaced.
firehose_created() {
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query 'DeliveryStreamDescription.CreateTimestamp' --output text
}
firehose_tag() {
  aws firehose list-tags-for-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query "Tags[?Key=='cdkd-srd'].Value | [0]" --output text
}
# Each read is its own assignment so a failed `aws` call trips `set -e`, rather
# than comparing as an empty string inside assert_eq's arguments.
PRE_TAG="$(firehose_tag)"
assert_eq "Firehose tag cdkd-srd before Phase 3b" "base" "${PRE_TAG}"
PRE_CREATED="$(firehose_created)"
if [ -z "${PRE_CREATED}" ] || [ "${PRE_CREATED}" = None ]; then
  echo "FAIL: no CreateTimestamp for ${NAME} before Phase 3b (got '${PRE_CREATED}')" >&2
  exit 1
fi
echo "==> Phase 3b: redeploy with a changed delivery stream tag"
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
POST_TAG="$(firehose_tag)"
assert_eq "Firehose tag cdkd-srd after Phase 3b (issue #2613: the delivery stream update() did not apply)" "updated" "${POST_TAG}"
POST_CREATED="$(firehose_created)"
if [ -z "${POST_CREATED}" ] || [ "${POST_CREATED}" = None ]; then
  echo "FAIL: no CreateTimestamp for ${NAME} after Phase 3b (got '${POST_CREATED}')" >&2
  exit 1
fi
assert_eq "Firehose CreateTimestamp after Phase 3b (issue #2613: the tag change must update the stream in place, not replace it)" "${PRE_CREATED}" "${POST_CREATED}"
echo "    delivery stream tag updated in place, CreateTimestamp unchanged (issue #2613)"

# --- Phase 3c: a destination update with removed sub-fields (issue #1160) --
# FileExtension changes, so the redeploy reaches UpdateDestination; Prefix,
# ErrorOutputPrefix and CustomTimeZone leave the template. A live CloudFormation
# A/B kept every removed destination sub-field, so cdkd must too.
P3C_PRE_EXT="$(firehose_dest FileExtension)"
assert_eq "Firehose FileExtension before Phase 3c" ".json" "${P3C_PRE_EXT}"
echo "==> Phase 3c: redeploy with FileExtension changed and Prefix / ErrorOutputPrefix / CustomTimeZone removed"
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3C_EXT="$(firehose_dest FileExtension)"
assert_eq "Firehose FileExtension after Phase 3c (issue #1160: the update dropped it)" ".ndjson" "${P3C_EXT}"
P3C_PREFIX="$(firehose_dest Prefix)"
assert_eq "Firehose Prefix after Phase 3c (removed from the template; CloudFormation keeps it)" "data/" "${P3C_PREFIX}"
P3C_ERR="$(firehose_dest ErrorOutputPrefix)"
assert_eq "Firehose ErrorOutputPrefix after Phase 3c (removed from the template; CloudFormation keeps it)" "errors/" "${P3C_ERR}"
P3C_TZ="$(firehose_dest CustomTimeZone)"
assert_eq "Firehose CustomTimeZone after Phase 3c (removed from the template; CloudFormation keeps it)" "Asia/Tokyo" "${P3C_TZ}"
P3C_CREATED="$(firehose_created)"
assert_eq "Firehose CreateTimestamp after Phase 3c (the destination change must update the stream in place)" "${PRE_CREATED}" "${P3C_CREATED}"
echo "    FileExtension updated in place; the removed sub-fields stayed live (issue #1160)"

# --- Phase 3d / 3e: server-side encryption on, then off (issue #5357) -----
# Read once per phase, right after deploy returns and with no polling: update()
# waits for the asynchronous ENABLING / DISABLING transition to end.
firehose_enc() { # usage: firehose_enc <DeliveryStreamEncryptionConfiguration field>
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query "DeliveryStreamDescription.DeliveryStreamEncryptionConfiguration.$1" --output text
}
P3D_PRE="$(firehose_enc Status)"
assert_eq "Firehose encryption before Phase 3d" "DISABLED" "${P3D_PRE}"
echo "==> Phase 3d: redeploy adding DeliveryStreamEncryptionConfigurationInput (AWS_OWNED_CMK)"
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 CDKD_SRD_ENC=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3D_STATUS="$(firehose_enc Status)"
assert_eq "Firehose encryption status after Phase 3d (issue #5357: update() never applied DeliveryStreamEncryptionConfigurationInput, or returned before ENABLED)" "ENABLED" "${P3D_STATUS}"
P3D_TYPE="$(firehose_enc KeyType)"
assert_eq "Firehose encryption KeyType after Phase 3d" "AWS_OWNED_CMK" "${P3D_TYPE}"
P3D_CREATED="$(firehose_created)"
assert_eq "Firehose CreateTimestamp after Phase 3d (encryption must be applied in place)" "${PRE_CREATED}" "${P3D_CREATED}"
echo "    encryption enabled in place (issue #5357)"

echo "==> Phase 3e: redeploy with DeliveryStreamEncryptionConfigurationInput removed"
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3E_STATUS="$(firehose_enc Status)"
assert_eq "Firehose encryption status after Phase 3e (issue #5357: removing the block must stop encryption, as CloudFormation does)" "DISABLED" "${P3E_STATUS}"
P3E_CREATED="$(firehose_created)"
assert_eq "Firehose CreateTimestamp after Phase 3e (encryption must be removed in place)" "${PRE_CREATED}" "${P3E_CREATED}"
echo "    encryption disabled in place (issue #5357)"

# --- Phase 3f: an in-place legacy S3 destination update (issue #5439) ------
# Every earlier phase's env is carried, so only the legacy stream differs.
legacy_desc() { # usage: legacy_desc <DeliveryStreamDescription JMESPath>
  aws firehose describe-delivery-stream --delivery-stream-name "${LEGACY_NAME}" --region "${REGION}" \
    --query "DeliveryStreamDescription.$1" --output text
}
legacy_s3() { # usage: legacy_s3 <S3DestinationDescription field path>
  legacy_desc "Destinations[0].S3DestinationDescription.$1"
}
# The ARN derives from the fixed name, so a delete + re-create keeps it;
# CreateTimestamp is what tells an in-place update from a replacement.
P3F_PRE_CREATED="$(legacy_desc CreateTimestamp)"
if [ -z "${P3F_PRE_CREATED}" ] || [ "${P3F_PRE_CREATED}" = None ]; then
  echo "FAIL: no CreateTimestamp for ${LEGACY_NAME} before Phase 3f (got '${P3F_PRE_CREATED}')" >&2
  exit 1
fi
P3F_PRE_PREFIX="$(legacy_s3 Prefix)"
assert_eq "legacy-S3 stream Prefix before Phase 3f" "legacy-a/" "${P3F_PRE_PREFIX}"
P3F_PRE_COMP="$(legacy_s3 CompressionFormat)"
assert_eq "legacy-S3 stream CompressionFormat before Phase 3f" "UNCOMPRESSED" "${P3F_PRE_COMP}"
P3F_PRE_INTERVAL="$(legacy_s3 BufferingHints.IntervalInSeconds)"
assert_eq "legacy-S3 stream BufferingHints.IntervalInSeconds before Phase 3f" "60" "${P3F_PRE_INTERVAL}"
echo "==> Phase 3f: redeploy changing the legacy S3DestinationConfiguration (${LEGACY_NAME})"
if ! CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 CDKD_SRD_LEGACY_V2=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the legacy S3DestinationConfiguration update failed to deploy (issue #5439: cdkd refused an update CloudFormation applies in place)" >&2
  exit 1
fi
P3F_PREFIX="$(legacy_s3 Prefix)"
assert_eq "legacy-S3 stream Prefix after Phase 3f (issue #5439)" "legacy-b/" "${P3F_PREFIX}"
P3F_COMP="$(legacy_s3 CompressionFormat)"
assert_eq "legacy-S3 stream CompressionFormat after Phase 3f (issue #5439)" "GZIP" "${P3F_COMP}"
P3F_INTERVAL="$(legacy_s3 BufferingHints.IntervalInSeconds)"
assert_eq "legacy-S3 stream BufferingHints.IntervalInSeconds after Phase 3f (issue #5439)" "120" "${P3F_INTERVAL}"
P3F_SIZE="$(legacy_s3 BufferingHints.SizeInMBs)"
assert_eq "legacy-S3 stream BufferingHints.SizeInMBs after Phase 3f (issue #5439)" "10" "${P3F_SIZE}"
P3F_CREATED="$(legacy_desc CreateTimestamp)"
assert_eq "legacy-S3 stream CreateTimestamp after Phase 3f (the update must apply in place, not replace the stream)" "${P3F_PRE_CREATED}" "${P3F_CREATED}"
echo "    legacy S3 destination updated in place, CreateTimestamp unchanged (issue #5439)"

# --- Phase 3g: an encryption change the deadline cut short (issue #5380) ---
# The Start is sent within seconds and the ENABLING transition takes 80-95 s,
# so a 30 s per-type deadline fails the update AFTER the irreversible call.
# Before the fix the record kept the previous (unencrypted) block and nothing
# else, so the redeploy of that same template below diffed empty and sent
# nothing: the stream stayed ENABLED. Now the record names the key unsettled
# and the redeploy reads the stream and stops encryption.
unsettled_of_stream() { # the stream record's unsettledProperties, comma-joined
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r --arg name "${NAME}" '[.resources[]
        | select(.resourceType == "AWS::KinesisFirehose::DeliveryStream" and .physicalId == $name)
        | (.unsettledProperties // [])[]] | join(",")'
}
P3G_PRE="$(firehose_enc Status)"
assert_eq "Firehose encryption before Phase 3g" "DISABLED" "${P3G_PRE}"
echo "==> Phase 3g: redeploy adding encryption under a 30s Firehose deadline (must fail mid-transition)"
set +e
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 CDKD_SRD_LEGACY_V2=1 CDKD_SRD_ENC=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --resource-warn-after AWS::KinesisFirehose::DeliveryStream=10s \
  --resource-timeout AWS::KinesisFirehose::DeliveryStream=30s
P3G_EXIT=$?
set -e
if [ "${P3G_EXIT}" -eq 0 ]; then
  echo "FAIL: Phase 3g's deploy succeeded; the 30s deadline must cut the ENABLING transition short (premise of the arm)" >&2
  exit 1
fi
P3G_UNSETTLED="$(unsettled_of_stream)"
assert_eq "stream record's unsettledProperties after the cut-short deploy (issue #5380: a failed update recorded nothing it had applied)" \
  "DeliveryStreamEncryptionConfigurationInput" "${P3G_UNSETTLED}"
# `cdkd drift` names it too; its exit code reports the drift itself.
P3G_DRIFT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json || true)"
P3G_DRIFT_UNSETTLED="$(printf '%s' "${P3G_DRIFT}" \
  | jq -r '[.[].unsettled // [] | .[] | .properties[]] | join(",")')"
assert_eq "cdkd drift --json unsettled properties after Phase 3g (issue #5380)" \
  "DeliveryStreamEncryptionConfigurationInput" "${P3G_DRIFT_UNSETTLED}"
# Let the transition AWS accepted finish, so the next phase starts from a
# stream that holds the attempted block while the record holds none.
P3G_SETTLED=""
for _ in $(seq 1 40); do
  P3G_SETTLED="$(firehose_enc Status)"
  [ "${P3G_SETTLED}" != "ENABLING" ] && break
  sleep 5
done
assert_eq "Firehose encryption once the cut-short Start finished" "ENABLED" "${P3G_SETTLED}"

echo "==> Phase 3g: redeploy the template without encryption (the record's own block)"
CDKD_SRD_PHASE=b CDKD_SRD_TAG=updated CDKD_SRD_FILE_EXT=.ndjson CDKD_SRD_TRIM=1 CDKD_SRD_LEGACY_V2=1 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3G_STATUS="$(firehose_enc Status)"
assert_eq "Firehose encryption after redeploying the recorded template (issue #5380: the redeploy diffed empty and left the stream encrypted)" \
  "DISABLED" "${P3G_STATUS}"
P3G_AFTER="$(unsettled_of_stream)"
assert_eq "stream record's unsettledProperties after the converging deploy" "" "${P3G_AFTER}"
P3G_CREATED="$(firehose_created)"
assert_eq "Firehose CreateTimestamp after Phase 3g (encryption must converge in place)" "${PRE_CREATED}" "${P3G_CREATED}"
echo "    the unsettled encryption converged on redeploy (issue #5380)"

# --- Phase 4: destroy, everything gone at once ---------------------------
STREAM_ARN="$(stream_arn)"
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# No polling: delete() now returns only once each stream is gone.
assert_gone "Firehose delivery stream ${NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}"
assert_gone "Firehose delivery stream ${LEGACY_NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${LEGACY_NAME}" --region "${REGION}"
assert_gone "Kinesis stream ${NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}"
assert_gone "Kinesis stream consumer ${NAME} still exists after destroy" \
  aws kinesis describe-stream-consumer --stream-arn "${STREAM_ARN}" --consumer-name "${NAME}" --region "${REGION}"
assert_gone "bucket ${BUCKET_A} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_A}" --region "${REGION}"
assert_gone "bucket ${BUCKET_B} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_B}" --region "${REGION}"
assert_gone "role ${NAME} still exists after destroy" \
  aws iam get-role --role-name "${NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    streams, buckets, role and cdkd state all gone"

echo "[verify] PASS — named Kinesis + Firehose streams are gone when destroy returns, and an immediate redeploy succeeds"
