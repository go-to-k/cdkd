#!/usr/bin/env bash
# verify.sh — cdkd CC-routed Fn::GetAtt read-back enrichment integ.
#
# Regression coverage for issue #1103: AWS::Pipes::Pipe, AWS::S3::AccessPoint
# and AWS::ResourceGroups::Group have NO SDK provider (pure Cloud Control) and
# the CC CREATE ResourceModel is sparse for all three, so `Fn::GetAtt` on
# their computed attributes (`Arn`, and `Alias` for the access point) fell
# through cdkd's intrinsic resolver's constructAttribute default to the
# physicalId — the bare resource NAME. Deploy stayed green (a silent GetAtt
# divergence poisoning outputs and downstream consumers).
#
# Phases:
#   1. Deploy bucket + access point, SQS->SQS pipe (+role), resource group.
#      Assert each GetAtt-backed stack output EQUALS the real value read back
#      from the service API (equality, not just an `arn:` prefix check).
#   2. Destroy + assert the pipe / access point / group are gone and the cdkd
#      state file removed.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdCcGetattReadbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
AP_NAME="cdkd-ccgar-ap"
PIPE_NAME="cdkd-ccgar-pipe"
RG_NAME="cdkd-ccgar-rg"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws pipes delete-pipe --name "${PIPE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3control delete-access-point --account-id "${ACCOUNT_ID}" \
    --name "${AP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws resource-groups delete-group --group-name "${RG_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  # The fixture bucket is auto-named; find it via the stack-name prefix and
  # delete it (it is always empty — nothing writes objects into it).
  for BUCKET in $(aws s3api list-buckets \
      --query "Buckets[?starts_with(Name, 'cdkdccgetattreadbackexample-bucket')].Name" \
      --output text 2>/dev/null); do
    aws s3 rb "s3://${BUCKET}" --force >/dev/null 2>&1 || true
  done
  # The pipe role + queues are stack-prefixed; state destroy above removes
  # them on the happy path, these direct deletes cover interrupted runs.
  for QURL in $(aws sqs list-queues --queue-name-prefix "${STACK}" --region "${REGION}" \
      --query 'QueueUrls[]' --output text 2>/dev/null); do
    aws sqs delete-queue --queue-url "${QURL}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for ROLE in $(aws iam list-roles \
      --query "Roles[?starts_with(RoleName, '${STACK}-PipeRole')].RoleName" \
      --output text 2>/dev/null); do
    for INLINE in $(aws iam list-role-policies --role-name "${ROLE}" \
        --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${INLINE}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy access point + pipe + resource group"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Locate each output by key prefix so a CDK-hashed output logical id still
# matches; fall back to the exact key.
output_value() {
  echo "${STATE}" | jq -r --arg k "$1" \
    '[.outputs | to_entries[] | select(.key | startswith($k)) | .value] | first // (.outputs[$k] // "")'
}

# Every assertion is an EQUALITY check against the value the service API
# returns — a prefix check would not catch a wrong-but-arn-shaped value.
PIPE_ARN_OUT=$(output_value PipeArn)
PIPE_ARN_REAL=$(aws pipes describe-pipe --name "${PIPE_NAME}" --region "${REGION}" \
  --query 'Arn' --output text)
echo "    PipeArn output: ${PIPE_ARN_OUT} (real: ${PIPE_ARN_REAL})"
if [ -z "${PIPE_ARN_REAL}" ] || [ "${PIPE_ARN_REAL}" = "None" ]; then
  echo "FAIL: could not read the real pipe ARN from AWS" >&2; exit 1
fi
if [ "${PIPE_ARN_OUT}" != "${PIPE_ARN_REAL}" ]; then
  echo "FAIL: Fn::GetAtt(Pipe, 'Arn') resolved to '${PIPE_ARN_OUT}', expected '${PIPE_ARN_REAL}' (issue #1103 physicalId fallback)" >&2
  exit 1
fi

AP_ARN_OUT=$(output_value ApArn)
AP_ALIAS_OUT=$(output_value ApAlias)
AP_ARN_REAL=$(aws s3control get-access-point --account-id "${ACCOUNT_ID}" \
  --name "${AP_NAME}" --region "${REGION}" --query 'AccessPointArn' --output text)
AP_ALIAS_REAL=$(aws s3control get-access-point --account-id "${ACCOUNT_ID}" \
  --name "${AP_NAME}" --region "${REGION}" --query 'Alias' --output text)
echo "    ApArn output: ${AP_ARN_OUT} (real: ${AP_ARN_REAL})"
echo "    ApAlias output: ${AP_ALIAS_OUT} (real: ${AP_ALIAS_REAL})"
if [ "${AP_ARN_OUT}" != "${AP_ARN_REAL}" ]; then
  echo "FAIL: Fn::GetAtt(Ap, 'Arn') resolved to '${AP_ARN_OUT}', expected '${AP_ARN_REAL}' (issue #1103 physicalId fallback)" >&2
  exit 1
fi
if [ "${AP_ALIAS_OUT}" != "${AP_ALIAS_REAL}" ]; then
  echo "FAIL: Fn::GetAtt(Ap, 'Alias') resolved to '${AP_ALIAS_OUT}', expected '${AP_ALIAS_REAL}' (issue #1103 physicalId fallback)" >&2
  exit 1
fi

RG_ARN_OUT=$(output_value RgArn)
RG_ARN_REAL=$(aws resource-groups get-group --group-name "${RG_NAME}" \
  --region "${REGION}" --query 'Group.GroupArn' --output text)
echo "    RgArn output: ${RG_ARN_OUT} (real: ${RG_ARN_REAL})"
if [ "${RG_ARN_OUT}" != "${RG_ARN_REAL}" ]; then
  echo "FAIL: Fn::GetAtt(Rg, 'Arn') resolved to '${RG_ARN_OUT}', expected '${RG_ARN_REAL}' (issue #1103 physicalId fallback)" >&2
  exit 1
fi
echo "    All GetAtt outputs equal the real service-API values (read-back enrichment works)"

# Belt-and-suspenders: the state attributes must carry the ARNs too (the
# read-back writes them at create time; the outputs merely consume them).
STATE_PIPE_ARN=$(echo "${STATE}" | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::Pipes::Pipe") | .value.attributes.Arn] | first // ""')
if [ "${STATE_PIPE_ARN}" != "${PIPE_ARN_REAL}" ]; then
  echo "FAIL: state pipe attribute Arn is '${STATE_PIPE_ARN}', expected '${PIPE_ARN_REAL}'" >&2
  exit 1
fi
echo "    state pipe attribute Arn carries the real ARN"

# --- Phase 2: destroy --------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws pipes describe-pipe --name "${PIPE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: pipe ${PIPE_NAME} still exists after destroy" >&2; exit 1
fi
if aws s3control get-access-point --account-id "${ACCOUNT_ID}" --name "${AP_NAME}" \
    --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: access point ${AP_NAME} still exists after destroy" >&2; exit 1
fi
if aws resource-groups get-group --group-name "${RG_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: resource group ${RG_NAME} still exists after destroy" >&2; exit 1
fi
echo "    Pipe / AccessPoint / ResourceGroup deleted"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — CC-routed Fn::GetAtt read-back enrichment works end-to-end, 2 phases passed"
