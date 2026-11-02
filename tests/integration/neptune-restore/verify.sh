#!/usr/bin/env bash
#
# go-to-k/cdkd#5638: `AWS::Neptune::DBCluster` restored through the SDK
# provider. A restore's source keys are write-only, so no read names them: the
# restored cluster's INHERITED values show it was restored, and CloudTrail's
# request parameters show which keys reached AWS.
#
# Phases:
#   1. Baseline deploy: VPC, DB subnet group, the source cluster and its
#      instance (a copy-on-write restore refuses a source with none).
#   2. A cluster snapshot of the source, under a run-unique name: several
#      peers share this account. A restorable time is read for the next step.
#   3. The deploy adding four restored clusters, one encrypting an unencrypted
#      snapshot. Asserted per cluster:
#      `provisionedBy: sdk`; the source's maintenance window, which a plain
#      create would not hold; port 8182, not the source's 8183; each declared
#      value CloudFormation sends or drops (retention, backup window, IAM auth,
#      CopyTagsToSnapshot); CloneGroupId set only for the copy-on-write one. A
#      declared window AWS refuses warns, costing no other value.
#   4. CloudTrail: the call each cluster was made with, and its restore keys
#      (`SnapshotIdentifier`, `SourceDBClusterIdentifier`, `RestoreType`,
#      `RestoreToTime`, `UseLatestRestorableTime`). Delivery lags 5 to 15
#      minutes, so this polls.
#   5. An ordinary update applies in place to a restored cluster and to the
#      one holding a refused window, whose update must not resend it, and
#      replaces none of them (the keys are create-only and never read back);
#      drift reports nothing on them.
#   6. Destroy, and everything is gone. The snapshot is deleted by this script.
#
# Cost: one db.t3.medium instance, five clusters with almost no storage.
# A note for whoever runs this, read by nothing: a run takes roughly an hour, so
# until the ledger holds a PASS, give the watchdog a budget of 7200s; its floor
# of 1500s would kill the run.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdNeptuneRestore"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/neptune-restore"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096). Sourced by absolute path,
# before the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The identifiers the stack derives from its lower-cased name.
ID_PREFIX="$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')"
SOURCE_CLUSTER="${ID_PREFIX}-source"
SOURCE_DB="${ID_PREFIX}-source-db"
FROM_SNAPSHOT="${ID_PREFIX}-from-snapshot"
BARE_SNAPSHOT="${ID_PREFIX}-bare-snapshot"
LATEST_CLONE="${ID_PREFIX}-latest-clone"
TO_TIME="${ID_PREFIX}-to-time"
SNAPSHOT_ID="${ID_PREFIX}-${RUN_ID:-$(date +%s)-$$}"
SOURCE_MAINTENANCE="sat:03:11-sat:03:41"

# Set once the preconditions below pass: before that, the identifiers or the
# stack may belong to a concurrent or earlier run.
CLEANUP_ARMED=""
# Set once step 1 deployed: until then an identifier may be a peer's cluster,
# since a deploy that lost the name race fails with the peer's still standing.
IDS_OWNED=""
SNAPSHOT_CREATED=""
LOG_DIR="$(mktemp -d)"

TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::Neptune::DBCluster=40m
  --resource-timeout AWS::Neptune::DBInstance=40m
)

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} snapshot=${SNAPSHOT_ID}"

