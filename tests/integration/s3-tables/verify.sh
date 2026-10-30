#!/usr/bin/env bash
# verify.sh — cdkd S3Tables integ test.
#
# Two concerns in one fixture:
#   1. (issue #609) An AWS::S3Tables::Table / ::TableBucket with template-set
#      Tags has those tags reach AWS after `cdkd deploy` — `Tags` was a
#      silent-drop before #609. Resolves the ARNs from cdkd state outputs,
#      calls `s3tables ListTagsForResource`, asserts the tags are present.
#   2. (issues #974 / #5316) CloudFormation's `Ref` for an
#      AWS::S3Tables::Table returns its TableARN. Asserts the Ref resolves to
#      the TableARN for the plain Table and for the schema-bearing
#      IcebergTable (both SDK-routed, composite physical ids), via a CfnOutput
#      AND a consuming SSM parameter round-trip, never the table name.
#   3. (issue #2613) Phase 1b redeploys with changed tag values: the
#      TableBucket and the SDK-routed Table update in place, through the
#      provider's update() and its recorded-region guard.
#   4. (issue #5313) Phase 1c redeploys with a new TableName and Namespace:
#      the SDK-routed Table is renamed in place on AWS (same TableARN, as
#      CloudFormation does) and the state records the new composite id; its
#      Ref reader keeps the unchanged TableARN.
#   5. (issue #5316) Phase 1d seeds both Ref readers' records and AWS values
#      with the table name an older cdkd resolved the Ref to, and drops the
#      Table's recorded TableARN (a pre-v0.201.0 record), redeploys the same
#      template, and asserts each reader is rewritten to the TableARN and the
#      Table's TableARN is re-read from AWS and recorded.
#   6. (issue #2762) The TableBucket's StorageClass / Metrics /
#      UnreferencedFileRemoval and the IcebergTable's IcebergMetadata /
#      StorageClass / Compaction / SnapshotManagement — Cloud Control routing
#      silent drops before #2762 — are sent by the SDK provider: Phase 1
#      routes the IcebergTable via the SDK and reads every value back from
#      AWS; Phase 1b changes UnreferencedDays and Compaction in place.
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

STACK="S3TablesStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

EXPECTED_ENV_TAG="cdkd-integ"
EXPECTED_TEAM_TAG="platform"
# #609 backfill (this PR — U / TableBucket Tags) — distinct keys from
# the Table's `env` / `team` so the assertion confirms each resource's
# tag-diff fired against the correct ARN.
EXPECTED_BUCKET_ENV_TAG="cdkd-integ"
EXPECTED_BUCKET_TEAM_TAG="platform"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

TABLE_ARN=""
TABLE_BUCKET_ARN=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # Pass --state-bucket explicitly (PR #735 / #738 retrospective: the
  # cdk.json placeholder otherwise poisons state destroy). Do NOT silence
  # stderr — a partial-failure on the deeply-nested TableBucket → Namespace
  # → Table cascade silently leaves orphans otherwise.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # The consuming SSM parameter (issue #974) has a deterministic name, so a
  # partial-failure that left it behind is swept here directly.
  aws ssm delete-parameter --region "${REGION}" --name "/${STACK}/iceberg-table-ref" >/dev/null 2>&1 || true
  aws ssm delete-parameter --region "${REGION}" --name "/${STACK}/table-ref" >/dev/null 2>&1 || true
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
# CDKD_S3T_* unset: Phase 1 asserts the base `platform` tag value and the
# base table name / namespace.
env -u CDKD_S3T_TEAM -u CDKD_S3T_TABLE_NAME -u CDKD_S3T_TABLE_NS node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the table ARN from cdkd state's TableArn output. The state's
# physicalId for AWS::S3Tables::Table is the cdkd-compound form
# `<bucketArn>|<namespace>|<name>`, NOT the real table ARN that
# ListTagsForResource expects — the Outputs section carries the real ARN
# (via attrTableArn → CfnOutput in the fixture).
TABLE_ARN=$(echo "${STATE}" | jq -r '.outputs.TableArn // ""')
if [ -z "${TABLE_ARN}" ] || [ "${TABLE_ARN}" = "null" ]; then
  echo "FAIL: could not resolve TableArn from state outputs" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    resolved Table ARN: ${TABLE_ARN}"

TABLE_BUCKET_ARN=$(echo "${STATE}" | jq -r '.outputs.TableBucketArn // ""')
echo "    resolved TableBucket ARN: ${TABLE_BUCKET_ARN}"

# Confirm cdkd routed via the SDK provider (not CC-API). If routing
# flipped (e.g. an unhandled silent-drop sneaked in), the backfill
# closure being tested IS the wrong code path.
# Named: the stack holds two tables, and a `first` over both reads whichever
# the state lists first.
PROVISIONED_BY=$(echo "${STATE}" | jq -r '.resources.Table.provisionedBy // "MISSING"')
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::S3Tables::Table routed via '${PROVISIONED_BY}', expected 'sdk' (silent-drop routing flip — backfill is on the wrong path)" >&2
  exit 1
