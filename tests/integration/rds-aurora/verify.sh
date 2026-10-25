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
# #5004 (removal KEEPS the live value, as CloudFormation does): DeletionProtection
# + EnableIAMDatabaseAuthentication are SET on the SecurityCluster in phase 1 and
# DROPPED in the phase-2 UPDATE pass (CDKD_TEST_UPDATE=true). A real
# CloudFormation A/B (#5004) showed CFn KEEPS both on removal, and
# ModifyDBCluster treats an absent field as "no change", so cdkd sends no
# reset. Phase 2 asserts both are STILL true via DescribeDBClusters; the
# destroys pass --remove-protection because protection is retained.
# A companion change drops BackupRetentionPeriod (7 in phase 1), which
# CloudFormation RESETS to 1: asserting the reset BEFORE the keeps proves
# ModifyDBCluster fired in the removal deploy.
# #1160 (VpcSecurityGroupIds removal): phase 2 also drops the SecurityCluster's
# VpcSecurityGroupIds. A real CloudFormation A/B showed CloudFormation moves
# the cluster to the VPC's `default` security group, so phase 2 asserts that.
# #1160 (Port / monitoring / managed-password removal): phase 2 also drops
# Port (reset to 5432), MonitoringInterval + MonitoringRoleArn (kept), and
# ManageMasterUserPassword + MasterUserSecret with a MasterUserPassword added
# (managed password turned off), each as CloudFormation does (A/B on #1160).
#
# #1160 (DBProxy removal kept + warned): the proxy sets DebugLogging=true in
# phase 1 and DROPS it in phase 2. ModifyDBProxy keeps an omitted setting and
# CloudFormation keeps it too (CFn A/B on issue #1160), so cdkd sends no reset:
# phase 2 asserts the live DebugLogging is STILL true and the deploy printed
# the warning naming DebugLogging as left in place, as CloudFormation leaves it.
#
# #3993 (no Cloud Control final snapshot): the L2 AuroraCluster is routed via
# Cloud Control (asserted, so the arm cannot pass vacuously), whose registry
# delete handler took an untagged `rds-snapshot-<random>` on every delete. The
# run fails if any manual snapshot of that cluster was created after it began;
# cleanup deletes any such snapshot either way.
#
# #4030 (CloudFormation's default DeletionPolicy): the L1 SecurityCluster
# declares no DeletionPolicy (asserted), whose CloudFormation default for a
# DBCluster is Snapshot, so the phase-3 destroy must take exactly one
# `<cluster id>-final-<UTC timestamp>` snapshot; cleanup deletes it.
#
# #2204 (--remove-protection compensation): phase 2b starts with
# DeletionProtection still ON (phase 2 kept it), adds an out-of-band member instance to the
# SecurityCluster so DeleteDBCluster refuses TERMINALLY, runs
# `cdkd destroy --remove-protection` (which must fail) and asserts the guard
# is back ON — cdkd turned it off and the delete failed, so cdkd must restore
# it. The phase-3 destroy then passes --remove-protection too.
#
# #4087 (DBProxyTargetGroup is cc-broken): Cloud Control's read and delete
# handlers cannot address the type by its TargetGroupArn. Phase 1b deploys Tags
# on the proxy's target group (CDKD_TEST_TG_TAGS=v1) and asserts they reach AWS
# on the SDK route. Phase 1c rewrites the record to provisionedBy=cc-api (what a
# pre-fix binary recorded when an unhandled key routed it), then redeploys with
# changed Tags (v2): the record must flip back to sdk with the SAME physicalId,
# without a replacement, and the tag diff must land. Phase 2 drops Tags (all
# removed). Before phase 2b's destroy the record is seeded to cc-api again, so
# that destroy only passes the failure-set check if the target group is deleted
# through the SDK provider.
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
# Phase 2b's go-to-k/cdkd#2319 check: the deployments/*.jsonl keys before the
# destroy, and the RESOURCE_FAILED events read after it (AWS text: removed by
# cleanup on every exit).
EVENT_KEYS_2B=""
EVENTS_2B=""
# Phase 1c's captured deploy output (issue #4087), removed by cleanup likewise.
DEPLOY_1C_LOG=""
# Phase 2's captured deploy output (issue #1160 DBProxy arm), likewise.
DEPLOY_2_LOG=""
# Issue #3993: the L2 cluster's identifier, and when this run began (UTC,
# second precision, the prefix AWS's SnapshotCreateTime is compared on).
AURORA_CLUSTER_ID=""
RUN_START=""

