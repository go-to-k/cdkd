#!/bin/bash
# cdkd integration test: infra-security (VPC, KMS, S3, SSM, IAM, CloudTrail).
#
# The standard deploy -> destroy cycle, plus one step the stack itself makes
# necessary. Its AuditTrail delivers log objects into SecureBucket within
# minutes of the deploy, and SecureBucket keeps `autoDeleteObjects: false`, so a
# destroy that deletes the trail then meets a NON-EMPTY bucket and refuses it,
# as CloudFormation does. That refusal is correct and is not what this fixture
# tests (README: "Destroy removes all resources cleanly"), so the trail is
# stopped and the bucket emptied just before the destroy, and again in the
# EXIT-trap cleanup.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="InfraSecurityStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The generated bucket name and trail ARN, read from the stack's recorded
# outputs once the deploy has written them. Empty until then.
BUCKET_NAME=""
TRAIL_ARN=""

read_outputs() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --quiet 2>/dev/null)" || return 1
  BUCKET_NAME="$(jq -r '.outputs.BucketName // empty' <<<"${state}")"
  TRAIL_ARN="$(jq -r '.outputs.TrailArn // empty' <<<"${state}")"
}

# Stop the trail's delivery, then delete every object in SecureBucket. The
# bucket is unversioned (the stack sets no `versioned`), so an `s3 rm` leaves no
# noncurrent version behind; if it ever turns versioning on, the destroy's
# non-empty refusal will say so. An already empty bucket, a missing bucket and a
# missing trail all pass.
quiesce_trail_bucket() {
  if [ -n "${TRAIL_ARN}" ]; then
    aws cloudtrail stop-logging --name "${TRAIL_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${BUCKET_NAME}" ]; then
    aws s3 rm "s3://${BUCKET_NAME}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  echo "==> Cleanup: stopping the trail, emptying SecureBucket, destroying any leftover stack"
  # `set +eu`: best-effort, run as much as the env allows.
  set +eu
  if [ -n "${STATE_BUCKET:-}" ] && [ -x "${LOCAL_DIST}" ]; then
    if [ -z "${BUCKET_NAME}" ]; then read_outputs; fi
    quiesce_trail_bucket
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    # lock.json points at nothing; a stranded one wedges the next deploy.
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose

if ! read_outputs || [ -z "${BUCKET_NAME}" ] || [ -z "${TRAIL_ARN}" ]; then
  echo "FAIL: could not read BucketName / TrailArn from ${STATE_KEY} (bucket='${BUCKET_NAME}' trail='${TRAIL_ARN}')" >&2
  exit 1
fi
echo "    bucket: ${BUCKET_NAME}"
echo "    trail:  ${TRAIL_ARN}"

echo "==> Phase 2: stop the trail and empty SecureBucket"
quiesce_trail_bucket

echo "==> Phase 3: destroy"
# CloudTrail can still deliver a buffered log object shortly after
# `stop-logging`, refilling the bucket before the destroy reaches it. Only that
# case earns one retry: empty again, destroy again, and that one must succeed.
if ! node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force; then
  echo "    destroy failed once; emptying SecureBucket again for a late trail delivery and retrying"
  quiesce_trail_bucket
  node "${LOCAL_DIST}" destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --force
fi

echo "PASS: infra-security deploy -> destroy"
