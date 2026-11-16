#!/usr/bin/env bash
#
# go-to-k/cdkd#6445 case 3: a create-first replacement under
# `UpdateReplacePolicy: Snapshot` waits for the deploy's cleanup phase to
# delete the old RDS instance, and that deferred delete takes the final
# snapshot. A deploy that fails after the replacement never reaches the
# cleanup phase: its rollback re-adopts the old instance whole, and no final
# snapshot is taken.
#
# Phases:
#   1. Baseline deploy: `Db` = RDS instance `cdkd-rsfr-db-a`. Asserted: it is
#      available, state names it on the SDK route (the atomic final snapshot's
#      route), and it has no manual snapshot.
#   2. `DB_SUFFIX=b BREAK=true` deploys with `--force-stateful-recreation` and
#      the automatic rollback: `cdkd-rsfr-db-b` is created, the old instance's
#      delete waits for the cleanup phase, and `BadQueue` fails the deploy.
#      Asserted, AWS first: `cdkd-rsfr-db-a` is still available (not deleting)
#      with its step-1 `DbiResourceId`, `cdkd-rsfr-db-b` is gone, `db-a` has no
#      manual snapshot, and `db-b` has exactly one, which the rollback's delete
#      of the new copy took under its `UpdateReplacePolicy: Snapshot` (deleted
#      as a test artifact); the deploy said
#      the old instance's delete waits for the rest of the deploy, never deleted
#      it inline, and the rollback re-adopted it; state names it with no
#      superseded entry, and the journal keeps only the failed `BadQueue`.
#   3. Positive control, `DB_SUFFIX=b` without `BREAK`: the deploy succeeds,
#      and its cleanup phase deletes `cdkd-rsfr-db-a` with a final snapshot.
#      Asserted: `cdkd-rsfr-db-a` is gone, exactly one manual snapshot of it
#      exists and is available, the cleanup ran after the deploy's other
#      changes, and state names `cdkd-rsfr-db-b`. The snapshot is then deleted.
#   4. `cdkd destroy` (`DeletionPolicy: Delete`): both instances, the subnet
#      group, the state file and the journal are gone, no manual snapshot of
#      either instance is left, and the state prefix's object versions are
#      swept.
#
# Cost: one db.t3.micro instance at a time (two during the replacing deploys),
# for roughly 40-60 minutes in all, plus one small manual snapshot deleted in
# step 3. On any failure, cleanup deletes both instances without a final
# snapshot, every manual snapshot of them, the subnet group and the stack.
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
STACK="CdkdReplaceSnapshotFailedRollback"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/replace-snapshot-failed-rollback"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096).
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The names the stack derives (lib/replace-snapshot-failed-rollback-stack.ts).
DB_A="cdkd-rsfr-db-a"
DB_B="cdkd-rsfr-db-b"
ALL_DBS=("${DB_A}" "${DB_B}")
SUBNET_GROUP="cdkd-rsfr-subnets"

