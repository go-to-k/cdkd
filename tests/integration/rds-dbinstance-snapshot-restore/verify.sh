#!/usr/bin/env bash
# verify.sh — cdkd RDS DB instance restores from a DB snapshot, from a
# Multi-AZ DB cluster snapshot and to a point in time (go-to-k/cdkd#5640).
#
# `AWS::RDS::DBInstance` `DBSnapshotIdentifier`, `DBClusterSnapshotIdentifier`
# and `UseLatestRestorableTime` on the SDK route. Before they were wired, cdkd
# routed such a template to Cloud Control (the keys were SDK-unwired), so
# phase 3's provisionedBy=sdk assertions are red on a binary without them.
#
# What CloudFormation's handler does (the archived
# aws-cloudformation-resource-providers-rds source, `aws-rds-dbinstance`): either
# key makes the create a RestoreDBInstanceFromDBSnapshot (the engine, when
# undeclared, read from the snapshot), then, once the instance is available, a
# ModifyDBInstance with the members the restore call has none for (the
# retention, the backup and maintenance windows, ...). A restore never sets the
# master user name or the database name: the snapshot's are kept. A
# point-in-time key makes the create a RestoreDBInstanceToPointInTime instead,
# tested BEFORE a read replica: `SourceDBInstanceIdentifier` is then the
# restore's source, and the instance is no replica.
#
# Phases:
#   1. Deploy `Source` (a db.t3.micro, database `appdb`, user `cdkdadmin`,
#      retention 1) and `SourceCluster` (a Multi-AZ DB cluster, user
#      `postgres`). provisionedBy=sdk.
#   2. Wait for `Source` to be `available` with a LatestRestorableTime (its
#      first automated backup), then take a manual snapshot of each (a
#      template cannot make one), waited to `available`.
#   3. + CDKD_TEST_PITR=true: `PitrInstance` (Source to its latest restorable
#      time, no engine declared): provisionedBy=sdk, no read replica, the
#      source's user, database and engine, the declared port and
#      MaxAllocatedStorage (restore call), the declared retention and backup
#      window (follow-up only), and `cdkd drift` lists it clean (the source
#      key is not read back).
#      CDKD_TEST_SNAPSHOT_ID + CDKD_TEST_CLUSTER_SNAPSHOT_ID: `SnapInstance`
#      (from the DB snapshot) and `ClusterSnapInstance` (from the cluster
#      snapshot). Both provisionedBy=sdk; each holds its snapshot's user name
#      and engine (neither declares an engine), the declared port (restore
#      call) and the declared retention and backup window (follow-up only).
#      `SnapInstance` also holds `appdb` (its template declares no database
#      name) and MultiAZ false, and the deploy warned that its declared
#      MasterUsername was not applied. `ClusterSnapInstance` holds the
#      cluster's io1 storage.
#   4. + CDKD_TEST_UPDATE=true: `SnapInstance` BackupRetentionPeriod 3 -> 4
#      and `PitrInstance` 2 -> 3: the same instances (DbiResourceId).
#   5. A changed DBSnapshotIdentifier, then an added RestoreTime, is refused
#      before any call ("Resource is immutable" under CloudFormation): each
#      deploy fails naming the key, and the instance and its record are
#      unchanged.
#   6. Destroy: every instance, the cluster, the subnet group, the VPC, the
#      state and the source's automated backups are gone; then the two manual
#      snapshots (not cdkd's) are deleted.
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

STACK="CdkdRdsInstanceSnapshotRestoreExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SOURCE_ID="cdkd-integ-rds-inst-src-5640"
CLUSTER_ID="cdkd-integ-rds-maz-src-5640"
SNAP_INSTANCE_ID="cdkd-integ-rds-inst-restored-5640"
CLUSTER_SNAP_INSTANCE_ID="cdkd-integ-rds-inst-from-maz-5640"
PITR_INSTANCE_ID="cdkd-integ-rds-inst-pitr-5640"
# The manual snapshots verify.sh takes (fixed: the sweep finds them).
SNAPSHOT_ID="cdkd-integ-rds-inst-manual-5640"
CLUSTER_SNAPSHOT_ID="cdkd-integ-rds-maz-manual-5640"
SUBNET_GROUP="cdkd-integ-rds-inst-snap-5640"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
WARN_LINE="MasterUsername not applied: a restore from a snapshot takes them from the snapshot"
# Sentinel: the line's opening, independent of its wording.
WARN_SENTINEL="DBInstance SnapInstance: "
REFUSAL_LINE="DBSnapshotIdentifier cannot be added or changed on an existing DB instance"
# Sentinel: the engine's update-refusal opening, independent of cdkd's reason.
REFUSAL_SENTINEL="cannot be updated in place"
PITR_REFUSAL_LINE="RestoreTime cannot be added or changed on an existing DB instance"

