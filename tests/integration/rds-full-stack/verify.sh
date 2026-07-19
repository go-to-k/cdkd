#!/usr/bin/env bash
# verify.sh - cdkd rds-full-stack integ test.
#
# Stresses a realistic single-instance RDS deployment and the consumption of
# the DBInstance's COMPUTED endpoint address via Fn::GetAtt:
#
#   VPC (natGateways:0, isolated subnets)
#     + explicit DBSubnetGroup
#     + explicit DBParameterGroup (with a non-default `application_name`)
#     + explicit SecurityGroup
#     + L2 rds.DatabaseInstance (db.t3.micro, single-AZ, deletionProtection
#       false, RemovalPolicy DESTROY, CDK-managed Secrets Manager creds)
#     + SSM StringParameter whose value is
#       Fn::GetAtt(<Database>, Endpoint.Address)
#
# What this proves (the angle the two existing RDS fixtures do NOT cover):
#   1. ORDERING: cdkd creates the SubnetGroup + ParameterGroup + SG before the
#      instance (Ref edges), and the SSM Parameter only AFTER the instance is
#      available (the parameter Refs the instance's computed endpoint).
#   2. SLOW-CREATE PROPAGATION: the DBInstance takes ~5-10 min to become
#      available; cdkd must wait for it and read back the endpoint attribute.
#   3. GETATT OF A COMPUTED ATTRIBUTE: the SSM parameter value must equal the
#      LIVE DescribeDBInstances endpoint address. If cdkd resolved the GetAtt
#      before the instance was available (empty endpoint) or parallelized the
#      parameter against the instance, the value would be empty / wrong.
#   4. The instance uses OUR explicit DBSubnetGroup + DBParameterGroup (not the
#      engine defaults).
#
# This integ is SLOW by RDS nature (~5-10 min create, a few min delete) -
# that is acceptable and expected.
#
# Resource identification: the explicit DBSubnetGroup / DBParameterGroup are
# CDK-auto-named (no physical name set), so they are resolved from cdkd state
# after deploy. The SSM parameter has an explicit name. RDS DBInstance/group
# tagging is not relied on; cdkd:integ-fixture tag is added where cheap.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdRdsFullStackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

SSM_PARAM_NAME="/cdkd/rds-full-stack/db-endpoint"
EXPECTED_APP_NAME="cdkd-rds-full-stack"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Physical ids resolved from cdkd state after deploy; used by the trap so a
# partial-failure run still cleans up in the RDS-safe order.
DB_INSTANCE_ID=""
DB_SUBNET_GROUP=""
DB_PARAM_GROUP=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS RDS resources"
  # Do NOT silence stderr on `state destroy` - a partial-failure (e.g. a VPC
  # dependency still 'deleting' from an in-flight DBInstance) silently leaves
  # orphan resources otherwise. The redundant per-resource deletes below ARE
  # allowed to be silent: they are best-effort (state destroy already handled
  # them on the happy path) and the `s3 rm` calls are expected to NotFound
  # after a successful state destroy.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
  fi

  # RDS teardown ORDER is load-bearing: the instance must be deleted (and gone)
  # BEFORE its DBSubnetGroup / DBParameterGroup can be deleted, and the SG /
  # VPC can only go after the instance releases its ENIs. So: delete the
  # instance first + wait for it to disappear, then the groups.
  if [ -n "${DB_INSTANCE_ID}" ]; then
    aws rds delete-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null 2>&1
    # Best-effort wait (bounded by the waiter's own default ~30min cap) so the
    # subnet/param group deletes below do not fail with InvalidDBSubnetGroup
    # StateFault / still-in-use. Ignored if the instance is already gone.
    aws rds wait db-instance-deleted \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${DB_SUBNET_GROUP}" ]; then
    aws rds delete-db-subnet-group \
      --db-subnet-group-name "${DB_SUBNET_GROUP}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${DB_PARAM_GROUP}" ]; then
    aws rds delete-db-parameter-group \
      --db-parameter-group-name "${DB_PARAM_GROUP}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  # The SSM parameter has a deterministic name - clean it directly.
  aws ssm delete-parameter \
    --name "${SSM_PARAM_NAME}" \
    --region "${REGION}" >/dev/null 2>&1

  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary (RDS create is ~5-10 min - be patient)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes; then
  echo "FAIL: deploy failed for ${STACK}" >&2
  # On a deploy failure, dump the state (if any) so the failing resource +
  # error is visible for triage.
  echo "--- cdkd state (if any) for triage ---" >&2
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq '.' >&2 || echo "(no state file)" >&2
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve physical ids from state (for assertions AND the trap).
DB_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.physicalId] | first // ""')
DB_SUBNET_GROUP=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBSubnetGroup") | .value.physicalId] | first // ""')
DB_PARAM_GROUP=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup") | .value.physicalId] | first // ""')