# The Neptune CLI has instance waiters only: a cluster's status is polled.
cluster_status() { # usage: cluster_status <identifier>
  local out
  if out="$(aws neptune describe-db-clusters --db-cluster-identifier "$1" --region "${REGION}" \
    --query 'DBClusters[0].Status' --output text 2>&1)"; then
    printf '%s' "${out}"
  elif gone_probe aws neptune describe-db-clusters --db-cluster-identifier "$1" --region "${REGION}"; then
    printf 'gone'
  else
    printf '%s' "${out}"
  fi
}
delete_instance_by_id() { ( # usage: delete_instance_by_id <identifier>
  set +eu
  aws neptune wait db-instance-available --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  aws neptune delete-db-instance --db-instance-identifier "$1" --skip-final-snapshot \
    --region "${REGION}" >/dev/null 2>&1
  aws neptune wait db-instance-deleted --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_cluster_by_id() { ( # usage: delete_cluster_by_id <identifier>
  set +eu
  for _ in $(seq 1 180); do
    s="$(cluster_status "$1")" || break
    [ "${s}" = "gone" ] && exit 0
    # `failed` never reaches `available`, and accepts the delete as it is.
    [ "${s}" = "available" ] || [ "${s}" = "failed" ] && break
    sleep 10
  done
  aws neptune delete-db-cluster --db-cluster-identifier "$1" --skip-final-snapshot \
    --region "${REGION}" >/dev/null 2>&1
  for _ in $(seq 1 180); do
    s="$(cluster_status "$1")" || break
    [ "${s}" = "gone" ] && exit 0
    sleep 10
  done
  echo "[verify] WARN: DB cluster $1 could not be confirmed deleted (last status '${s}'); delete it by hand" >&2
  true
); }
delete_snapshot() { ( # usage: delete_snapshot; a snapshot still `creating` refuses the delete
  set +eu
  for _ in $(seq 1 60); do
    aws neptune delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    if ( gone_probe aws neptune describe-db-cluster-snapshots \
      --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" ); then
      exit 0
    fi
    sleep 10
  done
  echo "[verify] WARN: snapshot ${SNAPSHOT_ID} could not be confirmed deleted; delete it by hand" >&2
  exit 1
); }

cleanup() {
  rc=$?
  set +eu
  rm -rf "${LOG_DIR}"
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # First: it costs storage, and the slow deletes below can be interrupted.
    if [ -n "${SNAPSHOT_CREATED}" ] && delete_snapshot; then
      SNAPSHOT_CREATED=""
    fi
    if [ -n "${IDS_OWNED}" ]; then
      # Clones and restores first, then the source's member, then the source.
      delete_cluster_by_id "${LATEST_CLONE}"
      delete_cluster_by_id "${TO_TIME}"
      delete_cluster_by_id "${FROM_SNAPSHOT}"
      delete_cluster_by_id "${BARE_SNAPSHOT}"
      delete_instance_by_id "${SOURCE_DB}"
      delete_cluster_by_id "${SOURCE_CLUSTER}"
    fi
    # From the fixture directory: a failure before the script's own `cd` would
    # otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force "${TIMEOUT_OVERRIDES[@]}")
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  # Again after the clusters: one still restoring can hold it.
  if [ -n "${SNAPSHOT_CREATED}" ]; then
    delete_snapshot
  fi
  # NONCURRENT only, per ../s3-versions.sh: on a failure a live state.json may
  # be the only record of what is still standing. The success path sweeps all.
  if [ -n "${CLEANUP_ARMED}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
  fi
  exit "${rc}"
}
trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the (slow) cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# A record or resource left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for id in "${SOURCE_CLUSTER}" "${FROM_SNAPSHOT}" "${BARE_SNAPSHOT}" "${LATEST_CLONE}" "${TO_TIME}"; do
  assert_gone "precondition: DB cluster ${id} already exists (left by an earlier run); delete it first" \
    aws neptune describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}"
done
LEFT_SNAPSHOTS="$(aws neptune describe-db-cluster-snapshots --snapshot-type manual --region "${REGION}" \
  --query "DBClusterSnapshots[?starts_with(DBClusterSnapshotIdentifier, '${ID_PREFIX}-')].DBClusterSnapshotIdentifier" --output text)"
if [ -n "${LEFT_SNAPSHOTS}" ]; then
  echo "[verify] FAIL: an earlier run left snapshots, or a peer's run is live: ${LEFT_SNAPSHOTS}" >&2
  exit 1
fi
assert_gone "precondition: DB instance ${SOURCE_DB} already exists (left by an earlier run); delete it first" \
  aws neptune describe-db-instances --db-instance-identifier "${SOURCE_DB}" --region "${REGION}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (VPC, DB subnet group, source cluster and instance)"
env -u RESTORE_SNAPSHOT_ID -u RESTORE_TO_TIME ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  "${TIMEOUT_OVERRIDES[@]}"
IDS_OWNED=1

echo "[verify] step 2: snapshot ${SNAPSHOT_ID}, and a restorable time"
SNAPSHOT_CREATED=1
aws neptune create-db-cluster-snapshot --db-cluster-identifier "${SOURCE_CLUSTER}" \
  --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}" >/dev/null
SNAPSHOT_STATUS=""
for _ in $(seq 1 120); do
  SNAPSHOT_STATUS="$(aws neptune describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" \
    --region "${REGION}" --query 'DBClusterSnapshots[0].Status' --output text)"
  [ "${SNAPSHOT_STATUS}" = "available" ] && break
  sleep 10
done
if [ "${SNAPSHOT_STATUS}" != "available" ]; then
  echo "[verify] FAIL: snapshot ${SNAPSHOT_ID} is '${SNAPSHOT_STATUS}' after 20 minutes" >&2
  exit 1
fi
# Whole seconds, rounded down, inside the restorable window: the instance has
# been up for minutes. CloudTrail shows the value in the same spelling.
LATEST_TIME="$(aws neptune describe-db-clusters --db-cluster-identifier "${SOURCE_CLUSTER}" --region "${REGION}" \
  --query 'DBClusters[0].LatestRestorableTime' --output text)"
RESTORE_TO_TIME="$(printf '%s' "${LATEST_TIME}" | cut -c1-19)Z"
case "${RESTORE_TO_TIME}" in
  20??-??-??T??:??:??Z) ;;
  *)
    echo "[verify] FAIL: the source reports no restorable time ('${LATEST_TIME}')" >&2
    exit 1
    ;;
