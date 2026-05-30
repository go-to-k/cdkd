#!/usr/bin/env bash
# verify.sh — cdkd S3Tables::Table Tags backfill integ test (issue #609).
#
# Asserts that an AWS::S3Tables::Table with template-set Tags has those
# tags reach AWS after `cdkd deploy` — `Tags` was a silent-drop on
# DBInstance::S3Tables::Table before this PR. Resolves the table ARN
# from cdkd state's TableArn output, calls `s3tables ListTagsForResource`,
# asserts both tags are present.
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

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

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