fi
echo "    OK: AWS::S3Tables::Table routed via SDK provider (provisionedBy=sdk)"

# --- Assertion: SDK-routed Table `Ref` resolves to the TableARN (#5316) --
# cdkd's composite physical id `<bucketArn>|<namespace>|<name>` holds no
# segment of the ARN; the Ref comes from the recorded TableARN attribute.
# Before #5316 it was the trailing table name.
TABLE_REF=$(echo "${STATE}" | jq -r '.outputs.TableRef // ""')
if [ "${TABLE_REF}" != "${TABLE_ARN}" ]; then
  echo "FAIL: Ref(Table) output is '${TABLE_REF}', expected the TableARN '${TABLE_ARN}' (issue #5316: CloudFormation's Ref of an S3 Tables table is its ARN)" >&2
  exit 1
fi
TABLE_REF_PARAM_P1="$(aws ssm get-parameter --region "${REGION}" --name "/${STACK}/table-ref" --query 'Parameter.Value' --output text)"
if [ "${TABLE_REF_PARAM_P1}" != "${TABLE_ARN}" ]; then
  echo "FAIL: SSM parameter /${STACK}/table-ref is '${TABLE_REF_PARAM_P1}', expected the TableARN '${TABLE_ARN}' (issue #5316: Ref(Table) reached a consuming resource as something else)" >&2
  exit 1
fi
echo "    OK: Ref(Table) == TableARN in the output and in the consuming SSM parameter (issue #5316)"

# --- Assertion: Tags reached AWS via ListTagsForResource --------------
# Capture stdout + stderr + exit code separately so a failed AWS CLI
# call surfaces its actual error rather than silently dying with a
# parse error downstream.
set +e
TAGS_JSON=$(aws s3tables list-tags-for-resource \
  --region "${REGION}" \
  --resource-arn "${TABLE_ARN}" \
  --output json 2>/tmp/s3tables-tags-err)
TAGS_RC=$?
set -e
if [ "${TAGS_RC}" -ne 0 ] || [ -z "${TAGS_JSON}" ]; then
  echo "FAIL: ListTagsForResource exited ${TAGS_RC} for ${TABLE_ARN}" >&2
  echo "stdout: ${TAGS_JSON}" >&2
  echo "stderr:" >&2
  cat /tmp/s3tables-tags-err >&2 || true
  exit 1
fi

# S3Tables returns `tags: { key: value }` (a flat map), NOT the
# `tags: [{Key, Value}]` array form CFn uses. Assert both expected
# entries are present.
ACTUAL_ENV=$(echo "${TAGS_JSON}" | jq -r '.tags.env // "MISSING"')
ACTUAL_TEAM=$(echo "${TAGS_JSON}" | jq -r '.tags.team // "MISSING"')

if [ "${ACTUAL_ENV}" != "${EXPECTED_ENV_TAG}" ]; then
  echo "FAIL: env tag is '${ACTUAL_ENV}', expected '${EXPECTED_ENV_TAG}' (Tags silent-drop NOT closed)" >&2
  echo "${TAGS_JSON}" | jq .
  exit 1
fi
echo "    OK: env tag == '${EXPECTED_ENV_TAG}' on AWS (Tags silent-drop CLOSED by #609)"

if [ "${ACTUAL_TEAM}" != "${EXPECTED_TEAM_TAG}" ]; then
  echo "FAIL: team tag is '${ACTUAL_TEAM}', expected '${EXPECTED_TEAM_TAG}'" >&2
  exit 1
fi
echo "    OK: team tag == '${EXPECTED_TEAM_TAG}' on AWS"

# --- Assertion: TableBucket Tags reached AWS (#609 — this PR / U) -----
# TableBucket's physicalId IS the bucket ARN, so the same
# ListTagsForResource API used for Table works against it directly.
# Distinct keys (`bucket-env` / `bucket-team`) so a misrouted tag (e.g.
# the Table's `env` tag accidentally landing on the bucket via a bad
# ARN derivation) would surface as MISSING, not as a value-equality
# match against an unrelated resource.
if [ -z "${TABLE_BUCKET_ARN}" ] || [ "${TABLE_BUCKET_ARN}" = "null" ]; then
  echo "FAIL: TableBucketArn output is empty/null — cannot run TableBucket tag assertion" >&2
  exit 1
fi

set +e
BUCKET_TAGS_JSON=$(aws s3tables list-tags-for-resource \
  --region "${REGION}" \
  --resource-arn "${TABLE_BUCKET_ARN}" \
  --output json 2>/tmp/s3tables-bucket-tags-err)
BUCKET_TAGS_RC=$?
set -e
if [ "${BUCKET_TAGS_RC}" -ne 0 ] || [ -z "${BUCKET_TAGS_JSON}" ]; then
  echo "FAIL: ListTagsForResource exited ${BUCKET_TAGS_RC} for ${TABLE_BUCKET_ARN}" >&2
  echo "stdout: ${BUCKET_TAGS_JSON}" >&2
  echo "stderr:" >&2
  cat /tmp/s3tables-bucket-tags-err >&2 || true
  exit 1
