#!/usr/bin/env bash
# verify.sh - DeletionPolicy: Snapshot on Redshift + ElastiCache ReplicationGroup
# (issue #1353).
#
# Completes the #1352 coverage: the two remaining CFn-documented
# Snapshot-capable types are CC-API-routed with no atomic delete parameter,
# so cdkd must run its pre-delete snapshot machinery (CreateClusterSnapshot /
# ElastiCache CreateSnapshot + wait) before the delete.
#
#   Phase 1: deploy a single-node dc2.large Redshift cluster + a 1-node
#            cache.t3.micro Redis replication group, both
#            DeletionPolicy: Snapshot.
#   Phase 2: cdkd destroy - both resources must be deleted AND a ready
#            (available) cdkd-prefixed snapshot must exist for each.
#   Phase 3: delete the two final snapshots (test artifacts; a real user
#            would keep them) and verify zero orphans.
#
# ~30-40 min end to end (ElastiCache replication-group create dominates).
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdDeletionPolicySnapshotHeavyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IDS_FILE="/tmp/cdkd-integ-deletion-policy-snapshot-heavy-ids"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Throwaway per-run Redshift master password (cluster lives ~20 minutes).
CDKD_TEST_RS_PASSWORD="Cdkd$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')a1"
export CDKD_TEST_RS_PASSWORD

# redshift_snapshot_id / redis_snapshot_id — first cdkd-prefixed snapshot of
# the source, or empty ("None"-free strict captures; a real probe failure
# aborts the run; in cleanup the surrounding `set +eu` keeps it best-effort).
redshift_snapshot_id() {
  local id
  id=$(aws redshift describe-cluster-snapshots --region "${REGION}" \
    --cluster-identifier "$1" --snapshot-type manual \
    --query "Snapshots[?starts_with(SnapshotIdentifier, '$1-final-')] | [0].SnapshotIdentifier" \
    --output text) || return 1
  if [ "${id}" = "None" ]; then id=""; fi
  printf '%s' "${id}"
}
redis_snapshot_id() {
  local id
  id=$(aws elasticache describe-snapshots --region "${REGION}" \
    --query "Snapshots[?starts_with(SnapshotName, '$1-final-')] | [0].SnapshotName" \
    --output text) || return 1
  if [ "${id}" = "None" ]; then id=""; fi
  printf '%s' "${id}"
}

# tag_sweep_ids <tag-value> — resource ARNs this fixture tagged, so a deploy
# that dies BEFORE the ids file is written still gets cleaned up. Best-effort:
# callers run it inside the `set +eu` cleanup span.
tag_sweep_ids() {
  aws resourcegroupstaggingapi get-resources --region "${REGION}" \
    --tag-filters "Key=cdkd-integ,Values=$1" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover snapshots + clusters + state"
  set +eu
  # Tag sweep FIRST: the ids file only exists after a successful deploy, so a
  # Phase-1 failure would otherwise leave a billing cluster + replication
  # group behind (both carry the cdkd-integ tag from the template).
  for arn in $(tag_sweep_ids deletion-policy-snapshot-heavy-redshift); do
    swept_cluster="${arn##*:}"
    aws redshift delete-cluster --cluster-identifier "${swept_cluster}" \
      --skip-final-cluster-snapshot --region "${REGION}" >/dev/null 2>&1
  done
  for arn in $(tag_sweep_ids deletion-policy-snapshot-heavy-redis); do
    swept_group="${arn##*:}"
    aws elasticache delete-replication-group --replication-group-id "${swept_group}" \
      --no-retain-primary-cluster --region "${REGION}" >/dev/null 2>&1
  done
  if [ -f "${IDS_FILE}" ]; then
    while IFS=$'\t' read -r kind src_id; do
      [ -n "${src_id}" ] || continue
      if [ "${kind}" = "redshift" ]; then
        snap=$(redshift_snapshot_id "${src_id}")
        if [ -n "${snap}" ]; then
          aws redshift delete-cluster-snapshot --snapshot-identifier "${snap}" \
            --region "${REGION}" >/dev/null 2>&1
        fi
        # A cluster still `creating` rejects delete with
        # InvalidClusterStateFault — retry so it cannot leak (bounded). The
        # loop branches on the DELETE's own (mutation) output, never on a
        # separate read probe, so it cannot conclude "gone" from a throttle.
        for _ in $(seq 1 30); do
          del_out=$(aws redshift delete-cluster --cluster-identifier "${src_id}" \
            --skip-final-cluster-snapshot --region "${REGION}" 2>&1) && break
          case "${del_out}" in *ClusterNotFound*) break ;; esac
          sleep 20
        done
      elif [ "${kind}" = "redis" ]; then
        snap=$(redis_snapshot_id "${src_id}")
        if [ -n "${snap}" ]; then
          aws elasticache delete-snapshot --snapshot-name "${snap}" \
            --region "${REGION}" >/dev/null 2>&1
        fi
        for _ in $(seq 1 30); do
          del_out=$(aws elasticache delete-replication-group \
            --replication-group-id "${src_id}" --no-retain-primary-cluster \
            --region "${REGION}" 2>&1) && break
          case "${del_out}" in *ReplicationGroupNotFound*) break ;; esac
          sleep 20
        done
      fi
    done < "${IDS_FILE}"
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --skip-final-snapshot --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -f "${IDS_FILE}"
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy (Redshift cluster + Redis replication group, both Snapshot policy)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