# Print the manual snapshots of cluster $1 created at or after RUN_START, one
# id per line. Fails (rc 1) when the listing or a timestamp is unreadable, so
# a caller cannot read an error as "none".
this_run_cluster_snapshots() { # usage: this_run_cluster_snapshots <cluster id>
  local out
  out=$(aws rds describe-db-cluster-snapshots --db-cluster-identifier "$1" \
    --snapshot-type manual --region "${REGION}" --output json) || return 1
  echo "${out}" | jq -r --arg start "${RUN_START}" '
    .DBClusterSnapshots
    | if all(.[]; (.SnapshotCreateTime // "") | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(\\+00:00|Z)$"))
      then .[] | select(.SnapshotCreateTime[0:19] >= $start) | .DBClusterSnapshotIdentifier
      else error("unreadable SnapshotCreateTime") end'
}

# Delete the out-of-band member and wait for it to be gone. One still
# `creating` refuses the delete, so wait for `available` first.
delete_oob_instance() { # usage: delete_oob_instance <instance id>
  aws rds wait db-instance-available --db-instance-identifier "$1" --region "${REGION}" || true
  aws rds delete-db-instance --db-instance-identifier "$1" --region "${REGION}" >/dev/null || return 1
  aws rds wait db-instance-deleted --db-instance-identifier "$1" --region "${REGION}"
}

# Issue #4087 helpers. The target group's logical id, from state.
TG_TYPE="AWS::RDS::DBProxyTargetGroup"
tg_field() { # usage: tg_field <jq path under the resource, e.g. .physicalId>
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  echo "${state}" | jq -r --arg t "${TG_TYPE}" "[.resources | to_entries[] | select(.value.resourceType == \$t) | .value${1}] | first // \"\""
}
# The target group's user tags as sorted `k=v` pairs, space-joined.
tg_tags() { # usage: tg_tags <target group arn>
  aws rds list-tags-for-resource --resource-name "$1" --region "${REGION}" \
    --query "join(' ', sort(TagList[?!starts_with(Key, 'aws:')].join('=', [Key, Value]) || \`[]\`))" \
    --output text
}
# Rewrite the target group's record to provisionedBy=cc-api, the record a
# pre-fix binary wrote when an unhandled key auto-routed it to Cloud Control.
seed_tg_cc_api() {
  local state seeded
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  seeded=$(echo "${state}" | jq --arg t "${TG_TYPE}" \
    '.resources |= with_entries(if .value.resourceType == $t then .value.provisionedBy = "cc-api" else . end)') || return 1
  printf '%s\n' "${seeded}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null || return 1
  [ "$(tg_field .provisionedBy)" = "cc-api" ] || { echo "FAIL: seeding the target group record to cc-api did not stick" >&2; return 1; }
}

# This stack's deployments/*.jsonl keys, sorted, one per line (go-to-k/cdkd#2319).
# A failed listing returns non-zero, so a caller never reads an empty list as
# "no new events".
deployment_event_keys() {
  local listed
  listed="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
    --prefix "cdkd/${STACK}/${REGION}/deployments/" --output json)" || return 1
  printf '%s' "${listed}" | jq -r '.Contents // [] | .[].Key | select(endswith(".jsonl"))' | LC_ALL=C sort
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
  [ -n "${EVENT_KEYS_2B}" ] && rm -f "${EVENT_KEYS_2B}"
  [ -n "${EVENTS_2B}" ] && rm -f "${EVENTS_2B}"
  [ -n "${DEPLOY_1C_LOG}" ] && rm -f "${DEPLOY_1C_LOG}"
  [ -n "${DEPLOY_2_LOG}" ] && rm -f "${DEPLOY_2_LOG}"
  if [ -n "${OOB_INSTANCE_ID}" ]; then
    delete_oob_instance "${OOB_INSTANCE_ID}" || true
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # --remove-protection: an aborted run can leave the phase-1
    # DeletionProtection=true live on the SecurityCluster (#1160 fixture
    # shape); idempotent when protection is already off.
    # --skip-final-snapshot: the policy-less L1 resource defaults to Snapshot
    # (#4030), and a cleanup snapshot would outlive the run (RUN_START is empty
    # before the run) or be refused on a resource still `creating`.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --remove-protection \
      --skip-final-snapshot \
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
  # Issue #4030: the SecurityCluster's final snapshot from this run's destroy.
  # Older ones are not this run's to delete.
  if [ -n "${DB_CLUSTER_ID}" ] && [ -n "${RUN_START}" ]; then
    if ! SEC_SNAPS_TO_CLEAN=$(this_run_cluster_snapshots "${DB_CLUSTER_ID}"); then
      echo "    WARN: cleanup could not list the manual snapshots of ${DB_CLUSTER_ID}; check for a leftover by hand" >&2
      SEC_SNAPS_TO_CLEAN=""
    fi
    for snap in ${SEC_SNAPS_TO_CLEAN}; do
      aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier "${snap}" --region "${REGION}"
      aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${snap}" --region "${REGION}" >/dev/null \
        && echo "    cleanup: deleted this run's manual snapshot ${snap}"
    done
  fi
  # Issue #3993: a manual snapshot of the L2 cluster this run created (the
  # leak, or the reverted-fix proof). Older ones are not this run's to delete.
  if [ -n "${AURORA_CLUSTER_ID}" ] && [ -n "${RUN_START}" ]; then
    if ! SNAPS_TO_CLEAN=$(this_run_cluster_snapshots "${AURORA_CLUSTER_ID}"); then
      echo "    WARN: cleanup could not list the manual snapshots of ${AURORA_CLUSTER_ID}; check for a leftover rds-snapshot-* by hand" >&2
      SNAPS_TO_CLEAN=""
    fi
    for snap in ${SNAPS_TO_CLEAN}; do
      aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier "${snap}" --region "${REGION}"
      aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${snap}" --region "${REGION}" >/dev/null \
        && echo "    cleanup: deleted this run's manual snapshot ${snap}"
    done
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
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "==> Phase 1: deploy with the local binary (run start ${RUN_START}Z)"
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

# Issue #3993 premise: the L2 AuroraCluster must be Cloud Control-routed, or
# the no-snapshot assertion (after phase 3; phase 2b's destroy is the one that
# deletes this cluster) tests the SDK path it always passed.
AURORA_CLUSTER_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("^AuroraCluster"))) | .value.physicalId] | first // ""')
AURORA_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("^AuroraCluster"))) | .value.provisionedBy // "sdk"] | first // ""')
if [ -z "${AURORA_CLUSTER_ID}" ] || [ "${AURORA_CLUSTER_ID}" = "null" ]; then
  echo "FAIL: could not resolve the L2 AuroraCluster identifier from state" >&2
  exit 1
