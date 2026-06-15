#!/usr/bin/env bash
# verify.sh — cdkd CloudFront::Distribution Tags backfill integ test
# (issue #609).
#
# Asserts that the two CDK `Tags.of(distribution).add(...)` calls in
# `lib/s3-cloudfront-stack.ts` reach AWS — the `Tags` top-level CFn
# property was a silent-drop on `AWS::CloudFront::Distribution` until
# this PR wired `CreateDistributionWithTagsCommand` + per-update
# `TagResource` / `UntagResource` diffing into the dedicated SDK
# Provider. Without the fix, every CDK-deployed CloudFront distro
# silently lost its tags on the way through cdkd.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="S3CloudFrontStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Belt-and-suspenders sweep of the deterministically-named standalone OAC
  # (`${STACK}-oac`). An interrupted prior run can leave it orphaned, and a
  # CREATE on the next run then hard-fails with "...already exists" before the
  # rest of the stack deploys. `state destroy` handles it when it is in state;
  # this name-based sweep covers the interrupted-mid-create case.
  local oac_id
  oac_id=$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='${STACK}-oac'].Id | [0]" \
    --output text 2>/dev/null)
  if [ -n "${oac_id}" ] && [ "${oac_id}" != "None" ]; then
    local oac_etag
    oac_etag=$(aws cloudfront get-origin-access-control --id "${oac_id}" \
      --query ETag --output text 2>/dev/null)
    if [ -n "${oac_etag}" ] && [ "${oac_etag}" != "None" ]; then
      aws cloudfront delete-origin-access-control --id "${oac_id}" \
        --if-match "${oac_etag}" >/dev/null 2>&1 || true
    fi
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

DIST_ID=$(echo "${STATE}" | jq -r '.outputs.DistributionId // empty')
if [ -z "${DIST_ID}" ]; then
  echo "FAIL: cdkd state did not emit a DistributionId output" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: deployed distribution id = ${DIST_ID}"

DIST_ARN=$(aws cloudfront get-distribution --id "${DIST_ID}" --region "${REGION}" \
  --query 'Distribution.ARN' --output text)
if [ -z "${DIST_ARN}" ] || [ "${DIST_ARN}" = "None" ]; then
  echo "FAIL: GetDistribution returned no ARN for ${DIST_ID}" >&2
  exit 1
fi

# --- Assertion: AWS reflects the two CDK Tags -------------------------
TAGS_JSON=$(aws cloudfront list-tags-for-resource --resource "${DIST_ARN}" --region "${REGION}" \
  --query 'Tags.Items' --output json)

OWNER=$(echo "${TAGS_JSON}" | jq -r '.[] | select(.Key == "cdkd-test-owner") | .Value // empty')
ENV_TAG=$(echo "${TAGS_JSON}" | jq -r '.[] | select(.Key == "cdkd-test-env") | .Value // empty')

if [ "${OWNER}" != "integ" ]; then
  echo "FAIL: tag 'cdkd-test-owner' missing or wrong value (got: '${OWNER}', expected 'integ')" >&2
  echo "${TAGS_JSON}" | jq .
  exit 1
fi
echo "    OK: tag cdkd-test-owner=integ present on distribution"

if [ "${ENV_TAG}" != "integ-env" ]; then
  echo "FAIL: tag 'cdkd-test-env' missing or wrong value (got: '${ENV_TAG}', expected 'integ-env')" >&2
  echo "${TAGS_JSON}" | jq .
  exit 1
fi
echo "    OK: tag cdkd-test-env=integ-env present on distribution"
echo "    OK: CloudFront::Distribution Tags silent-drop CLOSED by #609"

