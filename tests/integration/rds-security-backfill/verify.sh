#!/usr/bin/env bash
# verify.sh — cdkd RDS security-cluster backfill integ test (issue #609).
#
# Asserts that the managed-secret + Enhanced-Monitoring + IAM-auth security
# properties reach AWS after `cdkd deploy` for BOTH:
#   * AWS::RDS::DBInstance (standalone Postgres): KmsKeyId / MasterUserSecret /
#     ManageMasterUserPassword / MonitoringRoleArn / MonitoringInterval /
#     EnableIAMDatabaseAuthentication
#   * AWS::RDS::DBCluster (Aurora Serverless v2): MasterUserSecret /
#     ManageMasterUserPassword / MonitoringRoleArn / MonitoringInterval /
#     EnableIAMDatabaseAuthentication / PubliclyAccessible
#
# Each was a silent-drop before #609. Readable props are asserted via
# DescribeDBInstances / DescribeDBClusters. Both resources are also asserted
# to carry `provisionedBy=sdk` in cdkd state — a routing guard proving none
# of the set props flipped the resource to the Cloud Control path (which would
# have made the SDK-provider verification meaningless). Also asserts the
# destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="RdsSecurityBackfillStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

EXPECTED_MONITORING_INTERVAL=60
EXPECTED_IAM_AUTH="true"
EXPECTED_PUBLICLY_ACCESSIBLE="false"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# Auto-generated physical names; resolved from cdkd state after deploy.
DB_INSTANCE_ID=""
DB_CLUSTER_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS RDS resources"
  # Do NOT silence stderr on `state destroy` — a partial-failure (e.g. a VPC
  # dependency still 'deleting' from an in-flight DBInstance) silently leaves
  # orphan resources otherwise. See PR #735 retrospective. The stdout-piped
  # calls below ARE allowed to be silent: the redundant deletes are best-effort
  # (state destroy already handled them on the happy path) and the `s3 rm`
  # calls are expected to NotFound after state destroy succeeds.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${DB_INSTANCE_ID}" ]; then
    aws rds delete-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1 || true
  fi
  if [ -n "${DB_CLUSTER_ID}" ]; then
    aws rds delete-db-cluster \
      --db-cluster-identifier "${DB_CLUSTER_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the auto-generated physical identifiers from cdkd state.
