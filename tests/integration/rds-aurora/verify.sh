#!/usr/bin/env bash
# verify.sh — cdkd RDS Aurora integ test (issue #609 DBCluster security backfill).
#
# The rds-aurora fixture deploys an Aurora Serverless v2 L2 cluster + writer
# instance + DBProxy / DBProxyEndpoint family AND a standalone L1
# `rds.CfnDBCluster` ("SecurityCluster") added for the #609 DBCluster
# silent-drop security backfill (this fixture absorbed the DBCluster half of
# the former standalone `rds-security-backfill` fixture per the "do not
# proliferate per-property integ fixtures" directive).
#
# This script asserts that the SecurityCluster's #609 security props each
# reach AWS after `cdkd deploy` — each was a silent-drop before #609:
#   ManageMasterUserPassword / MasterUserSecret / MonitoringRoleArn /
#   MonitoringInterval / EnableIAMDatabaseAuthentication
#   — asserted via DescribeDBClusters (MonitoringRoleArn deploy also proves the #794 IAM-race retry).
#
# The SecurityCluster is also asserted to carry `provisionedBy=sdk` in cdkd
# state — a routing guard proving none of the set props flipped the resource
# to the Cloud Control path (which would make the SDK-provider verification
# meaningless). Also asserts the destroy path cleans up the whole stack.
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
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="RdsAuroraStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

EXPECTED_MONITORING_INTERVAL=60
EXPECTED_IAM_AUTH="true"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Auto-generated physical name; resolved from cdkd state after deploy.
DB_CLUSTER_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS RDS resources"
  # Do NOT silence stderr on `state destroy` — a partial-failure (e.g. a VPC
  # dependency still 'deleting' from an in-flight DBCluster) silently leaves
  # orphan resources otherwise. See PR #735 retrospective. The stdout-piped
  # calls below ARE allowed to be silent: the redundant delete is best-effort
  # (state destroy already handled it on the happy path) and the `s3 rm`
  # calls are expected to NotFound after state destroy succeeds.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" \
      --yes
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

# Resolve the security cluster's auto-generated identifier from cdkd state.
# The fixture's only L1 CfnDBCluster is the SecurityCluster; the L2
# DatabaseCluster also produces an AWS::RDS::DBCluster, so select by logical
# id stem ('SecurityCluster') to disambiguate.
DB_CLUSTER_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("SecurityCluster"))) | .value.physicalId] | first // ""')
if [ -z "${DB_CLUSTER_ID}" ] || [ "${DB_CLUSTER_ID}" = "null" ]; then
  echo "FAIL: could not resolve the SecurityCluster DBCluster identifier from state" >&2
  echo "${STATE}" | jq '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | {key, physicalId: .value.physicalId}]'
  exit 1
fi
echo "    resolved SecurityCluster identifier: ${DB_CLUSTER_ID}"

