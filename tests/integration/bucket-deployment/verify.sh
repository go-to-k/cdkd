#!/usr/bin/env bash
# verify.sh — cdkd BucketDeployment (Custom::CDKBucketDeployment) functional integ.
#
# BucketDeployment synthesizes a heavy Custom::CDKBucketDeployment custom
# resource (Provider-framework Lambda + AwsCliLayer) that downloads the zipped
# asset and syncs it into the destination bucket. No existing fixture covers it.
# This test asserts the file actually landed in the bucket (not just that deploy
# succeeded), exercising asset publishing + a heavy CR on deploy AND destroy.
#
# Phases:
#   1. Deploy. Resolve the destination bucket from the stack output, then assert
#      the deployed object (index.html) is present AND has the expected content.
#   2. Destroy + assert the bucket and the cdkd state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdBucketDeploymentExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER="cdkd bucket-deployment integ marker v1"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after Phase 1 from the stack output.
SITE_BUCKET=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${SITE_BUCKET}" ]; then
    aws s3 rb "s3://${SITE_BUCKET}" --force >/dev/null 2>&1 || true
  fi
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# --- Phase 1: deploy + assert the asset synced ------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SITE_BUCKET="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
  | jq -r '.outputs.SiteBucketName')"
if [ -z "${SITE_BUCKET}" ] || [ "${SITE_BUCKET}" = "null" ]; then
  echo "FAIL: could not resolve SiteBucketName output after deploy" >&2
  exit 1
fi
echo "    destination bucket: ${SITE_BUCKET}"

BODY="$(aws s3 cp "s3://${SITE_BUCKET}/index.html" - --region "${REGION}" 2>/dev/null || echo "")"
if ! echo "${BODY}" | grep -qF "${MARKER}"; then
  echo "FAIL: deployed index.html missing or wrong content; got: ${BODY}" >&2
  exit 1
fi
echo "    OK: index.html synced into the bucket with the expected content"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws s3api head-bucket --bucket "${SITE_BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: bucket ${SITE_BUCKET} still exists after destroy" >&2
  exit 1
fi
echo "    OK: bucket is gone"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

# Lambda auto-creates /aws/lambda/* log groups on invoke; sweep so orphan-zero.
sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — BucketDeployment synced the asset + clean destroy, all phases passed"