esac
export RESTORE_SNAPSHOT_ID="${SNAPSHOT_ID}" RESTORE_TO_TIME

echo "[verify] step 3: deploy the four restored clusters"
# The identifiers are fixed, so CloudTrail still holds an earlier run's events.
TRAIL_START="$(date +%s)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" "${TIMEOUT_OVERRIDES[@]}" 2>&1 | tee "${LOG_DIR}/restore.log"

STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_sdk_record() { # usage: assert_sdk_record <logicalId> <identifier>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || return 1
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || return 1
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk: the restore keys are wired, so nothing routes this to Cloud Control)" >&2
    exit 1
  fi
}
assert_sdk_record FromSnapshot "${FROM_SNAPSHOT}"
assert_sdk_record BareSnapshot "${BARE_SNAPSHOT}"
assert_sdk_record LatestClone "${LATEST_CLONE}"
assert_sdk_record ToTime "${TO_TIME}"

describe_cluster() { # usage: describe_cluster <identifier>
  aws neptune describe-db-clusters --db-cluster-identifier "$1" --region "${REGION}" --query 'DBClusters[0]' --output json
}
assert_field() { # usage: assert_field <json> <identifier> <jq path> <expected> <why>
  local got
  got="$(printf '%s' "$1" | jq -r "$3 | tostring")" || return 1
  if [ "${got}" != "$4" ]; then
    echo "[verify] FAIL: $2 $3 reads '${got}' (expected '$4': $5)" >&2
    exit 1
  fi
}
RESTORED="restored from the source, which a plain create is not"

C="$(describe_cluster "${FROM_SNAPSHOT}")"
assert_field "${C}" "${FROM_SNAPSHOT}" .PreferredMaintenanceWindow "${SOURCE_MAINTENANCE}" "${RESTORED}"
assert_field "${C}" "${FROM_SNAPSHOT}" .Port 8182 "a restore takes the type's port, as CloudFormation does"
assert_field "${C}" "${FROM_SNAPSHOT}" .BackupRetentionPeriod 5 "declared, sent after the restore"
assert_field "${C}" "${FROM_SNAPSHOT}" .PreferredBackupWindow 05:11-05:41 "declared, sent after the restore"
assert_field "${C}" "${FROM_SNAPSHOT}" .IAMDatabaseAuthenticationEnabled true "declared on the restore call"
assert_field "${C}" "${FROM_SNAPSHOT}" .CopyTagsToSnapshot true "declared on the restore call"
assert_field "${C}" "${FROM_SNAPSHOT}" .CloneGroupId null "no clone"

TAG_VALUE="$(aws neptune list-tags-for-resource --resource-name "$(printf '%s' "${C}" | jq -r .DBClusterArn)" \
  --region "${REGION}" --query "TagList[?Key=='cdkd:integ-fixture'].Value | [0]" --output text)"
if [ "${TAG_VALUE}" != "neptune-restore" ]; then
  echo "[verify] FAIL: ${FROM_SNAPSHOT} holds the fixture tag as '${TAG_VALUE}' (Tags on the restore call)" >&2
  exit 1
fi

C="$(describe_cluster "${BARE_SNAPSHOT}")"
assert_field "${C}" "${BARE_SNAPSHOT}" .PreferredMaintenanceWindow "${SOURCE_MAINTENANCE}" "${RESTORED}"
assert_field "${C}" "${BARE_SNAPSHOT}" .BackupRetentionPeriod 1 "none declared: a snapshot restore sets 1, as CloudFormation does, not the source's 7"
assert_field "${C}" "${BARE_SNAPSHOT}" .Port 8182 "a restore takes the type's port, as CloudFormation does"
assert_field "${C}" "${BARE_SNAPSHOT}" .StorageEncrypted true "StorageEncrypted has no restore member: it reaches AWS as the default key"

