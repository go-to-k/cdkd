#!/usr/bin/env bash
# verify.sh — cdkd RDS::DBInstance 6-property backfill integ test
# (issue #609).
#
# Asserts that a standalone (non-cluster) RDS Postgres DBInstance whose
# template sets the 6 sibling-of-DBCluster properties has each one reach
# AWS after `cdkd deploy` — each was a silent-drop before #609. The 5
# AWS-readable ones (DeletionProtection / EngineVersion / Port /
# StorageEncrypted / VPCSecurityGroups) are asserted via DescribeDBInstances;
# MasterUserPassword is not AWS-readable (RDS never returns it), so we
# assert the paired MasterUsername reached AWS as a credibility proxy
# that the create payload was accepted. Also asserts the destroy path
# cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="RdsDbInstanceBackfillStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

EXPECTED_ENGINE_VERSION="17.4"
EXPECTED_PORT=5433
EXPECTED_DELETION_PROTECTION="false"
EXPECTED_STORAGE_ENCRYPTED="true"
EXPECTED_MASTER_USERNAME="postgres"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# The fixture's DBInstance has no explicit instanceIdentifier, so CDK
# auto-generates the physical name; resolve it from cdkd state after deploy.
DB_INSTANCE_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS DBInstance"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${DB_INSTANCE_ID}" ]; then
    aws rds delete-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
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

# Resolve the auto-generated DBInstance identifier from cdkd state.
DB_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.physicalId] | first // ""')
if [ -z "${DB_INSTANCE_ID}" ] || [ "${DB_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBInstance identifier from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved DBInstance identifier: ${DB_INSTANCE_ID}"

# Resolve the expected VPC security group id from state so the assertion
# can compare against the real generated id (no hardcoded sg-XXX needed).
EXPECTED_SG=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | first // ""')
if [ -z "${EXPECTED_SG}" ] || [ "${EXPECTED_SG}" = "null" ]; then
  echo "FAIL: could not resolve SecurityGroup id from state" >&2
  exit 1
fi
echo "    expected VPC security group: ${EXPECTED_SG}"

# --- Assertion: 5 AWS-readable props reached AWS ----------------------
# DescribeDBInstances returns every prop the create payload accepted;
# verifying each one proves the silent-drop is closed by the #609 backfill.
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeDBInstances returned empty for ${DB_INSTANCE_ID}" >&2
  exit 1
fi

# EngineVersion: the create-time payload's literal string, returned as-is.
ACTUAL_ENGINE_VERSION=$(echo "${INSTANCE}" | jq -r '.EngineVersion // "null"')
if [ "${ACTUAL_ENGINE_VERSION}" != "${EXPECTED_ENGINE_VERSION}" ]; then
  echo "FAIL: EngineVersion is '${ACTUAL_ENGINE_VERSION}', expected '${EXPECTED_ENGINE_VERSION}' (EngineVersion silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.EngineVersion'
  exit 1
fi
echo "    OK: EngineVersion == ${EXPECTED_ENGINE_VERSION} on AWS (EngineVersion silent-drop CLOSED by #609)"

# Port: Postgres default is 5432; the fixture sets 5433.
# DescribeDBInstances surfaces the active port at Endpoint.Port (NOT a
# top-level field) — matching the readback's source.
ACTUAL_PORT=$(echo "${INSTANCE}" | jq -r '.Endpoint.Port // "null"')
if [ "${ACTUAL_PORT}" != "${EXPECTED_PORT}" ]; then
  echo "FAIL: Endpoint.Port is '${ACTUAL_PORT}', expected '${EXPECTED_PORT}' (Port silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.Endpoint'
  exit 1
fi
echo "    OK: Endpoint.Port == ${EXPECTED_PORT} on AWS (Port silent-drop CLOSED by #609)"

# DeletionProtection: explicit false from the template. Pre-#609 this
# would have defaulted to false too, so it is the weakest signal of the
# 5 — kept for completeness but not load-bearing.
ACTUAL_DELETION_PROTECTION=$(echo "${INSTANCE}" | jq -r '.DeletionProtection // "null"')
if [ "${ACTUAL_DELETION_PROTECTION}" != "${EXPECTED_DELETION_PROTECTION}" ]; then
  echo "FAIL: DeletionProtection is '${ACTUAL_DELETION_PROTECTION}', expected '${EXPECTED_DELETION_PROTECTION}'" >&2
  exit 1
fi
echo "    OK: DeletionProtection == ${EXPECTED_DELETION_PROTECTION} on AWS"

# StorageEncrypted: RDS default is false for db.t3.micro Postgres;
# the fixture sets true. A silent-drop would leave AWS at false.
ACTUAL_STORAGE_ENCRYPTED=$(echo "${INSTANCE}" | jq -r '.StorageEncrypted // "null"')
if [ "${ACTUAL_STORAGE_ENCRYPTED}" != "${EXPECTED_STORAGE_ENCRYPTED}" ]; then
  echo "FAIL: StorageEncrypted is '${ACTUAL_STORAGE_ENCRYPTED}', expected '${EXPECTED_STORAGE_ENCRYPTED}' (StorageEncrypted silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: StorageEncrypted == ${EXPECTED_STORAGE_ENCRYPTED} on AWS (StorageEncrypted silent-drop CLOSED by #609)"

# VPCSecurityGroups: AWS returns VpcSecurityGroups[].VpcSecurityGroupId.
# A silent-drop would have AWS assign the VPC's default SG (different id).
ACTUAL_SGS=$(echo "${INSTANCE}" | jq -r '[.VpcSecurityGroups[]?.VpcSecurityGroupId] | sort | join(",")')
if [ "${ACTUAL_SGS}" != "${EXPECTED_SG}" ]; then
  echo "FAIL: VpcSecurityGroups is '${ACTUAL_SGS}', expected '${EXPECTED_SG}' (VPCSecurityGroups silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.VpcSecurityGroups'
  exit 1
fi
echo "    OK: VpcSecurityGroups == [${EXPECTED_SG}] on AWS (VPCSecurityGroups silent-drop CLOSED by #609)"

# MasterUserPassword: AWS does not return it. Assert MasterUsername
# (paired create-time prop) reached AWS as a credibility proxy that
# the create payload was accepted with the explicit-credentials shape.
# Without the backfill, MasterUserPassword would be silent-dropped and
# the create call would fail outright with "MasterUserPassword required"
# — so reaching `available` AT ALL implicitly proves the password rode.
ACTUAL_MASTER_USERNAME=$(echo "${INSTANCE}" | jq -r '.MasterUsername // "null"')
if [ "${ACTUAL_MASTER_USERNAME}" != "${EXPECTED_MASTER_USERNAME}" ]; then
  echo "FAIL: MasterUsername is '${ACTUAL_MASTER_USERNAME}', expected '${EXPECTED_MASTER_USERNAME}'" >&2
  exit 1
fi
echo "    OK: MasterUsername == ${EXPECTED_MASTER_USERNAME} on AWS"
echo "    OK: MasterUserPassword (not AWS-readable) implicitly verified — create reached 'available' (MasterUserPassword silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# RDS DeleteDBInstance is async: the instance lingers in 'deleting' for
# a few minutes before describe returns DBInstanceNotFoundFault. cdkd's
# delete path waits for the terminal NotFound, but the post-delete S3
# state cleanup is the verifiable signal here.
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# Spot-check the DBInstance is also gone or in 'deleting'.
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

echo ""
echo "=== PASS: RDS::DBInstance #609 6-prop backfill integ ==="