# --- Routing guard: the SecurityCluster must be SDK-provisioned -------
# If any set prop were still a silent-drop, #614 routing would flip the
# resource to the Cloud Control path (provisionedBy=cc-api) and the
# SDK-provider assertions below would prove nothing.
CLUSTER_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("SecurityCluster"))) | .value.provisionedBy] | first // "sdk"')
if [ "${CLUSTER_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: SecurityCluster routed via '${CLUSTER_PROVISIONED_BY}', expected 'sdk' (a set prop is still a silent-drop → CC-API routing)" >&2
  exit 1
fi
echo "    OK: SecurityCluster provisionedBy=sdk (no silent-drop CC-API flip)"

# --- Assertions: DBCluster security props reached AWS -----------------
CLUSTER=$(aws rds describe-db-clusters \
  --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0]' --output json 2>/dev/null)
if [ -z "${CLUSTER}" ] || [ "${CLUSTER}" = "null" ]; then
  echo "FAIL: DescribeDBClusters returned empty for ${DB_CLUSTER_ID}" >&2
  exit 1
fi

# MonitoringInterval: Enhanced Monitoring interval in seconds (fixture sets 60;
# AWS default is 0). A silent-drop would leave AWS at 0. This deploying cleanly
# is also the real-AWS proof of the #794 retry fix (the same-stack monitoring
# role races IAM propagation on the cluster create; the deploy engine now
# retries on the ENHANCED_MONITORING signal until it propagates).
ACTUAL_INTERVAL=$(echo "${CLUSTER}" | jq -r '.MonitoringInterval // "null"')
if [ "${ACTUAL_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: DBCluster MonitoringInterval is '${ACTUAL_INTERVAL}', expected '${EXPECTED_MONITORING_INTERVAL}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster MonitoringInterval == ${EXPECTED_MONITORING_INTERVAL} (silent-drop CLOSED by #609; #794 retry survived the IAM race)"

# MonitoringRoleArn: present and non-empty proves the role ARN rode the create.
ACTUAL_ROLE=$(echo "${CLUSTER}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${ACTUAL_ROLE}" = "null" ] || [ -z "${ACTUAL_ROLE}" ]; then
  echo "FAIL: DBCluster MonitoringRoleArn is empty (MonitoringRoleArn silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster MonitoringRoleArn == ${ACTUAL_ROLE} (silent-drop CLOSED by #609)"

# EnableIAMDatabaseAuthentication: AWS surfaces it as
# IAMDatabaseAuthenticationEnabled. Use the explicit-presence check —
# jq's `//` treats `false` as missing (alternative-on-null-or-false).
ACTUAL_IAM=$(echo "${CLUSTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${ACTUAL_IAM}" != "${EXPECTED_IAM_AUTH}" ]; then
  echo "FAIL: DBCluster IAMDatabaseAuthenticationEnabled is '${ACTUAL_IAM}', expected '${EXPECTED_IAM_AUTH}' (silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DBCluster EnableIAMDatabaseAuthentication == ${EXPECTED_IAM_AUTH} (silent-drop CLOSED by #609)"

# NOTE: PubliclyAccessible is NOT asserted — AWS rejects it for aurora-postgresql
# ("PubliclyAccessible isn't supported for DB engine aurora-postgresql"); it is
# valid only for Multi-AZ DB clusters (non-Aurora). The provider wiring is
# correct + unit-tested; a real-AWS assertion would need a Multi-AZ DB cluster
# fixture (deferred). See the fixture comment for the full rationale.

# ManageMasterUserPassword + MasterUserSecret: a managed master password is
# reflected by a populated MasterUserSecret (with SecretArn + KmsKeyId).
# Without ManageMasterUserPassword the create would have failed outright
# (no MasterUserPassword was supplied — they are mutually exclusive), so a
# populated secret proves both props rode.
ACTUAL_SECRET=$(echo "${CLUSTER}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${ACTUAL_SECRET}" = "null" ] || [ -z "${ACTUAL_SECRET}" ]; then
  echo "FAIL: DBCluster MasterUserSecret.SecretArn is empty (ManageMasterUserPassword / MasterUserSecret silent-drop NOT closed)" >&2
  echo "${CLUSTER}" | jq '.MasterUserSecret'
  exit 1
fi
echo "    OK: DBCluster MasterUserSecret populated (${ACTUAL_SECRET}); ManageMasterUserPassword + MasterUserSecret CLOSED by #609"

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
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Spot-check the security cluster is gone or in 'deleting'.
CLUSTER_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null || echo "gone")
if [ "${CLUSTER_STATUS}" = "gone" ] || [ "${CLUSTER_STATUS}" = "deleting" ]; then
  echo "    OK: SecurityCluster is gone or deleting (status: ${CLUSTER_STATUS})"
else
  echo "FAIL: SecurityCluster still in unexpected state after destroy: ${CLUSTER_STATUS}" >&2
  exit 1
fi

echo ""
echo "=== PASS: RDS Aurora integ + #609 DBCluster security backfill ==="