fi

ACTUAL_BUCKET_ENV=$(echo "${BUCKET_TAGS_JSON}" | jq -r '.tags["bucket-env"] // "MISSING"')
ACTUAL_BUCKET_TEAM=$(echo "${BUCKET_TAGS_JSON}" | jq -r '.tags["bucket-team"] // "MISSING"')

if [ "${ACTUAL_BUCKET_ENV}" != "${EXPECTED_BUCKET_ENV_TAG}" ]; then
  echo "FAIL: bucket-env tag is '${ACTUAL_BUCKET_ENV}', expected '${EXPECTED_BUCKET_ENV_TAG}' (TableBucket Tags silent-drop NOT closed)" >&2
  echo "${BUCKET_TAGS_JSON}" | jq .
  exit 1
fi
echo "    OK: bucket-env tag == '${EXPECTED_BUCKET_ENV_TAG}' on AWS (TableBucket Tags silent-drop CLOSED by #609 / U)"

if [ "${ACTUAL_BUCKET_TEAM}" != "${EXPECTED_BUCKET_TEAM_TAG}" ]; then
  echo "FAIL: bucket-team tag is '${ACTUAL_BUCKET_TEAM}', expected '${EXPECTED_BUCKET_TEAM_TAG}'" >&2
  exit 1
fi
echo "    OK: bucket-team tag == '${EXPECTED_BUCKET_TEAM_TAG}' on AWS"