# Set once the preconditions below pass: before that, the instances or the
# stack may belong to a concurrent or earlier run.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The manual snapshots of instance "$1", one identifier per line.
manual_snapshots() { # usage: manual_snapshots <db-instance-id>  (fails on a failed listing)
  local out
  out="$(aws rds describe-db-snapshots --db-instance-identifier "$1" --snapshot-type manual \
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true
}
# The instance's status, or `gone` when RDS reports it not found; fails on any
# other read failure.
db_status() { # usage: db_status <db-instance-id>
  local out
  if out="$(aws rds describe-db-instances --db-instance-identifier "$1" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1)"; then
    printf '%s\n' "${out}"
    return 0
  fi
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    printf 'gone\n'
    return 0
  fi
  echo "[verify] FAIL: could not read RDS instance $1: ${out}" >&2
  return 1
}
# Wait (up to ~30 min) until instance "$1" reads gone.
wait_db_gone() { # usage: wait_db_gone <db-instance-id>  (0 = gone)
  local status
  for _ in $(seq 1 120); do
    status="$(db_status "$1")" || return 1
    [ "${status}" = "gone" ] && return 0
    sleep 15
  done
  return 1
}
# Wait (up to ~5 min) until manual snapshot "$1" reads gone; a snapshot reads
# `deleting` for a while after its delete.
wait_snapshot_gone() { # usage: wait_snapshot_gone <snapshot-id>  (0 = gone)
  for _ in $(seq 1 30); do
    if gone_probe aws rds describe-db-snapshots --db-snapshot-identifier "$1"; then return 0; fi
    sleep 10
  done
  return 1
}
delete_db() { ( # usage: delete_db <db-instance-id>  (best-effort, no final snapshot)
  set +eu
  aws rds delete-db-instance --db-instance-identifier "$1" --skip-final-snapshot \
    --delete-automated-backups >/dev/null 2>&1
  true
); }
delete_snapshots_of() { ( # usage: delete_snapshots_of <db-instance-id>  (best-effort)
  set +eu
  for s in $(manual_snapshots "$1" 2>/dev/null); do
    aws rds delete-db-snapshot --db-snapshot-identifier "${s}" >/dev/null 2>&1
  done
  true
); }

cleanup() {
  rc=$?
  set +eu
  rm -rf "${LOG_DIR}"
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # The instances first, by name and without a snapshot: a record may not
    # hold the one a failed rollback left. The destroy below then deletes what
    # the records hold, the VPC among them, and the journal.
    for d in "${ALL_DBS[@]}"; do delete_db "${d}"; done
    for d in "${ALL_DBS[@]}"; do wait_db_gone "${d}" >/dev/null 2>&1; done
    (cd "${TEST_DIR}" && env -u DB_SUFFIX -u BREAK ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    for d in "${ALL_DBS[@]}"; do
      delete_snapshots_of "${d}"
      [ "$(db_status "${d}" 2>/dev/null)" = "gone" ] \
        || echo "[verify] WARN: RDS instance ${d} could not be confirmed deleted; delete it by hand" >&2
      [ -z "$(manual_snapshots "${d}" 2>/dev/null)" ] \
        || echo "[verify] WARN: manual snapshots of ${d} may remain; delete them by hand" >&2
    done
    ( set +eu; aws rds delete-db-subnet-group --db-subnet-group-name "${SUBNET_GROUP}" >/dev/null 2>&1; true )
    ( gone_probe aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" ) \
      || echo "[verify] WARN: DB subnet group ${SUBNET_GROUP} could not be confirmed deleted; delete it by hand" >&2
    # A destroy that failed leaves the state record, and with it the VPC.
    ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) \
      || echo "[verify] WARN: ${STATE_KEY} still exists, so the stack's VPC and subnets may remain; run cdkd destroy ${STACK} again" >&2
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
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
# run the cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# A record, journal, instance or snapshot left by an earlier, interrupted run
# would be blamed on the steps below.
for key in "${STATE_KEY}" "${JOURNAL_KEY}"; do
  assert_gone "precondition: ${key} already exists (left by an earlier run); destroy the stack first" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
for d in "${ALL_DBS[@]}"; do
  assert_gone "precondition: RDS instance ${d} already exists (left by an earlier run); delete it first" \
    aws rds describe-db-instances --db-instance-identifier "${d}"
  PRE_SNAPS="$(manual_snapshots "${d}")"
  if [ -n "${PRE_SNAPS}" ]; then
    echo "[verify] FAIL: precondition -- manual snapshots of ${d} already exist (left by an earlier run); delete them first: ${PRE_SNAPS}" >&2
    exit 1
  fi
done
assert_gone "precondition: DB subnet group ${SUBNET_GROUP} already exists (left by an earlier run); delete it first" \
  aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (Db = ${DB_A})"
env -u DB_SUFFIX -u BREAK ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
STATUS_1="$(db_status "${DB_A}")"
# AWS's own identity of the instance: a re-created copy under the same name
# would read a different one.
DBI_1="$(aws rds describe-db-instances --db-instance-identifier "${DB_A}" \
  --query 'DBInstances[0].DbiResourceId' --output text)"
case "${DBI_1}" in
  db-?*) ;;
  *) echo "[verify] FAIL: could not read ${DB_A}'s DbiResourceId after step 1 (got '${DBI_1}')" >&2; exit 1 ;;
