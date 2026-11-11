#!/usr/bin/env bash
# verify.sh — cdkd RDS DB cluster point-in-time and snapshot restores
# (go-to-k/cdkd#5639).
#
# `AWS::RDS::DBCluster` `SourceDBClusterIdentifier`, `RestoreToTime`,
# `RestoreType`, `UseLatestRestorableTime`, `SourceDbClusterResourceId` and
# `SnapshotIdentifier` on the SDK route. Before each was wired, cdkd routed such
# a template to Cloud Control (the keys were SDK-unwired), so phase 3's
# provisionedBy=sdk assertion is red on a binary without them.
#
# What CloudFormation's handler does (the archived
# aws-cloudformation-resource-providers-rds source, `aws-rds-dbcluster`): a
# source makes the create a RestoreDBClusterToPointInTime, then a ModifyDBCluster
# once the cluster is available with the members the restore call has none for
# (the parameter group, retention, windows, ...; the retention 1 when absent),
# then EnableHttpEndpoint for a declared Data API. A restore never sets the
# master user name.
#
# Phases:
#   1. Deploy `Source` (retention 3). provisionedBy=sdk.
#   2. Wait for the source's latest restorable time, and take a manual cluster
#      snapshot of it (a template cannot make one), waited to `available`.
#   3. CDKD_TEST_RESTORE=true + CDKD_TEST_RESTORE_TIME=<that time>:
#      `PitrCluster` (latest time) and `TimeCluster` (RestoreToTime). Both hold
#      the source's user name (so they were restored, not created) and the
#      fixture's own parameter group; `PitrCluster` port 5434, retention 5, the
#      declared backup window, CopyTagsToSnapshot and the Data API on;
#      `TimeCluster` retention 1. Both provisionedBy=sdk, and the deploy warned
#      that each keeps the source's MasterUsername. Likewise `IdCluster`
#      (`SourceDbClusterResourceId`: the source's resource id, latest time)
#      and `SnapCluster` (`SnapshotIdentifier`: the manual snapshot), each with
#      its declared port, parameter group and retention.
#   4. + CDKD_TEST_UPDATE=true: `PitrCluster` BackupRetentionPeriod 5 -> 6:
#      the same cluster (resource id), retention 6.
#   5. Destroy: every cluster, the parameter group, the subnet group, the VPC
#      and the state are gone; then the manual snapshot (not cdkd's) is deleted.
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
# password reaches the state records, and the state bucket is versioned.
# Sourced before the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

cd "$(dirname "$0")"

STACK="CdkdRdsPitrRestoreExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
SOURCE_ID="cdkd-integ-rds-pitr-src-5639"
PITR_CLUSTER_ID="cdkd-integ-rds-pitr-latest-5639"
TIME_CLUSTER_ID="cdkd-integ-rds-pitr-time-5639"
ID_CLUSTER_ID="cdkd-integ-rds-pitr-id-5639"
SNAP_CLUSTER_ID="cdkd-integ-rds-pitr-snap-5639"
# The manual snapshot verify.sh takes of the source (fixed: the sweep finds it).
SNAPSHOT_ID="cdkd-integ-rds-pitr-manual-5639"
PARAM_GROUP="cdkd-integ-rds-pitr-5639"
SUBNET_GROUP="cdkd-integ-rds-pitr-5639"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
KEPT_LINE="the restored cluster keeps its source's MasterUsername, not the template's"
# Sentinel: the line's opening, independent of its wording.
KEPT_SENTINEL=": the restored cluster"

# Best-effort delete of one cluster, until it is gone. The delete is re-sent
# each round: a cluster interrupted mid-restore (`creating`) refuses it until
# it is `available`.
sweep_cluster() { ( # usage: sweep_cluster <cluster id>
  set +eu
  for _ in $(seq 1 120); do
    out="$(aws rds describe-db-clusters --db-cluster-identifier "$1" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBClusterNotFound*) break ;; esac
    aws rds modify-db-cluster --db-cluster-identifier "$1" --no-deletion-protection \
      --apply-immediately --region "${REGION}" >/dev/null 2>&1
    aws rds delete-db-cluster --db-cluster-identifier "$1" \
      --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
) }