C="$(describe_cluster "${LATEST_CLONE}")"
assert_field "${C}" "${LATEST_CLONE}" .PreferredMaintenanceWindow "${SOURCE_MAINTENANCE}" "${RESTORED}"
assert_field "${C}" "${LATEST_CLONE}" .Port 8182 "a restore takes the type's port, as CloudFormation does"
assert_field "${C}" "${LATEST_CLONE}" .BackupRetentionPeriod 3 "declared, sent after the restore"
assert_field "${C}" "${LATEST_CLONE}" .CopyTagsToSnapshot true "declared, sent after the restore"
assert_field "${C}" "${LATEST_CLONE}" .PreferredBackupWindow 07:11-07:41 "the declared window overlaps the maintenance window, so AWS refuses it"
if ! grep -q 'AWS refused PreferredBackupWindow after the restore' "${LOG_DIR}/restore.log"; then
  echo "[verify] FAIL: the deploy did not warn about the refused PreferredBackupWindow (output above)" >&2
  exit 1
fi
if [ "$(printf '%s' "${C}" | jq -r '.CloneGroupId // ""')" = "" ]; then
  echo "[verify] FAIL: ${LATEST_CLONE} has no CloneGroupId: RestoreType copy-on-write did not reach AWS" >&2
  exit 1
fi

C="$(describe_cluster "${TO_TIME}")"
assert_field "${C}" "${TO_TIME}" .PreferredMaintenanceWindow "${SOURCE_MAINTENANCE}" "${RESTORED}"
assert_field "${C}" "${TO_TIME}" .Port 8182 "a restore takes the type's port, as CloudFormation does"
assert_field "${C}" "${TO_TIME}" .BackupRetentionPeriod 7 "none declared: a point-in-time restore inherits the source's"
assert_field "${C}" "${TO_TIME}" .CloneGroupId null "full-copy is no clone"
echo "[verify] step 3 ok: four clusters restored on the SDK route"

echo "[verify] step 4: CloudTrail shows each restore call and its keys"
trail_event() { # usage: trail_event <identifier> <eventName>: the request, or nothing yet
  aws cloudtrail lookup-events --region "${REGION}" --start-time "${TRAIL_START}" \
    --lookup-attributes "AttributeKey=ResourceName,AttributeValue=$1" --max-results 20 --output json \
    | jq -c --arg e "$2" '[.Events[] | select(.EventName == $e) | .CloudTrailEvent | fromjson | select(.errorCode == null) | .requestParameters] | first // empty'
}
wait_trail_event() { # usage: wait_trail_event <identifier> <eventName> (up to 25 minutes)
  local event=""
  for _ in $(seq 1 50); do
    event="$(trail_event "$1" "$2")" || return 1
    if [ -n "${event}" ]; then
      printf '%s' "${event}"
      return 0
    fi
    sleep 30
  done
  echo "[verify] FAIL: CloudTrail shows no $2 for $1 after 25 minutes (a plain CreateDBCluster, or undelivered)" >&2
  return 1
}
E_SNAPSHOT="$(wait_trail_event "${FROM_SNAPSHOT}" RestoreDBClusterFromSnapshot)"
assert_field "${E_SNAPSHOT}" "${FROM_SNAPSHOT}" .snapshotIdentifier "${SNAPSHOT_ID}" "SnapshotIdentifier on the wire"
E_BARE="$(wait_trail_event "${BARE_SNAPSHOT}" RestoreDBClusterFromSnapshot)"
assert_field "${E_BARE}" "${BARE_SNAPSHOT}" .snapshotIdentifier "${SNAPSHOT_ID}" "SnapshotIdentifier on the wire"
assert_field "${E_BARE}" "${BARE_SNAPSHOT}" .kmsKeyId alias/aws/rds "StorageEncrypted: true with no key"
E_LATEST="$(wait_trail_event "${LATEST_CLONE}" RestoreDBClusterToPointInTime)"
assert_field "${E_LATEST}" "${LATEST_CLONE}" .sourceDBClusterIdentifier "${SOURCE_CLUSTER}" "SourceDBClusterIdentifier on the wire"
assert_field "${E_LATEST}" "${LATEST_CLONE}" .useLatestRestorableTime true "UseLatestRestorableTime on the wire"
assert_field "${E_LATEST}" "${LATEST_CLONE}" .restoreType copy-on-write "RestoreType on the wire"
E_TIME="$(wait_trail_event "${TO_TIME}" RestoreDBClusterToPointInTime)"
assert_field "${E_TIME}" "${TO_TIME}" .sourceDBClusterIdentifier "${SOURCE_CLUSTER}" "SourceDBClusterIdentifier on the wire"
assert_field "${E_TIME}" "${TO_TIME}" .restoreType full-copy "RestoreType on the wire"
TRAIL_TIME="$(printf '%s' "${E_TIME}" | jq -r '.restoreToTime // ""' | cut -c1-19)Z"
if [ "${TRAIL_TIME}" != "${RESTORE_TO_TIME}" ]; then
  echo "[verify] FAIL: RestoreToTime reached AWS as '${TRAIL_TIME}' (expected '${RESTORE_TO_TIME}')" >&2
  exit 1
