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
# #1160 (reset-on-removal): DeletionProtection + EnableIAMDatabaseAuthentication
# are SET on the SecurityCluster in phase 1 and DROPPED in the phase-2 UPDATE
# pass (CDKD_TEST_UPDATE=true). ModifyDBCluster has merge semantics (an absent
# input field means "no change"), so before the #1160 fix the removed fields
# silently kept their old live values — worst case DeletionProtection, which
# would make the destroy fail. Phase 2 asserts both reset to their CFn
# defaults (false / false) via DescribeDBClusters.
#
# #2204 (--remove-protection compensation): phase 2b turns DeletionProtection
# back ON out of band, adds an out-of-band member instance to the
# SecurityCluster so DeleteDBCluster refuses TERMINALLY, runs
# `cdkd destroy --remove-protection` (which must fail) and asserts the guard
# is back ON — cdkd turned it off and the delete failed, so cdkd must restore
# it. The phase-3 destroy then passes --remove-protection too.
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
# Phase 2b's out-of-band cluster member (issue #2204). Not in cdkd state, so no
# cdkd destroy removes it: cleanup deletes it FIRST, or the SecurityCluster
# (and the VPC under it) cannot be deleted. Set just before the create.
OOB_INSTANCE_ID=""
# Phase 2b's captured destroy output; removed by cleanup too, since a signal
# landing mid-destroy never reaches the phase's own `rm`.
DESTROY_2B_LOG=""

