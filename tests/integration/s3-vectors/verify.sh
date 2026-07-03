#!/usr/bin/env bash
# verify.sh - cdkd S3Vectors::VectorBucket Tags backfill assertion (#609).
#
# Deploys the s3-vectors fixture (now with Tags on the L1 CfnVectorBucket)
# and asserts that the user tags reach AWS via the CreateVectorBucket
# wire path. ListTagsForResource is the read-back call; the assertion
# matches what cdkd's readCurrentState surfaces.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="S3VectorsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" = "0" ]; then
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
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
BUCKET_NAME=$(echo "${STATE}" | jq -r '.outputs.VectorBucketName // empty')
if [ -z "${BUCKET_NAME}" ]; then
  echo "FAIL: state.outputs.VectorBucketName missing after deploy" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi

# Resolve the bucket ARN — ListTagsForResource is keyed by ARN, not name.
BUCKET_ARN=$(aws s3vectors get-vector-bucket \
  --vector-bucket-name "${BUCKET_NAME}" --region "${REGION}" \
  --query 'vectorBucket.vectorBucketArn' --output text 2>/dev/null)
if [ -z "${BUCKET_ARN}" ] || [ "${BUCKET_ARN}" = "None" ]; then
  echo "FAIL: GetVectorBucket(${BUCKET_NAME}) returned no ARN" >&2
  exit 1
fi

# --- Assertion: Tags reached AWS via CreateVectorBucket.tags ---------
TAGS_JSON=$(aws s3vectors list-tags-for-resource \
  --resource-arn "${BUCKET_ARN}" --region "${REGION}" \
  --query 'tags' --output json 2>/dev/null)
ENV_TAG=$(echo "${TAGS_JSON}" | jq -r '.env // empty')
TEAM_TAG=$(echo "${TAGS_JSON}" | jq -r '.team // empty')

if [ "${ENV_TAG}" != "cdkd-integ" ]; then
  echo "FAIL: tag 'env' is '${ENV_TAG}', expected 'cdkd-integ' (silent-drop NOT closed)" >&2
  echo "      raw tags: ${TAGS_JSON}" >&2
  exit 1
fi
if [ "${TEAM_TAG}" != "platform" ]; then
  echo "FAIL: tag 'team' is '${TEAM_TAG}', expected 'platform' (silent-drop NOT closed)" >&2
  echo "      raw tags: ${TAGS_JSON}" >&2
  exit 1
fi
echo "    OK: VectorBucket tags { env=cdkd-integ, team=platform } reached AWS (Tags backfill CLOSED)"

# --- Phase 1.5: in-place Tags UPDATE ---------------------------------
# Re-deploy with CDKD_TEST_UPDATE=true so the fixture changes the tag set
# (env value changed, owner added, team removed). This exercises the
# VectorBucket update() path — TagResource + UntagResource — which was a
# silent no-op before the fix. Assert the AWS-side tags reflect the change.
echo "==> Phase 1.5: in-place Tags update (CDKD_TEST_UPDATE=true)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

UPD_TAGS_JSON=$(aws s3vectors list-tags-for-resource \
  --resource-arn "${BUCKET_ARN}" --region "${REGION}" \
  --query 'tags' --output json 2>/dev/null)
UPD_ENV=$(echo "${UPD_TAGS_JSON}" | jq -r '.env // empty')
UPD_OWNER=$(echo "${UPD_TAGS_JSON}" | jq -r '.owner // empty')
UPD_TEAM=$(echo "${UPD_TAGS_JSON}" | jq -r 'if has("team") then .team else "ABSENT" end')

if [ "${UPD_ENV}" != "cdkd-integ-updated" ]; then
  echo "FAIL: after update, tag 'env' is '${UPD_ENV}', expected 'cdkd-integ-updated' (TagResource not applied)" >&2
  echo "      raw tags: ${UPD_TAGS_JSON}" >&2
  exit 1
fi
if [ "${UPD_OWNER}" != "cdkd" ]; then
  echo "FAIL: after update, tag 'owner' is '${UPD_OWNER}', expected 'cdkd' (TagResource not applied)" >&2
  echo "      raw tags: ${UPD_TAGS_JSON}" >&2
  exit 1
fi
if [ "${UPD_TEAM}" != "ABSENT" ]; then
  echo "FAIL: after update, tag 'team' is '${UPD_TEAM}', expected ABSENT (UntagResource not applied)" >&2
  echo "      raw tags: ${UPD_TAGS_JSON}" >&2
  exit 1
fi
echo "    OK: tags updated on AWS { env=cdkd-integ-updated, owner=cdkd, team removed } (update() path works)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3vectors get-vector-bucket --vector-bucket-name "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: VectorBucket '${BUCKET_NAME}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: VectorBucket is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> s3-vectors test passed (Tags backfill closed + clean destroy)"