# Best-effort delete of one DB instance, until it is gone. The delete is
# re-sent each round: an instance still `creating`, `backing-up` or
# `modifying` (a run interrupted mid-restore or mid-follow-up) refuses it.
sweep_instance() { ( # usage: sweep_instance <instance id>
  set +eu
  for _ in $(seq 1 120); do
    out="$(aws rds describe-db-instances --db-instance-identifier "$1" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBInstanceNotFound*) exit 0 ;; esac
    aws rds modify-db-instance --db-instance-identifier "$1" --no-deletion-protection \
      --apply-immediately --region "${REGION}" >/dev/null 2>&1
    aws rds delete-db-instance --db-instance-identifier "$1" --skip-final-snapshot \
      --delete-automated-backups --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
  echo "    WARN: RDS instance $1 still present after the sweep" >&2
) }

# The same for the Multi-AZ DB cluster (its delete takes its instances).
sweep_cluster() { ( # usage: sweep_cluster <cluster id>
  set +eu
  for _ in $(seq 1 120); do
    out="$(aws rds describe-db-clusters --db-cluster-identifier "$1" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBClusterNotFound*) exit 0 ;; esac
    aws rds modify-db-cluster --db-cluster-identifier "$1" --no-deletion-protection \
      --apply-immediately --region "${REGION}" >/dev/null 2>&1
    aws rds delete-db-cluster --db-cluster-identifier "$1" \
      --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
  echo "    WARN: RDS cluster $1 still present after the sweep" >&2
) }

# Not cdkd's: verify.sh made them, so verify.sh deletes them, re-sending the
# delete until each is gone (one still `creating` refuses it), so the next
# run's create of the same name does not meet it.
sweep_snapshots() { (
  set +eu
  gone=""
  for _ in $(seq 1 60); do
    out="$(aws rds describe-db-snapshots --db-snapshot-identifier "${SNAPSHOT_ID}" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBSnapshotNotFound*) gone=1; break ;; esac
    aws rds delete-db-snapshot --db-snapshot-identifier "${SNAPSHOT_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
  [ -n "${gone}" ] || echo "    WARN: manual snapshot ${SNAPSHOT_ID} could not be deleted" >&2
  gone=""
  for _ in $(seq 1 60); do
    out="$(aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBClusterSnapshotNotFound*) gone=1; break ;; esac
    aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
  [ -n "${gone}" ] || echo "    WARN: manual cluster snapshot ${CLUSTER_SNAPSHOT_ID} could not be deleted" >&2
) }

# The automated backups an instance's delete kept (status `retained`: a delete
# without --delete-automated-backups, or a run interrupted mid-delete).
sweep_automated_backups() { (
  set +eu
  for id in "${SOURCE_ID}" "${PITR_INSTANCE_ID}"; do
    for arn in $(aws rds describe-db-instance-automated-backups --db-instance-identifier "${id}" \
      --region "${REGION}" --query 'DBInstanceAutomatedBackups[?Status==`retained`].DBInstanceAutomatedBackupsArn' \
      --output text 2>/dev/null); do
      [ "${arn}" = "None" ] && continue
      aws rds delete-db-instance-automated-backup --db-instance-automated-backups-arn "${arn}" \
        --region "${REGION}" >/dev/null 2>&1 || echo "    WARN: retained automated backup ${arn} could not be deleted" >&2
    done
  done
) }

