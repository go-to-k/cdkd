#!/usr/bin/env bash
# verify.sh — cdkd RDS::DBInstance backfill integ test (issue #609).
#
# Asserts that a standalone (non-cluster) RDS Postgres DBInstance whose
# template sets the #609 sibling-of-DBCluster properties has each one reach
# AWS after `cdkd deploy` — each was a silent-drop before #609.
#
# Original (#738) properties (AWS-readable):
#   DeletionProtection / EngineVersion / Port / StorageEncrypted /
#   VPCSecurityGroups / MasterUsername — asserted via DescribeDBInstances.
#
# Folded-in security properties (this fixture absorbed the former standalone
# `rds-security-backfill` fixture per the "do not proliferate per-property
# integ fixtures" directive):
#   KmsKeyId / MasterUserSecret / ManageMasterUserPassword /
#   MonitoringRoleArn / MonitoringInterval / EnableIAMDatabaseAuthentication
#   — also asserted via DescribeDBInstances.
#
# The credentials shape changed when folding in the security props: the
# managed-master-password (ManageMasterUserPassword) is mutually exclusive
# with a literal MasterUserPassword, so this fixture sets NO password and
# proves the managed credential rode via the populated MasterUserSecret
# read-back (a credibility proxy that the explicit-managed-credential create
# payload was accepted).
#
# The DBInstance is also asserted to carry `provisionedBy=sdk` in cdkd state
# — a routing guard proving none of the set props flipped the resource to
# the Cloud Control path (which would make the SDK-provider verification
# meaningless). Also asserts the destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="RdsDbInstanceBackfillStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

