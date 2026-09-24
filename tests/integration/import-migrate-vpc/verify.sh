#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd import --migrate-from-cloudformation`
# adopts a CDK `ec2.Vpc` completely (issue #3661): route tables, routes, the
# internet gateway and its attachment, subnet route-table / NACL associations,
# a NACL with entries, a NAT gateway + EIP, and an instance.
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. `cdk deploy` the stack (the existing CloudFormation stack to migrate).
#   3. `cdkd import --migrate-from-cloudformation --yes`; assert the summary
#      reports `0 not found` / `0 failed` and no unresolved intrinsic.
#   4. `cdkd deploy` with an unchanged template: nothing created or updated.
#      Before the fix, the orphaned route tables were created a second time and
#      the associations conflicted.
#   5. `cdkd destroy --force`; gone-probes for the VPC, instance, NAT gateway,
#      and the state file.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-migrate-vpc"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportMigrateVpc"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-migrate-vpc.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The import writes cdkd state BEFORE it retires the CloudFormation stack, so
# one of the two owns every resource at every point: destroy through whichever
# holds them.
cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${STACK}"
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
(cd "${TEST_DIR}" && { [ -x node_modules/.bin/cdk ] || npm install; })
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
CDK_RESOLVED="$(command -v cdk)"
CDK_VERSION="$(cdk --version)"
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION})"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${STATE_KEY} already exists — clean up first"
  exit 1
fi

echo "[verify] step 3: cdk deploy (the CloudFormation stack to migrate)"
(cd "${TEST_DIR}" && cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")
physical_of_type() {
  aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
    --query "StackResources[?ResourceType==\`$1\`].PhysicalResourceId | [0]" --output text
}
VPC_ID="$(physical_of_type AWS::EC2::VPC)"
INSTANCE_ID="$(physical_of_type AWS::EC2::Instance)"
NAT_ID="$(physical_of_type AWS::EC2::NatGateway)"
echo "[verify] step 3 ok: vpc=${VPC_ID} instance=${INSTANCE_ID} nat=${NAT_ID}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"
PLAIN_IMPORT="$(sed 's/\x1b\[[0-9;]*m//g' "${WORK}/import.log")"
SUMMARY="$(printf '%s\n' "${PLAIN_IMPORT}" | grep -E '^Summary: ' | tail -1)"
if [ -z "${SUMMARY}" ]; then
  echo "[verify] FAIL: the import printed no 'Summary:' line (its wording changed?)"
  exit 1
fi
echo "[verify] import ${SUMMARY}"
if ! printf '%s' "${SUMMARY}" | grep -q ' 0 not found' || ! printf '%s' "${SUMMARY}" | grep -q ' 0 failed'; then
  printf '%s\n' "${PLAIN_IMPORT}" | grep -E 'no matching AWS resource|failed' || true
  echo "[verify] FAIL: the import did not adopt every resource (issue #3661)"
  exit 1
fi
if printf '%s' "${PLAIN_IMPORT}" | grep -q 'Failed to resolve intrinsics'; then
  echo "[verify] FAIL: the import left an unresolved intrinsic"
  exit 1
fi
echo "[verify] step 4 ok"

echo "[verify] step 5: cdkd deploy with an unchanged template"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy.log"
# cdkd colours every resource line, so strip ANSI before matching the row.
if sed 's/\x1b\[[0-9;]*m//g' "${WORK}/deploy.log" | grep -qE '✓ .* (created|updated|deleted)'; then
  echo "[verify] FAIL: an unchanged deploy after the migration created, updated or deleted resources (issue #3661)"
  exit 1
fi
echo "[verify] step 5 ok: nothing created, updated or deleted"

echo "[verify] step 6: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
# Terminated instances stay listed for a while, so probe the STATE instead.
INSTANCE_STATE="$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" --query 'Reservations[0].Instances[0].State.Name' --output text)"
case "${INSTANCE_STATE}" in
  terminated|shutting-down) ;;
  *) echo "[verify] FAIL: instance ${INSTANCE_ID} is ${INSTANCE_STATE} after destroy"; exit 1 ;;
esac
NAT_STATE="$(aws ec2 describe-nat-gateways --nat-gateway-ids "${NAT_ID}" --region "${REGION}" --query 'NatGateways[0].State' --output text)"
case "${NAT_STATE}" in
  deleted|deleting) ;;
  *) echo "[verify] FAIL: NAT gateway ${NAT_ID} is ${NAT_STATE} after destroy"; exit 1 ;;
esac
assert_gone "vpc ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 6 ok: resources and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