# Best-effort teardown of a partial destroy, by fixed name and by the CDK Name
# tag: the restored instances BEFORE their sources, the sources, the
# snapshots, the subnet group, then the VPC leaf-first.
sweep() { (
  set +eu
  # The two restored instances together (each wait can take minutes), then the sources.
  sweep_instance "${SNAP_INSTANCE_ID}" &
  sweep_instance "${CLUSTER_SNAP_INSTANCE_ID}" &
  sweep_instance "${PITR_INSTANCE_ID}" &
  wait
  sweep_instance "${SOURCE_ID}" &
  sweep_cluster "${CLUSTER_ID}" &
  wait
  sweep_snapshots
  sweep_automated_backups
  aws rds delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP}" \
    --region "${REGION}" >/dev/null 2>&1
  vpc="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" --query 'Vpcs[0].VpcId' --output text 2>/dev/null)"
  if [ -n "${vpc}" ] && [ "${vpc}" != "None" ]; then
    for eni in $(aws ec2 describe-network-interfaces --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null); do
      aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${REGION}" >/dev/null 2>&1
    done
    for sg in $(aws ec2 describe-security-groups --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "RouteTables[?Associations[0].Main!=\`true\`].RouteTableId" --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    if aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1; then
      echo "    swept leftover VPC ${vpc}"
    else
      echo "    WARN: leftover VPC ${vpc} could not be deleted" >&2
    fi
  fi
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG:-}"
  if [ -f "${LOCAL_DIST}" ]; then
    CDKD_TEST_SNAPSHOT_ID="${SNAPSHOT_ID}" CDKD_TEST_CLUSTER_SNAPSHOT_ID="${CLUSTER_SNAPSHOT_ID}" \
      CDKD_TEST_PITR=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  sweep
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

instance_field() { # usage: instance_field <instance id> <query>
  aws rds describe-db-instances --db-instance-identifier "$1" \
    --region "${REGION}" --query "DBInstances[0].$2" --output text
}

assert_instance() { # usage: assert_instance <phase> <instance id> <query> <want>
  local got
  if ! got="$(instance_field "$2" "$3" 2>&1)"; then
    echo "FAIL: ${1}: reading ${2} ${3} failed: ${got}" >&2
    exit 1
  fi
  if [ "${got}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} ${3}='${got}', want '${4}'" >&2
    exit 1
  fi
}

# A record's field, read from `cdkd state show --json`.
record_field() { # usage: record_field <logical id> <provisionedBy | properties.Key>
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources[process.argv[1]];if(!r){process.exit(3)}let v=r;for(const k of process.argv[2].split("."))v=v==null?undefined:v[k];process.stdout.write(v==null?"":String(v))})' "$1" "$2"
}

assert_record() { # usage: assert_record <phase> <logical id> <field> <want>
  local got
  if ! got="$(record_field "$2" "$3")"; then
    echo "FAIL: ${1}: no state record for ${2} (or the state could not be read)" >&2
    exit 1
  fi
  if [ "${got}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} record ${3}='${got}', want '${4}'" >&2
    exit 1
  fi
}

# --- Phase 1: deploy the sources ---------------------------------------------
echo "==> Phase 1: deploy the source instance and the Multi-AZ DB cluster"
env -u CDKD_TEST_SNAPSHOT_ID -u CDKD_TEST_CLUSTER_SNAPSHOT_ID -u CDKD_TEST_UPDATE \
  -u CDKD_TEST_PITR -u CDKD_TEST_PITR_RESTORE_TIME \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_record "Phase 1" Source provisionedBy sdk
assert_record "Phase 1" SourceCluster provisionedBy sdk
assert_instance "Phase 1" "${SOURCE_ID}" MasterUsername cdkdadmin
assert_instance "Phase 1" "${SOURCE_ID}" DBName appdb
assert_instance "Phase 1" "${SOURCE_ID}" BackupRetentionPeriod 1

# --- Phase 2: the manual snapshots -------------------------------------------
# Waits until `<verb> ... --query <status>` reads `available`. Right after the
# create the read can answer not-found (eventual consistency): only that is
# waited out; any other failure is fatal.
wait_snapshot_available() { # usage: wait_snapshot_available <label> <not-found code> aws rds <verb> <args...>
  local label="$1" missing="$2" status="" out
  shift 2
  for _ in $(seq 1 120); do
    if ! out="$("$@" 2>&1)"; then
      case "${out}" in
        *"${missing}"*) status="not-found"; sleep 10; continue ;;
        *) echo "FAIL: Phase 2: reading ${label} failed: ${out}" >&2; exit 1 ;;
      esac
    fi
    status="${out}"
    [ "${status}" = "available" ] && return 0
    sleep 10
  done
  echo "FAIL: Phase 2: ${label} is '${status}' after 20 minutes, want available" >&2
  exit 1
}