# Delete the out-of-band member and wait for it to be gone. One still
# `creating` refuses the delete, so wait for `available` first.
delete_oob_instance() { # usage: delete_oob_instance <instance id>
  aws rds wait db-instance-available --db-instance-identifier "$1" --region "${REGION}" || true
  aws rds delete-db-instance --db-instance-identifier "$1" --region "${REGION}" >/dev/null || return 1
  aws rds wait db-instance-deleted --db-instance-identifier "$1" --region "${REGION}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS RDS resources"
  # Do NOT silence stderr on `state destroy` — a partial-failure (e.g. a VPC
  # dependency still 'deleting' from an in-flight DBCluster) silently leaves
  # orphan resources otherwise. See PR #735 retrospective. The stdout-piped
  # calls below ARE allowed to be silent: the redundant delete is best-effort
  # (state destroy already handled it on the happy path) and the `s3 rm`
  # calls are expected to NotFound after state destroy succeeds.
  set +eu
  [ -n "${DESTROY_2B_LOG}" ] && rm -f "${DESTROY_2B_LOG}"
  if [ -n "${OOB_INSTANCE_ID}" ]; then
    delete_oob_instance "${OOB_INSTANCE_ID}" || true
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # --remove-protection: an aborted run can leave the phase-1
    # DeletionProtection=true live on the SecurityCluster (#1160 fixture
    # shape); idempotent when protection is already off.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --remove-protection \
      --yes
  fi
  if [ -n "${DB_CLUSTER_ID}" ]; then
    # Best-effort flip-off before the redundant raw delete — a protected
    # cluster (aborted between phases 1 and 2) refuses delete-db-cluster.
    aws rds modify-db-cluster \
      --db-cluster-identifier "${DB_CLUSTER_ID}" \
      --region "${REGION}" \
      --no-deletion-protection \
      --apply-immediately >/dev/null 2>&1 || true
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

# DeletionProtection: SET true by the phase-1 template (#1160 removable
# field). Same false-vs-null jq trap — use the explicit-presence check.
ACTUAL_PROTECTION=$(echo "${CLUSTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
if [ "${ACTUAL_PROTECTION}" != "true" ]; then
  echo "FAIL: base DBCluster DeletionProtection is '${ACTUAL_PROTECTION}', expected 'true'" >&2
  exit 1
fi
echo "    OK: base DBCluster DeletionProtection == true (#1160 phase-1 field set)"

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

# --- Phase 2: UPDATE pass (#1160 reset-on-removal) --------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (DROP DeletionProtection + EnableIAMDatabaseAuthentication)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# The removed fields must have reset to their CFn defaults (false / false),
# NOT kept the phase-1 values (the merge-semantics silent drop #1160 closes).
# DeletionProtection applies immediately; the IAM-auth flip can leave the
# cluster briefly 'modifying', so poll until the cluster settles back to
# 'available' with both fields reset (also guards the destroy below against
# an InvalidDBClusterState race).
echo "==> Waiting for the SecurityCluster to settle with both #1160 fields reset"
RESET_OK=""
for _ in $(seq 1 60); do
  AFTER=$(aws rds describe-db-clusters \
    --db-cluster-identifier "${DB_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json)
  AFTER_STATUS=$(echo "${AFTER}" | jq -r '.Status // "null"')
  AFTER_PROTECTION=$(echo "${AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
  AFTER_IAM=$(echo "${AFTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
  if [ "${AFTER_STATUS}" = "available" ] && [ "${AFTER_PROTECTION}" = "false" ] && [ "${AFTER_IAM}" = "false" ]; then
    RESET_OK="yes"
    break
  fi
  sleep 10
done
if [ -z "${RESET_OK}" ]; then
  echo "FAIL: after removal, SecurityCluster did not settle to DeletionProtection=false + IAMDatabaseAuthenticationEnabled=false (status='${AFTER_STATUS}', protection='${AFTER_PROTECTION}', iamAuth='${AFTER_IAM}') — #1160 ModifyDBCluster reset-on-removal NOT closed" >&2
  exit 1
fi
echo "    OK: after removal, AWS reset DeletionProtection=false + IAMDatabaseAuthenticationEnabled=false (#1160 silent-drop CLOSED)"

# --- Phase 2b: --remove-protection compensation (issue #2204) ---------
# The failure has to be TERMINAL (a retryable one is retried, and a sequence
# that exhausts its attempts is a deliberate non-compensated case) and has to
# land AFTER the flip but BEFORE AWS accepts the delete. A cluster member cdkd
# does not own gives exactly that: cdkd flips the SecurityCluster's guard off
# and DeleteDBCluster refuses (InvalidDBClusterStateFault, "still contains DB
# instances"), which matches no retryable pattern.
#
# The discriminator is the READBACK, not cdkd's output: before #2204 the flip
# was never undone, so the cluster reads DeletionProtection=false here.
#
# COST, stated so a slow run is not read as a hang. cdkd's destroy has no
# per-resource target and its level loop does not stop at a failure, so this
# destroy deletes everything it can (the L2 AuroraCluster, the proxy family,
# both IAM roles) and keeps going below the refused SecurityCluster. Its
# subnet group, the shared SG, the subnets and the VPC are still held by the
# out-of-band member's ENI and answer DependencyViolation, which the EC2
# provider and the destroy loop both retry: expect this phase to add tens of
# minutes. The failure-set assertion below proves nothing ELSE failed along
# the way, and phase 3 deletes what is left.
echo "==> Phase 2b: --remove-protection compensation after a terminal delete failure (issue #2204)"
aws rds modify-db-cluster --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" --deletion-protection --apply-immediately >/dev/null

cluster_protection() { # usage: cluster_protection <cluster id>
  local out
  out=$(aws rds describe-db-clusters --db-cluster-identifier "$1" \
    --region "${REGION}" --query 'DBClusters[0]' --output json) || return 1
  echo "${out}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end'
}
# PREMISE: the guard is ON before the destroy. A guard that was already off
# must be LEFT off, so without this "false afterwards" would be correct.
PRE_PROTECTION=$(cluster_protection "${DB_CLUSTER_ID}")
if [ "${PRE_PROTECTION}" != "true" ]; then
  echo "FAIL: phase 2b premise: DeletionProtection is '${PRE_PROTECTION}' before the destroy, expected 'true'" >&2
  exit 1
fi

# The destroy below deletes SecurityMonitoringRole (a lower DAG level than the
# refused cluster), after which phase 3 has to MODIFY a cluster whose
# MonitoringRoleArn names a role that no longer exists. Turn Enhanced
# Monitoring off first, so phase 3's flip and cleanup's raw flip-off never
# depend on RDS accepting a cluster in that state. The #609 monitoring
# assertions ran in phase 1, so nothing later reads these fields.
aws rds modify-db-cluster --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" --monitoring-interval 0 --apply-immediately >/dev/null
aws rds wait db-cluster-available --db-cluster-identifier "${DB_CLUSTER_ID}" --region "${REGION}"

# A run-unique name, so a leftover from an aborted run cannot collide. The id
# is recorded BEFORE the create: a create AWS accepted but the CLI reported as
# failed must still be deleted by cleanup (deleting an absent one is absorbed).
OOB_INSTANCE_ID="cdkd-ra-oob-member-$(date +%s)"
aws rds create-db-instance --db-instance-identifier "${OOB_INSTANCE_ID}" \
  --db-instance-class db.serverless --engine aurora-postgresql \
  --db-cluster-identifier "${DB_CLUSTER_ID}" --region "${REGION}" >/dev/null
# Waiting takes the create's own timing out of the arm, and cleanup can only
# delete an available member anyway.
aws rds wait db-instance-available --db-instance-identifier "${OOB_INSTANCE_ID}" --region "${REGION}"

DESTROY_2B_LOG="$(mktemp)"
if node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force \
  --remove-protection >"${DESTROY_2B_LOG}" 2>&1; then
  cat "${DESTROY_2B_LOG}" >&2
  echo "FAIL: phase 2b destroy exited 0; the SecurityCluster still holds an out-of-band member, so DeleteDBCluster must refuse" >&2
  exit 1
fi
DESTROY_2B_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DESTROY_2B_LOG}")"
rm -f "${DESTROY_2B_LOG}"
DESTROY_2B_LOG=""
printf '%s\n' "${DESTROY_2B_PLAIN}" >&2
# PREMISE: the failure is the engineered one. A destroy that died before the
# flip leaves the guard ON too, which would pass the readback while testing
# nothing.
if ! grep -qE 'still contains DB instances|non-deleting state' <<<"${DESTROY_2B_PLAIN}"; then
  echo "FAIL: phase 2b destroy failed, but not with DeleteDBCluster's member refusal -- the arm did not reach the compensation" >&2
  exit 1
fi
# The FAILURE SET: the SecurityCluster, and nothing but it and what the
# out-of-band member's ENI holds (its subnet group, the shared SG, the VPC and
# its subnets). Anything else failing here would otherwise be absorbed silently
# by phase 3's destroy.
FAILED_2B="$(printf '%s\n' "${DESTROY_2B_PLAIN}" | sed -n 's/^.*✗ Failed to delete \([A-Za-z0-9]*\):.*$/\1/p' | sort -u)"
if ! printf '%s\n' "${FAILED_2B}" | grep -qx SecurityCluster; then
  echo "FAIL: phase 2b: SecurityCluster is not among the failed deletes (got: $(printf '%s ' ${FAILED_2B}))" >&2
  exit 1
fi
UNEXPECTED_2B="$(printf '%s\n' "${FAILED_2B}" | grep -vE '^(SecurityCluster|SecuritySubnetGroup|AuroraSecurityGroup[0-9A-F]{8}|AuroraVpc[A-Za-z0-9]*)$' || true)"
if [ -n "${UNEXPECTED_2B}" ]; then
  echo "FAIL: phase 2b: deletes failed outside the engineered set: $(printf '%s ' ${UNEXPECTED_2B})" >&2
  exit 1
fi

POST_PROTECTION=""
for i in $(seq 1 12); do
  POST_PROTECTION=$(cluster_protection "${DB_CLUSTER_ID}")
  [ "${POST_PROTECTION}" = "true" ] && break
  if [ "${i}" -lt 12 ]; then
    sleep 5
  fi
done
if [ "${POST_PROTECTION}" != "true" ]; then
  echo "FAIL: phase 2b: a failed destroy left DeletionProtection='${POST_PROTECTION}' on ${DB_CLUSTER_ID} (expected true) -- the --remove-protection flip was not compensated (issue #2204)" >&2
  exit 1
fi
# The narration's sentinel is the readback above: a restored guard with no
# line means the wording drifted, not the behavior.
if ! grep -qF -- "--remove-protection had turned DeletionProtection off, so it was re-enabled on ${DB_CLUSTER_ID}." <<<"${DESTROY_2B_PLAIN}"; then
  echo "FAIL: phase 2b: DeletionProtection is back ON, but no restore line names ${DB_CLUSTER_ID} -- the compensation wording drifted" >&2
  exit 1
fi
echo "    OK: SecurityCluster DeletionProtection restored after the terminal delete failure (#2204)"

delete_oob_instance "${OOB_INSTANCE_ID}"
OOB_INSTANCE_ID=""
echo "    OK: out-of-band member deleted"

# --- Phase 3: destroy -------------------------------------------------
# --remove-protection: phase 2b left the SecurityCluster's guard ON, so this is
# also the flip's live SUCCESS path. The #1160 reset is proven by phase 2's
# readback above.
echo "==> Phase 3: destroy --remove-protection (phase 2b left the guard ON)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force \
  --remove-protection

# RDS Delete* is async: resources linger in 'deleting' for a few minutes
# before describe returns *NotFoundFault. cdkd's delete path waits for the
# terminal NotFound, but the post-delete S3 state cleanup is the verifiable
# signal here.
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Spot-check the security cluster is gone or in 'deleting'.
if gone_probe aws rds describe-db-clusters --db-cluster-identifier "${DB_CLUSTER_ID}" --region "${REGION}"; then
  CLUSTER_STATUS="gone"
elif ! CLUSTER_STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "${DB_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0].Status' --output text 2>&1); then
  # TOCTOU: the cluster can vanish between gone_probe and this requery.
  printf '%s' "${CLUSTER_STATUS}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && CLUSTER_STATUS="gone" \
    || { echo "FAIL: describe-db-clusters requery undetermined: ${CLUSTER_STATUS}" >&2; exit 1; }
fi
if [ "${CLUSTER_STATUS}" = "gone" ] || [ "${CLUSTER_STATUS}" = "deleting" ]; then
  echo "    OK: SecurityCluster is gone or deleting (status: ${CLUSTER_STATUS})"
else
  echo "FAIL: SecurityCluster still in unexpected state after destroy: ${CLUSTER_STATUS}" >&2
  exit 1
fi

echo ""
echo "=== PASS: RDS Aurora integ + #609 DBCluster security backfill + #1160 reset-on-removal ==="
