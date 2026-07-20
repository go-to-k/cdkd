#!/usr/bin/env bash
# verify.sh — cdkd propagation-races-2 integ test.
#
# A fresh-principal / propagation-race DETECTOR. Every resource in the stack is
# a NEW consumer of a resource created moments earlier in the SAME deploy:
#   1. IAM InstanceProfile -> EC2 Instance   (RunInstances validates the profile)
#   2. Lambda::Permission granting a fresh S3 bucket source (AddPermission)
#   3. S3 BucketPolicy referencing a fresh IAM role principal (PutBucketPolicy)
#   4. KMS Key policy referencing a fresh IAM role principal (CreateKey)
#
# PASS CONDITION = `cdkd deploy` SUCCEEDS. If cdkd does not retry the
# fresh-principal propagation error for one of these edges, the deploy fails and
# this script prints which resource failed + the AWS error + the
# `cdkd events --format json` RESOURCE_FAILED lines for triage. On success it
# asserts each resource works, then destroys and asserts every named resource is
# gone (by the fixture-owned `cdkd:integ-fixture` tag / state-resolved id, NOT
# the AWS-reserved `aws:cdk:path` tag).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe (macOS): no `grep -P`, no `date -d`; boolean asserts use the
# `if has("X") then .X|tostring else "null" end` jq idiom (jq's `//` treats an
# explicit `false` as missing).

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