# A point-in-time restore needs the source's first automated backup (a
# LatestRestorableTime), and a snapshot needs the instance `available`, which
# it leaves for `backing-up` after a create with backups.
echo "==> Phase 2: wait for ${SOURCE_ID} to be available with a latest restorable time"
SOURCE_READY=""
for _ in $(seq 1 120); do
  if ! SOURCE_READY="$(aws rds describe-db-instances --db-instance-identifier "${SOURCE_ID}" \
    --region "${REGION}" --query 'DBInstances[0].[DBInstanceStatus,LatestRestorableTime]' --output text 2>&1)"; then
    echo "FAIL: Phase 2: reading ${SOURCE_ID} failed: ${SOURCE_READY}" >&2
    exit 1
  fi
  case "${SOURCE_READY}" in available*) [[ "${SOURCE_READY}" != *None ]] && break ;; esac
  sleep 10
done
case "${SOURCE_READY}" in
  available*) [[ "${SOURCE_READY}" != *None ]] || { echo "FAIL: Phase 2: ${SOURCE_ID} has no latest restorable time after 20 minutes" >&2; exit 1; } ;;
  *) echo "FAIL: Phase 2: ${SOURCE_ID} reads '${SOURCE_READY}' after 20 minutes, want available" >&2; exit 1 ;;
esac

echo "==> Phase 2: take manual snapshots ${SNAPSHOT_ID} and ${CLUSTER_SNAPSHOT_ID}"
aws rds create-db-snapshot --db-instance-identifier "${SOURCE_ID}" \
  --db-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" >/dev/null
# A Multi-AZ DB cluster refuses a snapshot while it is not `available`
# (`backing-up` right after its create): wait that out first.
CLUSTER_STATUS=""
for _ in $(seq 1 90); do
  if ! CLUSTER_STATUS="$(aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" \
    --region "${REGION}" --query 'DBClusters[0].Status' --output text 2>&1)"; then
    echo "FAIL: Phase 2: reading cluster ${CLUSTER_ID} failed: ${CLUSTER_STATUS}" >&2
    exit 1
  fi
  [ "${CLUSTER_STATUS}" = "available" ] && break
  sleep 10
done
if [ "${CLUSTER_STATUS}" != "available" ]; then
  echo "FAIL: Phase 2: cluster ${CLUSTER_ID} is '${CLUSTER_STATUS}' after 15 minutes, want available" >&2
  exit 1
fi
aws rds create-db-cluster-snapshot --db-cluster-identifier "${CLUSTER_ID}" \
  --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" --region "${REGION}" >/dev/null
wait_snapshot_available "snapshot ${SNAPSHOT_ID}" DBSnapshotNotFound \
  aws rds describe-db-snapshots --db-snapshot-identifier "${SNAPSHOT_ID}" \
  --region "${REGION}" --query 'DBSnapshots[0].Status' --output text
wait_snapshot_available "cluster snapshot ${CLUSTER_SNAPSHOT_ID}" DBClusterSnapshotNotFound \
  aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" \
  --region "${REGION}" --query 'DBClusterSnapshots[0].Status' --output text
# What the restored instances restore from, in every later step (a mode-gated
# resource leaves the template in any step without it).
export CDKD_TEST_SNAPSHOT_ID="${SNAPSHOT_ID}"
export CDKD_TEST_CLUSTER_SNAPSHOT_ID="${CLUSTER_SNAPSHOT_ID}"
export CDKD_TEST_PITR=true
# Only phase 5's refused deploy adds a RestoreTime.
unset CDKD_TEST_PITR_RESTORE_TIME