if [ -z "${DB_INSTANCE_ID}" ] || [ "${DB_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBInstance identifier from state" >&2
  echo "${STATE}" | jq '[.resources | to_entries[] | {key, type: .value.resourceType, physicalId: .value.physicalId}]' >&2
  exit 1
fi
if [ -z "${DB_SUBNET_GROUP}" ] || [ "${DB_SUBNET_GROUP}" = "null" ]; then
  echo "FAIL: could not resolve DBSubnetGroup name from state" >&2
  exit 1
fi
if [ -z "${DB_PARAM_GROUP}" ] || [ "${DB_PARAM_GROUP}" = "null" ]; then
  echo "FAIL: could not resolve DBParameterGroup name from state" >&2
  exit 1
fi
echo "    resolved DBInstance:      ${DB_INSTANCE_ID}"
echo "    resolved DBSubnetGroup:   ${DB_SUBNET_GROUP}"
echo "    resolved DBParameterGroup: ${DB_PARAM_GROUP}"

# --- Assertion 1: the instance exists + uses our groups ---------------
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeDBInstances returned empty for ${DB_INSTANCE_ID}" >&2
  exit 1
fi

# The instance must reference OUR explicit DBSubnetGroup (not a default).
ACTUAL_SUBNET_GROUP=$(echo "${INSTANCE}" | jq -r '.DBSubnetGroup.DBSubnetGroupName // "null"')
if [ "${ACTUAL_SUBNET_GROUP}" != "${DB_SUBNET_GROUP}" ]; then
  echo "FAIL: DBInstance subnet group is '${ACTUAL_SUBNET_GROUP}', expected '${DB_SUBNET_GROUP}' (custom subnet group not applied)" >&2
  exit 1
fi
echo "    OK: DBInstance uses the custom DBSubnetGroup (${ACTUAL_SUBNET_GROUP})"

# The instance must reference OUR explicit DBParameterGroup. AWS surfaces the
# group(s) under DBParameterGroups[].DBParameterGroupName.
ACTUAL_PARAM_GROUP=$(echo "${INSTANCE}" | jq -r '[.DBParameterGroups[]?.DBParameterGroupName] | index("'"${DB_PARAM_GROUP}"'") // "missing"')
if [ "${ACTUAL_PARAM_GROUP}" = "missing" ] || [ "${ACTUAL_PARAM_GROUP}" = "null" ]; then
  echo "FAIL: DBInstance is not using the custom DBParameterGroup '${DB_PARAM_GROUP}'" >&2
  echo "${INSTANCE}" | jq '.DBParameterGroups' >&2
  exit 1
fi
echo "    OK: DBInstance uses the custom DBParameterGroup (${DB_PARAM_GROUP})"

# Belt-and-suspenders: the custom parameter group carries our non-default
# `application_name` value (proves the explicit group was created with our
# parameters, not just attached by name).
ACTUAL_APP_NAME=$(aws rds describe-db-parameters \
  --db-parameter-group-name "${DB_PARAM_GROUP}" \
  --region "${REGION}" \
  --query "Parameters[?ParameterName=='application_name'].ParameterValue | [0]" \
  --output json 2>/dev/null | jq -r '. // "null"')
if [ "${ACTUAL_APP_NAME}" != "${EXPECTED_APP_NAME}" ]; then
  echo "FAIL: DBParameterGroup application_name is '${ACTUAL_APP_NAME}', expected '${EXPECTED_APP_NAME}'" >&2
  exit 1
fi
echo "    OK: DBParameterGroup application_name == ${EXPECTED_APP_NAME}"

# --- Assertion 2: the computed endpoint resolved into the SSM param ---
# This is the load-bearing assertion: the SSM parameter value must equal the
# LIVE DescribeDBInstances endpoint address. Proves Fn::GetAtt of the computed
# Endpoint.Address resolved post-create.
LIVE_ENDPOINT=$(echo "${INSTANCE}" | jq -r '.Endpoint.Address // "null"')
if [ "${LIVE_ENDPOINT}" = "null" ] || [ -z "${LIVE_ENDPOINT}" ]; then
  echo "FAIL: DescribeDBInstances returned no Endpoint.Address for ${DB_INSTANCE_ID}" >&2
  exit 1
fi
echo "    live DBInstance endpoint: ${LIVE_ENDPOINT}"

SSM_VALUE=$(aws ssm get-parameter \
  --name "${SSM_PARAM_NAME}" \
  --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "")
if [ -z "${SSM_VALUE}" ]; then
  echo "FAIL: SSM parameter ${SSM_PARAM_NAME} not found or empty after deploy" >&2
  exit 1
fi
if [ "${SSM_VALUE}" != "${LIVE_ENDPOINT}" ]; then
  echo "FAIL: SSM parameter value '${SSM_VALUE}' != live DB endpoint '${LIVE_ENDPOINT}'" >&2
  echo "       (Fn::GetAtt(<DBInstance>, Endpoint.Address) did NOT resolve to the computed endpoint)" >&2
  exit 1
fi
echo "    OK: SSM parameter value == live DB endpoint (computed Fn::GetAtt resolved post-create)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy (RDS delete is slow - allow a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# State file must be gone after a clean destroy.
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# DBInstance must be gone or in 'deleting'. RDS Delete* is async; cdkd's delete
# path waits for the terminal NotFound, so a clean destroy leaves it gone.
INSTANCE_STATUS=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "gone")
if [ "${INSTANCE_STATUS}" = "gone" ] || [ "${INSTANCE_STATUS}" = "deleting" ]; then
  echo "    OK: DBInstance is gone or deleting (status: ${INSTANCE_STATUS})"
else
  echo "FAIL: DBInstance still in unexpected state after destroy: ${INSTANCE_STATUS}" >&2
  exit 1
fi

# DBSubnetGroup must be gone.
if aws rds describe-db-subnet-groups \
  --db-subnet-group-name "${DB_SUBNET_GROUP}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: DBSubnetGroup ${DB_SUBNET_GROUP} still exists after destroy" >&2
  exit 1
fi
echo "    OK: DBSubnetGroup is gone"

# DBParameterGroup must be gone.
if aws rds describe-db-parameter-groups \
  --db-parameter-group-name "${DB_PARAM_GROUP}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: DBParameterGroup ${DB_PARAM_GROUP} still exists after destroy" >&2
  exit 1
fi
echo "    OK: DBParameterGroup is gone"

# SSM parameter must be gone.
if aws ssm get-parameter \
  --name "${SSM_PARAM_NAME}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${SSM_PARAM_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: SSM parameter is gone"

echo ""
echo "[verify] PASS"
echo "=== PASS: rds-full-stack integ (custom subnet/param groups + GetAtt computed endpoint) ==="
