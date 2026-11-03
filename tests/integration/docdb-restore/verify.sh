#!/usr/bin/env bash
# verify.sh — cdkd DocDB cluster restores (go-to-k/cdkd#5628).
#
# `AWS::DocDB::DBCluster` `SnapshotIdentifier`, `SourceDBClusterIdentifier`,
# `RestoreType`, `RestoreToTime` and `UseLatestRestorableTime` on the SDK route.
# Before this, cdkd refused such a template pre-flight (the type has no Cloud
# Control handlers), so phase 3 is red on a pre-fix binary.
#
# A real CloudFormation measurement (us-east-1, engine 5.0.0, the handler's
# calls read from CloudTrail): `SnapshotIdentifier` calls
# RestoreDBClusterFromSnapshot, then a ModifyDBCluster with the parameter group,
# retention and windows; `SourceDBClusterIdentifier` calls
# RestoreDBClusterToPointInTime and drops the retention and windows; both send
# port 27017 when none is declared, not the source's; neither sets the master
# user name or password. cdkd sends the dropped values too.
#
# Phases:
#   1. Deploy `Source` (port 27018). provisionedBy=sdk.
#   2. Snapshot `Source` out of band, and wait for its latest restorable time.
#   3. CDKD_TEST_RESTORE=true + CDKD_TEST_RESTORE_TIME=<that time>:
#      `SnapCluster` (from the snapshot), `PitrCluster` (from `Source`, latest
#      time) and `TimeCluster` (from `Source`, RestoreToTime). Each holds the
#      source's user name (so it was restored, not created), port 27017, the
#      declared retention and the fixture's own parameter group;
#      `SnapCluster` and `PitrCluster` both declared windows, `SnapCluster`
#      CopyTagsToSnapshot. All provisionedBy=sdk, and the deploy warned that
#      each keeps the source's MasterUsername.
#   4. + CDKD_TEST_UPDATE=true: `PitrCluster`'s RestoreType changes beside
#      BackupRetentionPeriod 5 -> 6: the same cluster (resource id), retention 6.
#   5. Destroy: every cluster, the parameter group, the subnet group, the VPC
#      and the state are gone.
#      The snapshot verify.sh made is deleted and asserted gone.
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

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# Shared S3 VERSION-sweep helpers (issue #2096): the template's literal master
# passwords reach the state records, and the state bucket is versioned.
# Sourced before the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

cd "$(dirname "$0")"

STACK="CdkdDocdbRestoreExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
SOURCE_ID="cdkd-integ-docdb-restore-src-5628"
SNAP_CLUSTER_ID="cdkd-integ-docdb-restore-snap-5628"
PITR_CLUSTER_ID="cdkd-integ-docdb-restore-pitr-5628"
TIME_CLUSTER_ID="cdkd-integ-docdb-restore-time-5628"
PARAM_GROUP="cdkd-integ-docdb-restore-5628"
# Must match SNAPSHOT_ID in lib/docdb-restore-stack.ts.
SNAPSHOT_ID="cdkd-integ-docdb-restore-5628"
SUBNET_GROUP="cdkd-integ-docdb-restore-5628"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
KEPT_LINE="the restored cluster keeps its source's MasterUsername, not the template's"
# Sentinel: the line's opening, independent of its wording.
KEPT_SENTINEL="(AWS::DocDB::DBCluster): the restored cluster"

# Best-effort delete of one cluster, waiting until it is gone only when AWS
# took the delete.
sweep_cluster() { ( # usage: sweep_cluster <cluster id>
  set +eu
  aws docdb modify-db-cluster --db-cluster-identifier "$1" --no-deletion-protection \
    --apply-immediately --region "${REGION}" >/dev/null 2>&1
  if aws docdb delete-db-cluster --db-cluster-identifier "$1" \
    --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1; then
    for _ in $(seq 1 90); do
      out="$(aws docdb describe-db-clusters --db-cluster-identifier "$1" \
        --region "${REGION}" 2>&1)"
      case "${out}" in *DBClusterNotFound*) break ;; esac
      sleep 10
    done
  fi
) }