# --- Phase 3: both restores ----------------------------------------------------
echo "==> Phase 3: restore SnapInstance (${SNAPSHOT_ID}), ClusterSnapInstance (${CLUSTER_SNAPSHOT_ID}) and PitrInstance (${SOURCE_ID}, latest restorable time)"
DEPLOY_LOG="$(mktemp)"
set +e
# A restore copies its source first: 60 minutes per instance instead of the
# create's 30 (the restore waits to the resource deadline).
env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --resource-timeout 'AWS::RDS::DBInstance=60m' \
  >"${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: Phase 3: the restore deploy exited ${DEPLOY_RC}" >&2
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
for logical in SnapInstance ClusterSnapInstance PitrInstance; do
  # The discriminator: a pre-fix binary routes these to Cloud Control.
  assert_record "Phase 3" "${logical}" provisionedBy sdk
done
# Here-strings, not pipes: under pipefail an early `grep -q` exit can SIGPIPE
# the upstream grep and read as no match.
LINES="$(grep -F "SnapInstance" "${DEPLOY_LOG}" || true)"
if ! grep -qF "${WARN_LINE}" <<<"${LINES}"; then
  if grep -qF "${WARN_SENTINEL}" <<<"${LINES}"; then
    echo "FAIL: Phase 3: the SnapInstance warning no longer reads '${WARN_LINE}' (wording drift?)" >&2
  else
    echo "FAIL: Phase 3: the deploy did not warn that SnapInstance's MasterUsername was not applied" >&2
  fi
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}"
for id in "${SNAP_INSTANCE_ID}" "${CLUSTER_SNAP_INSTANCE_ID}"; do
  assert_instance "Phase 3" "${id}" DBInstanceStatus available
  # Neither template declares an engine. RDS would take the snapshot's either
  # way, so this pins the outcome only; that cdkd reads and sends it is unit-tested.
  assert_instance "Phase 3" "${id}" Engine postgres
done
# SnapInstance: the snapshot's user and database, not the template's (none
# declared for the database): the instance was restored, not created (RDS's
# result; with provisionedBy=sdk above, the SDK route's restore made it).
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" MasterUsername cdkdadmin
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" DBName appdb
# On the restore call: the port and the flag (a restore without them keeps
# 5432 and false). MultiAZ false is RDS's result for this single-AZ source
# either way; that cdkd sends false for an undeclared MultiAZ is unit-tested.
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" Endpoint.Port 5434
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" CopyTagsToSnapshot True
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" MultiAZ False
# On the follow-up ModifyDBInstance only (the source holds retention 0).
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" BackupRetentionPeriod 3
assert_instance "Phase 3" "${SNAP_INSTANCE_ID}" PreferredBackupWindow 05:00-05:30
# ClusterSnapInstance: the cluster's user and io1 storage (its template
# declares neither), the declared port (restore call) and the declared
# retention and window (follow-up; the cluster holds retention 1).
assert_instance "Phase 3" "${CLUSTER_SNAP_INSTANCE_ID}" MasterUsername postgres
assert_instance "Phase 3" "${CLUSTER_SNAP_INSTANCE_ID}" StorageType io1
assert_instance "Phase 3" "${CLUSTER_SNAP_INSTANCE_ID}" Endpoint.Port 5435
assert_instance "Phase 3" "${CLUSTER_SNAP_INSTANCE_ID}" BackupRetentionPeriod 2
assert_instance "Phase 3" "${CLUSTER_SNAP_INSTANCE_ID}" PreferredBackupWindow 06:00-06:30
SNAP_RESOURCE_ID="$(instance_field "${SNAP_INSTANCE_ID}" DbiResourceId)"
echo "    both restored (snapshot user, engine and storage; declared port; follow-up retention and window), provisionedBy=sdk"
# PitrInstance: restored to a point in time, not made a read replica of its
# declared source (the pre-fix SDK precedence would have; the handler tests
# the point-in-time keys first), holding the source's user, database and
# engine (none declared), the restore call's port and MaxAllocatedStorage,
# and the follow-up's retention and window (the source holds 1 and 04:00).
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" DBInstanceStatus available
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" ReadReplicaSourceDBInstanceIdentifier None
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" Engine postgres
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" MasterUsername cdkdadmin
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" DBName appdb
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" Endpoint.Port 5436
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" MaxAllocatedStorage 40
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" BackupRetentionPeriod 2
assert_instance "Phase 3" "${PITR_INSTANCE_ID}" PreferredBackupWindow 07:00-07:30
PITR_RESOURCE_ID="$(instance_field "${PITR_INSTANCE_ID}" DbiResourceId)"
# Drift: RDS keeps no record of a point-in-time restore's source, so the
# recorded SourceDBInstanceIdentifier (and UseLatestRestorableTime) must not
# read as drift. Only PitrInstance's own entry is read: another resource's
# drift is not this arm's subject.
DRIFT_OUT="$(mktemp)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_OUT}"
DRIFT_RC=$?
set -e
if ! PITR_DRIFT="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=(Array.isArray(r)?r:[r])[0]||{};const in_=(k)=>(s[k]||[]).some(e=>e.logicalId==="PitrInstance");process.stdout.write(in_("clean")?"clean":in_("drifted")?"drifted: "+JSON.stringify((s.drifted||[]).find(e=>e.logicalId==="PitrInstance").changes):"absent")' "${DRIFT_OUT}" 2>&1)"; then
  echo "FAIL: Phase 3: cdkd drift --json (rc ${DRIFT_RC}) printed no readable report: ${PITR_DRIFT}" >&2
  head -c 2000 "${DRIFT_OUT}" >&2
  exit 1
