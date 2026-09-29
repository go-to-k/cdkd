#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control final-snapshot handlers (issue #4029).
#
# A Cloud Control delete handler for a snapshot-capable type may take a final
# snapshot of its own, because Cloud Control never tells it the DeletionPolicy.
# For RDS it always does (#3993); cdkd deletes those through RDS instead. This
# fixture covers the rest of #4029, each resource Cloud Control-routed and
# declaring DeletionPolicy: Delete. Measured on pre-fix cdkd (2026-09-29):
#
#   - AuroraMember: an Aurora cluster that is a member of a global cluster.
#     The handler detached it and took `rds-snapshot-<random>`; cdkd now
#     detaches it through RDS and deletes it without a snapshot.
#   - NeptuneCluster: a Neptune cluster (CopyTagsToSnapshot routes it through
#     Cloud Control). The handler took `<logical id>-snapshot-<random>`; cdkd
#     now deletes it through Neptune.
#   - Cache: a Redis cache cluster, moved onto Cloud Control in phase 2 with
#     --recreate-via-cc-api. Its handler took no snapshot; this arm guards
#     that it stays so.
#
# The run fails if any of the three has a manual snapshot created after the run
# began, and cleanup deletes any such snapshot.
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

# The Aurora master password is a stack-generated secret resolved through a
# dynamic reference, so state versions are swept like every secret-consuming
# fixture (issue #2096). Sourced by absolute path before the `cd` below, so the
# helper exists before the first `cleanup` can fire.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

cd "$(dirname "$0")"

STACK="CdkdCcFinalSnapshotHandlersExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Physical names are fixed in lib/, so cleanup can address them without state.
GLOBAL_ID="cdkd-ccfs-global"
AURORA_ID="cdkd-ccfs-aurora"
NEPTUNE_ID="cdkd-ccfs-neptune"
CACHE_ID="cdkd-ccfs-cache"
# When this run began (UTC, second precision). Empty until then, so the
# pre-run cleanup deletes no snapshot.
RUN_START=""