DB_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.physicalId] | first // ""')
DB_CLUSTER_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | .value.physicalId] | first // ""')
if [ -z "${DB_INSTANCE_ID}" ] || [ "${DB_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBInstance identifier from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
if [ -z "${DB_CLUSTER_ID}" ] || [ "${DB_CLUSTER_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBCluster identifier from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved DBInstance identifier: ${DB_INSTANCE_ID}"
echo "    resolved DBCluster identifier: ${DB_CLUSTER_ID}"

# --- Routing guard: both resources must be SDK-provisioned ------------
# If any set prop were still a silent-drop, #614 routing would flip the
# resource to the Cloud Control path (provisionedBy=cc-api) and the
# SDK-provider assertions below would prove nothing.
INST_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.provisionedBy] | first // "sdk"')
CLUSTER_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | .value.provisionedBy] | first // "sdk"')
if [ "${INST_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: DBInstance routed via '${INST_PROVISIONED_BY}', expected 'sdk' (a set prop is still a silent-drop → CC-API routing)" >&2
  exit 1
fi
if [ "${CLUSTER_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: DBCluster routed via '${CLUSTER_PROVISIONED_BY}', expected 'sdk' (a set prop is still a silent-drop → CC-API routing)" >&2
  exit 1
fi
echo "    OK: both DBInstance and DBCluster provisionedBy=sdk (no silent-drop CC-API flip)"

# --- Assertions: DBInstance security props reached AWS ----------------
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeDBInstances returned empty for ${DB_INSTANCE_ID}" >&2
  exit 1
fi

# MonitoringInterval: Enhanced Monitoring interval in seconds (fixture sets 60;
# AWS default is 0). A silent-drop would leave AWS at 0.
ACTUAL_INST_INTERVAL=$(echo "${INSTANCE}" | jq -r '.MonitoringInterval // "null"')
if [ "${ACTUAL_INST_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: DBInstance MonitoringInterval is '${ACTUAL_INST_INTERVAL}', expected '${EXPECTED_MONITORING_INTERVAL}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBInstance MonitoringInterval == ${EXPECTED_MONITORING_INTERVAL} (silent-drop CLOSED by #609)"

# MonitoringRoleArn: present and non-empty proves the role ARN rode the create.
ACTUAL_INST_ROLE=$(echo "${INSTANCE}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${ACTUAL_INST_ROLE}" = "null" ] || [ -z "${ACTUAL_INST_ROLE}" ]; then
  echo "FAIL: DBInstance MonitoringRoleArn is empty (MonitoringRoleArn silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBInstance MonitoringRoleArn == ${ACTUAL_INST_ROLE} (silent-drop CLOSED by #609)"

# EnableIAMDatabaseAuthentication: AWS surfaces as IAMDatabaseAuthenticationEnabled.
# Use the explicit-presence check (jq `//` treats false as missing).
ACTUAL_INST_IAM=$(echo "${INSTANCE}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${ACTUAL_INST_IAM}" != "${EXPECTED_IAM_AUTH}" ]; then
  echo "FAIL: DBInstance IAMDatabaseAuthenticationEnabled is '${ACTUAL_INST_IAM}', expected '${EXPECTED_IAM_AUTH}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBInstance EnableIAMDatabaseAuthentication == ${EXPECTED_IAM_AUTH} (silent-drop CLOSED by #609)"

# KmsKeyId: storage-encryption key. With StorageEncrypted=true + the
# aws/rds alias, AWS resolves and returns a key ARN. Non-empty proves the
# create payload carried KmsKeyId.
ACTUAL_INST_KMS=$(echo "${INSTANCE}" | jq -r '.KmsKeyId // "null"')
if [ "${ACTUAL_INST_KMS}" = "null" ] || [ -z "${ACTUAL_INST_KMS}" ]; then
  echo "FAIL: DBInstance KmsKeyId is empty (KmsKeyId / StorageEncrypted silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBInstance KmsKeyId == ${ACTUAL_INST_KMS} (silent-drop CLOSED by #609)"

# ManageMasterUserPassword + MasterUserSecret: a managed master password is
# reflected by a populated MasterUserSecret (with SecretArn + KmsKeyId).
# Without ManageMasterUserPassword the create would have failed outright
# (no MasterUserPassword was supplied — they are mutually exclusive), so a
# populated secret proves both props rode.
ACTUAL_INST_SECRET=$(echo "${INSTANCE}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${ACTUAL_INST_SECRET}" = "null" ] || [ -z "${ACTUAL_INST_SECRET}" ]; then
  echo "FAIL: DBInstance MasterUserSecret.SecretArn is empty (ManageMasterUserPassword / MasterUserSecret silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.MasterUserSecret'
  exit 1
fi
echo "    OK: DBInstance MasterUserSecret populated (${ACTUAL_INST_SECRET}); ManageMasterUserPassword + MasterUserSecret CLOSED by #609"

# --- Assertions: DBCluster security props reached AWS -----------------
CLUSTER=$(aws rds describe-db-clusters \
  --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0]' --output json 2>/dev/null)
if [ -z "${CLUSTER}" ] || [ "${CLUSTER}" = "null" ]; then
  echo "FAIL: DescribeDBClusters returned empty for ${DB_CLUSTER_ID}" >&2
  exit 1
fi

ACTUAL_CLUSTER_INTERVAL=$(echo "${CLUSTER}" | jq -r '.MonitoringInterval // "null"')
if [ "${ACTUAL_CLUSTER_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: DBCluster MonitoringInterval is '${ACTUAL_CLUSTER_INTERVAL}', expected '${EXPECTED_MONITORING_INTERVAL}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster MonitoringInterval == ${EXPECTED_MONITORING_INTERVAL} (silent-drop CLOSED by #609)"

ACTUAL_CLUSTER_ROLE=$(echo "${CLUSTER}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${ACTUAL_CLUSTER_ROLE}" = "null" ] || [ -z "${ACTUAL_CLUSTER_ROLE}" ]; then
  echo "FAIL: DBCluster MonitoringRoleArn is empty (MonitoringRoleArn silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster MonitoringRoleArn == ${ACTUAL_CLUSTER_ROLE} (silent-drop CLOSED by #609)"

ACTUAL_CLUSTER_IAM=$(echo "${CLUSTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${ACTUAL_CLUSTER_IAM}" != "${EXPECTED_IAM_AUTH}" ]; then
  echo "FAIL: DBCluster IAMDatabaseAuthenticationEnabled is '${ACTUAL_CLUSTER_IAM}', expected '${EXPECTED_IAM_AUTH}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster EnableIAMDatabaseAuthentication == ${EXPECTED_IAM_AUTH} (silent-drop CLOSED by #609)"

# PubliclyAccessible: explicit false from the template (create-only on the
# cluster). With a non-default DBSubnetGroup the AWS default is false too, so
# this is a weaker signal — kept for completeness.
ACTUAL_CLUSTER_PUBLIC=$(echo "${CLUSTER}" | jq -r 'if has("PubliclyAccessible") then .PubliclyAccessible | tostring else "null" end')
if [ "${ACTUAL_CLUSTER_PUBLIC}" != "${EXPECTED_PUBLICLY_ACCESSIBLE}" ]; then
  echo "FAIL: DBCluster PubliclyAccessible is '${ACTUAL_CLUSTER_PUBLIC}', expected '${EXPECTED_PUBLICLY_ACCESSIBLE}'" >&2
  exit 1
fi
echo "    OK: DBCluster PubliclyAccessible == ${EXPECTED_PUBLICLY_ACCESSIBLE}"

ACTUAL_CLUSTER_SECRET=$(echo "${CLUSTER}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${ACTUAL_CLUSTER_SECRET}" = "null" ] || [ -z "${ACTUAL_CLUSTER_SECRET}" ]; then
  echo "FAIL: DBCluster MasterUserSecret.SecretArn is empty (ManageMasterUserPassword / MasterUserSecret silent-drop NOT closed)" >&2
  echo "${CLUSTER}" | jq '.MasterUserSecret'
  exit 1
fi
echo "    OK: DBCluster MasterUserSecret populated (${ACTUAL_CLUSTER_SECRET}); ManageMasterUserPassword + MasterUserSecret CLOSED by #609"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# RDS Delete* is async: resources linger in 'deleting' for a few minutes
# before describe returns *NotFoundFault. cdkd's delete path waits for the
# terminal NotFound, but the post-delete S3 state cleanup is the verifiable
# signal here.
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# Spot-check both resources are gone or in 'deleting'.
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

CLUSTER_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "gone")
if [ "${CLUSTER_STATUS}" = "gone" ] || [ "${CLUSTER_STATUS}" = "deleting" ]; then
  echo "    OK: DBCluster is gone or deleting (status: ${CLUSTER_STATUS})"
else
  echo "FAIL: DBCluster still in unexpected state after destroy: ${CLUSTER_STATUS}" >&2
  exit 1
fi

echo ""
echo "=== PASS: RDS security-cluster #609 backfill integ (DBCluster + DBInstance) ==="