fi
rm -f "${DRIFT_OUT}"
if [ "${PITR_DRIFT}" != "clean" ]; then
  echo "FAIL: Phase 3: cdkd drift lists PitrInstance as '${PITR_DRIFT}', want clean" >&2
  exit 1
fi
echo "    PitrInstance restored to a point in time (no replica; source user, database, engine; declared port, MaxAllocatedStorage; follow-up retention and window), drift clean"

# --- Phase 4: an in-place update of a restored instance ----------------------
echo "==> Phase 4: SnapInstance BackupRetentionPeriod 3 -> 4, PitrInstance 2 -> 3"
CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_instance "Phase 4" "${SNAP_INSTANCE_ID}" DbiResourceId "${SNAP_RESOURCE_ID}"
assert_instance "Phase 4" "${SNAP_INSTANCE_ID}" BackupRetentionPeriod 4
assert_record "Phase 4" SnapInstance provisionedBy sdk
# The restored record's point-in-time keys are unchanged: no refusal.
assert_instance "Phase 4" "${PITR_INSTANCE_ID}" DbiResourceId "${PITR_RESOURCE_ID}"
assert_instance "Phase 4" "${PITR_INSTANCE_ID}" BackupRetentionPeriod 3
echo "    SnapInstance and PitrInstance updated in place (same DbiResourceId, retention 4 and 3)"

# --- Phase 5: a changed snapshot is refused ----------------------------------
# No snapshot of this name needs to exist: the refusal comes before any call.
echo "==> Phase 5: a changed DBSnapshotIdentifier is refused"
DEPLOY_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_SNAPSHOT_ID="cdkd-integ-rds-inst-other-5640" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  >"${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: Phase 5: the deploy changing DBSnapshotIdentifier exited 0, want a refusal" >&2
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
if ! grep -qF "${REFUSAL_LINE}" "${DEPLOY_LOG}"; then
  if grep -qF "${REFUSAL_SENTINEL}" "${DEPLOY_LOG}"; then
    echo "FAIL: Phase 5: the refusal no longer reads '${REFUSAL_LINE}' (wording drift?)" >&2
  else
    echo "FAIL: Phase 5: the deploy failed, but not with the DBSnapshotIdentifier refusal" >&2
  fi
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}"
assert_instance "Phase 5" "${SNAP_INSTANCE_ID}" DbiResourceId "${SNAP_RESOURCE_ID}"
assert_instance "Phase 5" "${SNAP_INSTANCE_ID}" DBInstanceStatus available
assert_record "Phase 5" SnapInstance properties.DBSnapshotIdentifier "${SNAPSHOT_ID}"
echo "    refused before any call; the instance and its record are unchanged"

echo "==> Phase 5: an added RestoreTime on PitrInstance is refused"
DEPLOY_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_PITR_RESTORE_TIME="2026-01-01T00:00:00Z" \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  >"${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: Phase 5: the deploy adding RestoreTime exited 0, want a refusal" >&2
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
if ! grep -qF "${PITR_REFUSAL_LINE}" "${DEPLOY_LOG}"; then
  if grep -qF "${REFUSAL_SENTINEL}" "${DEPLOY_LOG}"; then
    echo "FAIL: Phase 5: the refusal no longer reads '${PITR_REFUSAL_LINE}' (wording drift?)" >&2
  else
    echo "FAIL: Phase 5: the deploy failed, but not with the RestoreTime refusal" >&2
  fi
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}"
assert_instance "Phase 5" "${PITR_INSTANCE_ID}" DbiResourceId "${PITR_RESOURCE_ID}"
assert_instance "Phase 5" "${PITR_INSTANCE_ID}" DBInstanceStatus available
assert_record "Phase 5" PitrInstance properties.RestoreTime ""
echo "    refused before any call; PitrInstance and its record are unchanged"

