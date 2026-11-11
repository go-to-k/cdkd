#!/usr/bin/env bash
# verify.sh — cdkd S3 BucketPolicy create onto a bucket that already holds a
# policy (go-to-k/cdkd#6109).
#
# PutBucketPolicy replaces the bucket's WHOLE policy. Before the fix, cdkd's
# BucketPolicy create sent it blindly, so a policy another owner attached (in
# the wild: the grant a log-delivery service auto-attaches for a WAF / VPC
# Flow Logs destination) was silently dropped, where CloudFormation refuses
# the create with "The bucket policy already exists on bucket <name>".
#
# Phase 1: deploy the bucket alone; assert it holds no policy.
# Phase 2: attach the "other owner's" policy out of band, then deploy the
#          template's BucketPolicy. The deploy must FAIL with the refusal, and
#          the other owner's policy must survive the failed deploy (and its
#          rollback) untouched.
# Phase 3: remove that policy and re-deploy: the create now succeeds and the
#          bucket holds the template's statement (negative control: the guard
#          does not refuse an ordinary create).
# Phase 4: destroy; assert the bucket and state are gone.

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

STACK="CdkdS3BucketPolicyExistingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-integ-bp-existing-${ACCOUNT}-${REGION}"
FOREIGN_SID="CdkdIntegForeignOwner"
TEMPLATE_SID="CdkdIntegTemplateStatement"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws s3api delete-bucket-policy --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# The bucket's policy document, or the empty string when it holds none.
# Any other read failure fails the run.
bucket_policy() {
  local out
  if out="$(aws s3api get-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --query Policy --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if grep -q 'NoSuchBucketPolicy' <<<"${out}"; then
    return 0
  fi
  echo "FAIL: get-bucket-policy on ${BUCKET} failed: ${out}" >&2
  return 1
}

echo "==> Phase 1: deploy the bucket alone"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P1="$(bucket_policy)" || exit 1
if [ -n "${P1}" ]; then
  echo "FAIL: bucket ${BUCKET} already holds a policy after phase 1: ${P1}" >&2
  exit 1
fi
echo "    OK: bucket holds no policy"

echo "==> Phase 2: attach another owner's policy out of band, then deploy the template's BucketPolicy"
FOREIGN_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"${FOREIGN_SID}\",\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${ACCOUNT}:root\"},\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"}]}"
aws s3api put-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --policy "${FOREIGN_POLICY}"
P2A="$(bucket_policy)" || exit 1
grep -q "${FOREIGN_SID}" <<<"${P2A}" || { echo "FAIL: the out-of-band policy did not attach: ${P2A}" >&2; exit 1; }

if OUT="$(CDKD_TEST_UPDATE=policy node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"; then
  RC=0
else
  RC=$?
fi
printf '%s\n' "${OUT}" | tail -40
if [ "${RC}" -eq 0 ]; then
  echo "FAIL: the deploy succeeded over the existing bucket policy (go-to-k/cdkd#6109: the create overwrote it)" >&2
  exit 1
fi
MARKER="The bucket policy already exists on bucket ${BUCKET}"
# Sentinel: a second phrase of the same refusal, so a reworded refusal fails
# loudly instead of reading as "some other failure".
SENTINEL="cdkd does not overwrite it"
if ! grep -qF "${MARKER}" <<<"${OUT}"; then
  if grep -qF "${SENTINEL}" <<<"${OUT}"; then
    echo "FAIL: the refusal's wording drifted (sentinel present, marker '${MARKER}' absent)" >&2
  else
    echo "FAIL: the deploy failed (rc=${RC}) but not with the existing-policy refusal" >&2
  fi
  exit 1
fi
echo "    OK: the deploy refused with '${MARKER}' (rc=${RC})"
P2B="$(bucket_policy)" || exit 1
grep -q "${FOREIGN_SID}" <<<"${P2B}" || { echo "FAIL: the other owner's policy is gone after the refused deploy: ${P2B:-<no policy>}" >&2; exit 1; }
if grep -q "${TEMPLATE_SID}" <<<"${P2B}"; then
  echo "FAIL: the template's statement reached the bucket despite the refusal: ${P2B}" >&2
  exit 1
fi
echo "    OK: the other owner's policy survived the refused deploy untouched"

echo "==> Phase 3: remove the other owner's policy and re-deploy"
aws s3api delete-bucket-policy --bucket "${BUCKET}" --region "${REGION}"
CDKD_TEST_UPDATE=policy node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3="$(bucket_policy)" || exit 1
grep -q "${TEMPLATE_SID}" <<<"${P3}" || { echo "FAIL: the template's BucketPolicy is not on the bucket after phase 3: ${P3:-<no policy>}" >&2; exit 1; }
echo "    OK: the BucketPolicy create succeeded on a bucket with no policy"

echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=policy node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
echo "    OK: bucket gone"
assert_gone "state ${STATE_KEY} remains after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"

trap - EXIT INT TERM
echo ""
echo "[verify] PASS — s3-bucket-policy-existing: a BucketPolicy create refuses an existing policy and leaves it intact"