esac
if [ "${STATUS_1}" != "available" ]; then
  echo "[verify] FAIL: ${DB_A} is '${STATUS_1}' after step 1 (expected available)" >&2
  exit 1
fi
STATE_1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ "$(printf '%s' "${STATE_1}" | jq -r '.resources.Db.physicalId // "<absent>"')" != "${DB_A}" ]; then
  echo "[verify] FAIL: state's Db is not ${DB_A} after step 1" >&2
  exit 1
fi
# The atomic final snapshot is the SDK route's; Cloud Control would refuse it.
if [ "$(printf '%s' "${STATE_1}" | jq -r '.resources.Db.provisionedBy // "<absent>"')" != "sdk" ]; then
  echo "[verify] FAIL: precondition -- state's Db is not on the SDK route after step 1, so its replacement cannot take an atomic final snapshot" >&2
  exit 1
fi
if [ -n "$(manual_snapshots "${DB_A}")" ]; then
  echo "[verify] FAIL: ${DB_A} has a manual snapshot after step 1" >&2
  exit 1
fi

echo "[verify] step 2: replacing deploy (Db = ${DB_B}), then BadQueue fails it"
set +e
env DB_SUFFIX=b BREAK=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --force-stateful-recreation > "${LOG_DIR}/deploy.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the deploy unexpectedly SUCCEEDED (BadQueue's create must fail)" >&2
  exit 1
fi
DEPLOY_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | tr '\n' ' ' | tr -s ' ')"
# The premise: the replacement ran, then BadQueue failed the deploy.
# Both on ONE line of the log. Captured first: a `grep | grep -q` pipe can
# SIGPIPE under pipefail.
FAIL_LINES="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | grep -F "Failed to create" || true)"
if ! grep -qF "BadQueue" <<<"${FAIL_LINES}"; then
  echo "[verify] FAIL: precondition -- the deploy did not fail on BadQueue's create (output above)" >&2
  exit 1
fi
# AWS first: the old instance was never sent its delete, and no snapshot of it
# was taken; the rollback deleted the new one.
STATUS_2="$(db_status "${DB_A}")"
if [ "${STATUS_2}" != "available" ]; then
  echo "[verify] FAIL: ${DB_A} is '${STATUS_2}' after step 2 (expected available: its delete must wait for the cleanup phase, which a failed deploy never reaches) -- go-to-k/cdkd#6445 (output above)" >&2
  exit 1
fi
DBI_2="$(aws rds describe-db-instances --db-instance-identifier "${DB_A}" \
  --query 'DBInstances[0].DbiResourceId' --output text)"
if [ "${DBI_2}" != "${DBI_1}" ]; then
  echo "[verify] FAIL: ${DB_A}'s DbiResourceId is '${DBI_2}' after the rollback (expected ${DBI_1}: the same instance re-adopted, not a re-created one)" >&2
  exit 1
fi
if ! wait_db_gone "${DB_B}"; then
  echo "[verify] FAIL: the replacement ${DB_B} still exists after the rollback re-adopted ${DB_A}" >&2
  exit 1
fi
LEFT_SNAPS_A="$(manual_snapshots "${DB_A}")"
if [ -n "${LEFT_SNAPS_A}" ]; then
  echo "[verify] FAIL: a final snapshot of ${DB_A} was taken although the rollback re-adopted it: ${LEFT_SNAPS_A}" >&2
  exit 1