fi
if [ "${AURORA_PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: #3993 premise: the L2 AuroraCluster is routed via '${AURORA_PROVISIONED_BY}', expected 'cc-api'" >&2
  exit 1
fi
echo "    OK: L2 AuroraCluster ${AURORA_CLUSTER_ID} is provisionedBy=cc-api (#3993 premise)"
# Without --skip-final-snapshot the fix applies to a RECORDED
# `DeletionPolicy: Delete` only; an absent one is CloudFormation's `Snapshot`
# default, which the Cloud Control route refuses (#4030).
AURORA_DELETION_POLICY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("^AuroraCluster"))) | .value.deletionPolicy // "absent"] | first // ""')
if [ "${AURORA_DELETION_POLICY}" != "Delete" ]; then
  echo "FAIL: #3993 premise: the L2 AuroraCluster records DeletionPolicy '${AURORA_DELETION_POLICY}', expected 'Delete'" >&2
  exit 1
fi

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

# Issue #4030 premise: the L1 SecurityCluster declares NO DeletionPolicy, so
# its destroy applies CloudFormation's default for a DBCluster, Snapshot.
SEC_DELETION_POLICY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster" and (.key | test("SecurityCluster"))) | .value.deletionPolicy // "absent"] | first // ""')
if [ "${SEC_DELETION_POLICY}" != "absent" ]; then
  echo "FAIL: #4030 premise: the SecurityCluster records DeletionPolicy '${SEC_DELETION_POLICY}', expected none" >&2
  exit 1
fi
echo "    OK: SecurityCluster records no DeletionPolicy (#4030 premise)"

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

# BackupRetentionPeriod: SET to 7 by the phase-1 template (AWS default 1);
# phase 2 drops it and asserts the reset to 1 (the #5004 companion change).
ACTUAL_RETENTION=$(echo "${CLUSTER}" | jq -r '.BackupRetentionPeriod // "null"')
if [ "${ACTUAL_RETENTION}" != "7" ]; then
  echo "FAIL: base DBCluster BackupRetentionPeriod is '${ACTUAL_RETENTION}', expected '7' (phase-2 reset premise)" >&2
  exit 1
fi
echo "    OK: base DBCluster BackupRetentionPeriod == 7 (phase-2 reset premise)"

# #1160 VpcSecurityGroupIds removal premise: phase 1 puts the SecurityCluster
# on AuroraSecurityGroup, which is not the VPC's default group.
# cluster_sgs <cluster id>: "<sg id>:<status>" pairs, sorted.
cluster_sgs() {
  local out
  out=$(aws rds describe-db-clusters --db-cluster-identifier "$1" --region "${REGION}" \
    --query 'DBClusters[0].VpcSecurityGroups' --output json) || return 1
  echo "${out}" | jq -r '[(. // [])[] | "\(.VpcSecurityGroupId):\(.Status)"] | sort | join(" ")'
}
CUSTOM_SG_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup" and (.key | test("^AuroraSecurityGroup"))) | .value.physicalId] | first // ""')
SG_VPC_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // ""')
DEFAULT_SG_ID=""
if [ -n "${SG_VPC_ID}" ]; then
  DEFAULT_SG_ID=$(aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=vpc-id,Values=${SG_VPC_ID}" "Name=group-name,Values=default" \
    --query 'SecurityGroups[0].GroupId' --output text)
fi
case "${CUSTOM_SG_ID}" in sg-?*) ;; *) echo "FAIL: could not resolve AuroraSecurityGroup's id from state (got '${CUSTOM_SG_ID}')" >&2; exit 1 ;; esac
# --output text prints `None` for an empty match, so match the id shape.
case "${DEFAULT_SG_ID}" in sg-?*) ;; *) echo "FAIL: could not resolve the default security group of VPC '${SG_VPC_ID}' (got '${DEFAULT_SG_ID}')" >&2; exit 1 ;; esac
if [ "${CUSTOM_SG_ID}" = "${DEFAULT_SG_ID}" ]; then
  echo "FAIL: #1160 premise: AuroraSecurityGroup is the VPC default group, so the removal arm could not tell the two apart" >&2
  exit 1
fi
BASE_SGS=$(cluster_sgs "${DB_CLUSTER_ID}")
if [ "${BASE_SGS}" != "${CUSTOM_SG_ID}:active" ]; then
  echo "FAIL: #1160 premise: the SecurityCluster must start on AuroraSecurityGroup only (want '${CUSTOM_SG_ID}:active', got '${BASE_SGS}')" >&2
  exit 1
fi
echo "    OK: base SecurityCluster on AuroraSecurityGroup ${CUSTOM_SG_ID}, not the VPC default ${DEFAULT_SG_ID} (#1160 premise)"

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

# #1160 Port removal premise: phase 1 declares Port 5433 (the engine default
# is 5432), so phase 2's reset to the default is observable.
ACTUAL_PORT=$(echo "${CLUSTER}" | jq -r '.Port // "null"')
if [ "${ACTUAL_PORT}" != "5433" ]; then
  echo "FAIL: #1160 premise: base SecurityCluster Port is '${ACTUAL_PORT}', expected 5433" >&2
  exit 1
fi
echo "    OK: base SecurityCluster Port == 5433 (#1160 phase-2 reset premise)"

# --- Phase 1b: Tags on the DBProxyTargetGroup (issue #4087) -----------
TG_ARN=$(tg_field .physicalId)
TG_LOGICAL=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg t "${TG_TYPE}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .key] | first // ""')
case "${TG_ARN}" in
  arn:aws:rds:*:target-group:*) ;;
  *) echo "FAIL: could not resolve the DBProxyTargetGroup TargetGroupArn from state (got '${TG_ARN}')" >&2; exit 1 ;;