STACK="CdkdPropagationRaces2Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="propagation-races-2"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved physical ids (populated post-deploy; used by assertions + cleanup).
INSTANCE_ID=""
INSTANCE_PROFILE_NAME=""
FUNCTION_NAME=""
NOTIFY_BUCKET=""
POLICED_BUCKET=""
KEY_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # cdkd-owned teardown first (deletes resources AND state in dependency order).
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
  fi
  # Belt-and-suspenders direct deletes in case state is already gone. EC2 must
  # go BEFORE the VPC/SG (ENI ordering): terminate the instance and wait so the
  # security group + subnet are not blocked by a lingering ENI/DependencyViolation.
  if [ -n "${INSTANCE_ID}" ]; then
    aws ec2 terminate-instances --instance-ids "${INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    aws ec2 wait instance-terminated --instance-ids "${INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${INSTANCE_PROFILE_NAME}" ]; then
    # Detach roles before deleting the profile (AWS requires it).
    for r in $(aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
      --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null); do
      aws iam remove-role-from-instance-profile \
        --instance-profile-name "${INSTANCE_PROFILE_NAME}" \
        --role-name "${r}" >/dev/null 2>&1
    done
    aws iam delete-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null 2>&1
  fi
  if [ -n "${FUNCTION_NAME}" ]; then
    aws lambda delete-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1
  fi
  for b in "${NOTIFY_BUCKET}" "${POLICED_BUCKET}"; do
    if [ -n "${b}" ]; then
      aws s3 rb "s3://${b}" --force --region "${REGION}" >/dev/null 2>&1
    fi
  done
  if [ -n "${KEY_ID}" ]; then
    aws kms schedule-key-deletion --key-id "${KEY_ID}" \
      --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Triage helper: dump cdkd events RESOURCE_FAILED lines on a deploy failure so a
# CI run shows exactly which race edge failed + the AWS error.
dump_failure_triage() {
  echo "==> DEPLOY FAILED — triage via cdkd events --format json" >&2
  set +e
  EVENTS_JSON=$(node "${LOCAL_DIST}" events "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --format json 2>/dev/null)
  if [ -n "${EVENTS_JSON}" ]; then
    echo "${EVENTS_JSON}" | jq -r '
      (if type == "array" then . else (.events // .runs // []) end)
      | (if (.[0] | type) == "object" and (.[0] | has("events")) then (.[] .events // []) | add else . end)
      | map(select(.type == "RESOURCE_FAILED" or .type == "ROLLBACK_RESOURCE_FAILED"))
      | .[]
      | "  RESOURCE_FAILED: \(.logicalId // "?") (\(.resourceType // "?"))\n    \(.error.name // "?") \(if .error.awsErrorCode then "(\(.error.awsErrorCode))" else "" end): \(.error.message // "?")"
    ' 2>/dev/null || echo "  (could not parse events JSON; raw below)" && echo "${EVENTS_JSON}" >&2
  else
    echo "  (no events recorded — deploy may have failed before any resource started)" >&2
  fi
  set -e
}

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

# --- Phase 1: deploy (the race detector) ------------------------------
echo "==> Phase 1: deploy with the local binary (pass condition = deploy succeeds)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes; then
  echo "FAIL: cdkd deploy returned non-zero — a fresh-principal propagation race was NOT retried" >&2
  dump_failure_triage
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve physical ids from state.
resolve_id() {
  echo "${STATE}" | jq -r --arg t "$1" \
    '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""'
}
INSTANCE_ID=$(resolve_id "AWS::EC2::Instance")
INSTANCE_PROFILE_NAME=$(resolve_id "AWS::IAM::InstanceProfile")
FUNCTION_NAME=$(resolve_id "AWS::Lambda::Function")
KEY_ID=$(resolve_id "AWS::KMS::Key")
# Two buckets share a type; resolve by output name instead.
NOTIFY_BUCKET=$(echo "${STATE}" | jq -r '.outputs.NotifyBucketName // ""')
POLICED_BUCKET=$(echo "${STATE}" | jq -r '.outputs.PolicedBucketName // ""')

echo "    instance=${INSTANCE_ID} profile=${INSTANCE_PROFILE_NAME} fn=${FUNCTION_NAME}"
echo "    notifyBucket=${NOTIFY_BUCKET} policedBucket=${POLICED_BUCKET} key=${KEY_ID}"

for v in "${INSTANCE_ID}" "${INSTANCE_PROFILE_NAME}" "${FUNCTION_NAME}" "${NOTIFY_BUCKET}" "${POLICED_BUCKET}" "${KEY_ID}"; do
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then
    echo "FAIL: could not resolve one or more physical ids from state" >&2
    echo "${STATE}" | jq '{resources: (.resources | keys), outputs}' >&2
    exit 1
  fi
done

# --- Edge 1 assertion: instance launched WITH the fresh instance profile
echo "==> Edge 1: EC2 Instance launched with the fresh InstanceProfile"
INSTANCE=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" --query 'Reservations[0].Instances[0]' --output json 2>/dev/null)
INSTANCE_STATE=$(echo "${INSTANCE}" | jq -r '.State.Name // "null"')
if [ "${INSTANCE_STATE}" != "running" ] && [ "${INSTANCE_STATE}" != "pending" ]; then
  echo "FAIL: instance state is '${INSTANCE_STATE}', expected running/pending" >&2
  exit 1
fi
ATTACHED_PROFILE=$(echo "${INSTANCE}" | jq -r '.IamInstanceProfile.Arn // "null"')
if [ "${ATTACHED_PROFILE}" = "null" ]; then
  echo "FAIL: instance has no IAM instance profile attached — the fresh profile did not bind" >&2
  exit 1
fi
echo "    OK: instance ${INSTANCE_STATE}, profile attached (${ATTACHED_PROFILE})"

# --- Edge 2 assertion: Lambda is invokable + the bucket-source permission exists
echo "==> Edge 2: Lambda::Permission for the fresh S3 source"
INVOKE_OUT=$(aws lambda invoke --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --payload '{}' /tmp/prop2-invoke.out 2>/dev/null \
  --query 'StatusCode' --output text || echo "null")
if [ "${INVOKE_OUT}" != "200" ]; then
  echo "FAIL: Lambda invoke StatusCode was '${INVOKE_OUT}', expected 200" >&2
  exit 1
fi
POLICY_JSON=$(aws lambda get-policy --function-name "${FUNCTION_NAME}" \
  --region "${REGION}" --query 'Policy' --output text)
if ! echo "${POLICY_JSON}" | grep -qF "s3.amazonaws.com"; then
  echo "FAIL: Lambda resource policy does not grant s3.amazonaws.com — the permission PUT did not land" >&2
  echo "${POLICY_JSON}" >&2
  exit 1
fi
echo "    OK: Lambda invokable (200) + resource policy grants the S3 source"

# --- Edge 3 assertion: bucket policy present + references the fresh role
echo "==> Edge 3: S3 BucketPolicy referencing the fresh role"
BUCKET_POLICY=$(aws s3api get-bucket-policy --bucket "${POLICED_BUCKET}" \
  --region "${REGION}" --query 'Policy' --output text)
if [ -z "${BUCKET_POLICY}" ]; then
  echo "FAIL: no bucket policy on ${POLICED_BUCKET} — PutBucketPolicy did not land" >&2
  exit 1
fi
if ! echo "${BUCKET_POLICY}" | grep -qF "AllowFreshRoleRead"; then
  echo "FAIL: bucket policy missing the AllowFreshRoleRead statement" >&2
  echo "${BUCKET_POLICY}" >&2
  exit 1
fi
echo "    OK: bucket policy present + references the fresh role principal"

# --- Edge 4 assertion: KMS key usable + the key policy references the fresh role
echo "==> Edge 4: KMS Key policy referencing the fresh role"
KEY_STATE=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text)
if [ "${KEY_STATE}" != "Enabled" ]; then
  echo "FAIL: KMS key state is '${KEY_STATE}', expected Enabled" >&2
  exit 1
fi
# Key is usable: encrypt a tiny blob.
ENC=$(aws kms encrypt --key-id "${KEY_ID}" --plaintext "$(printf 'ok' | base64)" \
  --region "${REGION}" --query 'CiphertextBlob' --output text 2>/dev/null || echo "")
if [ -z "${ENC}" ]; then
  echo "FAIL: KMS encrypt failed — key not usable" >&2
  exit 1
fi
KEY_POLICY=$(aws kms get-key-policy --key-id "${KEY_ID}" --policy-name default \
  --region "${REGION}" --query 'Policy' --output text)
if ! echo "${KEY_POLICY}" | grep -qF "AllowFreshRoleUse"; then
  echo "FAIL: KMS key policy missing the AllowFreshRoleUse statement" >&2
  echo "${KEY_POLICY}" >&2
  exit 1
fi
echo "    OK: KMS key Enabled + usable + policy references the fresh role principal"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Post-destroy: assert each NAMED resource is gone ------------------
echo "==> Post-destroy: assert named resources are gone (by fixture tag / resolved id)"

# Instance terminated / shutting-down / gone.
ST=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
case "${ST}" in
  terminated|shutting-down|gone) echo "    OK: instance gone (state: ${ST})" ;;
  *) echo "FAIL: instance ${INSTANCE_ID} still in state ${ST} after destroy" >&2; exit 1 ;;
esac

# Instance profile gone.
assert_gone "instance profile ${INSTANCE_PROFILE_NAME} still exists after destroy" aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}"
echo "    OK: instance profile gone"

# Lambda function gone.
assert_gone "Lambda ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
echo "    OK: Lambda function gone"

# Both buckets gone.
for b in "${NOTIFY_BUCKET}" "${POLICED_BUCKET}"; do
  assert_gone "bucket ${b} still exists after destroy" aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
echo "    OK: both S3 buckets gone"

# KMS key scheduled for deletion (KMS keys cannot be hard-deleted immediately).
if gone_probe aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}"; then
  KEY_STATE_AFTER="gone"
else
  KEY_STATE_AFTER=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" \
    --query 'KeyMetadata.KeyState' --output text)
fi
case "${KEY_STATE_AFTER}" in
  PendingDeletion|gone) echo "    OK: KMS key pending deletion / gone (state: ${KEY_STATE_AFTER})" ;;
  *) echo "FAIL: KMS key ${KEY_ID} still in state ${KEY_STATE_AFTER} after destroy (expected PendingDeletion)" >&2; exit 1 ;;
esac

# Tag-scoped sweep: no running/pending instance carries our fixture tag (catches
# an orphan that state-resolved-id checks would miss because it lost the stack
# name).
ORPHAN_INSTANCES=$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "${ORPHAN_INSTANCES}" ] && [ "${ORPHAN_INSTANCES}" != "None" ]; then
  echo "FAIL: orphan instance(s) carrying the fixture tag remain: ${ORPHAN_INSTANCES}" >&2
  exit 1
fi
echo "    OK: no tagged orphan instances remain"

# Nothing left for the cleanup trap to delete.
INSTANCE_ID=""
INSTANCE_PROFILE_NAME=""
FUNCTION_NAME=""
NOTIFY_BUCKET=""
POLICED_BUCKET=""
KEY_ID=""

echo ""
echo "=== PASS: propagation-races-2 integ (4 fresh-principal/consumer race edges deployed, asserted, destroyed clean) ==="