EXPECTED_ENGINE_VERSION="17.6"
EXPECTED_PORT=5433
EXPECTED_DELETION_PROTECTION="false"
EXPECTED_STORAGE_ENCRYPTED="true"
EXPECTED_MASTER_USERNAME="postgres"
EXPECTED_MONITORING_INTERVAL=60
EXPECTED_IAM_AUTH="true"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The fixture's DBInstance has no explicit instanceIdentifier, so CDK
# auto-generates the physical name; resolve it from cdkd state after deploy.
DB_INSTANCE_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS DBInstance"
  # Do NOT silence stderr on `state destroy` — a partial-failure (e.g.
  # VPC dependency still in 'deleting' from a prior in-flight DBInstance)
  # silently leaves orphan resources behind otherwise. See PR #735
  # retrospective. The two stdout-piped calls below ARE allowed to be
  # silent: the redundant `delete-db-instance` is best-effort (state
  # destroy already handled it on the happy path), and the `s3 rm`
  # calls are expected to NotFound after state destroy succeeds.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Pass --state-bucket explicitly so the cdk.json default placeholder
    # ('your-cdkd-state-bucket') does not poison state destroy with a
    # bogus bucket name — every other integ fixture's cdk.json carries
    # the same placeholder, so the env-var passthrough is load-bearing
    # for any cleanup that needs to find the test's actual state.
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
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Routing guard: the DBInstance must be SDK-provisioned ------------
# If any set prop were still a silent-drop, #614 routing would flip the
# resource to the Cloud Control path (provisionedBy=cc-api) and the
# SDK-provider assertions below would prove nothing.
INST_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.provisionedBy] | first // "sdk"')
if [ "${INST_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: DBInstance routed via '${INST_PROVISIONED_BY}', expected 'sdk' (a set prop is still a silent-drop → CC-API routing)" >&2
  exit 1
fi
echo "    OK: DBInstance provisionedBy=sdk (no silent-drop CC-API flip)"

# --- Assertion: AWS-readable props reached AWS ------------------------
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
# asserted props — kept for completeness but not load-bearing.
# NOTE: use `tostring` instead of `// "null"` because jq's `//` operator
# treats `false` as a missing value (it's the "alternative-on-null-or-false"
# operator), so an explicit `false` from AWS would falsely register as `null`.
ACTUAL_DELETION_PROTECTION=$(echo "${INSTANCE}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
if [ "${ACTUAL_DELETION_PROTECTION}" != "${EXPECTED_DELETION_PROTECTION}" ]; then
  echo "FAIL: DeletionProtection is '${ACTUAL_DELETION_PROTECTION}', expected '${EXPECTED_DELETION_PROTECTION}'" >&2
  exit 1
fi
echo "    OK: DeletionProtection == ${EXPECTED_DELETION_PROTECTION} on AWS"

# StorageEncrypted: RDS default is false for db.t3.micro Postgres;
# the fixture sets true. A silent-drop would leave AWS at false.
# Same `false`-vs-null trap as DeletionProtection above — use the
# explicit-presence check.
ACTUAL_STORAGE_ENCRYPTED=$(echo "${INSTANCE}" | jq -r 'if has("StorageEncrypted") then .StorageEncrypted | tostring else "null" end')
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

# MasterUsername: AWS-required paired create-time prop, returned as-is.
ACTUAL_MASTER_USERNAME=$(echo "${INSTANCE}" | jq -r '.MasterUsername // "null"')
if [ "${ACTUAL_MASTER_USERNAME}" != "${EXPECTED_MASTER_USERNAME}" ]; then
  echo "FAIL: MasterUsername is '${ACTUAL_MASTER_USERNAME}', expected '${EXPECTED_MASTER_USERNAME}'" >&2
  exit 1
fi
echo "    OK: MasterUsername == ${EXPECTED_MASTER_USERNAME} on AWS"

# --- Assertions: folded-in #609 security props reached AWS ------------
# MonitoringInterval: Enhanced Monitoring interval in seconds (fixture sets
# 60; AWS default is 0). A silent-drop would leave AWS at 0.
ACTUAL_INTERVAL=$(echo "${INSTANCE}" | jq -r '.MonitoringInterval // "null"')
if [ "${ACTUAL_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: MonitoringInterval is '${ACTUAL_INTERVAL}', expected '${EXPECTED_MONITORING_INTERVAL}' (MonitoringInterval silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: MonitoringInterval == ${EXPECTED_MONITORING_INTERVAL} on AWS (silent-drop CLOSED by #609)"

# MonitoringRoleArn: present and non-empty proves the role ARN rode the create.
ACTUAL_MON_ROLE=$(echo "${INSTANCE}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${ACTUAL_MON_ROLE}" = "null" ] || [ -z "${ACTUAL_MON_ROLE}" ]; then
  echo "FAIL: MonitoringRoleArn is empty (MonitoringRoleArn silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: MonitoringRoleArn == ${ACTUAL_MON_ROLE} on AWS (silent-drop CLOSED by #609)"

# EnableIAMDatabaseAuthentication: AWS surfaces it as
# IAMDatabaseAuthenticationEnabled. Same false-vs-null trap as above —
# use the explicit-presence check (jq `//` treats false as missing).
ACTUAL_IAM_AUTH=$(echo "${INSTANCE}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${ACTUAL_IAM_AUTH}" != "${EXPECTED_IAM_AUTH}" ]; then
  echo "FAIL: IAMDatabaseAuthenticationEnabled is '${ACTUAL_IAM_AUTH}', expected '${EXPECTED_IAM_AUTH}' (EnableIAMDatabaseAuthentication silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: EnableIAMDatabaseAuthentication == ${EXPECTED_IAM_AUTH} on AWS (silent-drop CLOSED by #609)"

# KmsKeyId: storage-encryption key. With StorageEncrypted=true + the
# aws/rds alias, AWS resolves and returns a key ARN. Non-empty proves the
# create payload carried KmsKeyId.
ACTUAL_KMS=$(echo "${INSTANCE}" | jq -r '.KmsKeyId // "null"')
if [ "${ACTUAL_KMS}" = "null" ] || [ -z "${ACTUAL_KMS}" ]; then
  echo "FAIL: KmsKeyId is empty (KmsKeyId / StorageEncrypted silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: KmsKeyId == ${ACTUAL_KMS} on AWS (silent-drop CLOSED by #609)"

# ManageMasterUserPassword + MasterUserSecret: a managed master password is
# reflected by a populated MasterUserSecret (with SecretArn + KmsKeyId).
# Without ManageMasterUserPassword the create would have failed outright
# (no MasterUserPassword was supplied — they are mutually exclusive), so a
# populated secret proves both props rode.
ACTUAL_SECRET=$(echo "${INSTANCE}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${ACTUAL_SECRET}" = "null" ] || [ -z "${ACTUAL_SECRET}" ]; then
  echo "FAIL: MasterUserSecret.SecretArn is empty (ManageMasterUserPassword / MasterUserSecret silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.MasterUserSecret'
  exit 1
fi
echo "    OK: MasterUserSecret populated (${ACTUAL_SECRET}); ManageMasterUserPassword + MasterUserSecret CLOSED by #609"

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
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
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
echo "=== PASS: RDS::DBInstance #609 backfill integ (base + folded-in security props) ==="