fi
echo "[verify] step 4 ok: every restore key reached AWS"

echo "[verify] step 5: an ordinary update replaces nothing, and drift is clean"
resource_id() { # usage: resource_id <identifier>
  aws neptune describe-db-clusters --db-cluster-identifier "$1" --region "${REGION}" \
    --query 'DBClusters[0].DbClusterResourceId' --output text
}
RID_SNAPSHOT="$(resource_id "${FROM_SNAPSHOT}")"
RID_BARE="$(resource_id "${BARE_SNAPSHOT}")"
RID_LATEST="$(resource_id "${LATEST_CLONE}")"
RID_TIME="$(resource_id "${TO_TIME}")"
RESTORE_UPDATE=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" "${TIMEOUT_OVERRIDES[@]}"
if [ "$(resource_id "${FROM_SNAPSHOT}")" != "${RID_SNAPSHOT}" ] \
  || [ "$(resource_id "${BARE_SNAPSHOT}")" != "${RID_BARE}" ] \
  || [ "$(resource_id "${LATEST_CLONE}")" != "${RID_LATEST}" ] \
  || [ "$(resource_id "${TO_TIME}")" != "${RID_TIME}" ]; then
  echo "[verify] FAIL: an ordinary update replaced a restored cluster" >&2
  exit 1
fi
C="$(describe_cluster "${TO_TIME}")"
assert_field "${C}" "${TO_TIME}" .BackupRetentionPeriod 9 "the ordinary update reached AWS"
UPDATE_TAG="$(aws neptune list-tags-for-resource --resource-name "$(describe_cluster "${LATEST_CLONE}" | jq -r .DBClusterArn)" \
  --region "${REGION}" --query "TagList[?Key=='restore-update'].Value | [0]" --output text)"
if [ "${UPDATE_TAG}" != "applied" ]; then
  echo "[verify] FAIL: ${LATEST_CLONE} holds the update's tag as '${UPDATE_TAG}': the update of a cluster with a refused window did not apply" >&2
  exit 1
fi
if ! RESTORE_UPDATE=true ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${LOG_DIR}/drift.log" 2>&1; then
  cat "${LOG_DIR}/drift.log" >&2
  echo "[verify] FAIL: drift reports the restored stack as drifted (output above)" >&2
  exit 1
fi
echo "[verify] step 5 ok"

echo "[verify] step 6: destroy"
VPC_ID="$(printf '%s' "${STATE_3}" | jq -r '[.resources[] | select(.resourceType == "AWS::EC2::VPC") | .physicalId] | first // empty')"
SUBNET_GROUP="$(printf '%s' "${STATE_3}" | jq -r '.resources.SubnetGroup.physicalId // empty')"
if [ -z "${SUBNET_GROUP}" ] || [ -z "${VPC_ID}" ]; then
  echo "[verify] FAIL: state names no DB subnet group ('${SUBNET_GROUP}') or VPC ('${VPC_ID}')" >&2
  exit 1
fi
RESTORE_UPDATE=true ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force "${TIMEOUT_OVERRIDES[@]}"
for id in "${FROM_SNAPSHOT}" "${BARE_SNAPSHOT}" "${LATEST_CLONE}" "${TO_TIME}" "${SOURCE_CLUSTER}"; do
  assert_gone "DB cluster ${id} still exists after destroy" \
    aws neptune describe-db-clusters --db-cluster-identifier "${id}" --region "${REGION}"
done
assert_gone "DB instance ${SOURCE_DB} still exists after destroy" \
  aws neptune describe-db-instances --db-instance-identifier "${SOURCE_DB}" --region "${REGION}"
assert_gone "DB subnet group ${SUBNET_GROUP} still exists after destroy" \
  aws neptune describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

if delete_snapshot; then
  SNAPSHOT_CREATED=""
fi
assert_gone "snapshot ${SNAPSHOT_ID} still exists after its delete" \
  aws neptune describe-db-cluster-snapshots --db-cluster-snapshot-identifier "${SNAPSHOT_ID}" --region "${REGION}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "neptune-restore state teardown"

echo "[verify] PASS -- Neptune DB clusters restored through the SDK provider (go-to-k/cdkd#5638)"
