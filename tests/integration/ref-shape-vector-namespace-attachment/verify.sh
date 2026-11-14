#!/usr/bin/env bash
# verify.sh — cdkd Ref of AWS::S3Vectors::VectorBucket, AWS::AppSync::GraphQLApi,
# AWS::S3Tables::Namespace and AWS::EC2::VPCGatewayAttachment (issue #6243).
#
# Each used to resolve to a value CloudFormation never returns, with no
# warning. Asserts every Ref output equals the CloudFormation shape built from
# what AWS reports, that the vector bucket's ARN reached a resource property,
# that a second deploy re-resolves the same values from the stored records,
# then destroys clean.

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

STACK="CdkdRefShapeVectorNamespaceAttachmentExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    fi
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

assert_eq() { # usage: assert_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

assert_refs() {
  local bucket_name live_bucket_arn api_id live_api_arn tb_arn live_tb_arn vpc_id igw_id param_name param_value
  bucket_name="$(output_of VectorBucketRef)" || return 1
  live_bucket_arn="$(output_of VectorBucketArn)" || return 1
  case "${live_bucket_arn}" in arn:*:s3vectors:*:bucket/?*) ;; *) echo "FAIL: VectorBucketArn output '${live_bucket_arn}'" >&2; exit 1 ;; esac
  live_bucket_arn="$(aws s3vectors get-vector-bucket --region "${REGION}" --vector-bucket-arn "${live_bucket_arn}" --query 'vectorBucket.vectorBucketArn' --output text)" || return 1
  assert_eq "Ref VectorBucket (ARN, not the name)" "${bucket_name}" "${live_bucket_arn}"

  param_name="$(output_of ParamName)" || return 1
  param_value="$(aws ssm get-parameter --region "${REGION}" --name "${param_name}" --query 'Parameter.Value' --output text)" || return 1
  assert_eq "SSM parameter value from Ref VectorBucket" "${param_value}" "${live_bucket_arn}"

  api_id="$(output_of ApiId)" || return 1
  [ -n "${api_id}" ] || { echo "FAIL: ApiId output missing" >&2; exit 1; }
  live_api_arn="$(aws appsync get-graphql-api --region "${REGION}" --api-id "${api_id}" --query 'graphqlApi.arn' --output text)" || return 1
  assert_eq "Ref GraphQLApi (ARN, not the API id)" "$(output_of ApiRef)" "${live_api_arn}"

  tb_arn="$(output_of TableBucketRef)" || return 1
  live_tb_arn="$(aws s3tables get-table-bucket --region "${REGION}" --table-bucket-arn "${tb_arn}" --query 'arn' --output text)" || return 1
  assert_eq "Ref TableBucket" "${tb_arn}" "${live_tb_arn}"
  aws s3tables get-namespace --region "${REGION}" --table-bucket-arn "${live_tb_arn}" --namespace refshape >/dev/null || return 1
  assert_eq "Ref Namespace (<tableBucketARN>|<namespace>)" "$(output_of NamespaceRef)" "${live_tb_arn}|refshape"

  vpc_id="$(output_of VpcId)" || return 1
  igw_id="$(output_of IgwId)" || return 1
  case "${igw_id}" in igw-?*) ;; *) echo "FAIL: IgwId output '${igw_id}'" >&2; exit 1 ;; esac
  [ "$(aws ec2 describe-internet-gateways --region "${REGION}" --internet-gateway-ids "${igw_id}" \
    --query 'InternetGateways[0].Attachments[0].VpcId' --output text)" = "${vpc_id}" ] \
    || { echo "FAIL: ${igw_id} is not attached to ${vpc_id}" >&2; exit 1; }
  assert_eq "Ref VPCGatewayAttachment (IGW|<vpcId>)" "$(output_of AttachmentRef)" "IGW|${vpc_id}"
}

echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy1.log"
assert_refs
VECTOR_BUCKET_ARN="$(output_of VectorBucketArn)"
API_ID="$(output_of ApiId)"
TABLE_BUCKET_ARN="$(output_of TableBucketRef)"
VPC_ID="$(output_of VpcId)"
IGW_ID="$(output_of IgwId)"

echo "==> Phase 2: UPDATE (parameter description only; every Ref re-resolves from the records)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy2.log"
assert_refs
assert_eq "VectorBucketArn after the update (no replacement)" "$(output_of VectorBucketArn)" "${VECTOR_BUCKET_ARN}"
assert_eq "ApiId after the update (no replacement)" "$(output_of ApiId)" "${API_ID}"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "vector bucket ${VECTOR_BUCKET_ARN} still exists after destroy" aws s3vectors get-vector-bucket --region "${REGION}" --vector-bucket-arn "${VECTOR_BUCKET_ARN}"
assert_gone "GraphQL API ${API_ID} still exists after destroy" aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}"
assert_gone "table bucket ${TABLE_BUCKET_ARN} still exists after destroy" aws s3tables get-table-bucket --region "${REGION}" --table-bucket-arn "${TABLE_BUCKET_ARN}"
assert_gone "internet gateway ${IGW_ID} still exists after destroy" aws ec2 describe-internet-gateways --region "${REGION}" --internet-gateway-ids "${IGW_ID}"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: vector bucket, API, table bucket, IGW, VPC and state gone"

echo ""
echo "[verify] PASS — ref-shape-vector-namespace-attachment: Ref of VectorBucket, GraphQLApi, Namespace and VPCGatewayAttachment match CloudFormation across an update"