# Best-effort teardown of a partial destroy, by fixed name and by the CDK Name
# tag: the restored clusters, the source, the snapshot, the subnet group, then
# the VPC leaf-first.
sweep() { (
  set +eu
  sweep_cluster "${PITR_CLUSTER_ID}"
  sweep_cluster "${TIME_CLUSTER_ID}"
  sweep_cluster "${SNAP_CLUSTER_ID}"
  sweep_cluster "${SOURCE_ID}"
  aws docdb delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
    --region "${REGION}" >/dev/null 2>&1
  aws docdb delete-db-cluster-parameter-group --db-cluster-parameter-group-name "${PARAM_GROUP}" \
    --region "${REGION}" >/dev/null 2>&1
  aws docdb delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP}" \
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
    igw="$(aws ec2 describe-internet-gateways --region "${REGION}" --filters "Name=attachment.vpc-id,Values=${vpc}" --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null)"
    if [ -n "${igw}" ] && [ "${igw}" != "None" ]; then
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
    fi
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
    CDKD_TEST_RESTORE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  sweep
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    # NONCURRENT only, per ../s3-versions.sh; the success path sweeps all.
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
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

cluster_field() { # usage: cluster_field <cluster id> <query>
  aws docdb describe-db-clusters --db-cluster-identifier "$1" \
    --region "${REGION}" --query "DBClusters[0].$2" --output text
}

assert_cluster() { # usage: assert_cluster <phase> <cluster id> <query> <want>
  local got
  got="$(cluster_field "$2" "$3")" || return 1
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
  got="$(record_field "$2" "$3")" || return 1
  if [ "${got}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} record ${3}='${got}', want '${4}'" >&2
    exit 1
  fi
}

# --- Phase 1: deploy the source --------------------------------------------
echo "==> Phase 1: deploy the source cluster"
env -u CDKD_TEST_RESTORE -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_record "Phase 1" Source provisionedBy sdk
assert_cluster "Phase 1" "${SOURCE_ID}" Port 27018
assert_cluster "Phase 1" "${SOURCE_ID}" MasterUsername cdkdadmin

# --- Phase 2: snapshot the source, out of band ------------------------------
echo "==> Phase 2: snapshot ${SOURCE_ID} as ${SNAPSHOT_ID}"
aws docdb create-db-cluster-snapshot --db-cluster-identifier "${SOURCE_ID}" \
  --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" >/dev/null
SNAP_STATUS=""
for _ in $(seq 1 90); do
  SNAP_STATUS="$(aws docdb describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
    --region "${REGION}" --query 'DBClusterSnapshots[0].Status' --output text)"
  [ "${SNAP_STATUS}" = "available" ] && break
  sleep 10
done
if [ "${SNAP_STATUS}" != "available" ]; then
  echo "FAIL: Phase 2: snapshot ${SNAPSHOT_ID} status '${SNAP_STATUS}' after 15 minutes" >&2
  exit 1
fi
LATEST=""
for _ in $(seq 1 60); do
  LATEST="$(cluster_field "${SOURCE_ID}" LatestRestorableTime)"
  [ -n "${LATEST}" ] && [ "${LATEST}" != "None" ] && break
  sleep 10
done
if [ -z "${LATEST}" ] || [ "${LATEST}" = "None" ]; then
  echo "FAIL: Phase 2: ${SOURCE_ID} has no LatestRestorableTime after 10 minutes" >&2
  exit 1
fi
echo "    snapshot available; source restorable to ${LATEST}"
# What TimeCluster restores to, in every later step (a mode-gated resource
# leaves the template in any step without it).
export CDKD_TEST_RESTORE_TIME="${LATEST}"

# --- Phase 3: both restores ---------------------------------------------------
echo "==> Phase 3: restore SnapCluster (snapshot), PitrCluster (latest time) and TimeCluster (${LATEST})"
DEPLOY_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_UPDATE CDKD_TEST_RESTORE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  >"${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: Phase 3: the restore deploy exited ${DEPLOY_RC}" >&2
  tail -n 60 "${DEPLOY_LOG}" >&2
  exit 1
fi
for logical in SnapCluster PitrCluster TimeCluster; do
  assert_record "Phase 3" "${logical}" provisionedBy sdk
  if ! grep -F "${logical} " "${DEPLOY_LOG}" | grep -qF "${KEPT_LINE}"; then
    if grep -F "${logical} " "${DEPLOY_LOG}" | grep -qF "${KEPT_SENTINEL}"; then
      echo "FAIL: Phase 3: the ${logical} warning no longer reads '${KEPT_LINE}' (wording drift?)" >&2
    else
      echo "FAIL: Phase 3: the deploy did not warn that ${logical} keeps the source's MasterUsername" >&2
    fi
    tail -n 60 "${DEPLOY_LOG}" >&2
    exit 1
  fi
done
rm -f "${DEPLOY_LOG}"
for id in "${SNAP_CLUSTER_ID}" "${PITR_CLUSTER_ID}" "${TIME_CLUSTER_ID}"; do
  # The source's user name, not the template's: the cluster was restored.
  assert_cluster "Phase 3" "${id}" MasterUsername cdkdadmin
  # The type's port, not the source's 27018.
  assert_cluster "Phase 3" "${id}" Port 27017
  # The fixture's own group: a restore that skipped the follow-up holds the default.
  assert_cluster "Phase 3" "${id}" DBClusterParameterGroup "${PARAM_GROUP}"
  assert_cluster "Phase 3" "${id}" Status available
done
for id in "${SNAP_CLUSTER_ID}" "${PITR_CLUSTER_ID}"; do
  assert_cluster "Phase 3" "${id}" PreferredBackupWindow 05:00-05:30
  assert_cluster "Phase 3" "${id}" PreferredMaintenanceWindow sun:06:00-sun:06:30
done
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" BackupRetentionPeriod 3
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" CopyTagsToSnapshot True
# CloudFormation drops these on a point-in-time restore; cdkd sends them.
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" BackupRetentionPeriod 5
assert_cluster "Phase 3" "${TIME_CLUSTER_ID}" BackupRetentionPeriod 4
PITR_RESOURCE_ID="$(cluster_field "${PITR_CLUSTER_ID}" DbClusterResourceId)"
echo "    all three restored (source user name, port 27017, declared retention, windows and parameter group), provisionedBy=sdk"

# --- Phase 4: an update beside a RestoreType change ---------------------------
echo "==> Phase 4: PitrCluster RestoreType change + BackupRetentionPeriod 5 -> 6"
CDKD_TEST_RESTORE=true CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_cluster "Phase 4" "${PITR_CLUSTER_ID}" DbClusterResourceId "${PITR_RESOURCE_ID}"
assert_cluster "Phase 4" "${PITR_CLUSTER_ID}" BackupRetentionPeriod 6
assert_record "Phase 4" PitrCluster provisionedBy sdk
assert_record "Phase 4" PitrCluster properties.RestoreType copy-on-write
echo "    PitrCluster updated in place (same resource id, retention 6)"

# --- Phase 5: destroy ---------------------------------------------------------
echo "==> Phase 5: destroy"
CDKD_TEST_RESTORE=true CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for id in "${SNAP_CLUSTER_ID}" "${PITR_CLUSTER_ID}" "${TIME_CLUSTER_ID}" "${SOURCE_ID}"; do
  assert_gone "DocDB cluster ${id} still exists after destroy" aws docdb describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}"