# Manual snapshots of cluster $2 (via service $1) created at or after
# RUN_START, one id per line; rc != 0 when the listing fails. A snapshot with
# no creation time yet (still being created) counts as this run's, like the
# cache arm below: the ids are this fixture's own.
this_run_rds_cluster_snapshots() { # usage: <service rds|neptune> <cluster id>
  local out
  out=$(aws "$1" describe-db-cluster-snapshots --db-cluster-identifier "$2" \
    --snapshot-type manual --region "${REGION}" --output json) || return 1
  # A present timestamp must be UTC, the prefix RUN_START is compared on;
  # anything else fails the listing rather than comparing wrongly.
  echo "${out}" | jq -r --arg start "${RUN_START}" '
    .DBClusterSnapshots
    | if all(.[]; .SnapshotCreateTime == null or (.SnapshotCreateTime | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(\\+00:00|Z)$")))
      then .[] | select(((.SnapshotCreateTime // "9999")[0:19]) >= $start) | .DBClusterSnapshotIdentifier
      else error("non-UTC SnapshotCreateTime") end'
}

# Snapshots of cache cluster $1 created at or after RUN_START, one name per
# line. A snapshot still being created may carry no node timestamp yet: it
# counts as this run's.
this_run_cache_snapshots() { # usage: <cache cluster id>
  local out
  out=$(aws elasticache describe-snapshots --cache-cluster-id "$1" \
    --region "${REGION}" --output json) || return 1
  echo "${out}" | jq -r --arg start "${RUN_START}" '
    .Snapshots[]
    | select(((.NodeSnapshots[0].SnapshotCreateTime // "9999")[0:19]) >= $start)
    | .SnapshotName'
}

record() { # usage: record <logical id> <jq field>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r --arg id "$1" ".resources[\$id]$2 // \"absent\""
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # --skip-final-snapshot: a teardown snapshot would outlive the run.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --remove-protection \
      --skip-final-snapshot \
      --yes
  fi
  # Best effort by fixed name, for a run that lost its state.
  aws elasticache delete-cache-cluster --cache-cluster-id "${CACHE_ID}" --region "${REGION}" >/dev/null 2>&1
  aws neptune delete-db-cluster --db-cluster-identifier "${NEPTUNE_ID}" --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1
  AURORA_ARN=$(aws rds describe-db-clusters --db-cluster-identifier "${AURORA_ID}" --region "${REGION}" --query 'DBClusters[0].DBClusterArn' --output text 2>/dev/null)
  case "${AURORA_ARN}" in
    arn:*)
      aws rds remove-from-global-cluster --global-cluster-identifier "${GLOBAL_ID}" --db-cluster-identifier "${AURORA_ARN}" --region "${REGION}" >/dev/null 2>&1
      aws rds wait db-cluster-available --db-cluster-identifier "${AURORA_ID}" --region "${REGION}" >/dev/null 2>&1
      aws rds delete-db-cluster --db-cluster-identifier "${AURORA_ID}" --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1
      aws rds wait db-cluster-deleted --db-cluster-identifier "${AURORA_ID}" --region "${REGION}" >/dev/null 2>&1
      ;;
  esac
  aws rds delete-global-cluster --global-cluster-identifier "${GLOBAL_ID}" --region "${REGION}" >/dev/null 2>&1
  # This run's snapshots of the three (the leak under test, or a teardown's).
  if [ -n "${RUN_START}" ]; then
    for pair in "rds ${AURORA_ID}" "neptune ${NEPTUNE_ID}"; do
      set -- ${pair}
      if ! SNAPS=$(this_run_rds_cluster_snapshots "$1" "$2"); then
        echo "    WARN: cleanup could not list the manual snapshots of $2; check for a leftover by hand" >&2
        SNAPS=""
      fi
      for snap in ${SNAPS}; do
        # Neptune shares the RDS snapshot API, and only `rds` has the waiter.
        aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier "${snap}" --region "${REGION}"
        aws "$1" delete-db-cluster-snapshot --db-cluster-snapshot-identifier "${snap}" --region "${REGION}" >/dev/null \
          && echo "    cleanup: deleted this run's manual snapshot ${snap}"
      done
    done
    if ! SNAPS=$(this_run_cache_snapshots "${CACHE_ID}"); then
      echo "    WARN: cleanup could not list the snapshots of ${CACHE_ID}; check for a leftover by hand" >&2
      SNAPS=""
    fi
    for snap in ${SNAPS}; do
      # No ElastiCache snapshot waiter: poll up to 15 minutes for `available`.
      for _ in $(seq 1 90); do
        STATUS=$(aws elasticache describe-snapshots --snapshot-name "${snap}" --region "${REGION}" --query 'Snapshots[0].SnapshotStatus' --output text 2>/dev/null)
        [ "${STATUS}" = "available" ] && break
        sleep 10
      done
      aws elasticache delete-snapshot --snapshot-name "${snap}" --region "${REGION}" >/dev/null \
        && echo "    cleanup: deleted this run's snapshot ${snap}"
    done
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  # NONCURRENT only, per ../s3-versions.sh: this also runs from the failure
  # and signal traps, where a live state.json may be the only record of a
  # standing resource. The success path does the full sweep.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
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
echo "==> Phase 1: deploy (run start ${RUN_START}Z)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Premises: without these the no-snapshot assertions test nothing.
for id in AuroraMember NeptuneCluster; do
  BY=$(record "${id}" '.provisionedBy')
  [ "${BY}" = "cc-api" ] || { echo "FAIL: premise: ${id} is routed via '${BY}', expected cc-api" >&2; exit 1; }
done
for id in AuroraMember NeptuneCluster Cache; do
  POLICY=$(record "${id}" '.deletionPolicy')
  [ "${POLICY}" = "Delete" ] || { echo "FAIL: premise: ${id} records DeletionPolicy '${POLICY}', expected Delete" >&2; exit 1; }
done
AURORA_ARN=$(aws rds describe-db-clusters --db-cluster-identifier "${AURORA_ID}" --region "${REGION}" --query 'DBClusters[0].DBClusterArn' --output text)
MEMBERS=$(aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_ID}" --region "${REGION}" --query 'GlobalClusters[0].GlobalClusterMembers[].DBClusterArn' --output text)
case " ${MEMBERS} " in
  *" ${AURORA_ARN} "*) ;;
  *) echo "FAIL: premise: ${AURORA_ID} is not a member of ${GLOBAL_ID} (members: ${MEMBERS})" >&2; exit 1 ;;
esac
echo "    OK: AuroraMember and NeptuneCluster are provisionedBy=cc-api; ${AURORA_ID} is a member of ${GLOBAL_ID}; all three record DeletionPolicy: Delete"

# --- Phase 2: move the cache onto Cloud Control ------------------------
echo "==> Phase 2: recreate the cache via Cloud Control (--recreate-via-cc-api)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api Cache \
  --force-stateful-recreation \
  --yes
CACHE_BY=$(record Cache '.provisionedBy')
[ "${CACHE_BY}" = "cc-api" ] || { echo "FAIL: premise: after --recreate-via-cc-api the cache is routed via '${CACHE_BY}', expected cc-api" >&2; exit 1; }
echo "    OK: Cache is provisionedBy=cc-api"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Aurora cluster ${AURORA_ID} still exists after destroy" aws rds describe-db-clusters --db-cluster-identifier "${AURORA_ID}" --region "${REGION}"
assert_gone "global cluster ${GLOBAL_ID} still exists after destroy" aws rds describe-global-clusters --global-cluster-identifier "${GLOBAL_ID}" --region "${REGION}"
assert_gone "Neptune cluster ${NEPTUNE_ID} still exists after destroy" aws neptune describe-db-clusters --db-cluster-identifier "${NEPTUNE_ID}" --region "${REGION}"
assert_gone "cache cluster ${CACHE_ID} still exists after destroy" aws elasticache describe-cache-clusters --cache-cluster-id "${CACHE_ID}" --region "${REGION}"
echo "    OK: state, the Aurora member, the global cluster, the Neptune cluster and the cache are gone"

# Issue #4029: no final snapshot of any of the three. Every leak is reported
# before failing, so one run measures all three handlers.
LEAKS=""
for pair in "rds ${AURORA_ID}" "neptune ${NEPTUNE_ID}"; do
  set -- ${pair}
  if ! SNAPS=$(this_run_rds_cluster_snapshots "$1" "$2"); then
    echo "FAIL: could not list the manual snapshots of $2" >&2
    exit 1
  fi
  [ -n "${SNAPS}" ] && LEAKS="${LEAKS} $2:$(printf '%s,' ${SNAPS})"
done
if ! SNAPS=$(this_run_cache_snapshots "${CACHE_ID}"); then
  echo "FAIL: could not list the snapshots of ${CACHE_ID}" >&2
  exit 1
fi
[ -n "${SNAPS}" ] && LEAKS="${LEAKS} ${CACHE_ID}:$(printf '%s,' ${SNAPS})"
if [ -n "${LEAKS}" ]; then
  echo "FAIL: destroying the Cloud Control-routed resources (DeletionPolicy: Delete) left snapshot(s):${LEAKS} (issue #4029)" >&2
  exit 1
fi
echo "    OK: no snapshot of ${AURORA_ID}, ${NEPTUNE_ID} or ${CACHE_ID} since ${RUN_START}Z (issue #4029)"

# --- State-version sweep, on the success path ------------------------------
# The bucket is VERSIONED: `aws s3 rm` and destroy leave every prior state
# version readable. Disarm the trap first; nothing is left for cleanup to do.
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "cc-final-snapshot-handlers state teardown"

echo ""
echo "[verify] PASS — Cloud Control-routed Aurora global member, Neptune cluster and Redis cache cluster deleted without a final snapshot"