# Best-effort teardown of a partial destroy, by fixed name and by the CDK Name
# tag: the restored clusters, the source, the parameter group, the subnet
# group, then the VPC leaf-first.
sweep() { (
  set +eu
  sweep_cluster "${PITR_CLUSTER_ID}"
  sweep_cluster "${TIME_CLUSTER_ID}"
  sweep_cluster "${ID_CLUSTER_ID}"
  sweep_cluster "${SNAP_CLUSTER_ID}"
  sweep_cluster "${SOURCE_ID}"
  # Not cdkd's: verify.sh made it, so verify.sh deletes it, re-sending the
  # delete until it is gone (one still `creating` refuses it), so the next run's
  # create of the same name does not meet it.
  snap_gone=""
  for _ in $(seq 1 60); do
    out="$(aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
      --region "${REGION}" 2>&1)"
    case "${out}" in *DBClusterSnapshotNotFound*) snap_gone=1; break ;; esac
    aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    sleep 10
  done
  [ -n "${snap_gone}" ] || echo "    WARN: manual snapshot ${SNAPSHOT_ID} could not be deleted" >&2
  aws rds delete-db-cluster-parameter-group --db-cluster-parameter-group-name "${PARAM_GROUP}" \
    --region "${REGION}" >/dev/null 2>&1
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
  aws rds describe-db-clusters --db-cluster-identifier "$1" \
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
  if ! got="$(record_field "$2" "$3")"; then
    echo "FAIL: ${1}: no state record for ${2} (or the state could not be read)" >&2
    exit 1
  fi
  if [ "${got}" != "$4" ]; then
    echo "FAIL: ${1}: ${2} record ${3}='${got}', want '${4}'" >&2
    exit 1
  fi
}

# --- Phase 1: deploy the source --------------------------------------------
echo "==> Phase 1: deploy the source cluster"
env -u CDKD_TEST_RESTORE -u CDKD_TEST_UPDATE -u CDKD_TEST_RESTORE_TIME -u CDKD_TEST_SNAPSHOT_ID \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_record "Phase 1" Source provisionedBy sdk
assert_cluster "Phase 1" "${SOURCE_ID}" MasterUsername cdkdadmin
assert_cluster "Phase 1" "${SOURCE_ID}" BackupRetentionPeriod 3

# --- Phase 2: the source's latest restorable time ---------------------------
echo "==> Phase 2: wait for ${SOURCE_ID}'s latest restorable time"
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
echo "    source restorable to ${LATEST}"
echo "    taking manual snapshot ${SNAPSHOT_ID} of ${SOURCE_ID}"
aws rds create-db-cluster-snapshot --db-cluster-identifier "${SOURCE_ID}" \
  --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" >/dev/null
SNAP_STATUS=""
for _ in $(seq 1 90); do
  SNAP_STATUS="$(aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
    --region "${REGION}" --query 'DBClusterSnapshots[0].Status' --output text)"
  [ "${SNAP_STATUS}" = "available" ] && break
  sleep 10
done
if [ "${SNAP_STATUS}" != "available" ]; then
  echo "FAIL: Phase 2: snapshot ${SNAPSHOT_ID} is '${SNAP_STATUS}' after 15 minutes, want available" >&2
  exit 1
fi
# What SnapCluster restores from, in every later step.
export CDKD_TEST_SNAPSHOT_ID="${SNAPSHOT_ID}"
# What TimeCluster restores to, in every later step (a mode-gated resource
# leaves the template in any step without it).
export CDKD_TEST_RESTORE_TIME="${LATEST}"

# --- Phase 3: both restores ---------------------------------------------------
echo "==> Phase 3: restore PitrCluster (latest time), TimeCluster (${LATEST}), IdCluster (resource id) and SnapCluster (${SNAPSHOT_ID})"
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
for logical in PitrCluster TimeCluster IdCluster SnapCluster; do
  # The discriminator: a pre-fix binary routes these to Cloud Control.
  assert_record "Phase 3" "${logical}" provisionedBy sdk
  # Here-strings, not pipes: under pipefail an early `grep -q` exit can
  # SIGPIPE the upstream grep and read as no match.
  LINES="$(grep -F "${logical}" "${DEPLOY_LOG}" || true)"
  if ! grep -qF "${KEPT_LINE}" <<<"${LINES}"; then
    if grep -qF "${KEPT_SENTINEL}" <<<"${LINES}"; then
      echo "FAIL: Phase 3: the ${logical} warning no longer reads '${KEPT_LINE}' (wording drift?)" >&2
    else
      echo "FAIL: Phase 3: the deploy did not warn that ${logical} keeps the source's MasterUsername" >&2
    fi
    tail -n 60 "${DEPLOY_LOG}" >&2
    exit 1
  fi
