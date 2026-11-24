#!/usr/bin/env bash
# verify.sh — cdkd --no-wait and a Fn::GetAtt of an RDS instance's endpoint
# (go-to-k/cdkd#6940, rule 1).
#
# Phase 1 deploys with --no-wait. The RDS instance's create returns while it
# is `creating`, so its record lacks `Endpoint.Address` / `Endpoint.Port`. An
# echo custom resource and an Output reference them. Asserted: the deploy
# succeeds and prints the GetAtt's readiness wait for the instance, the
# instance is on the SDK provider and `available`, the echoed address and port
# and the Output equal DescribeDBInstances, and the record now holds the
# endpoint. Before #6940 the references were refused and the deploy failed.
#
# Phase 2 destroys and asserts every resource and the state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Runtime: ~15 min (RDS instance create + delete).

set -euo pipefail

export AWS_PAGER=""

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

STACK="CdkdNoWaitGetattRdsEndpointExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
NAME="cdkdnowaitgetattrdsendpointexample"
DB_ID="${NAME}-db"
DB_SUBNETS="${NAME}-db"
FUNCTION_NAME="${STACK}-echo"
ROLE_NAME="${STACK}-echo"
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
VPC_NAME="${STACK}-vpc"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${DEPLOY_LOG}"
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # By name, for what no state of this run holds: the instance first, then
  # its subnet group, then the VPC by its Name tag (RDS releases the
  # instance's network interfaces some minutes after the delete).
  aws rds delete-db-instance --region "${REGION}" --db-instance-identifier "${DB_ID}" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted --region "${REGION}" --db-instance-identifier "${DB_ID}" >/dev/null 2>&1
  aws rds delete-db-subnet-group --region "${REGION}" --db-subnet-group-name "${DB_SUBNETS}" >/dev/null 2>&1
  for vpc in $(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${VPC_NAME}" \
    --query 'Vpcs[].VpcId' --output text); do
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" \
      --query 'Subnets[].SubnetId' --output text); do
      for _ in $(seq 1 40); do
        aws ec2 delete-subnet --region "${REGION}" --subnet-id "${subnet}" >/dev/null 2>&1 && break
        sleep 30
      done
    done
    aws ec2 delete-vpc --region "${REGION}" --vpc-id "${vpc}" >/dev/null 2>&1
  done
  aws lambda delete-function --region "${REGION}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first (vp run build)" >&2; exit 1; }

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"; }

# --- Phase 1: deploy with --no-wait ----------------------------------------
echo "==> Phase 1: deploy --no-wait"
DEPLOY_LOG="$(mktemp)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes --no-wait 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: the --no-wait deploy failed (before #6940 the endpoint references were refused)" >&2
  exit 1
fi
DEPLOY_OUT="$(cat "${DEPLOY_LOG}")"
if ! grep -qE 'Db \(AWS::RDS::DBInstance\), whose readiness wait --no-wait skipped: Fn::GetAtt' <<<"${DEPLOY_OUT}"; then
  echo "FAIL: the deploy printed no Fn::GetAtt readiness wait for the RDS instance" >&2
  exit 1
fi
echo "    OK: the endpoint reference waited for the instance --no-wait had not waited for"

STATE="$(state_json)"
ROUTE="$(jq -r '.resources.Db.provisionedBy // "<absent>"' <<<"${STATE}")"
if [ "${ROUTE}" != "sdk" ]; then
  echo "FAIL: the RDS instance was provisioned by '${ROUTE}', not the SDK provider (Cloud Control waits itself)" >&2
  exit 1
fi
echo "    OK: RDS instance provisioned by the SDK provider"

DB="$(aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}" \
  --query 'DBInstances[0]' --output json)"
LIVE_ADDRESS="$(jq -r '.Endpoint.Address // empty' <<<"${DB}")"
LIVE_PORT="$(jq -r '.Endpoint.Port // empty' <<<"${DB}")"
[ "$(jq -r '.DBInstanceStatus' <<<"${DB}")" = "available" ] || { echo "FAIL: ${DB_ID} is not available: ${DB}" >&2; exit 1; }
[ -n "${LIVE_ADDRESS}" ] || { echo "FAIL: RDS reports no endpoint for ${DB_ID}" >&2; exit 1; }

ECHO="$(jq -r '.outputs.Echo // empty' <<<"${STATE}")"
[ -n "${ECHO}" ] || { echo "FAIL: no Echo output" >&2; exit 1; }
if [ "$(jq -r '.Address' <<<"${ECHO}")" != "${LIVE_ADDRESS}" ] || [ "$(jq -r '.Port' <<<"${ECHO}")" != "${LIVE_PORT}" ]; then
  echo "FAIL: echoed endpoint ${ECHO}, RDS reports ${LIVE_ADDRESS}:${LIVE_PORT}" >&2
  exit 1
fi
echo "    OK: the custom resource received ${LIVE_ADDRESS}:${LIVE_PORT}"
OUTPUT_ADDRESS="$(jq -r '.outputs.DbEndpointAddress // empty' <<<"${STATE}")"
[ "${OUTPUT_ADDRESS}" = "${LIVE_ADDRESS}" ] || { echo "FAIL: DbEndpointAddress output '${OUTPUT_ADDRESS}'" >&2; exit 1; }
echo "    OK: the Output DbEndpointAddress is the endpoint"
RECORDED="$(jq -r '.resources.Db.attributes["Endpoint.Address"] // empty' <<<"${STATE}")"
[ "${RECORDED}" = "${LIVE_ADDRESS}" ] || { echo "FAIL: the record holds Endpoint.Address '${RECORDED}'" >&2; exit 1; }
echo "    OK: the read after the wait is on the record"
VPC_ID="$(jq -r '.outputs.VpcId // empty' <<<"${STATE}")"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output '${VPC_ID}'" >&2; exit 1 ;; esac

# --- Phase 2: destroy -------------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "DB instance ${DB_ID} still exists after destroy" aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "${DB_ID}"
assert_gone "RDS subnet group ${DB_SUBNETS} still exists after destroy" aws rds describe-db-subnet-groups --region "${REGION}" --db-subnet-group-name "${DB_SUBNETS}"
assert_gone "echo function ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --region "${REGION}" --function-name "${FUNCTION_NAME}"
assert_gone "echo role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
if [ "$(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "${LOG_GROUP}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP}'])" --output text)" != "0" ]; then
  echo "FAIL: log group ${LOG_GROUP} still exists after destroy" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: instance, subnet group, VPC, function, role, log group and state gone"

echo ""
echo "[verify] PASS — no-wait-getatt-rds-endpoint: under --no-wait a Fn::GetAtt of the RDS instance's endpoint waited for the instance and served RDS's endpoint"