# Confirm TableBucket routed via SDK provider too (same routing-flip guard
# as the Table assertion above).
# Before issue #2762 the bucket's StorageClass / Metrics / UnreferencedFileRemoval
# routed it to Cloud Control, so this is where a pre-fix run goes RED first.
BUCKET_PROVISIONED_BY=$(echo "${STATE}" | jq -r '.resources.TableBucket.provisionedBy // "MISSING"')
if [ "${BUCKET_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::S3Tables::TableBucket routed via '${BUCKET_PROVISIONED_BY}', expected 'sdk' (silent-drop routing flip)" >&2
  exit 1
fi
echo "    OK: AWS::S3Tables::TableBucket routed via SDK provider (provisionedBy=sdk)"

# --- Assertion: IcebergTable `Ref` resolves to the TableARN (#974 / #5316)
# The IcebergTable carries IcebergMetadata / Compaction / SnapshotManagement /
# StorageClassConfiguration, Cloud Control routing silent drops until issue
# #2762 wired them into the SDK provider. Assert (1) it now routes via the
# SDK provider, under cdkd's composite physical id, and (2) both the CfnOutput
# Ref and the consuming SSM parameter's value equal the TableARN
# (`Fn::GetAtt TableARN`), not the table name.
ICEBERG_TABLE_NAME="cdkd_integ_cc_tbl"

ICEBERG_PROVISIONED_BY=$(echo "${STATE}" | jq -r '.resources.IcebergTable.provisionedBy // "MISSING"')
ICEBERG_PHYSICAL_ID=$(echo "${STATE}" | jq -r '.resources.IcebergTable.physicalId // ""')
if [ "${ICEBERG_PROVISIONED_BY}" != "sdk" ] || [ "${ICEBERG_PHYSICAL_ID}" != "${TABLE_BUCKET_ARN}|cdkd_integ_ns|${ICEBERG_TABLE_NAME}" ]; then
  echo "FAIL: IcebergTable routed via '${ICEBERG_PROVISIONED_BY}' with physicalId '${ICEBERG_PHYSICAL_ID}', expected 'sdk' with '${TABLE_BUCKET_ARN}|cdkd_integ_ns|${ICEBERG_TABLE_NAME}' (issue #2762: its configuration properties must not route it to Cloud Control)" >&2
  exit 1
fi
echo "    OK: IcebergTable routed via the SDK provider (provisionedBy=sdk, composite physicalId; issue #2762)"

EXPECTED_ICEBERG_ARN=$(echo "${STATE}" | jq -r '.outputs.IcebergTableArn // ""')
case "${EXPECTED_ICEBERG_ARN}" in
  arn:*:s3tables:*/table/*) ;;
  *)
    echo "FAIL: IcebergTableArn output is '${EXPECTED_ICEBERG_ARN}', expected an S3 Tables table ARN" >&2
    echo "${STATE}" | jq .outputs
    exit 1
    ;;
esac

# (a) The CfnOutput Ref value.
ICEBERG_REF=$(echo "${STATE}" | jq -r '.outputs.IcebergTableRef // ""')
if [ "${ICEBERG_REF}" != "${EXPECTED_ICEBERG_ARN}" ] || [ "${ICEBERG_REF}" = "${ICEBERG_TABLE_NAME}" ]; then
  echo "FAIL: Ref(IcebergTable) output is '${ICEBERG_REF}', expected the TableARN '${EXPECTED_ICEBERG_ARN}' (issue #5316)" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: Ref(IcebergTable) output == TableARN '${EXPECTED_ICEBERG_ARN}' (issue #5316)"

# (b) The consuming SSM parameter's value on AWS — proves the resolved Ref
# round-trips through a real resource write, not just cdkd's own outputs map.
REF_PARAM_NAME=$(echo "${STATE}" | jq -r '.outputs.IcebergTableRefParamName // ""')
if [ -z "${REF_PARAM_NAME}" ] || [ "${REF_PARAM_NAME}" = "null" ]; then
  echo "FAIL: could not resolve IcebergTableRefParamName from state outputs" >&2
  exit 1
fi
set +e
SSM_VALUE=$(aws ssm get-parameter \
  --region "${REGION}" \
  --name "${REF_PARAM_NAME}" \
  --query 'Parameter.Value' \
  --output text 2>/tmp/s3tables-ssm-err)
SSM_RC=$?
set -e
if [ "${SSM_RC}" -ne 0 ]; then
  echo "FAIL: ssm get-parameter exited ${SSM_RC} for ${REF_PARAM_NAME}" >&2
  cat /tmp/s3tables-ssm-err >&2 || true
  exit 1
fi
if [ "${SSM_VALUE}" != "${EXPECTED_ICEBERG_ARN}" ]; then
  echo "FAIL: SSM parameter '${REF_PARAM_NAME}' value is '${SSM_VALUE}', expected the TableARN '${EXPECTED_ICEBERG_ARN}' (Ref(IcebergTable) reached a consuming resource as something else)" >&2
  exit 1
fi
echo "    OK: consuming SSM parameter value == TableARN (Ref reached AWS correctly)"

# --- Assertion: the configuration properties reached AWS (issue #2762) ----
# Each read is its own assignment, so a failed `aws` trips `set -e` rather
# than comparing as an empty string. Every expected value is a non-default.
bucket_ufr() { # usage: bucket_ufr -> "<status> <unreferencedDays> <nonCurrentDays>"
  aws s3tables get-table-bucket-maintenance-configuration --region "${REGION}" \
    --table-bucket-arn "${TABLE_BUCKET_ARN}" --output json \
    | jq -r '.configuration.icebergUnreferencedFileRemoval | "\(.status) \(.settings.icebergUnreferencedFileRemoval.unreferencedDays) \(.settings.icebergUnreferencedFileRemoval.nonCurrentDays)"'
}
table_maintenance() { # usage: table_maintenance -> "<compaction status> <target MB> <snapshot status> <min> <max age>"
  aws s3tables get-table-maintenance-configuration --region "${REGION}" \
    --table-bucket-arn "${TABLE_BUCKET_ARN}" --namespace cdkd_integ_ns --name "${ICEBERG_TABLE_NAME}" --output json \
    | jq -r '.configuration | "\(.icebergCompaction.status) \(.icebergCompaction.settings.icebergCompaction.targetFileSizeMB) \(.icebergSnapshotManagement.status) \(.icebergSnapshotManagement.settings.icebergSnapshotManagement.minSnapshotsToKeep) \(.icebergSnapshotManagement.settings.icebergSnapshotManagement.maxSnapshotAgeHours)"'
}
BUCKET_STORAGE_CLASS="$(aws s3tables get-table-bucket-storage-class --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" --query 'storageClassConfiguration.storageClass' --output text)"
if [ "${BUCKET_STORAGE_CLASS}" != "INTELLIGENT_TIERING" ]; then
  echo "FAIL: TableBucket storage class is '${BUCKET_STORAGE_CLASS}', expected 'INTELLIGENT_TIERING' (issue #2762: StorageClassConfiguration did not reach CreateTableBucket)" >&2
  exit 1
fi
# The Get answers NotFound unless metrics are configured.
if ! aws s3tables get-table-bucket-metrics-configuration --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" >/dev/null; then
  echo "FAIL: TableBucket has no metrics configuration (issue #2762: MetricsConfiguration Enabled did not reach PutTableBucketMetricsConfiguration)" >&2
  exit 1
fi
BUCKET_UFR="$(bucket_ufr)"
if [ "${BUCKET_UFR}" != "enabled 5 7" ]; then
  echo "FAIL: TableBucket unreferenced file removal is '${BUCKET_UFR}', expected 'enabled 5 7' (issue #2762: UnreferencedFileRemoval did not reach PutTableBucketMaintenanceConfiguration)" >&2
  exit 1
fi
echo "    OK: TableBucket storage class, metrics and unreferenced file removal on AWS (issue #2762)"

TABLE_STORAGE_CLASS="$(aws s3tables get-table-storage-class --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" --namespace cdkd_integ_ns --name "${ICEBERG_TABLE_NAME}" --query 'storageClassConfiguration.storageClass' --output text)"
if [ "${TABLE_STORAGE_CLASS}" != "INTELLIGENT_TIERING" ]; then
  echo "FAIL: IcebergTable storage class is '${TABLE_STORAGE_CLASS}', expected 'INTELLIGENT_TIERING' (issue #2762: StorageClassConfiguration did not reach CreateTable)" >&2
  exit 1
fi
# S3 Tables writes a table's first metadata file only when CreateTable
# carries a schema; a table created without one has no metadata location.
METADATA_LOCATION="$(aws s3tables get-table-metadata-location --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" --namespace cdkd_integ_ns --name "${ICEBERG_TABLE_NAME}" --query 'metadataLocation' --output text)"
case "${METADATA_LOCATION}" in
  s3://*) ;;
  *)
    echo "FAIL: IcebergTable metadata location is '${METADATA_LOCATION}', expected an s3:// URI (issue #2762: IcebergMetadata did not reach CreateTable)" >&2
    exit 1
    ;;
esac
ICEBERG_MAINTENANCE="$(table_maintenance)"
# The template sets no target file size, so AWS may report its default or none.
case "${ICEBERG_MAINTENANCE}" in
  "disabled "*" enabled 2 200") ;;
  *)
    echo "FAIL: IcebergTable maintenance is '${ICEBERG_MAINTENANCE}', expected 'disabled <any> enabled 2 200' (issue #2762: Compaction / SnapshotManagement did not reach PutTableMaintenanceConfiguration)" >&2
    exit 1
    ;;
esac
echo "    OK: IcebergTable storage class, metadata, compaction and snapshot management on AWS (issue #2762)"

# The readback of every new key (issue #2762) against what AWS really answers
# (defaults included): a fresh deploy must read back as no drift.
# Exit 1 = drift, 2 = a command error, which is not a verdict.
assert_no_drift() { # usage: assert_no_drift "<phase label>"
  local out rc
  set +e
  out="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: $1: cdkd drift exited ${rc} on an untouched stack (issue #2762 readback; 1 = drift, 2 = command error):" >&2
    printf '%s\n' "${out}" >&2
    exit 1
  fi
  echo "    OK: $1: cdkd drift reports no drift"
}
assert_no_drift "Phase 1"

# Positive control for the drift-clean assertions: an out-of-band change to
# the IcebergTable's compaction (disabled in the template) must be REPORTED,
# or a clean drift proves nothing about the readback. Restored afterwards to
# the exact value AWS held (settings included), and the stack must read back
# clean again before Phase 1b.
put_compaction() { # usage: put_compaction <value json>
  aws s3tables put-table-maintenance-configuration --region "${REGION}" \
    --table-bucket-arn "${TABLE_BUCKET_ARN}" --namespace cdkd_integ_ns --name "${ICEBERG_TABLE_NAME}" \
    --type icebergCompaction --value "$1" >/dev/null
}
ORIGINAL_COMPACTION="$(aws s3tables get-table-maintenance-configuration --region "${REGION}" \
  --table-bucket-arn "${TABLE_BUCKET_ARN}" --namespace cdkd_integ_ns --name "${ICEBERG_TABLE_NAME}" --output json \
  | jq -c '.configuration.icebergCompaction')"
case "${ORIGINAL_COMPACTION}" in
  '{'*'"disabled"'*) ;;
  *) echo "FAIL: IcebergTable compaction before the positive control is '${ORIGINAL_COMPACTION}', expected a disabled configuration" >&2; exit 1 ;;
esac
put_compaction '{"status":"enabled"}'
set +e
DRIFT_OUT="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DRIFT_RC=$?
set -e
if [ "${DRIFT_RC}" -ne 1 ] || ! printf '%s' "${DRIFT_OUT}" | grep -q "Compaction"; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC} after an out-of-band compaction change, expected 1 naming Compaction (issue #2762: the readback does not see the change):" >&2
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
fi
echo "    OK: an out-of-band compaction change is reported as drift (issue #2762)"
put_compaction "${ORIGINAL_COMPACTION}"
assert_no_drift "Phase 1 after restoring compaction"

# --- Phase 1b: in-place tag update (issue #2613) ---------------------
# Only the `bucket-team` / `team` tag values change, so the redeploy reaches
# the S3 Tables provider's update() for the TableBucket and the SDK-routed
# Table, and its recorded-region guard. The physical ids pin that both were
# updated, not replaced. Each read is its own assignment so a failed `aws` /
# `jq` trips `set -e` instead of comparing as an empty string.
UPDATED_TEAM_TAG="platform-updated"
state_physical_id() { # usage: state_physical_id <logical id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "$1" '.resources[$id].physicalId // ""'
}
tag_value() { # usage: tag_value <resource arn> <tag key>
  aws s3tables list-tags-for-resource --region "${REGION}" --resource-arn "$1" --output json \
    | jq -r --arg k "$2" '.tags[$k] // "MISSING"'
}
require_value() { # usage: require_value <description> <value>
  case "$2" in
    ""|None|null) echo "FAIL: $1 is empty (got '$2')" >&2; exit 1 ;;
  esac
}
PRE_BUCKET_ID="$(state_physical_id TableBucket)"
require_value "TableBucket physicalId before Phase 1b" "${PRE_BUCKET_ID}"
PRE_TABLE_ID="$(state_physical_id Table)"
require_value "Table physicalId before Phase 1b" "${PRE_TABLE_ID}"

echo "==> Phase 1b: redeploy with changed bucket-team / team tag values"
env -u CDKD_S3T_TABLE_NAME -u CDKD_S3T_TABLE_NS CDKD_S3T_TEAM="${UPDATED_TEAM_TAG}" \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

POST_BUCKET_ID="$(state_physical_id TableBucket)"
require_value "TableBucket physicalId after Phase 1b" "${POST_BUCKET_ID}"
POST_TABLE_ID="$(state_physical_id Table)"
require_value "Table physicalId after Phase 1b" "${POST_TABLE_ID}"
if [ "${POST_BUCKET_ID}" != "${PRE_BUCKET_ID}" ] || [ "${POST_TABLE_ID}" != "${PRE_TABLE_ID}" ]; then
  echo "FAIL: Phase 1b replaced a resource (TableBucket ${PRE_BUCKET_ID} -> ${POST_BUCKET_ID}, Table ${PRE_TABLE_ID} -> ${POST_TABLE_ID}); a tag change must update in place (issue #2613)" >&2
  exit 1
fi
POST_BUCKET_TEAM="$(tag_value "${TABLE_BUCKET_ARN}" bucket-team)"
if [ "${POST_BUCKET_TEAM}" != "${UPDATED_TEAM_TAG}" ]; then
  echo "FAIL: bucket-team tag is '${POST_BUCKET_TEAM}' after Phase 1b, expected '${UPDATED_TEAM_TAG}' (issue #2613: the TableBucket update() did not apply)" >&2
  exit 1
fi
POST_TABLE_TEAM="$(tag_value "${TABLE_ARN}" team)"
if [ "${POST_TABLE_TEAM}" != "${UPDATED_TEAM_TAG}" ]; then
  echo "FAIL: team tag is '${POST_TABLE_TEAM}' after Phase 1b, expected '${UPDATED_TEAM_TAG}' (issue #2613: the Table update() did not apply)" >&2
  exit 1
fi
echo "    OK: TableBucket and Table tags updated in place (issue #2613)"
# Issue #2762: the same redeploy changes UnreferencedDays (5 -> 6) and turns
# the IcebergTable's compaction on with a 256 MB target, in place.
POST_ICEBERG_ID="$(state_physical_id IcebergTable)"
if [ "${POST_ICEBERG_ID}" != "${ICEBERG_PHYSICAL_ID}" ]; then
  echo "FAIL: Phase 1b replaced the IcebergTable (${ICEBERG_PHYSICAL_ID} -> ${POST_ICEBERG_ID}); a Compaction change must update in place (issue #2762)" >&2
  exit 1
fi
POST_UFR="$(bucket_ufr)"
if [ "${POST_UFR}" != "enabled 6 7" ]; then
  echo "FAIL: TableBucket unreferenced file removal is '${POST_UFR}' after Phase 1b, expected 'enabled 6 7' (issue #2762: the update did not reach PutTableBucketMaintenanceConfiguration)" >&2
  exit 1
fi
POST_MAINTENANCE="$(table_maintenance)"
if [ "${POST_MAINTENANCE}" != "enabled 256 enabled 2 200" ]; then
  echo "FAIL: IcebergTable maintenance is '${POST_MAINTENANCE}' after Phase 1b, expected 'enabled 256 enabled 2 200' (issue #2762: the update did not reach PutTableMaintenanceConfiguration)" >&2
  exit 1
fi
echo "    OK: UnreferencedFileRemoval and Compaction updated in place (issue #2762)"
# Phase 1b also drops MetricsConfiguration: the removal deletes the bucket's
# metrics configuration, whose Get then answers NotFound (the premise the
# readback's "NotFound = Disabled" rests on).
assert_gone "TableBucket metrics configuration still exists after Phase 1b removed MetricsConfiguration (issue #2762)" \
  aws s3tables get-table-bucket-metrics-configuration --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}"
echo "    OK: removing MetricsConfiguration deleted the bucket's metrics configuration (issue #2762)"
assert_no_drift "Phase 1b"

# --- Phase 1c: in-place rename (issue #5313) -------------------------
# Only the Table's TableName and Namespace change (the tag values stay at
# Phase 1b's), so the redeploy reaches the provider's update() with a rename
# alone. CloudFormation renames in place through RenameTable and keeps the
# TableARN; before the fix cdkd sent nothing, so AWS kept the old name while
# the state recorded the new one.
RENAMED_TABLE="cdkd_integ_tbl_renamed"
RENAMED_NS="cdkd_integ_ns2"
echo "==> Phase 1c: redeploy renaming the Table and moving it to ${RENAMED_NS}"
CDKD_S3T_TEAM="${UPDATED_TEAM_TAG}" CDKD_S3T_TABLE_NAME="${RENAMED_TABLE}" \
  CDKD_S3T_TABLE_NS="${RENAMED_NS}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

LIVE_TABLE_JSON="$(aws s3tables get-table --region "${REGION}" --table-arn "${TABLE_ARN}" --output json)"
LIVE_NAME="$(printf '%s' "${LIVE_TABLE_JSON}" | jq -r '.name // ""')"
LIVE_NS="$(printf '%s' "${LIVE_TABLE_JSON}" | jq -r '.namespace[0] // ""')"
if [ "${LIVE_NAME}" != "${RENAMED_TABLE}" ] || [ "${LIVE_NS}" != "${RENAMED_NS}" ]; then
  echo "FAIL: table ${TABLE_ARN} is '${LIVE_NS}.${LIVE_NAME}' on AWS after Phase 1c, expected '${RENAMED_NS}.${RENAMED_TABLE}' (issue #5313: the rename did not reach AWS)" >&2
  exit 1
fi
echo "    OK: table renamed on AWS to ${RENAMED_NS}.${RENAMED_TABLE} under the same TableARN"

RENAMED_TABLE_ID="$(state_physical_id Table)"
EXPECTED_RENAMED_ID="${TABLE_BUCKET_ARN}|${RENAMED_NS}|${RENAMED_TABLE}"
if [ "${RENAMED_TABLE_ID}" != "${EXPECTED_RENAMED_ID}" ]; then
  echo "FAIL: Table physicalId is '${RENAMED_TABLE_ID}' after Phase 1c, expected '${EXPECTED_RENAMED_ID}' (issue #5313)" >&2
  exit 1
fi
RENAMED_TABLE_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.outputs.TableArn // ""')"
if [ "${RENAMED_TABLE_ARN}" != "${TABLE_ARN}" ]; then
  echo "FAIL: TableArn output is '${RENAMED_TABLE_ARN}' after Phase 1c, expected the unchanged '${TABLE_ARN}' (a rename is in place, not a replacement)" >&2
  exit 1
fi
RENAMED_TEAM="$(tag_value "${TABLE_ARN}" team)"
if [ "${RENAMED_TEAM}" != "${UPDATED_TEAM_TAG}" ]; then
  echo "FAIL: team tag is '${RENAMED_TEAM}' after Phase 1c, expected '${UPDATED_TEAM_TAG}'" >&2
  exit 1
fi
assert_gone "a table still answers to the old name cdkd_integ_ns.cdkd_integ_tbl after Phase 1c" \
  aws s3tables get-table --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" \
  --namespace cdkd_integ_ns --name cdkd_integ_tbl
echo "    OK: state records ${EXPECTED_RENAMED_ID}; TableArn and tags unchanged; old name gone (issue #5313)"

# The Table's `Ref` is its TableARN, which the rename keeps (issue #5316), so
# the Ref output and its reader still hold the ARN.
RENAMED_TABLE_REF="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.outputs.TableRef // ""')"
if [ "${RENAMED_TABLE_REF}" != "${TABLE_ARN}" ]; then
  echo "FAIL: TableRef output is '${RENAMED_TABLE_REF}' after Phase 1c, expected the unchanged TableARN '${TABLE_ARN}' (issue #5316)" >&2
  exit 1
fi
TABLE_REF_PARAM="$(aws ssm get-parameter --region "${REGION}" --name "/${STACK}/table-ref" --query 'Parameter.Value' --output text)"
if [ "${TABLE_REF_PARAM}" != "${TABLE_ARN}" ]; then
  echo "FAIL: SSM parameter /${STACK}/table-ref is '${TABLE_REF_PARAM}' after Phase 1c, expected the unchanged TableARN '${TABLE_ARN}' (issue #5316)" >&2
  exit 1
fi
echo "    OK: the Table's Ref and its reader keep the TableARN across the rename"

# --- Phase 1d: a reader recorded by an older cdkd converges (issue #5316) --
# Before #5316 cdkd resolved the Table's `Ref` to the table name, so a stack
# deployed then recorded that name in the reader's state and on AWS. Seed both
# readers (the SDK-routed table's and the Cloud Control one's, issue #974's
# value) with their table's name, redeploy the unchanged Phase 1c template,
# and assert the diff sees each reader's resolved Ref (the ARN) differ from
# its record and rewrites it on AWS.
SEED_STATE="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq --arg v "${RENAMED_TABLE}" --arg cc "${ICEBERG_TABLE_NAME}" '
      def seed($id; $val):
        if .resources[$id].properties.Value == null then error("\($id).properties.Value missing") else . end
        | .resources[$id].properties.Value = $val
        | if .resources[$id].observedProperties.Value != null
          then .resources[$id].observedProperties.Value = $val else . end;
      seed("TableRefParam"; $v) | seed("IcebergTableRefParam"; $cc)
      | if .resources.Table.attributes.TableARN == null then error("Table.attributes.TableARN missing") else . end
      | del(.resources.Table.attributes.TableARN)' > "${SEED_STATE}"
SEEDED_VALUE="$(jq -r '.resources.TableRefParam.properties.Value + "," + .resources.IcebergTableRefParam.properties.Value' "${SEED_STATE}")"
SEEDED_TABLE_ARN="$(jq -r '.resources.Table.attributes.TableARN // "absent"' "${SEED_STATE}")"
if [ "${SEEDED_VALUE}" != "${RENAMED_TABLE},${ICEBERG_TABLE_NAME}" ] || [ "${SEEDED_TABLE_ARN}" != "absent" ]; then
  echo "FAIL: could not seed the reader records with '${RENAMED_TABLE},${ICEBERG_TABLE_NAME}' and drop Table's TableARN (got '${SEEDED_VALUE}', TableARN '${SEEDED_TABLE_ARN}')" >&2
  rm -f "${SEED_STATE}"
  exit 1
fi
aws s3 cp "${SEED_STATE}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
rm -f "${SEED_STATE}"
aws ssm put-parameter --region "${REGION}" --name "/${STACK}/table-ref" --type String \
  --value "${RENAMED_TABLE}" --overwrite >/dev/null
aws ssm put-parameter --region "${REGION}" --name "${REF_PARAM_NAME}" --type String \
  --value "${ICEBERG_TABLE_NAME}" --overwrite >/dev/null

echo "==> Phase 1d: redeploy over a reader recorded with the table name"
CDKD_S3T_TEAM="${UPDATED_TEAM_TAG}" CDKD_S3T_TABLE_NAME="${RENAMED_TABLE}" \
  CDKD_S3T_TABLE_NS="${RENAMED_NS}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

CONVERGED_PARAM="$(aws ssm get-parameter --region "${REGION}" --name "/${STACK}/table-ref" --query 'Parameter.Value' --output text)"
if [ "${CONVERGED_PARAM}" != "${TABLE_ARN}" ]; then
  echo "FAIL: SSM parameter /${STACK}/table-ref is '${CONVERGED_PARAM}' after Phase 1d, expected the TableARN '${TABLE_ARN}' (issue #5316: a reader recorded with the table name was not rewritten)" >&2
  exit 1
fi
CONVERGED_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
CONVERGED_RECORD="$(printf '%s' "${CONVERGED_STATE}" | jq -r '.resources.TableRefParam.properties.Value // ""')"
if [ "${CONVERGED_RECORD}" != "${TABLE_ARN}" ]; then
  echo "FAIL: TableRefParam records Value '${CONVERGED_RECORD}' after Phase 1d, expected the TableARN '${TABLE_ARN}' (issue #5316)" >&2
  exit 1
fi
# The seed dropped Table's TableARN, the shape a table created before cdkd
# recorded it has (go-to-k/cdkd#739). The deploy's heal re-read the table from
# AWS and recorded the ARN again. Either the Ref reader (read as Fn::GetAtt
# TableARN) or the TableArn output can trigger that heal; the Ref arm itself is
# pinned by the reader assertions above, which would hold the composite id
# without it.
HEALED_TABLE_ARN="$(printf '%s' "${CONVERGED_STATE}" | jq -r '.resources.Table.attributes.TableARN // ""')"
if [ "${HEALED_TABLE_ARN}" != "${TABLE_ARN}" ]; then
  echo "FAIL: Table records TableARN '${HEALED_TABLE_ARN}' after Phase 1d, expected the healed '${TABLE_ARN}' (issue #5316: a record with no TableARN was not re-read from AWS)" >&2
  exit 1
fi
CONVERGED_CC_PARAM="$(aws ssm get-parameter --region "${REGION}" --name "${REF_PARAM_NAME}" --query 'Parameter.Value' --output text)"
if [ "${CONVERGED_CC_PARAM}" != "${EXPECTED_ICEBERG_ARN}" ]; then
  echo "FAIL: SSM parameter ${REF_PARAM_NAME} is '${CONVERGED_CC_PARAM}' after Phase 1d, expected the TableARN '${EXPECTED_ICEBERG_ARN}' (issue #5316: the IcebergTable's reader recorded with the name was not rewritten)" >&2
  exit 1
fi
echo "    OK: readers recorded with the table name are rewritten to the TableARN for both tables (issue #5316)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Sanity: the TableBucket cascade (Tables → Namespaces → Bucket) should
# leave nothing behind. The bucket is the most visible orphan to spot-check.
if [ -n "${TABLE_BUCKET_ARN}" ]; then
  assert_gone "TableBucket ${TABLE_BUCKET_ARN} still exists after destroy" aws s3tables get-table-bucket --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}"
  echo "    OK: TableBucket cascade complete"
fi

echo ""
echo "=== PASS: S3Tables::Table #609 Tags backfill integ ==="
