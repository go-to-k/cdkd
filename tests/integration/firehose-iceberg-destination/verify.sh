#!/usr/bin/env bash
# verify.sh — cdkd Firehose DeliveryStream IcebergDestinationConfiguration on
# the SDK route (issue #5636).
#
# Before the fix the property was missing from the provider's
# handledProperties, so the stream routed through Cloud Control and its state
# record read `provisionedBy: "cc-api"` -- the first assertion after the
# deploy. Three members are spelled differently by CloudFormation and the SDK:
# `s3BackupMode` / `S3BackupMode`, `CatalogConfiguration.CatalogArn` /
# `CatalogARN`, and the read side's `S3DestinationDescription` /
# `S3Configuration`. Each is read back from AWS, and the deploy-time read
# (`observedProperties`) must carry CloudFormation's spelling.
#
# Phases:
#   1. Deploy: backup mode FailedDataOnly, buffering 60s, retry 300s, table
#      `events`. Assert provisionedBy=sdk, every templated member in
#      DescribeDeliveryStream, and the CloudFormation spelling in
#      observedProperties.
#   2. CDKD_TEST_UPDATE=true: buffering 120s, retry 600s, table `events_v2`.
#      Assert the same stream (create timestamp unchanged), the new values in
#      AWS, the catalog untouched, and a clean drift.
#   3. Empty the bucket (Glue's Iceberg metadata), destroy; assert the
#      stream, both tables, database, bucket, role and state file are
#      gone.
#
# Both destination tables (`events`, `events_v2`) are real Iceberg tables the
# stack creates before the stream: with table creation off, Firehose's create
# requires the table to exist (glue:GetTable refusal, measured 2026-11-02).
# The shape was validated by a throwaway CloudFormation stack the same day:
# the stream reached ACTIVE, the phase-2 update applied in place, and the
# read-back table entry held exactly the two templated keys.
#
# SchemaEvolutionConfiguration and TableCreationConfiguration are not
# templated: an enabled schema evolution is refused on a DirectPut stream
# (InvalidArgumentException "Iceberg schema evolution can not be enabled for
# the request type of stream", measured 2026-11-02), and AWS documents both
# only for a database source. They are pinned by the unit tests only.
#
# The backup mode stays FailedDataOnly in both phases: it is the only value
# Firehose accepts for Iceberg (the SDK's member docs) and also its default,
# so the write side of `s3BackupMode` cannot be told apart on AWS. Its READ
# side can: observedProperties must carry it as `s3BackupMode`.
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

STACK="CdkdFirehoseIcebergDestinationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Deterministic names from lib/firehose-iceberg-destination-stack.ts.
STREAM_NAME="CdkdFirehoseIceberg5636"
DATABASE_NAME="cdkd_firehose_iceberg_5636"
TABLE_NAMES="events events_v2"
ROLE_NAME="CdkdFirehoseIceberg5636Role-${REGION}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Only a value shaped like a bucket name AND carrying the name cdkd generates
# for this stack's `Bucket` (resource-name.ts: the lowercased
# `{StackName}-{LogicalId}`, plus `-{12 hex}` on a stack with an instance id)
# is ever emptied or deleted.
is_fixture_bucket() { # usage: is_fixture_bucket <name>
  [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] &&
    [[ "$1" =~ ^cdkdfirehoseicebergdestinationexample-bucket(-[0-9a-f]{12})?$ ]]
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # The bucket's name is generated, so read it from the record BEFORE the
  # state destroy drops it: a failed destroy leaves no other way to find it.
  local leftover_bucket=""
  if [ -n "${STATE_BUCKET:-}" ]; then
    leftover_bucket="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" 2>/dev/null |
      jq -r '.resources.Bucket.physicalId // empty' 2>/dev/null)"
  fi
  # The Iceberg tables' metadata sits in the bucket, which a delete refuses
  # while it holds objects: empty it first.
  if [ -n "${leftover_bucket}" ] && is_fixture_bucket "${leftover_bucket}"; then
    aws s3 rm "s3://${leftover_bucket}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET:-}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  # By deterministic name: a run that died before recording them in state.
  # A delete leaves the name DELETING for minutes, and the next create of it
  # is refused, so wait (capped) until the stream is gone.
  if aws firehose delete-delivery-stream --delivery-stream-name "${STREAM_NAME}" --allow-force-delete \
    --region "${REGION}" >/dev/null 2>&1; then
    for _ in $(seq 1 36); do
      # Subshell: an inconclusive probe (throttle, 5xx) exits only it, and
      # counts as still present, so the deletes below still run.
      (gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
        --region "${REGION}") && break
      sleep 5
    done
  fi
  # Stream, then tables, then database.
  for t in ${TABLE_NAMES}; do
    aws glue delete-table --database-name "${DATABASE_NAME}" --name "${t}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws glue delete-database --name "${DATABASE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name iceberg >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  # A failed state destroy left the bucket: empty and delete it by the name
  # read above, and name it loudly if it is still there.
  # Anything not this fixture's generated name is named and left alone.
  if [ "${rc}" != "0" ] && [ -n "${leftover_bucket}" ]; then
    if is_fixture_bucket "${leftover_bucket}"; then
      aws s3 rm "s3://${leftover_bucket}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
      aws s3api delete-bucket --bucket "${leftover_bucket}" --region "${REGION}" >/dev/null 2>&1 || true
      if ! (gone_probe aws s3api head-bucket --bucket "${leftover_bucket}" --region "${REGION}"); then
        echo "LEAK: bucket ${leftover_bucket} survived the cleanup -- delete it by hand" >&2
      fi
    else
      echo "SKIP: teardown sweep refused the recorded bucket name '${leftover_bucket}': not this fixture's generated name" >&2
      echo "LEAK: bucket '${leftover_bucket}' may remain -- delete it by hand" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
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

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CATALOG_ARN="arn:aws:glue:${REGION}:${ACCOUNT}:catalog"

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

# The stream's IcebergDestinationDescription, or FAIL when AWS reports none.
iceberg_desc() {
  local out
  out="$(aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
    --region "${REGION}" --output json)" || return 1
  if [ "$(jq -r '.DeliveryStreamDescription.Destinations[0].IcebergDestinationDescription | type' <<<"${out}")" != "object" ]; then
    echo "FAIL: ${STREAM_NAME} has no IcebergDestinationDescription:" >&2
    jq '.DeliveryStreamDescription.Destinations' <<<"${out}" >&2
    exit 1
  fi
  jq -c '.DeliveryStreamDescription.Destinations[0].IcebergDestinationDescription' <<<"${out}"
}