fi
# The rollback deletes the NEW copy under its own UpdateReplacePolicy (not its
# DeletionPolicy, as CloudFormation does: rollbackFinalSnapshotId,
# src/deployment/rollback-executor/messages.ts), so it takes exactly one final
# snapshot of db-b, which may hold writes. A test artifact: deleted here.
SNAPS_B="$(manual_snapshots "${DB_B}")"
if [ "$(printf '%s\n' "${SNAPS_B}" | grep -c .)" != "1" ]; then
  echo "[verify] FAIL: expected exactly one final snapshot of the rolled-back ${DB_B}, found: '${SNAPS_B}'" >&2
  exit 1
fi
aws rds delete-db-snapshot --db-snapshot-identifier "${SNAPS_B}" >/dev/null
if ! wait_snapshot_gone "${SNAPS_B}"; then
  echo "[verify] FAIL: the final snapshot ${SNAPS_B} of ${DB_B} still exists after its delete" >&2
  exit 1
fi
# The route. Sentinel: the inline delete's own announcement names the
# regression outright.
if grep -qF "Deleting old Db (${DB_A})..." <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the deploy deleted the old Db (${DB_A}) inline, right after the create -- go-to-k/cdkd#6445: UpdateReplacePolicy: Snapshot must defer the delete to the cleanup phase (output above)" >&2
  exit 1
fi
if ! grep -qF "Old Db (${DB_A}) is deleted after the rest of the deploy succeeds" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the deploy did not report deferring the old Db's delete to the cleanup phase -- the deferral's wording drifted, or the replacement took another route (output above)" >&2
  exit 1
fi
if ! grep -qF "the old resource of Db (${DB_A}) was not deleted yet — re-adopting it" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the rollback did not report re-adopting the old Db (${DB_A}) whose delete was never sent (output above)" >&2
  exit 1
fi
if grep -qF "Rollback failed for Db" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the rollback of Db failed (output above)" >&2
  exit 1
fi
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ "$(printf '%s' "${STATE_2}" | jq -r '.resources.Db.physicalId // "<absent>"')" != "${DB_A}" ]; then
  echo "[verify] FAIL: state's Db is not the re-adopted ${DB_A} after the rollback" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_2}" | jq '(.supersededResources // []) | length')" != "0" ]; then
  echo "[verify] FAIL: state still lists a superseded resource after the rollback re-adopted ${DB_A}" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_2}" | jq '.resources | has("BadQueue")')" != "false" ]; then
  echo "[verify] FAIL: state records BadQueue after the rollback" >&2
  exit 1
fi
# The clean rollback keeps a failed-only segment for the failed CREATE
# (settleJournalAfterCleanRollback, src/deployment/deploy-engine/rollback/
# settle.ts, kept for `cdkd rollback --revert-failed`): no completed operation
# is left to replay, and the failed one is BadQueue.
JOURNAL_LEFT="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)" \
  || { echo "[verify] FAIL: could not read the journal ${JOURNAL_KEY} after the rollback" >&2; exit 1; }
JOURNAL_SHAPE="$(printf '%s' "${JOURNAL_LEFT}" | jq -c '[([.segments[]?.operations[]?] | length), [.segments[]?.failedOperations[]?.logicalId]]')"
if [ "${JOURNAL_SHAPE}" != '[0,["BadQueue"]]' ]; then
  echo "[verify] FAIL: the journal after the clean rollback is ${JOURNAL_SHAPE} (expected [0,[\"BadQueue\"]]: no completed operation left, only the failed BadQueue)" >&2
  exit 1
fi
echo "[verify] step 2 ok: the rollback re-adopted ${DB_A} with no final snapshot taken, and deleted ${DB_B} (deploy rc=${DEPLOY_RC})"

echo "[verify] step 3: the same replacement without BadQueue: the cleanup phase deletes ${DB_A} with a final snapshot"
env -u BREAK DB_SUFFIX=b ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --force-stateful-recreation > "${LOG_DIR}/deploy-ok.log" 2>&1 \
  || { sed 's/^/  /' "${LOG_DIR}/deploy-ok.log"; echo "[verify] FAIL: step 3's deploy failed (output above)" >&2; exit 1; }