# --- Phase 6: destroy -----------------------------------------------------------
echo "==> Phase 6: destroy"
CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for id in "${SNAP_INSTANCE_ID}" "${CLUSTER_SNAP_INSTANCE_ID}" "${PITR_INSTANCE_ID}" "${SOURCE_ID}"; do
  # cdkd's destroy returns once AWS took the delete; wait out `deleting`.
  for _ in $(seq 1 90); do
    gone_probe aws rds describe-db-instances --db-instance-identifier "${id}" --region "${REGION}" && break
    sleep 10
  done
  assert_gone "RDS instance ${id} still exists after destroy" aws rds describe-db-instances --db-instance-identifier "${id}" --region "${REGION}"
done
for _ in $(seq 1 120); do
  gone_probe aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}" && break
  sleep 10
done
assert_gone "RDS cluster ${CLUSTER_ID} still exists after destroy" aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}"
assert_gone "RDS subnet group ${SUBNET_GROUP} still exists after destroy" aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
# A tag-filtered listing answers empty, not not-found: a strict capture, so a
# failed read fails the run rather than reading as zero.
VPC_LEFT="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" \
  --query 'Vpcs[].VpcId' --output text)"
if [ -n "${VPC_LEFT}" ]; then
  echo "FAIL: fixture VPC ${VPC_LEFT} still exists after destroy" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The instances' automated backups go with them (DeleteAutomatedBackups
# defaults to true); a retained one would keep billing. A listing by an
# identifier with none answers empty or not-found: a strict capture otherwise.
for id in "${SOURCE_ID}" "${PITR_INSTANCE_ID}"; do
  BACKUPS_LEFT=""
  for _ in $(seq 1 30); do
    if ! BACKUPS_LEFT="$(aws rds describe-db-instance-automated-backups --db-instance-identifier "${id}" \
      --region "${REGION}" --query 'DBInstanceAutomatedBackups[].Status' --output text 2>&1)"; then
      case "${BACKUPS_LEFT}" in
        *DBInstanceAutomatedBackupNotFound*) BACKUPS_LEFT="" ;;
        *) echo "FAIL: reading ${id}'s automated backups failed: ${BACKUPS_LEFT}" >&2; exit 1 ;;
      esac
    fi
    [ -z "${BACKUPS_LEFT}" ] && break
    sleep 10
  done
  if [ -n "${BACKUPS_LEFT}" ]; then
    echo "FAIL: ${id} still has automated backups after destroy (${BACKUPS_LEFT})" >&2
    exit 1
  fi
done
echo "    instances, cluster, subnet group, VPC, state and automated backups all gone"
# The manual snapshots outlive their sources; verify.sh made them, so it deletes them.
aws rds delete-db-snapshot --db-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" >/dev/null
aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" \
  --region "${REGION}" >/dev/null
for _ in $(seq 1 60); do
  gone_probe aws rds describe-db-snapshots --db-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" && break
  sleep 10
done
assert_gone "manual snapshot ${SNAPSHOT_ID} still exists after its delete" aws rds describe-db-snapshots --db-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}"
for _ in $(seq 1 60); do
  gone_probe aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" --region "${REGION}" && break
  sleep 10
done
assert_gone "manual cluster snapshot ${CLUSTER_SNAPSHOT_ID} still exists after its delete" aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${CLUSTER_SNAPSHOT_ID}" --region "${REGION}"
echo "    manual snapshots deleted"

trap - EXIT INT TERM
echo "[verify] PASS — RDS DB instance restores from a DB snapshot, a Multi-AZ DB cluster snapshot and to a point in time on the SDK route with CloudFormation's follow-up ModifyDBInstance, updated in place, a changed snapshot and an added RestoreTime refused, destroyed clean"