done
rm -f "${DEPLOY_LOG}"
for id in "${PITR_CLUSTER_ID}" "${TIME_CLUSTER_ID}" "${ID_CLUSTER_ID}" "${SNAP_CLUSTER_ID}"; do
  # The source's user name, not the template's: the cluster was restored.
  assert_cluster "Phase 3" "${id}" MasterUsername cdkdadmin
  # The fixture's own group: a restore that skipped the follow-up holds the default.
  assert_cluster "Phase 3" "${id}" DBClusterParameterGroup "${PARAM_GROUP}"
  assert_cluster "Phase 3" "${id}" Status available
done
# On the restore call.
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" Port 5434
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" CopyTagsToSnapshot True
# On the follow-up ModifyDBCluster, then EnableHttpEndpoint.
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" BackupRetentionPeriod 5
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" PreferredBackupWindow 05:00-05:30
assert_cluster "Phase 3" "${PITR_CLUSTER_ID}" HttpEndpointEnabled True
# None declared: the follow-up sends 1, as CloudFormation fills it (the source
# holds 3). INFERRED, not measured: whether a restore without the follow-up
# keeps the source's 3 is unknown, so this alone may not prove the follow-up
# ran (the parameter group and PitrCluster's retention 5 do). The value is
# printed into the run log either way.
TIME_RETENTION="$(cluster_field "${TIME_CLUSTER_ID}" BackupRetentionPeriod)"
echo "    TimeCluster BackupRetentionPeriod=${TIME_RETENTION} (source 3)"
assert_cluster "Phase 3" "${TIME_CLUSTER_ID}" BackupRetentionPeriod 1
# go-to-k/cdkd#5639: IdCluster, named by the source's resource id. Its port
# rides the restore call, its retention the follow-up.
assert_cluster "Phase 3" "${ID_CLUSTER_ID}" Port 5436
assert_cluster "Phase 3" "${ID_CLUSTER_ID}" BackupRetentionPeriod 2
# SnapCluster, from the manual snapshot: the port rides
# RestoreDBClusterFromSnapshot alone; the retention and backup window only the
# follow-up ModifyDBCluster (CopyTagsToSnapshot rides both).
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" Port 5435
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" CopyTagsToSnapshot True
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" BackupRetentionPeriod 4
assert_cluster "Phase 3" "${SNAP_CLUSTER_ID}" PreferredBackupWindow 06:00-06:30
PITR_RESOURCE_ID="$(cluster_field "${PITR_CLUSTER_ID}" DbClusterResourceId)"
echo "    all four restored (source user name, own parameter group, declared and default retention), provisionedBy=sdk"

# --- Phase 4: an in-place update of a restored cluster ------------------------
echo "==> Phase 4: PitrCluster BackupRetentionPeriod 5 -> 6"
CDKD_TEST_RESTORE=true CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_cluster "Phase 4" "${PITR_CLUSTER_ID}" DbClusterResourceId "${PITR_RESOURCE_ID}"
assert_cluster "Phase 4" "${PITR_CLUSTER_ID}" BackupRetentionPeriod 6
assert_record "Phase 4" PitrCluster provisionedBy sdk
echo "    PitrCluster updated in place (same resource id, retention 6)"

# --- Phase 5: destroy ---------------------------------------------------------
echo "==> Phase 5: destroy"
CDKD_TEST_RESTORE=true CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for id in "${PITR_CLUSTER_ID}" "${TIME_CLUSTER_ID}" "${ID_CLUSTER_ID}" "${SNAP_CLUSTER_ID}" "${SOURCE_ID}"; do
  # cdkd's destroy returns once AWS took the delete; wait out `deleting`.
  for _ in $(seq 1 90); do
    gone_probe aws rds describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}" && break
    sleep 10
  done
  assert_gone "RDS cluster ${id} still exists after destroy" aws rds describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}"
done
assert_gone "RDS parameter group ${PARAM_GROUP} still exists after destroy" aws rds describe-db-cluster-parameter-groups --db-cluster-parameter-group-name "${PARAM_GROUP}" --region "${REGION}"
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
echo "    clusters, parameter group, subnet group, VPC and state all gone"
# The manual snapshot outlives the source; verify.sh made it, so it deletes it.
aws rds delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
  --region "${REGION}" >/dev/null
for _ in $(seq 1 60); do
  gone_probe aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" && break
  sleep 10
done
assert_gone "manual snapshot ${SNAPSHOT_ID} still exists after its delete" aws rds describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}"
echo "    manual snapshot ${SNAPSHOT_ID} deleted"

trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "rds-dbcluster-pitr-restore state teardown"
echo "[verify] PASS — RDS DB cluster point-in-time (by name and by resource id) and snapshot restores on the SDK route with CloudFormation's follow-up ModifyDBCluster, updated in place, destroyed clean"
