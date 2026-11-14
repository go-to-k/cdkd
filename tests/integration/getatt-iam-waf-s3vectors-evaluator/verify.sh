#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt read-only attributes it used to REFUSE
# (issue #6242): AWS::IAM::ManagedPolicy AttachmentCount /
# PermissionsBoundaryUsageCount / IsAttachable / CreateDate / UpdateDate,
# AWS::WAFv2::WebACL Capacity, AWS::S3Vectors::VectorBucket CreationTime and
# AWS::BedrockAgentCore::Evaluator EvaluatorType / Provider.
#
# Each Output must equal the value the AWS API reports, after the create and
# after an in-place update that moves AttachmentCount / UpdateDate / Capacity
# (and leaves CreationTime, which the vector bucket's update does not
# re-record). Then destroys clean.

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

STACK="CdkdGetattIamWafS3vectorsEvaluator"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POLICY_NAME="${STACK}-policy"
ACL_NAME="${STACK}-acl"
VECTOR_BUCKET="cdkd-getatt-6242-vb"
EVALUATOR_NAME="cdkd_getatt_6242_evaluator"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct-API fallbacks, by the fixed names, for a destroy that did not finish.
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  if [ -n "${ACCOUNT}" ]; then
    local arn="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}" r
    for r in "${STACK}-role-a" "${STACK}-role-b"; do
      aws iam detach-role-policy --role-name "${r}" --policy-arn "${arn}" >/dev/null 2>&1
      aws iam delete-role --role-name "${r}" >/dev/null 2>&1
    done
    local v
    for v in $(aws iam list-policy-versions --policy-arn "${arn}" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
      aws iam delete-policy-version --policy-arn "${arn}" --version-id "${v}" >/dev/null 2>&1
    done
    aws iam delete-policy --policy-arn "${arn}" >/dev/null 2>&1
  fi
  local acl_id lock
  acl_id="$(aws wafv2 list-web-acls --scope REGIONAL --region "${REGION}" --query "WebACLs[?Name=='${ACL_NAME}'].Id | [0]" --output text 2>/dev/null)"
  if [ -n "${acl_id}" ] && [ "${acl_id}" != "None" ]; then
    lock="$(aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" --name "${ACL_NAME}" --id "${acl_id}" --query LockToken --output text 2>/dev/null)"
    aws wafv2 delete-web-acl --scope REGIONAL --region "${REGION}" --name "${ACL_NAME}" --id "${acl_id}" --lock-token "${lock}" >/dev/null 2>&1
  fi
  aws s3vectors delete-vector-bucket --region "${REGION}" --vector-bucket-name "${VECTOR_BUCKET}" >/dev/null 2>&1
  local ev_id
  ev_id="$(aws bedrock-agentcore-control list-evaluators --region "${REGION}" --query "evaluators[?evaluatorName=='${EVALUATOR_NAME}'].evaluatorId | [0]" --output text 2>/dev/null)"
  if [ -n "${ev_id}" ] && [ "${ev_id}" != "None" ]; then
    aws bedrock-agentcore-control delete-evaluator --region "${REGION}" --evaluator-id "${ev_id}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

# The AWS CLI prints a timestamp in the caller's local zone (`+09:00`); the
# attribute is UTC with a `Z`, whole seconds for both APIs probed here.
utc_seconds() { # usage: utc_seconds <cli timestamp>
  python3 -I -c 'import datetime,sys; print(datetime.datetime.fromisoformat(sys.argv[1]).astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"
}