esac
[ -n "$(tg_tags "${TG_ARN}")" ] && { echo "FAIL: #4087 premise: the target group already carries user tags before phase 1b: $(tg_tags "${TG_ARN}")" >&2; exit 1; }

echo "==> Phase 1b: deploy Tags on the proxy target group (CDKD_TEST_TG_TAGS=v1)"
CDKD_TEST_TG_TAGS=v1 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
TG_LAYER=$(tg_field .provisionedBy)
if [ "${TG_LAYER}" != "sdk" ]; then
  echo "FAIL: #4087: Tags routed the target group via '${TG_LAYER}', expected sdk (Cloud Control cannot delete this type)" >&2
  exit 1
fi
TAGS=$(tg_tags "${TG_ARN}")
if [ "${TAGS}" != "cdkd-drop=me cdkd-team=db" ]; then
  echo "FAIL: #4087: target group tags are '${TAGS}', expected 'cdkd-drop=me cdkd-team=db'" >&2
  exit 1
fi
echo "    OK: Tags reached the target group on the SDK route (${TAGS})"

# --- Phase 1c: a cc-api record returns to the SDK provider (issue #4087) --
echo "==> Phase 1c: seed provisionedBy=cc-api, then redeploy with changed Tags (CDKD_TEST_TG_TAGS=v2)"
seed_tg_cc_api
DEPLOY_1C_LOG="$(mktemp)"
if ! CDKD_TEST_TG_TAGS=v2 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DEPLOY_1C_LOG}" 2>&1; then
  cat "${DEPLOY_1C_LOG}" >&2
  rm -f "${DEPLOY_1C_LOG}"
  echo "FAIL: #4087: the redeploy over a cc-api target group record failed" >&2
  exit 1
fi
DEPLOY_1C_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_1C_LOG}")"
rm -f "${DEPLOY_1C_LOG}"
DEPLOY_1C_LOG=""
printf '%s\n' "${DEPLOY_1C_PLAIN}"
TG_LAYER=$(tg_field .provisionedBy)
TG_ARN_AFTER=$(tg_field .physicalId)
if [ "${TG_LAYER}" != "sdk" ]; then
  echo "FAIL: #4087: the cc-api record did not flip back (provisionedBy=${TG_LAYER}, expected sdk)" >&2
  exit 1
fi
if [ "${TG_ARN_AFTER}" != "${TG_ARN}" ]; then
  echo "FAIL: #4087: the flip changed the physicalId (${TG_ARN} -> ${TG_ARN_AFTER})" >&2
  exit 1
fi
# The witness that the flip was an in-place update: no replacement line for
# the target group, and the flip announced itself. The ARN check above is
# weaker than it looks -- the proxy's `default` group keeps its ARN even
# across a replacement on the same proxy -- so the `Replacing` grep is the
# real witness, trusted because the flip line at the same info level must
# match. The announcement's
# sentinel is the flipped record above: a flip with no line means the wording
# drifted, not the behavior.
if grep -qE "Replacing ${TG_LOGICAL} " <<<"${DEPLOY_1C_PLAIN}"; then
  echo "FAIL: #4087: the flip REPLACED ${TG_LOGICAL} instead of updating it in place" >&2
  exit 1
fi
if ! grep -qF "${TG_LOGICAL} (${TG_TYPE}): moving to the SDK provider" <<<"${DEPLOY_1C_PLAIN}"; then
  echo "FAIL: #4087: the record flipped to sdk, but no 'moving to the SDK provider' line names ${TG_LOGICAL} -- the wording drifted" >&2
  exit 1
fi
TAGS=$(tg_tags "${TG_ARN}")
if [ "${TAGS}" != "cdkd-team=platform" ]; then
  echo "FAIL: #4087: after the v2 update the target group tags are '${TAGS}', expected 'cdkd-team=platform' (one changed, one removed)" >&2
  exit 1
fi
echo "    OK: the cc-api record returned to the SDK provider in place (${TG_ARN}); tag diff applied (${TAGS})"