create_timestamp() {
  aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" \
    --region "${REGION}" --query 'DeliveryStreamDescription.CreateTimestamp' --output text
}

assert_eq() { # usage: assert_eq <description> <got> <want>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected '$3', got '$2' (#5636)" >&2
    exit 1
  fi
  echo "    ok: $1 = $2"
}

assert_sdk_route() {
  local by
  by="$(read_state | jq -r '.resources.Stream.provisionedBy // "<absent>"')"
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: AWS::KinesisFirehose::DeliveryStream routing layer is '${by}', expected 'sdk' (IcebergDestinationConfiguration still routes the stream to Cloud Control, #5636)" >&2
    exit 1
  fi
  echo "    ok: the delivery stream stayed on the SDK route"
}

# Members both phases template the same way.
assert_fixed_members() { # usage: assert_fixed_members <desc json>
  local desc="$1"
  assert_eq "CatalogConfiguration.CatalogARN" "$(jq -r '.CatalogConfiguration.CatalogARN' <<<"${desc}")" "${CATALOG_ARN}"
  assert_eq "CatalogConfiguration.WarehouseLocation" \
    "$(jq -r '.CatalogConfiguration.WarehouseLocation' <<<"${desc}")" "s3://${BUCKET_NAME}/warehouse/"
  assert_eq "BufferingHints.SizeInMBs" "$(jq -r '.BufferingHints.SizeInMBs' <<<"${desc}")" "1"
  assert_eq "RoleARN" "$(jq -r '.RoleARN' <<<"${desc}")" "${ROLE_ARN}"
  assert_eq "S3 BucketARN" "$(jq -r '.S3DestinationDescription.BucketARN' <<<"${desc}")" "arn:aws:s3:::${BUCKET_NAME}"
  assert_eq "S3 ErrorOutputPrefix" "$(jq -r '.S3DestinationDescription.ErrorOutputPrefix' <<<"${desc}")" "errors/"
  assert_eq "S3 RoleARN" "$(jq -r '.S3DestinationDescription.RoleARN' <<<"${desc}")" "${ROLE_ARN}"
  assert_eq "destination database" \
    "$(jq -r '.DestinationTableConfigurationList[0].DestinationDatabaseName' <<<"${desc}")" "${DATABASE_NAME}"
}

# Members phase 2 changes.
assert_phase_members() { # usage: assert_phase_members <desc json> <mode> <interval> <retry> <table>
  local desc="$1"
  assert_eq "S3BackupMode" "$(jq -r '.S3BackupMode' <<<"${desc}")" "$2"
  assert_eq "BufferingHints.IntervalInSeconds" "$(jq -r '.BufferingHints.IntervalInSeconds' <<<"${desc}")" "$3"
  assert_eq "RetryOptions.DurationInSeconds" "$(jq -r '.RetryOptions.DurationInSeconds' <<<"${desc}")" "$4"
  assert_eq "destination table" \
    "$(jq -r '.DestinationTableConfigurationList | map(.DestinationTableName) | join(",")' <<<"${desc}")" "$5"
}

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy (backup FailedDataOnly, buffering 60s, retry 300s, table events)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route
STATE="$(read_state)"
BUCKET_NAME="$(jq -r '.outputs.BucketName // empty' <<<"${STATE}")"
ROLE_ARN="$(jq -r '.outputs.RoleArn // empty' <<<"${STATE}")"
if [ -z "${BUCKET_NAME}" ] || [ -z "${ROLE_ARN}" ]; then
  echo "FAIL: BucketName / RoleArn missing from state outputs" >&2
  jq '.outputs' <<<"${STATE}" >&2
  exit 1
fi

DESC="$(iceberg_desc)"
assert_fixed_members "${DESC}"
assert_phase_members "${DESC}" FailedDataOnly 60 300 events

# The deploy-time read is readCurrentState's: CloudFormation's spelling, not
# the SDK's, or every drift run would report the member.
OBSERVED="$(jq -c '.resources.Stream.observedProperties.IcebergDestinationConfiguration // empty' <<<"${STATE}")"
if [ "$(jq -r 'type' <<<"${OBSERVED:-null}")" != "object" ]; then
  echo "FAIL: the stream's observedProperties carry no IcebergDestinationConfiguration -- readCurrentState does not read the Iceberg destination back (#5636)" >&2
  jq '.resources.Stream.observedProperties' <<<"${STATE}" >&2
  exit 1
fi
assert_eq "observed s3BackupMode" "$(jq -r '.s3BackupMode // "<absent>"' <<<"${OBSERVED}")" "FailedDataOnly"
assert_eq "observed CatalogConfiguration.CatalogArn" \
  "$(jq -r '.CatalogConfiguration.CatalogArn // "<absent>"' <<<"${OBSERVED}")" "${CATALOG_ARN}"
# A list entry compares by exact key set, so a default AWS adds inside one
# would read as drift against a template-only baseline on every run.
assert_eq "observed DestinationTableConfigurationList[0] keys" \
  "$(jq -r '.DestinationTableConfigurationList[0] | keys | join(",")' <<<"${OBSERVED}")" \
  "DestinationDatabaseName,DestinationTableName"
assert_eq "observed S3Configuration.BucketARN" \
  "$(jq -r '.S3Configuration.BucketARN // "<absent>"' <<<"${OBSERVED}")" "arn:aws:s3:::${BUCKET_NAME}"
assert_eq "observed S3Configuration.RoleARN" \
  "$(jq -r '.S3Configuration.RoleARN // "<absent>"' <<<"${OBSERVED}")" "${ROLE_ARN}"
BASE_CREATED="$(create_timestamp)"

# --- Phase 2: in-place update ------------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (buffering 120s, retry 600s, table events_v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route
assert_eq "stream create timestamp (in place, not replaced)" "$(create_timestamp)" "${BASE_CREATED}"
DESC="$(iceberg_desc)"
assert_fixed_members "${DESC}"
assert_phase_members "${DESC}" FailedDataOnly 120 600 events_v2

echo "==> Phase 2: drift must be clean"
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}"
echo "    ok: no drift after the update"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
# Glue wrote the Iceberg tables' metadata under warehouse/: empty the bucket
# so its delete can succeed.
is_fixture_bucket "${BUCKET_NAME}" || { echo "FAIL: '${BUCKET_NAME}' is not this fixture's generated bucket name" >&2; exit 1; }
aws s3 rm "s3://${BUCKET_NAME}" --recursive --region "${REGION}" >/dev/null
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "delivery stream ${STREAM_NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${STREAM_NAME}" --region "${REGION}"
for t in ${TABLE_NAMES}; do
  assert_gone "Glue table ${DATABASE_NAME}.${t} still exists after destroy" \
    aws glue get-table --database-name "${DATABASE_NAME}" --name "${t}" --region "${REGION}"
done
assert_gone "Glue database ${DATABASE_NAME} still exists after destroy" \
  aws glue get-database --name "${DATABASE_NAME}" --region "${REGION}"
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    ok: stream, database, role, bucket and state file are gone"

echo ""
echo "[verify] PASS — firehose-iceberg-destination: IcebergDestinationConfiguration created and updated in place on the SDK route, read back in CloudFormation's spelling (#5636)"