expect_eq() { # usage: expect_eq <label> <output value> <live value>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 output '$2' != live '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

# A refusal fails the deploy, so a passing deploy already proves the lookup;
# these compare each served value with AWS's.
assert_outputs() { # usage: assert_outputs <expected attachment count>
  local arn acl_arn acl_id ev_id live
  arn="$(output_of PolicyArn)"
  [ -n "${arn}" ] || { echo "FAIL: PolicyArn output missing" >&2; exit 1; }
  live="$(aws iam get-policy --policy-arn "${arn}" --output json)" || return 1
  expect_eq AttachmentCount "$(output_of AttachmentCount)" "$(jq -r '.Policy.AttachmentCount' <<<"${live}")"
  [ "$(output_of AttachmentCount)" = "$1" ] || { echo "FAIL: AttachmentCount '$(output_of AttachmentCount)', expected $1" >&2; exit 1; }
  expect_eq PermissionsBoundaryUsageCount "$(output_of PermissionsBoundaryUsageCount)" "$(jq -r '.Policy.PermissionsBoundaryUsageCount' <<<"${live}")"
  expect_eq IsAttachable "$(output_of IsAttachable)" "$(jq -r '.Policy.IsAttachable' <<<"${live}")"
  expect_eq CreateDate "$(output_of CreateDate)" "$(utc_seconds "$(jq -r '.Policy.CreateDate' <<<"${live}")")"
  expect_eq UpdateDate "$(output_of UpdateDate)" "$(utc_seconds "$(jq -r '.Policy.UpdateDate' <<<"${live}")")"

  acl_arn="$(output_of AclArn)"
  acl_id="${acl_arn##*/}"
  expect_eq AclCapacity "$(output_of AclCapacity)" \
    "$(aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" --name "${ACL_NAME}" --id "${acl_id}" --query 'WebACL.Capacity' --output text)"

  expect_eq VectorBucketCreationTime "$(output_of VectorBucketCreationTime)" \
    "$(utc_seconds "$(aws s3vectors get-vector-bucket --region "${REGION}" --vector-bucket-name "${VECTOR_BUCKET}" --query 'vectorBucket.creationTime' --output text)")"

  ev_id="$(output_of EvaluatorId)"
  live="$(aws bedrock-agentcore-control get-evaluator --region "${REGION}" --evaluator-id "${ev_id}" --output json)" || return 1
  expect_eq EvaluatorType "$(output_of EvaluatorType)" "$(jq -r '.evaluatorType' <<<"${live}")"
  expect_eq EvaluatorProvider "$(output_of EvaluatorProvider)" "$(jq -r '.provider' <<<"${live}")"
}

echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy1.log"
assert_outputs 1
[ "$(output_of AclCapacity)" = "0" ] || { echo "FAIL: a rule-less web ACL's Capacity is '$(output_of AclCapacity)', expected 0" >&2; exit 1; }
ARN_BEFORE="$(output_of PolicyArn)"
CREATED_BEFORE="$(output_of VectorBucketCreationTime)"
ACL_ARN="$(output_of AclArn)"
EV_ID="$(output_of EvaluatorId)"

# Distinct UpdateDate: IAM's dates are whole seconds.
sleep 2
echo "==> Phase 2: in-place UPDATE (new policy version + second role, a web ACL rule, a bucket tag, evaluator Level)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy2.log"
assert_outputs 2
[ "$(output_of PolicyArn)" = "${ARN_BEFORE}" ] || { echo "FAIL: the policy was replaced, not updated" >&2; exit 1; }
[ "$(output_of EvaluatorId)" = "${EV_ID}" ] || { echo "FAIL: the evaluator was replaced, not updated" >&2; exit 1; }
[ "$(output_of AclCapacity)" != "0" ] || { echo "FAIL: Capacity did not follow the added rule" >&2; exit 1; }
if [ "$(output_of UpdateDate)" = "$(output_of CreateDate)" ]; then
  echo "FAIL: UpdateDate did not move with the new default version" >&2
  exit 1
fi
expect_eq "VectorBucketCreationTime (kept across the tag update)" "$(output_of VectorBucketCreationTime)" "${CREATED_BEFORE}"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

ACL_ID="${ACL_ARN##*/}"
assert_gone "policy ${ARN_BEFORE} still exists after destroy" aws iam get-policy --policy-arn "${ARN_BEFORE}"
assert_gone "role ${STACK}-role-a still exists after destroy" aws iam get-role --role-name "${STACK}-role-a"
assert_gone "role ${STACK}-role-b still exists after destroy" aws iam get-role --role-name "${STACK}-role-b"
assert_gone "web ACL ${ACL_NAME} still exists after destroy" aws wafv2 get-web-acl --scope REGIONAL --region "${REGION}" --name "${ACL_NAME}" --id "${ACL_ID}"
assert_gone "vector bucket ${VECTOR_BUCKET} still exists after destroy" aws s3vectors get-vector-bucket --region "${REGION}" --vector-bucket-name "${VECTOR_BUCKET}"
assert_gone "evaluator ${EV_ID} still exists after destroy" aws bedrock-agentcore-control get-evaluator --region "${REGION}" --evaluator-id "${EV_ID}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: policy, roles, web ACL, vector bucket, evaluator and state gone"

echo ""
echo "[verify] PASS — getatt-iam-waf-s3vectors-evaluator: ManagedPolicy counts / dates, WebACL Capacity, VectorBucket CreationTime and Evaluator EvaluatorType / Provider match AWS across an update"