sed 's/^/  /' "${LOG_DIR}/deploy-ok.log" || true
OK_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy-ok.log")"
if ! wait_db_gone "${DB_A}"; then
  echo "[verify] FAIL: ${DB_A} still exists after the successful replacing deploy" >&2
  exit 1
fi
SNAPS_3="$(manual_snapshots "${DB_A}")"
if [ "$(printf '%s\n' "${SNAPS_3}" | grep -c .)" != "1" ]; then
  echo "[verify] FAIL: expected exactly one final snapshot of ${DB_A} after the cleanup phase deleted it, found: '${SNAPS_3}'" >&2
  exit 1
fi
SNAP_STATUS="$(aws rds describe-db-snapshots --db-snapshot-identifier "${SNAPS_3}" \
  --query 'DBSnapshots[0].Status' --output text)"
if [ "${SNAP_STATUS}" != "available" ]; then
  echo "[verify] FAIL: the final snapshot ${SNAPS_3} of ${DB_A} is '${SNAP_STATUS}' (expected available)" >&2
  exit 1
fi
# The delete ran in the cleanup phase: its pass line, after the deferral line.
DEFER_LINE="$(grep -nF "Old Db (${DB_A}) is deleted after the rest of the deploy succeeds" <<<"${OK_PLAIN}" | head -1 | cut -d: -f1 || true)"
CLEANUP_LINE="$(grep -nF "Deleting the old resource of 1 replaced resource(s)" <<<"${OK_PLAIN}" | head -1 | cut -d: -f1 || true)"
if [ -z "${DEFER_LINE}" ] || [ -z "${CLEANUP_LINE}" ] || [ "${CLEANUP_LINE}" -le "${DEFER_LINE}" ]; then
  echo "[verify] FAIL: step 3 did not defer ${DB_A}'s delete and then run it in the cleanup phase (deferral line ${DEFER_LINE:-<none>}, cleanup line ${CLEANUP_LINE:-<none>}; output above)" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ "$(printf '%s' "${STATE_3}" | jq -r '.resources.Db.physicalId // "<absent>"')" != "${DB_B}" ]; then
  echo "[verify] FAIL: state's Db is not ${DB_B} after step 3" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_3}" | jq '(.supersededResources // []) | length')" != "0" ]; then
  echo "[verify] FAIL: state still lists a superseded resource after the cleanup phase deleted ${DB_A}" >&2
  exit 1
fi
echo "[verify] step 3 ok: the cleanup phase deleted ${DB_A} with the final snapshot ${SNAPS_3}; deleting that test artifact"
aws rds delete-db-snapshot --db-snapshot-identifier "${SNAPS_3}" >/dev/null
if ! wait_snapshot_gone "${SNAPS_3}"; then
  echo "[verify] FAIL: the final snapshot ${SNAPS_3} still exists after its delete" >&2
  exit 1
fi

echo "[verify] step 4: destroy"
env -u BREAK DB_SUFFIX=b ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for d in "${ALL_DBS[@]}"; do
  if ! wait_db_gone "${d}"; then
    echo "[verify] FAIL: RDS instance ${d} still exists after destroy" >&2
    exit 1
  fi
  LEFT_SNAPS="$(manual_snapshots "${d}")"
  if [ -n "${LEFT_SNAPS}" ]; then
    echo "[verify] FAIL: manual snapshots of ${d} remain after destroy (DeletionPolicy: Delete takes none): ${LEFT_SNAPS}" >&2
    exit 1
  fi
done
assert_gone "DB subnet group ${SUBNET_GROUP} still exists after destroy" \
  aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "replace-snapshot-failed-rollback state teardown"

echo "[verify] PASS -- under UpdateReplacePolicy: Snapshot the old RDS instance's delete waited for the cleanup phase (go-to-k/cdkd#6445): a failed deploy's rollback re-adopted it with no final snapshot taken, and a successful one deleted it with its final snapshot"