CLUSTER_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | \
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);process.stdout.write(s.outputs.ClusterId ?? "")})')
GROUP_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | \
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);process.stdout.write(s.outputs.ReplicationGroupId ?? "")})')
if [ -z "${CLUSTER_ID}" ] || [ -z "${GROUP_ID}" ]; then
  echo "FAIL: deployed outputs not found (cluster=${CLUSTER_ID}, group=${GROUP_ID})" >&2
  exit 1
fi
printf 'redshift\t%s\nredis\t%s\n' "${CLUSTER_ID}" "${GROUP_ID}" > "${IDS_FILE}"
echo "    Cluster=${CLUSTER_ID} ReplicationGroup=${GROUP_ID}"

# --- Phase 2: destroy (pre-delete snapshot machinery, #1353) ----------------
echo "==> Phase 2: cdkd destroy (pre-delete final snapshots for both types)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "Redshift cluster still exists after destroy" \
  aws redshift describe-clusters --cluster-identifier "${CLUSTER_ID}" --region "${REGION}"
assert_gone "Redis replication group still exists after destroy" \
  aws elasticache describe-replication-groups --replication-group-id "${GROUP_ID}" --region "${REGION}"

SNAP_RS_ID=$(redshift_snapshot_id "${CLUSTER_ID}")
if [ -z "${SNAP_RS_ID}" ]; then
  echo "FAIL: no final snapshot created for Redshift cluster ${CLUSTER_ID} (DeletionPolicy: Snapshot ignored)" >&2
  exit 1
fi
SNAP_RS_STATE=$(aws redshift describe-cluster-snapshots --snapshot-identifier "${SNAP_RS_ID}" \
  --region "${REGION}" --query 'Snapshots[0].Status' --output text)
if [ "${SNAP_RS_STATE}" != "available" ]; then
  echo "FAIL: Redshift final snapshot ${SNAP_RS_ID} not available (status=${SNAP_RS_STATE})" >&2
  exit 1
fi
echo "    Redshift path OK: ${SNAP_RS_ID} available for ${CLUSTER_ID}"

SNAP_REDIS_ID=$(redis_snapshot_id "${GROUP_ID}")
if [ -z "${SNAP_REDIS_ID}" ]; then
  echo "FAIL: no final snapshot created for replication group ${GROUP_ID} (DeletionPolicy: Snapshot ignored)" >&2
  exit 1
fi
SNAP_REDIS_STATE=$(aws elasticache describe-snapshots --snapshot-name "${SNAP_REDIS_ID}" \
  --region "${REGION}" --query 'Snapshots[0].SnapshotStatus' --output text)
if [ "${SNAP_REDIS_STATE}" != "available" ]; then
  echo "FAIL: Redis final snapshot ${SNAP_REDIS_ID} not available (status=${SNAP_REDIS_STATE})" >&2
  exit 1
fi
echo "    ElastiCache path OK: ${SNAP_REDIS_ID} available for ${GROUP_ID}"

assert_gone "state file still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

# --- Phase 3: artifact cleanup + zero-orphan verification -------------------
echo "==> Phase 3: deleting the two final snapshots (test artifacts)"
aws redshift delete-cluster-snapshot --snapshot-identifier "${SNAP_RS_ID}" --region "${REGION}" >/dev/null
aws elasticache delete-snapshot --snapshot-name "${SNAP_REDIS_ID}" --region "${REGION}" >/dev/null

# Both snapshot deletes are ASYNC (a 'deleting' state lingers) — a single
# immediate gone-probe would false-FAIL; poll bounded before concluding leak.
RS_GONE=0
for _ in $(seq 1 24); do
  if gone_probe aws redshift describe-cluster-snapshots \
    --snapshot-identifier "${SNAP_RS_ID}" --region "${REGION}"; then
    RS_GONE=1
    break
  fi
  # An empty Snapshots list is a success response, not a not-found error —
  # treat it as gone too (same escape as the ElastiCache twin below).
  RS_REMAINING=$(aws redshift describe-cluster-snapshots \
    --snapshot-identifier "${SNAP_RS_ID}" --region "${REGION}" \
    --query 'length(Snapshots)' --output text)
  if [ "${RS_REMAINING}" = "0" ]; then
    RS_GONE=1
    break
  fi
  sleep 5
done
if [ "${RS_GONE}" -ne 1 ]; then
  echo "FAIL: Redshift final snapshot ${SNAP_RS_ID} still present after artifact cleanup" >&2
  exit 1
fi
REDIS_GONE=0
for _ in $(seq 1 24); do
  if gone_probe aws elasticache describe-snapshots --snapshot-name "${SNAP_REDIS_ID}" \
    --region "${REGION}"; then
    REDIS_GONE=1
    break
  fi
  # An empty Snapshots list is a success response, not a not-found error —
  # treat it as gone too (ElastiCache describe-snapshots by name returns []
  # once the delete completes).
  REMAINING=$(aws elasticache describe-snapshots --snapshot-name "${SNAP_REDIS_ID}" \
    --region "${REGION}" --query 'length(Snapshots)' --output text)
  if [ "${REMAINING}" = "0" ]; then
    REDIS_GONE=1
    break
  fi
  sleep 5
done
if [ "${REDIS_GONE}" -ne 1 ]; then
  echo "FAIL: Redis final snapshot ${SNAP_REDIS_ID} still present after artifact cleanup" >&2
  exit 1
fi
rm -f "${IDS_FILE}"

echo "PASS: DeletionPolicy: Snapshot honored for Redshift Cluster + ElastiCache ReplicationGroup, zero orphans"