# --- go-to-k/cdkd#3945 premise: the proxy target group before its UPDATE ---
# Re-read: phases 1b/1c above rewrote the record (Tags, the cc-api flip).
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
# Phase 2 sets MaxConnectionsPercent=90 on the proxy, which reaches AWS only
# through the DBProxyTargetGroup provider's `update()` — the method that now
# reads both DBClusterIdentifiers sides as identifier lists before any call.
PROXY_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxy") | .value.physicalId] | first // ""')
if [ -z "${PROXY_NAME}" ] || [ "${PROXY_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the DBProxy name from state" >&2
  exit 1
fi
# The target group must be SDK-routed, or phase 2 runs Cloud Control's update
# and passes without reaching the provider under test.
TG_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxyTargetGroup") | .value.provisionedBy // "sdk"] | first // ""')
if [ "${TG_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: #3945 premise: the DBProxyTargetGroup is routed via '${TG_PROVISIONED_BY}', expected 'sdk'" >&2
  exit 1
fi
# The recorded side the update will read must be the well-formed list naming
# the L2 cluster, or phase 2 proves nothing about reading one.
RECORDED_TG_CLUSTERS=$(echo "${STATE}" | jq -c '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxyTargetGroup") | .value.properties.DBClusterIdentifiers] | first')
if [ "${RECORDED_TG_CLUSTERS}" != "[\"${AURORA_CLUSTER_ID}\"]" ]; then
  echo "FAIL: #3945 premise: the DBProxyTargetGroup records DBClusterIdentifiers ${RECORDED_TG_CLUSTERS}, expected [\"${AURORA_CLUSTER_ID}\"]" >&2
  exit 1
fi
PRE_MAX_CONN=$(aws rds describe-db-proxy-target-groups --db-proxy-name "${PROXY_NAME}" \
  --target-group-name default --region "${REGION}" \
  --query 'TargetGroups[0].ConnectionPoolConfig.MaxConnectionsPercent' --output text)
if [ "${PRE_MAX_CONN}" = "90" ]; then
  echo "FAIL: #3945 premise: MaxConnectionsPercent is already 90 before phase 2, so the UPDATE arm cannot show the change landed" >&2
  exit 1
fi
echo "    OK: #3945 premise: proxy ${PROXY_NAME} target group records [${AURORA_CLUSTER_ID}], MaxConnectionsPercent=${PRE_MAX_CONN}"

# --- #1160 DBProxy removal premise: DebugLogging is set, live and recorded --
# The proxy must be SDK-routed (Cloud Control's update would never print the
# provider's warning), its record must carry DebugLogging=true (or phase 2
# removes nothing), and AWS must hold true (or "kept" is indistinguishable
# from the default false).
PROXY_LOGICAL=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxy") | .key] | first // ""')
PROXY_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxy") | .value.provisionedBy // "sdk"] | first // ""')
if [ "${PROXY_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: #1160 DBProxy premise: ${PROXY_LOGICAL} is routed via '${PROXY_PROVISIONED_BY}', expected 'sdk'" >&2
  exit 1
fi
RECORDED_DEBUG=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxy") | .value.properties | if has("DebugLogging") then .DebugLogging | tostring else "absent" end] | first // ""')
if [ "${RECORDED_DEBUG}" != "true" ]; then
  echo "FAIL: #1160 DBProxy premise: ${PROXY_LOGICAL} records DebugLogging=${RECORDED_DEBUG}, expected true" >&2
  exit 1
fi
PRE_DEBUG=$(aws rds describe-db-proxies --db-proxy-name "${PROXY_NAME}" --region "${REGION}" \
  --query 'DBProxies[0].DebugLogging' --output text)
if [ "${PRE_DEBUG}" != "True" ]; then
  echo "FAIL: #1160 DBProxy premise: live DebugLogging is '${PRE_DEBUG}' before phase 2, expected True" >&2
  exit 1
fi
echo "    OK: #1160 DBProxy premise: ${PROXY_LOGICAL} (sdk) records and holds DebugLogging=true"

# --- Phase 2: UPDATE pass (#5004 removal keeps) --------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (DROP DeletionProtection + EnableIAMDatabaseAuthentication + MonitoringInterval + MonitoringRoleArn, all KEPT; DROP Port, reset to 5432; DROP the managed password for a MasterUserPassword; drop proxy DebugLogging; set proxy MaxConnectionsPercent=90)"
DEPLOY_2_LOG="$(mktemp)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DEPLOY_2_LOG}" 2>&1; then
  cat "${DEPLOY_2_LOG}" >&2
  rm -f "${DEPLOY_2_LOG}"
  echo "FAIL: the phase-2 UPDATE deploy failed" >&2
  exit 1
fi
DEPLOY_2_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DEPLOY_2_LOG}")"
rm -f "${DEPLOY_2_LOG}"
DEPLOY_2_LOG=""
printf '%s\n' "${DEPLOY_2_PLAIN}"

# --- #1160 DBProxy removal: kept on AWS, and warned about -------------
if ! grep -qF "${PROXY_LOGICAL} (AWS::RDS::DBProxy): property DebugLogging was removed from the template and keeps its current AWS value, as CloudFormation leaves it; ModifyDBProxy keeps a setting it is not sent" <<<"${DEPLOY_2_PLAIN}"; then
  echo "FAIL: #1160: phase 2 dropped DebugLogging from ${PROXY_LOGICAL}, but the deploy printed no warning naming it as left in place" >&2
  exit 1
fi
POST_DEBUG=$(aws rds describe-db-proxies --db-proxy-name "${PROXY_NAME}" --region "${REGION}" \
  --query 'DBProxies[0].DebugLogging' --output text)
if [ "${POST_DEBUG}" != "True" ]; then
  echo "FAIL: #1160: after phase 2 dropped DebugLogging, live DebugLogging is '${POST_DEBUG}', expected True (cdkd sends no reset, as CloudFormation leaves it)" >&2
  exit 1
fi
echo "    OK: #1160: dropping DebugLogging kept the live value (True) and the deploy warned about it"

# #5004: the removed fields must be KEPT (CloudFormation keeps them on
# removal), NOT reset to false. Premise (phase 1) asserted both true above.
# Wait for the cluster to be 'available' (guards the steps below against an
# InvalidDBClusterState race), then assert both are still true. A deploy that
# wrongly sent a reset would flip them to false within this window.
echo "==> Waiting for the SecurityCluster to settle, then asserting DeletionProtection + IAM auth were KEPT (#5004)"
SETTLED=""
for _ in $(seq 1 60); do
  AFTER=$(aws rds describe-db-clusters \
    --db-cluster-identifier "${DB_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json)
  AFTER_STATUS=$(echo "${AFTER}" | jq -r '.Status // "null"')
  if [ "${AFTER_STATUS}" = "available" ]; then
    SETTLED="yes"
    break
  fi
  sleep 10
done
# Companion change: phase 2 also dropped BackupRetentionPeriod (7 in phase 1),
# which CloudFormation RESETS to 1. A live 1 proves ModifyDBCluster FIRED in this
# deploy -- asserted BEFORE the KEEP checks, so a skipped modify cannot leave the
# kept fields passing vacuously -- and pins #5004's RESET row on real AWS.
AFTER_RETENTION=$(echo "${AFTER}" | jq -r '.BackupRetentionPeriod // "null"')
if [ -z "${SETTLED}" ] || [ "${AFTER_RETENTION}" != "1" ]; then
  echo "FAIL: after phase 2 dropped BackupRetentionPeriod, the live value is '${AFTER_RETENTION}' (status='${AFTER_STATUS}'), expected 1 -- ModifyDBCluster did not fire or did not reset, so the KEEP assertions below would prove nothing (#5004)" >&2
  exit 1
fi
echo "    OK: phase 2 ModifyDBCluster fired (BackupRetentionPeriod 7 -> 1, CloudFormation's reset) -- the KEEP assertions are non-vacuous"
AFTER_PROTECTION=$(echo "${AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
AFTER_IAM=$(echo "${AFTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ -z "${SETTLED}" ] || [ "${AFTER_PROTECTION}" != "true" ] || [ "${AFTER_IAM}" != "true" ]; then
  echo "FAIL: after removal, SecurityCluster did not keep DeletionProtection=true + IAMDatabaseAuthenticationEnabled=true (status='${AFTER_STATUS}', protection='${AFTER_PROTECTION}', iamAuth='${AFTER_IAM}') — #5004: CloudFormation keeps both on removal" >&2
  exit 1
fi
echo "    OK: after removal, AWS kept DeletionProtection=true + IAMDatabaseAuthenticationEnabled=true (#5004, matches CloudFormation)"

# #1160: phase 2 removed the SecurityCluster's VpcSecurityGroupIds. It must
# move to the VPC default group, as CloudFormation does; a pre-fix cdkd sends
# nothing and the cluster stays on AuroraSecurityGroup, which fails HERE.
# Polled, because the swap can sit in `adding` / `removing` after `available`.
AFTER_SGS=""
for i in $(seq 1 30); do
  AFTER_SGS=$(cluster_sgs "${DB_CLUSTER_ID}")
  [ "${AFTER_SGS}" = "${DEFAULT_SG_ID}:active" ] && break
  if [ "${i}" -lt 30 ]; then
    sleep 10
  fi
done
if [ "${AFTER_SGS}" != "${DEFAULT_SG_ID}:active" ]; then
  echo "FAIL: #1160: after VpcSecurityGroupIds was removed, the SecurityCluster's groups are '${AFTER_SGS}', want '${DEFAULT_SG_ID}:active' (the VPC default group, as CloudFormation does; still '${CUSTOM_SG_ID}' means the removal sent nothing)" >&2
  exit 1
fi
echo "    OK: after VpcSecurityGroupIds removal, the SecurityCluster moved to the VPC default ${DEFAULT_SG_ID} (#1160, matches CloudFormation)"

# #1160 (comment 6401151077, CloudFormation A/B): phase 2 dropped Port,
# MonitoringInterval + MonitoringRoleArn, and ManageMasterUserPassword +
# MasterUserSecret (adding a MasterUserPassword). CloudFormation resets Port to
# the engine default, keeps both monitoring values, and turns the managed
# password off. A pre-fix cdkd keeps Port 5433, sends MonitoringInterval 0, and
# never sends ManageMasterUserPassword false, so each check below fails there.
# Re-read: the security-group swap above can re-settle the cluster.
AFTER=$(aws rds describe-db-clusters \
  --db-cluster-identifier "${DB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0]' --output json)
AFTER_PORT=$(echo "${AFTER}" | jq -r '.Port // "null"')
if [ "${AFTER_PORT}" != "5432" ]; then
  echo "FAIL: #1160: after Port was removed, the SecurityCluster's Port is '${AFTER_PORT}', want 5432 (CloudFormation resets it to the engine default; 5433 means the removal sent nothing)" >&2
  exit 1
fi
echo "    OK: after Port removal, the SecurityCluster is on 5432 (#1160, matches CloudFormation)"
AFTER_INTERVAL=$(echo "${AFTER}" | jq -r '.MonitoringInterval // "null"')
AFTER_ROLE=$(echo "${AFTER}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${AFTER_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ] || [ "${AFTER_ROLE}" != "${ACTUAL_ROLE}" ]; then
  echo "FAIL: #1160: after MonitoringInterval + MonitoringRoleArn were removed, the SecurityCluster has interval '${AFTER_INTERVAL}' and role '${AFTER_ROLE}', want '${EXPECTED_MONITORING_INTERVAL}' and '${ACTUAL_ROLE}' (CloudFormation keeps both; interval 0 means cdkd sent a reset)" >&2
  exit 1
fi
echo "    OK: after MonitoringInterval + MonitoringRoleArn removal, AWS kept ${AFTER_INTERVAL} and the role (#1160, matches CloudFormation)"
AFTER_SECRET=$(echo "${AFTER}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${AFTER_SECRET}" != "null" ]; then
  echo "FAIL: #1160: after ManageMasterUserPassword was removed with a MasterUserPassword added, the SecurityCluster still has the managed secret '${AFTER_SECRET}' (CloudFormation sends ManageMasterUserPassword false, which turns it off)" >&2
  exit 1
fi
echo "    OK: after ManageMasterUserPassword removal, the managed master password is off (#1160, matches CloudFormation)"

# Phase 2 sets no CDKD_TEST_TG_TAGS, so the template dropped Tags (#4087).
TAGS=$(tg_tags "${TG_ARN}")
if [ -n "${TAGS}" ]; then
  echo "FAIL: #4087: the template dropped Tags but the target group still carries '${TAGS}'" >&2
  exit 1
fi
echo "    OK: dropping Tags from the template removed them from the target group (#4087)"

# --- go-to-k/cdkd#3945: the DBProxyTargetGroup UPDATE -----------------
# The pool change landed (so `update()` ran past its list reads rather than
# refusing a well-formed list), and the cluster target is still the one
# registered: no Deregister of the real target, no stray registration.
POST_MAX_CONN=$(aws rds describe-db-proxy-target-groups --db-proxy-name "${PROXY_NAME}" \
  --target-group-name default --region "${REGION}" \
  --query 'TargetGroups[0].ConnectionPoolConfig.MaxConnectionsPercent' --output text)
if [ "${POST_MAX_CONN}" != "90" ]; then
  echo "FAIL: #3945: after phase 2, MaxConnectionsPercent is '${POST_MAX_CONN}', expected 90 -- the DBProxyTargetGroup update did not apply" >&2
  exit 1
fi
# jq over the whole list, not `--query`: the CLI applies a query per PAGE.
POST_TARGETS_JSON=$(aws rds describe-db-proxy-targets --db-proxy-name "${PROXY_NAME}" \
  --target-group-name default --region "${REGION}" --output json)
POST_CLUSTERS=$(echo "${POST_TARGETS_JSON}" | jq -c '[.Targets[] | select(.Type == "TRACKED_CLUSTER") | .RdsResourceId] | sort')
if [ "${POST_CLUSTERS}" != "[\"${AURORA_CLUSTER_ID}\"]" ]; then
  echo "FAIL: #3945: after phase 2 the proxy's cluster targets are ${POST_CLUSTERS}, expected [\"${AURORA_CLUSTER_ID}\"]" >&2
  exit 1
fi
# An instance target that is not a member of the tracked cluster is a stray
# registration (the pre-fix walk registered one-letter identifiers).
STRAY_INSTANCES=$(echo "${POST_TARGETS_JSON}" | jq -c --arg c "${AURORA_CLUSTER_ID}" '[.Targets[] | select(.Type == "RDS_INSTANCE" and .TrackedClusterId != $c) | .RdsResourceId]')
if [ "${STRAY_INSTANCES}" != "[]" ]; then
  echo "FAIL: #3945: after phase 2 the proxy holds instance targets outside ${AURORA_CLUSTER_ID}: ${STRAY_INSTANCES}" >&2
  exit 1
fi
POST_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
POST_TG_CLUSTERS=$(echo "${POST_STATE}" | jq -c '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBProxyTargetGroup") | .value.properties.DBClusterIdentifiers] | first')
if [ "${POST_TG_CLUSTERS}" != "[\"${AURORA_CLUSTER_ID}\"]" ]; then
  echo "FAIL: #3945: after phase 2 the DBProxyTargetGroup records DBClusterIdentifiers ${POST_TG_CLUSTERS}, expected [\"${AURORA_CLUSTER_ID}\"]" >&2
  exit 1
fi
echo "    OK: #3945: target group update applied MaxConnectionsPercent=90; ${AURORA_CLUSTER_ID} is still the only cluster target"

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
# The guard is already ON: phase 1 set it and phase 2 KEPT it (#5004), so no
# out-of-band flip is needed; the premise check below pins it.

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

# Issue #4087: destroy a target group recorded cc-api. It must be deleted
# through the SDK provider: Cloud Control's delete fails for the type, and the
# failure-set check below admits no DBProxyTargetGroup.
seed_tg_cc_api

EVENT_KEYS_2B="$(mktemp)"
if ! deployment_event_keys > "${EVENT_KEYS_2B}"; then
  echo "FAIL: phase 2b: could not list the deployments/ prefix before the destroy" >&2
  exit 1
fi
DESTROY_2B_LOG="$(mktemp)"
if node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force \
  --remove-protection \
  --verbose >"${DESTROY_2B_LOG}" 2>&1; then
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
# nothing. The thrown wrap names AWS's error by its class only
# (go-to-k/cdkd#2319), and the same class also covers the final-snapshot
# refusal "isn't currently in the available state" (#5184), so the member
# refusal itself is read on the wrap's --verbose debug line. Both lines are
# the provider's own DeleteDBCluster catch-wrap.
if ! grep -qE "Failed to delete DBCluster SecurityCluster: InvalidDBClusterStateFault\. Re-run with --verbose" <<<"${DESTROY_2B_PLAIN}"; then
  echo "FAIL: phase 2b destroy failed, but not with the DeleteDBCluster catch-wrap (InvalidDBClusterStateFault + --verbose pointer) -- the arm did not reach the compensation" >&2
  exit 1
fi
if ! grep -qE "Failed to delete DBCluster SecurityCluster: .*(still contains DB instances|non-deleting state)" <<<"${DESTROY_2B_PLAIN}"; then
  echo "FAIL: phase 2b: DeleteDBCluster refused with InvalidDBClusterStateFault, but its --verbose line is not the member refusal (the #5184 final-snapshot race reads \"isn't currently in the available state\") -- the arm did not reach the compensation" >&2
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
# go-to-k/cdkd#2319: the failed deletes' persisted RESOURCE_FAILED events name
# AWS's refusal by its class, and deployments/*.jsonl outlives the run. The
# engineered member refusal may quote no account id, so the account-id check
# guards a regression rather than proving this change. Only this destroy's
# new event files are read, so an earlier run's events cannot answer.
EVENTS_2B="$(mktemp)"
if ! NEW_EVENT_KEYS_2B="$(deployment_event_keys | LC_ALL=C comm -13 "${EVENT_KEYS_2B}" -)"; then
  echo "FAIL: phase 2b: could not list the deployments/ prefix after the destroy" >&2
  exit 1
fi
while IFS= read -r event_key || [ -n "${event_key}" ]; do
  [ -n "${event_key}" ] || continue
  aws s3 cp "s3://${STATE_BUCKET}/${event_key}" - --quiet \
    | jq -c 'select(.eventType == "RESOURCE_FAILED")' >> "${EVENTS_2B}"
done <<< "${NEW_EVENT_KEYS_2B}"
EVENT_ACCOUNT_2B="$(aws sts get-caller-identity --query Account --output text)"
# A FAIL prints only the cdkd-authored prefix and the length: the rest may be
# AWS's text, naming accounts, roles or sessions.
# The cdkd-authored prefix of a persisted message, never AWS's text: a message
# with no colon has no prefix of cdkd's (go-to-k/cdkd#2319).
msg_prefix() { case "$1" in *:*) printf '%s' "${1%%:*}" ;; *) printf '<none>' ;; esac; }
assert_failed_event_class_only_2B() { # usage: <logicalId> <wrap prefix>
  local msg
  # One value, not a line: a message can span lines.
  msg="$(jq -rs --arg l "$1" '[.[] | select(.logicalId == $l) | .error.message // empty] | last // empty' "${EVENTS_2B}")"
  if [ -z "${msg}" ]; then
    echo "FAIL: phase 2b: the destroy persisted no RESOURCE_FAILED event with an error message for $1 (the #2319 checks below would pass for free)" >&2
    exit 1
  fi
  if ! printf '%s' "${msg}" | grep -qE "$2: [A-Za-z0-9]+\. Re-run with --verbose for AWS's own message\."; then
    echo "FAIL: phase 2b: $1's RESOURCE_FAILED message is not '$2: <ErrorClass>. Re-run with --verbose for AWS's own message.' (#2319); observed prefix: '$(msg_prefix "${msg}")', ${#msg} chars" >&2
    exit 1
  fi
  # Every FAILED event this destroy wrote for it, not only the last.
  if jq -r --arg l "$1" 'select(.logicalId == $l) | .error.message // empty' "${EVENTS_2B}" \
    | grep -F "${EVENT_ACCOUNT_2B}" >/dev/null; then
    echo "FAIL: phase 2b: $1's RESOURCE_FAILED message quotes AWS's text, with this account's id (#2319); observed prefix: '$(msg_prefix "${msg}")', ${#msg} chars" >&2
    exit 1
  fi
}
assert_failed_event_class_only_2B SecurityCluster "Failed to delete DBCluster SecurityCluster"
rm -f "${EVENTS_2B}" "${EVENT_KEYS_2B}"
EVENTS_2B=""
EVENT_KEYS_2B=""
echo "phase 2b ok: the SecurityCluster RESOURCE_FAILED event names the AWS failure by its class, with no account id"

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

# Issue #4087: the target group seeded to cc-api must have been DELETED, not
# merely absent from the failure set -- a skipped or never-attempted delete
# prints no failure line and keeps its record. State survives this destroy
# (the SecurityCluster failed), so the record's absence is readable.
TG_LEFT=$(tg_field .physicalId)
if [ -n "${TG_LEFT}" ]; then
  echo "FAIL: #4087: the cc-api DBProxyTargetGroup record survived the phase 2b destroy (${TG_LEFT}); it was not deleted through the SDK provider" >&2
  exit 1
fi
echo "    OK: the cc-api target group record was deleted through the SDK provider (#4087)"

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

# Issue #4030: the phase-3 destroy of the policy-less SecurityCluster took
# exactly one cdkd final snapshot (CloudFormation's default is Snapshot).
# Before the fix it took none. Cleanup deletes it.
if ! SEC_SNAPSHOTS=$(this_run_cluster_snapshots "${DB_CLUSTER_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${DB_CLUSTER_ID}" >&2
  exit 1
fi
SEC_FINAL_COUNT=$(printf '%s\n' "${SEC_SNAPSHOTS}" | grep -c -- "^${DB_CLUSTER_ID}-final-[0-9]\{8\}-[0-9]\{6\}$" || true)
SEC_OTHER=$(printf '%s\n' "${SEC_SNAPSHOTS}" | grep -v -- "^${DB_CLUSTER_ID}-final-" | grep -v '^$' || true)
if [ "${SEC_FINAL_COUNT}" != "1" ] || [ -n "${SEC_OTHER}" ]; then
  echo "FAIL: destroying the policy-less ${DB_CLUSTER_ID} took ${SEC_FINAL_COUNT} cdkd final snapshot(s), expected 1 (CloudFormation's default DeletionPolicy is Snapshot; #4030); this run's snapshots: $(printf '%s ' ${SEC_SNAPSHOTS})" >&2
  exit 1
fi
echo "    OK: SecurityCluster destroy took the final snapshot $(printf '%s' "${SEC_SNAPSHOTS}") (#4030; cleanup deletes it)"

# Issue #3993: phase 2b's destroy deleted the Cloud Control-routed L2 cluster.
# Before the fix its registry handler left a manual final snapshot there.
if ! LEAKED_SNAPSHOTS=$(this_run_cluster_snapshots "${AURORA_CLUSTER_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${AURORA_CLUSTER_ID}" >&2
  exit 1
fi
if [ -n "${LEAKED_SNAPSHOTS}" ]; then
  echo "FAIL: destroying the Cloud Control-routed ${AURORA_CLUSTER_ID} (DeletionPolicy: Delete) left manual snapshot(s): $(printf '%s ' ${LEAKED_SNAPSHOTS})(issue #3993)" >&2
  exit 1
fi
echo "    OK: no manual snapshot of ${AURORA_CLUSTER_ID} since ${RUN_START}Z (#3993)"

echo ""
echo "=== PASS: RDS Aurora integ + #609 DBCluster security backfill + #5004 removal keeps ==="
