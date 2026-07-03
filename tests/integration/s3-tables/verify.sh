#!/usr/bin/env bash
# verify.sh — cdkd S3Tables integ test.
#
# Two concerns in one fixture:
#   1. (issue #609) An AWS::S3Tables::Table / ::TableBucket with template-set
#      Tags has those tags reach AWS after `cdkd deploy` — `Tags` was a
#      silent-drop before #609. Resolves the ARNs from cdkd state outputs,
#      calls `s3tables ListTagsForResource`, asserts the tags are present.
#   2. (issue #974) A CC-routed AWS::S3Tables::Table (IcebergMetadata set →
#      silent-drop → Cloud Control) stores the bare TableARN as its physical
#      id, but CFn `Ref` for a Table returns the table NAME. Asserts the Ref
#      resolves to the table name (via a CfnOutput AND a consuming SSM
#      parameter round-trip), not the bare ARN.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

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
      --state-bucket "${STATE_BUCKET}" \
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
  set -eu
}

trap cleanup EXIT

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
node "${LOCAL_DIST}" deploy "${STACK}" \
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
PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::S3Tables::Table") | .value.provisionedBy] | first // "sdk"')
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::S3Tables::Table routed via '${PROVISIONED_BY}', expected 'sdk' (silent-drop routing flip — backfill is on the wrong path)" >&2
  exit 1
fi
echo "    OK: AWS::S3Tables::Table routed via SDK provider (provisionedBy=sdk)"

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
BUCKET_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::S3Tables::TableBucket") | .value.provisionedBy] | first // "sdk"')
if [ "${BUCKET_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::S3Tables::TableBucket routed via '${BUCKET_PROVISIONED_BY}', expected 'sdk' (silent-drop routing flip)" >&2
  exit 1
fi
echo "    OK: AWS::S3Tables::TableBucket routed via SDK provider (provisionedBy=sdk)"

# --- Assertion: CC-routed Table `Ref` resolves to the table NAME (#974)
# The IcebergTable carries IcebergMetadata, which is a silent-drop on the
# SDK provider, so cdkd routes it through Cloud Control. CC's Table
# primaryIdentifier is the bare single-segment TableARN (pipe-free, ends in
# a UUID), and CFn `Ref` for a Table returns the table NAME — so before the
# #974 fix the Ref leaked the ARN. Assert (1) the table DID route via CC,
# and (2) both the CfnOutput Ref and the consuming SSM parameter's value
# equal the table name, not the ARN.
EXPECTED_TABLE_NAME="cdkd_integ_cc_tbl"

ICEBERG_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::S3Tables::Table" and (.value.properties.IcebergMetadata != null)) | .value.provisionedBy] | first // "sdk"')
if [ "${ICEBERG_PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: IcebergMetadata Table routed via '${ICEBERG_PROVISIONED_BY}', expected 'cc-api' (the #974 fixture must exercise the CC path — silent-drop routing changed?)" >&2
  echo "${STATE}" | jq '.resources | to_entries[] | select(.value.resourceType == "AWS::S3Tables::Table") | {physicalId: .value.physicalId, provisionedBy: .value.provisionedBy, hasIceberg: (.value.properties.IcebergMetadata != null)}'
  exit 1
fi
echo "    OK: IcebergMetadata Table routed via Cloud Control (provisionedBy=cc-api)"

# (a) The CfnOutput Ref value.
ICEBERG_REF=$(echo "${STATE}" | jq -r '.outputs.IcebergTableRef // ""')
if [ "${ICEBERG_REF}" != "${EXPECTED_TABLE_NAME}" ]; then
  echo "FAIL: Ref(IcebergTable) output is '${ICEBERG_REF}', expected the table name '${EXPECTED_TABLE_NAME}' (issue #974 — Ref leaked the ARN instead of the name)" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: Ref(IcebergTable) output == table name '${EXPECTED_TABLE_NAME}' (issue #974 fix)"

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
if [ "${SSM_VALUE}" != "${EXPECTED_TABLE_NAME}" ]; then
  echo "FAIL: SSM parameter '${REF_PARAM_NAME}' value is '${SSM_VALUE}', expected the table name '${EXPECTED_TABLE_NAME}' (Ref(IcebergTable) leaked the ARN into a consuming resource)" >&2
  exit 1
fi
echo "    OK: consuming SSM parameter value == table name '${EXPECTED_TABLE_NAME}' (Ref reached AWS correctly)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# Sanity: the TableBucket cascade (Tables → Namespaces → Bucket) should
# leave nothing behind. The bucket is the most visible orphan to spot-check.
if [ -n "${TABLE_BUCKET_ARN}" ]; then
  if aws s3tables get-table-bucket --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}" >/dev/null 2>&1; then
    echo "FAIL: TableBucket ${TABLE_BUCKET_ARN} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: TableBucket cascade complete"
fi

echo ""
echo "=== PASS: S3Tables::Table #609 Tags backfill integ ==="