done
assert_gone "DocDB parameter group ${PARAM_GROUP} still exists after destroy" aws docdb describe-db-cluster-parameter-groups --db-cluster-parameter-group-name "${PARAM_GROUP}" --region "${REGION}"
assert_gone "DocDB subnet group ${SUBNET_GROUP} still exists after destroy" aws docdb describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
# A tag-filtered listing answers empty, not not-found: a strict capture, so a
# failed read fails the run rather than reading as zero.
VPC_LEFT="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" \
  --query 'Vpcs[].VpcId' --output text)"
if [ -n "${VPC_LEFT}" ]; then
  echo "FAIL: fixture VPC ${VPC_LEFT} still exists after destroy" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The snapshot is verify.sh's own, never the stack's.
aws docdb delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
  --region "${REGION}" >/dev/null
# Measured gone at once; the wait only absorbs a `deleting` read.
for _ in $(seq 1 30); do
  gone_probe aws docdb describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" && break
  sleep 10
done
assert_gone "DocDB snapshot ${SNAPSHOT_ID} still exists after its delete" aws docdb describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}"
echo "    clusters, parameter group, subnet group, VPC, state and snapshot all gone"

trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "docdb-restore state teardown"
echo "[verify] PASS — DocDB restores: snapshot and point-in-time restored on the SDK route with the declared values CloudFormation drops, updated in place, destroyed clean"