# --- Assertion: cdkd drift is clean on the freshly-deployed DISTRIBUTION ---
# Exercises CloudFrontDistributionProvider.readCurrentState +
# getDriftUnknownPaths (this PR). Before this PR the type fell back to the
# CC-API GetResource path, whose deeply-nested DistributionConfig shape
# (AWS-injected Quantity wrappers / defaults) diverged from cdkd state and
# surfaced phantom drift. The new readCurrentState inverts convertToSdkFormat
# so a no-change distribution reports NO drift.
#
# The assertion is SCOPED to the AWS::CloudFront::Distribution resource (via
# --json + jq) rather than whole-stack-clean, because the fixture's S3
# BucketPolicy granting the OAI carries a SEPARATE, pre-existing latent
# false-positive: cdkd stores the OAI principal as the S3 canonical user id at
# deploy time but GetBucketPolicy returns it as
# `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity <id>`, so the
# two equivalent principal forms compare unequal. That is an S3 BucketPolicy
# provider gap unrelated to this PR (tracked separately); asserting only the
# distribution keeps this PR's drift test honest about what it actually fixes.
echo "==> Asserting cdkd drift reports NO false-positive on the fresh DISTRIBUTION"
set +e
DRIFT_JSON=$(node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --json 2>/dev/null)
set -e
# The distribution must be in the `clean` bucket and NOT in `drifted`.
DIST_CLEAN=$(echo "${DRIFT_JSON}" | jq '[.[].clean[] | select(.type == "AWS::CloudFront::Distribution")] | length')
DIST_DRIFTED=$(echo "${DRIFT_JSON}" | jq '[.[].drifted[] | select(.type == "AWS::CloudFront::Distribution")] | length')
if [ "${DIST_CLEAN}" != "1" ] || [ "${DIST_DRIFTED}" != "0" ]; then
  echo "FAIL: CloudFront::Distribution drift not clean on a fresh deploy (clean=${DIST_CLEAN}, drifted=${DIST_DRIFTED})" >&2
  echo "${DRIFT_JSON}" | jq '.[].drifted[] | select(.type == "AWS::CloudFront::Distribution")' >&2
  exit 1
fi
echo "    OK: CloudFront::Distribution reports clean on a fresh deploy — no phantom drift"

# --- Assertion: cdkd drift DETECTS an out-of-band console-style change ---
# Mutate the distribution Comment via update-distribution (the console path)
# and assert cdkd drift now exits 1 and names the changed key.
echo "==> Mutating distribution Comment out-of-band, then asserting drift detects it"
ETAG=$(aws cloudfront get-distribution-config --id "${DIST_ID}" --region "${REGION}" \
  --query 'ETag' --output text)
CONF=$(aws cloudfront get-distribution-config --id "${DIST_ID}" --region "${REGION}" \
  --query 'DistributionConfig' --output json)
DRIFTED_CONF=$(echo "${CONF}" | jq '.Comment = "drifted-out-of-band"')
echo "${DRIFTED_CONF}" > /tmp/cdkd-cf-drift-conf.json
aws cloudfront update-distribution --id "${DIST_ID}" --region "${REGION}" \
  --if-match "${ETAG}" \
  --distribution-config "file:///tmp/cdkd-cf-drift-conf.json" >/dev/null

set +e
DRIFT_JSON=$(node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --json 2>/dev/null)
set -e
# Scope the assertion to the distribution: it must now be in `drifted` with a
# Comment change. (The exit code is 1 once ANYTHING drifts, so we assert on the
# per-resource JSON instead of the exit code to stay distribution-scoped.)
DIST_COMMENT_DRIFT=$(echo "${DRIFT_JSON}" | jq '[.[].drifted[] | select(.type == "AWS::CloudFront::Distribution") | .changes[] | select(.path | test("Comment"))] | length')
if [ "${DIST_COMMENT_DRIFT}" -lt 1 ]; then
  echo "FAIL: cdkd drift did not detect the out-of-band Comment change on the distribution" >&2
  echo "${DRIFT_JSON}" | jq '.[].drifted[] | select(.type == "AWS::CloudFront::Distribution")' >&2
  exit 1
fi
echo "    OK: cdkd drift detected the out-of-band Comment change on the distribution"

# Revert the out-of-band change so the disable+delete in Phase 2 starts from
# the cdkd-managed config (avoids an extra propagation cycle on a drifted config).
echo "==> Reverting the out-of-band change"
ETAG=$(aws cloudfront get-distribution-config --id "${DIST_ID}" --region "${REGION}" \
  --query 'ETag' --output text)
echo "${CONF}" > /tmp/cdkd-cf-drift-conf.json
aws cloudfront update-distribution --id "${DIST_ID}" --region "${REGION}" \
  --if-match "${ETAG}" \
  --distribution-config "file:///tmp/cdkd-cf-drift-conf.json" >/dev/null
rm -f /tmp/cdkd-cf-drift-conf.json
echo "    OK: reverted; CloudFront::Distribution drift blind spot CLOSED"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# CloudFront destroy is slow — disable + propagation + delete. Wait up
# to ~20 minutes for the GetDistribution call to start returning NoSuch.
DIST_GONE=""
for _ in $(seq 1 80); do
  if ! aws cloudfront get-distribution --id "${DIST_ID}" --region "${REGION}" >/dev/null 2>&1; then
    DIST_GONE=1
    break
  fi
  sleep 15
done
if [ -z "${DIST_GONE}" ]; then
  echo "FAIL: CloudFront distribution ${DIST_ID} still exists ~20min after destroy" >&2
  exit 1
fi
echo "    OK: CloudFront distribution is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> s3-cloudfront test passed (Tags backfill closed + clean destroy)"
