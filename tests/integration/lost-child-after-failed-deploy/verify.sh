#!/usr/bin/env bash
# verify.sh — a bucket policy lost with a FAILED same-id recreate of its
# bucket is restored by the next deploy (issue #4443).
#
# Phases: deploy on the SDK route -> the bucket's policy denies plain HTTP ->
# THE FAILURE: recreate the fixed-name bucket on Cloud Control while the
# sibling the policy waits on is refused by SSM, so the deploy fails after the
# bucket and before the policy -> premise: the bucket really was re-created
# without a policy -> the policy's state record is gone -> THE ARM: a plain
# redeploy creates the policy again -> destroy + gone-probes.
#
# Before the fix the policy's record survived the failure, the redeploy diffed
# it unchanged, and the bucket stayed open to plain HTTP while state recorded
# the deny.

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

STACK="CdkdLostChildAfterFailedDeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SIBLING_NAME="${STACK}-sibling"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
BUCKET_LOGICAL_ID=""
BUCKET=""

state_json() {
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}"
}

# The number of Deny statements on aws:SecureTransport=false in the bucket's
# policy: 0 when the bucket has no policy at all.
deny_statements() {
  local out
  if ! out=$(aws s3api get-bucket-policy --bucket "${BUCKET}" --region "${REGION}" \
      --query Policy --output text 2>&1); then
    if printf '%s' "${out}" | grep -q 'NoSuchBucketPolicy'; then
      echo 0
      return 0
    fi
    echo "FAIL: get-bucket-policy failed: ${out}" >&2
    exit 1
  fi
  printf '%s' "${out}" | jq '[.Statement[] | select(.Effect == "Deny" and .Condition.Bool["aws:SecureTransport"] == "false")] | length'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${SIBLING_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  ACCT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [ -n "${ACCT}" ]; then
    local name
    name="$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')-${ACCT}"
    aws s3api delete-bucket-policy --bucket "${name}" --region "${REGION}" >/dev/null 2>&1 || true
    aws s3 rb "s3://${name}" --force --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
BUCKET_LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::S3::Bucket") | .key' "${TEMPLATE}" | head -1)
[ -n "${BUCKET_LOGICAL_ID}" ] || { echo "FAIL: no AWS::S3::Bucket in ${TEMPLATE}" >&2; exit 1; }

echo "==> Phase 1: Deploy (SDK route)"
env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BUCKET=$(state_json | jq -r --arg k "${BUCKET_LOGICAL_ID}" '.resources[$k].physicalId')
[ -n "${BUCKET}" ] && [ "${BUCKET}" != "null" ] || { echo "FAIL: no physical id recorded for the bucket" >&2; exit 1; }
LAYER0=$(state_json | jq -r --arg k "${BUCKET_LOGICAL_ID}" '.resources[$k].provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0} for the bucket, expected sdk" >&2; exit 1; }
D0=$(deny_statements)
[ "${D0}" = "1" ] || { echo "FAIL: phase 1: the bucket policy holds ${D0} deny statement(s), expected 1" >&2; exit 1; }
POLICY_KEY=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::S3::BucketPolicy") | .key' | head -1)
[ -n "${POLICY_KEY}" ] || { echo "FAIL: no AWS::S3::BucketPolicy record after phase 1" >&2; exit 1; }
CREATED0=$(aws s3api list-buckets --region "${REGION}" --query "Buckets[?Name=='${BUCKET}'].CreationDate" --output text)
echo "    OK: bucket ${BUCKET} on the SDK route, its policy denies plain HTTP"

echo "==> Phase 2: recreate the bucket while the policy's sibling fails (the deploy must fail)"
set +e
FAIL_OUT=$(env CDKD_TEST_PHASE=fail node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${BUCKET_LOGICAL_ID}" --force-stateful-recreation --yes 2>&1)
FAIL_RC=$?
set -e
printf '%s\n' "${FAIL_OUT}"
[ "${FAIL_RC}" -ne 0 ] || { echo "FAIL: premise: the phase 2 deploy succeeded; the sibling was meant to fail it" >&2; exit 1; }
grep -qi 'allowedPattern\|failed to satisfy constraint\|ValidationException' <<<"${FAIL_OUT}" || {
  echo "FAIL: premise: the phase 2 deploy failed for another reason than the sibling's refused value" >&2
  exit 1
}
# PREMISE: the bucket really was destroyed and re-created, and its policy
# went with it -- witnessed by the policy being GONE (D1 below). CreationDate is
# supporting evidence only: it is reported, not asserted, since its listing is
# eventually consistent and a second-resolution clock.
CREATED1=$(aws s3api list-buckets --region "${REGION}" --query "Buckets[?Name=='${BUCKET}'].CreationDate" --output text)
echo "    note: bucket CreationDate ${CREATED0:-<none>} -> ${CREATED1:-<none>}"
D1=$(deny_statements)
[ "${D1}" = "0" ] || { echo "FAIL: premise: the re-created bucket still holds ${D1} deny statement(s); the policy was not lost, so this run would not witness issue #4443" >&2; exit 1; }
# The fix: the record of a policy AWS no longer has is dropped.
HELD=$(state_json | jq -r --arg k "${POLICY_KEY}" '.resources | has($k)')
[ "${HELD}" = "false" ] || { echo "FAIL: after the failed deploy state still records ${POLICY_KEY}, which AWS no longer has (issue #4443)" >&2; exit 1; }
echo "    OK: deploy failed after the recreate; the lost policy's record is dropped"

echo "==> Phase 3: THE ARM -- a plain redeploy restores the policy"
env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
D2=$(deny_statements)
[ "${D2}" = "1" ] || { echo "FAIL: after the redeploy the bucket policy holds ${D2} deny statement(s), expected 1 -- the lost policy was not restored (issue #4443)" >&2; exit 1; }
HELD2=$(state_json | jq -r --arg k "${POLICY_KEY}" '.resources | has($k)')
[ "${HELD2}" = "true" ] || { echo "FAIL: the redeploy restored the policy but state does not record ${POLICY_KEY}" >&2; exit 1; }
echo "    OK: the policy is back and recorded"

echo "==> Phase 4: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "bucket ${BUCKET} survived destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "SSM parameter ${SIBLING_NAME} survived destroy" \
  aws ssm get-parameter --name "${SIBLING_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — lost-child-after-failed-deploy (a failed same-id recreate does not leave the bucket policy lost)"
