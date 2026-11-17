#!/usr/bin/env bash
#
# go-to-k/cdkd#6463: a create-first replacement of a type cdkd snapshots
# BEFORE its delete (here an EBS volume), under `UpdateReplacePolicy:
# Snapshot`, waits for the deploy's cleanup phase to delete the old copy, and
# the pre-delete snapshot moves into that deferred delete. A deploy that fails
# after the replacement never reaches the cleanup phase: its rollback
# re-adopts the old volume whole, and no snapshot of it is taken.
#
# Phases:
#   1. Baseline deploy: `Vol` = a 1 GiB gp3 volume in the first AZ. Asserted:
#      it is available, state names it, and no snapshot of it exists.
#   2. `VOL_AZ=b BREAK=true` deploys with `--force-stateful-recreation` and
#      the automatic rollback: a new volume is created in the second AZ, the
#      old volume's delete waits for the cleanup phase, and `BadQueue` fails
#      the deploy. Asserted, AWS first: the step-1 volume (same VolumeId) is
#      still available, the new volume (read from the state versions this run
#      wrote) is gone, no snapshot of either volume exists -- the old one's is
#      owed by the cleanup phase this deploy never reached, and the rollback
#      deletes a pre-delete-snapshot type's NEW copy with a plain delete
#      (`rollbackFinalSnapshotId` returns no identifier for it,
#      src/deployment/rollback-executor/messages.ts; Cloud Control's volume
#      delete is EC2 `DeleteVolume`, src/provisioning/ec2-volume-delete.ts);
#      the deploy said the old volume's delete waits for the rest of the
#      deploy, never deleted it inline, took no snapshot, and the rollback
#      re-adopted it; state names it with no superseded entry, and the journal
#      keeps only the failed `BadQueue`.
#   3. Positive control, `VOL_AZ=b` without `BREAK`: the deploy succeeds, and
#      its cleanup phase snapshots the old volume, then deletes it. Asserted:
#      the old volume is gone, exactly one snapshot of it exists, completed and
#      tagged by cdkd, started after the new volume was created; the deploy's
#      log shows the snapshot inside the cleanup pass, before the delete;
#      state names the new volume with no superseded entry. The snapshot is
#      then deleted.
#   4. `cdkd destroy` (`DeletionPolicy: Delete`): the volume, the state file
#      and the journal are gone, no snapshot of any of the run's volumes is
#      left, and the state prefix's object versions are swept.
#
# Cost: two 1 GiB gp3 volumes at most, for a few minutes, plus one empty
# 1 GiB snapshot deleted in step 3. On any failure, cleanup deletes every
# volume carrying this fixture's tag and every snapshot of a volume this run
# recorded, then destroys the stack.
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
STACK="CdkdReplacePredeleteSnapshotFailedRollback"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/replace-predelete-snapshot-failed-rollback"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096).
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The tag the stack puts on its volume (lib/replace-predelete-snapshot-failed-rollback-stack.ts).
FIXTURE_TAG="replace-predelete-snapshot-failed-rollback"
# The tag cdkd puts on its EBS final snapshot (src/provisioning/final-snapshot/shared.ts).
SNAPSHOT_TAG_KEY="cdkd:final-snapshot-of"

# Set once the preconditions below pass: before that, the volumes or the
# stack may belong to a concurrent or earlier run.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"
# Every volume id this run saw, for the failure cleanup's snapshot sweep.
RUN_VOLUMES=()

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The live (not deleted) volumes carrying this fixture's tag, one id per line.
fixture_volumes() { # (fails on a failed listing)
  local out
  out="$(aws ec2 describe-volumes \
    --filters "Name=tag:cdkd-integ-fixture,Values=${FIXTURE_TAG}" \
    "Name=status,Values=creating,available,in-use,deleting,error" \
    --query 'Volumes[].VolumeId' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true
}
# Every snapshot (any status) of volume "$1", one id per line.
snapshots_of() { # usage: snapshots_of <volume-id>  (fails on a failed listing)
  local out
  out="$(aws ec2 describe-snapshots --owner-ids self \
    --filters "Name=volume-id,Values=$1" \
    --query 'Snapshots[].SnapshotId' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true
}
# The volume's state, or `gone` when EC2 reports it not found; fails on any
# other read failure.
volume_state() { # usage: volume_state <volume-id>
  local out
  if out="$(aws ec2 describe-volumes --volume-ids "$1" \
    --query 'Volumes[0].State' --output text 2>&1)"; then
    printf '%s\n' "${out}"
    return 0
  fi
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    printf 'gone\n'
    return 0
  fi
  echo "[verify] FAIL: could not read EBS volume $1: ${out}" >&2
  return 1
}
# Wait (up to ~10 min) until volume "$1" reads gone (`deleted` counts).
wait_volume_gone() { # usage: wait_volume_gone <volume-id>  (0 = gone)
  local state
  for _ in $(seq 1 60); do
    state="$(volume_state "$1")" || return 1
    case "${state}" in gone | deleted) return 0 ;; esac
    sleep 10
  done
  return 1
}
# Wait (up to ~5 min) until snapshot "$1" reads gone.
wait_snapshot_gone() { # usage: wait_snapshot_gone <snapshot-id>  (0 = gone)
  for _ in $(seq 1 30); do
    if gone_probe aws ec2 describe-snapshots --snapshot-ids "$1"; then return 0; fi
    sleep 10
  done
  return 1
}
# The distinct `Vol` physical ids every version of the state file recorded,
# one per line: the step-2 row save names the new volume before the rollback
# moved state back.
state_version_volumes() { # (fails on a failed read)
  local versions tmp v
  versions="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${STATE_KEY}" \
    --query "Versions[?Key=='${STATE_KEY}'].VersionId" --output text)" || return 1
  tmp="${LOG_DIR}/state-version.json"
  for v in $(printf '%s\n' "${versions}" | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true); do
    aws s3api get-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --version-id "${v}" \
      "${tmp}" >/dev/null || return 1
    jq -r '.resources.Vol.physicalId // empty' "${tmp}" || return 1
  done | sort -u
}
delete_volume() { ( # usage: delete_volume <volume-id>  (best-effort)
  set +eu
  aws ec2 delete-volume --volume-id "$1" >/dev/null 2>&1
  true
); }
delete_snapshots_of() { ( # usage: delete_snapshots_of <volume-id>  (best-effort)
  set +eu
  for s in $(snapshots_of "$1" 2>/dev/null); do
    aws ec2 delete-snapshot --snapshot-id "${s}" >/dev/null 2>&1
  done
  true
); }

cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # Every volume of this run: the tagged ones still live, plus every id the
    # state versions recorded (a deleted one may still have a snapshot).
    for v in $(fixture_volumes 2>/dev/null) $(state_version_volumes 2>/dev/null); do
      RUN_VOLUMES+=("${v}")
    done
    (cd "${TEST_DIR}" && env -u VOL_AZ -u BREAK ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    for v in "${RUN_VOLUMES[@]}"; do delete_volume "${v}"; done
    for v in "${RUN_VOLUMES[@]}"; do
      wait_volume_gone "${v}" >/dev/null 2>&1 \
        || echo "[verify] WARN: EBS volume ${v} could not be confirmed deleted; delete it by hand" >&2
      delete_snapshots_of "${v}"
      [ -z "$(snapshots_of "${v}" 2>/dev/null)" ] \
        || echo "[verify] WARN: snapshots of ${v} may remain; delete them by hand" >&2
    done
    ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) \
      || echo "[verify] WARN: ${STATE_KEY} still exists; run cdkd destroy ${STACK} again" >&2
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  rm -rf "${LOG_DIR}"
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

# A record, journal, state version or volume left by an earlier, interrupted
# run would be blamed on the steps below.
for key in "${STATE_KEY}" "${JOURNAL_KEY}"; do
  assert_gone "precondition: ${key} already exists (left by an earlier run); destroy the stack first" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
PRE_VERSIONS="$(state_version_volumes)"
if [ -n "${PRE_VERSIONS}" ]; then
  echo "[verify] FAIL: precondition -- object versions of ${STATE_KEY} already exist (left by an earlier run); purge them first" >&2
  exit 1
fi
PRE_VOLUMES="$(fixture_volumes)"
if [ -n "${PRE_VOLUMES}" ]; then
  echo "[verify] FAIL: precondition -- volumes tagged cdkd-integ-fixture=${FIXTURE_TAG} already exist (left by an earlier run); delete them and their snapshots first: ${PRE_VOLUMES}" >&2
  exit 1
fi
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (Vol in the first AZ)"
env -u VOL_AZ -u BREAK ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
STATE_1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
VOL_1="$(printf '%s' "${STATE_1}" | jq -r '.resources.Vol.physicalId // "<absent>"')"
case "${VOL_1}" in
  vol-?*) ;;
  *) echo "[verify] FAIL: state's Vol is '${VOL_1}' after step 1 (expected a volume id)" >&2; exit 1 ;;
esac
RUN_VOLUMES+=("${VOL_1}")
STATE_V1="$(volume_state "${VOL_1}")"
if [ "${STATE_V1}" != "available" ]; then
  echo "[verify] FAIL: ${VOL_1} is '${STATE_V1}' after step 1 (expected available)" >&2
  exit 1
fi
if [ -n "$(snapshots_of "${VOL_1}")" ]; then
  echo "[verify] FAIL: ${VOL_1} has a snapshot after step 1" >&2
  exit 1
fi

echo "[verify] step 2: replacing deploy (Vol in the second AZ), then BadQueue fails it"
set +e
env VOL_AZ=b BREAK=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --force-stateful-recreation > "${LOG_DIR}/deploy.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the deploy unexpectedly SUCCEEDED (BadQueue's create must fail)" >&2
  exit 1
fi
DEPLOY_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | tr '\n' ' ' | tr -s ' ')"
# The premise: the replacement ran, then BadQueue failed the deploy. Both on
# ONE line of the log. Captured first: a `grep | grep -q` pipe can SIGPIPE
# under pipefail.
FAIL_LINES="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | grep -F "Failed to create" || true)"
if ! grep -qF "BadQueue" <<<"${FAIL_LINES}"; then
  echo "[verify] FAIL: precondition -- the deploy did not fail on BadQueue's create (output above)" >&2
  exit 1
fi
# The symptom first, before anything this run's new volume id is read from:
# pre-#6463 the deploy snapshotted and deleted the old volume inline, and the
# rollback re-created it under ANOTHER id, which would also trip the
# one-new-volume precondition below. AWS first: the old volume was never sent
# its delete (the same VolumeId, so re-adopted, not re-created), and no
# snapshot of it was taken.
STATE_V2="$(volume_state "${VOL_1}")"
if [ "${STATE_V2}" != "available" ]; then
  echo "[verify] FAIL: ${VOL_1} is '${STATE_V2}' after step 2 (expected available, re-adopted under the same VolumeId) -- go-to-k/cdkd#6463: under UpdateReplacePolicy: Snapshot the old volume's delete must wait for the cleanup phase, which a failed deploy never reaches, so the rollback re-adopts it instead of re-creating it empty (output above)" >&2
  exit 1
fi
if grep -qF "Deleting old Vol (${VOL_1})..." <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the deploy deleted the old Vol (${VOL_1}) inline, right after the create -- go-to-k/cdkd#6463: UpdateReplacePolicy: Snapshot must defer the delete to the cleanup phase (output above)" >&2
  exit 1
fi
LEFT_SNAPS_1="$(snapshots_of "${VOL_1}")"
if [ -n "${LEFT_SNAPS_1}" ]; then
  echo "[verify] FAIL: a snapshot of ${VOL_1} was taken although the rollback re-adopted it -- go-to-k/cdkd#6463: no snapshot may be taken before the create, and the cleanup phase never ran: ${LEFT_SNAPS_1}" >&2
  exit 1
fi
# The new volume: the one other id the state versions of this run recorded.
VERSION_VOLS="$(state_version_volumes)"
VOL_NEW="$(printf '%s\n' "${VERSION_VOLS}" | grep -vxF "${VOL_1}" || true)"
if [ "$(printf '%s\n' "${VOL_NEW}" | grep -c .)" != "1" ]; then
  echo "[verify] FAIL: precondition -- expected the state versions to name exactly one volume besides ${VOL_1} (the replacement), found: '${VOL_NEW}'" >&2
  exit 1
fi
RUN_VOLUMES+=("${VOL_NEW}")
if ! wait_volume_gone "${VOL_NEW}"; then
  echo "[verify] FAIL: the replacement ${VOL_NEW} still exists after the rollback re-adopted ${VOL_1}" >&2
  exit 1
fi
# The rollback deletes the NEW copy with a plain delete: rollbackFinalSnapshotId
# (src/deployment/rollback-executor/messages.ts) returns no identifier for a
# pre-delete-snapshot type, and nothing on the rollback path takes a
# pre-delete snapshot of it.
LEFT_SNAPS_NEW="$(snapshots_of "${VOL_NEW}")"
if [ -n "${LEFT_SNAPS_NEW}" ]; then
  echo "[verify] FAIL: a snapshot of the rolled-back ${VOL_NEW} exists (the rollback deletes a pre-delete-snapshot type's new copy plainly): ${LEFT_SNAPS_NEW}" >&2
  exit 1
fi
# The route. Sentinel: the EBS snapshot helper's line names the snapshot it
# creates or resumes (`Creating final snapshot snap-... for Vol (vol-...)`,
# final-snapshot/ebs.ts), so it names the regression outright.
if grep -qF "final snapshot snap-" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the failed deploy logged a final snapshot -- go-to-k/cdkd#6463: the old volume's snapshot belongs to the cleanup phase, and the rollback takes none (output above)" >&2
  exit 1
fi
if ! grep -qF "Old Vol (${VOL_1}) is deleted after the rest of the deploy succeeds" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the deploy did not report deferring the old Vol's delete to the cleanup phase -- the deferral's wording drifted, or the replacement took another route (output above)" >&2
  exit 1
fi
if ! grep -qF "the old resource of Vol (${VOL_1}) was not deleted yet — re-adopting it" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the rollback did not report re-adopting the old Vol (${VOL_1}) whose delete was never sent (output above)" >&2
  exit 1
fi
if grep -qF "Rollback failed for Vol" <<<"${DEPLOY_FLAT}"; then
  echo "[verify] FAIL: the rollback of Vol failed (output above)" >&2
  exit 1
fi
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ "$(printf '%s' "${STATE_2}" | jq -r '.resources.Vol.physicalId // "<absent>"')" != "${VOL_1}" ]; then
  echo "[verify] FAIL: state's Vol is not the re-adopted ${VOL_1} after the rollback" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_2}" | jq '(.supersededResources // []) | length')" != "0" ]; then
  echo "[verify] FAIL: state still lists a superseded resource after the rollback re-adopted ${VOL_1}" >&2
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
echo "[verify] step 2 ok: the rollback re-adopted ${VOL_1} with no snapshot taken, and deleted ${VOL_NEW} (deploy rc=${DEPLOY_RC})"

echo "[verify] step 3: the same replacement without BadQueue: the cleanup phase snapshots ${VOL_1}, then deletes it"
env -u BREAK VOL_AZ=b ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --force-stateful-recreation > "${LOG_DIR}/deploy-ok.log" 2>&1 \
  || { sed 's/^/  /' "${LOG_DIR}/deploy-ok.log"; echo "[verify] FAIL: step 3's deploy failed (output above)" >&2; exit 1; }
sed 's/^/  /' "${LOG_DIR}/deploy-ok.log" || true
OK_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy-ok.log")"
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
VOL_3="$(printf '%s' "${STATE_3}" | jq -r '.resources.Vol.physicalId // "<absent>"')"
case "${VOL_3}" in
  vol-?*) ;;
  *) echo "[verify] FAIL: state's Vol is '${VOL_3}' after step 3 (expected a volume id)" >&2; exit 1 ;;
esac
RUN_VOLUMES+=("${VOL_3}")
if [ "${VOL_3}" = "${VOL_1}" ] || [ "${VOL_3}" = "${VOL_NEW}" ]; then
  echo "[verify] FAIL: state's Vol after step 3 is ${VOL_3}, not a new volume" >&2
  exit 1
fi
if [ "$(printf '%s' "${STATE_3}" | jq '(.supersededResources // []) | length')" != "0" ]; then
  echo "[verify] FAIL: state still lists a superseded resource after the cleanup phase deleted ${VOL_1}" >&2
  exit 1
fi
if ! wait_volume_gone "${VOL_1}"; then
  echo "[verify] FAIL: ${VOL_1} still exists after the successful replacing deploy" >&2
  exit 1
fi
SNAPS_3="$(snapshots_of "${VOL_1}")"
if [ "$(printf '%s\n' "${SNAPS_3}" | grep -c .)" != "1" ]; then
  echo "[verify] FAIL: expected exactly one snapshot of ${VOL_1} after the cleanup phase deleted it, found: '${SNAPS_3}'" >&2
  exit 1
fi
SNAP_ROW="$(aws ec2 describe-snapshots --snapshot-ids "${SNAPS_3}" \
  --query "Snapshots[0].[State, StartTime, Tags[?Key=='${SNAPSHOT_TAG_KEY}'] | [0].Value]" --output text)"
read -r SNAP_STATE SNAP_START SNAP_TAG <<<"${SNAP_ROW}"
if [ "${SNAP_STATE}" != "completed" ]; then
  echo "[verify] FAIL: the snapshot ${SNAPS_3} of ${VOL_1} is '${SNAP_STATE}' (expected completed: cdkd waits for it before the delete)" >&2
  exit 1
fi
if [ "${SNAP_TAG}" != "${VOL_1}" ]; then
  echo "[verify] FAIL: the snapshot ${SNAPS_3} carries ${SNAPSHOT_TAG_KEY}='${SNAP_TAG}' (expected ${VOL_1}: the snapshot cdkd takes)" >&2
  exit 1
fi
# AWS's own clock: the snapshot was started after the new volume existed, so
# none was taken before the create.
VOL_3_CREATED="$(aws ec2 describe-volumes --volume-ids "${VOL_3}" --query 'Volumes[0].CreateTime' --output text)"
if [ -z "${SNAP_START}" ] || [ -z "${VOL_3_CREATED}" ] || ! [[ "${SNAP_START}" > "${VOL_3_CREATED}" ]]; then
  echo "[verify] FAIL: the snapshot ${SNAPS_3} started at '${SNAP_START}', not after the new volume ${VOL_3} was created at '${VOL_3_CREATED}' -- go-to-k/cdkd#6463: the snapshot belongs to the deferred delete" >&2
  exit 1
fi
# The log's order: the deferral, the cleanup pass, the snapshot, the delete.
line_of() { # usage: line_of <fixed text>  (first matching line number, or empty)
  grep -nF "$1" <<<"${OK_PLAIN}" | head -1 | cut -d: -f1 || true
}
DEFER_LINE="$(line_of "Old Vol (${VOL_1}) is deleted after the rest of the deploy succeeds")"
CLEANUP_LINE="$(line_of "Deleting the old resource of 1 replaced resource(s)")"
SNAP_LINE="$(line_of "final snapshot ${SNAPS_3} for Vol (${VOL_1})")"
DELETED_LINE="$(line_of "Old Vol (${VOL_1}) deleted")"
if [ -z "${DEFER_LINE}" ] || [ -z "${CLEANUP_LINE}" ] || [ -z "${SNAP_LINE}" ] || [ -z "${DELETED_LINE}" ] \
  || [ "${CLEANUP_LINE}" -le "${DEFER_LINE}" ] || [ "${SNAP_LINE}" -le "${CLEANUP_LINE}" ] \
  || [ "${DELETED_LINE}" -le "${SNAP_LINE}" ]; then
  echo "[verify] FAIL: step 3 did not defer ${VOL_1}'s delete, then snapshot and delete it in the cleanup phase (deferral line ${DEFER_LINE:-<none>}, cleanup line ${CLEANUP_LINE:-<none>}, snapshot line ${SNAP_LINE:-<none>}, deleted line ${DELETED_LINE:-<none>}; output above)" >&2
  exit 1
fi
FIRST_SNAP_LINE="$(line_of "final snapshot snap-")"
if [ -z "${FIRST_SNAP_LINE}" ] || [ "${FIRST_SNAP_LINE}" -le "${CLEANUP_LINE}" ]; then
  echo "[verify] FAIL: step 3 logged a final snapshot before its cleanup pass (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the cleanup phase snapshotted ${VOL_1} as ${SNAPS_3}, then deleted it; deleting that test artifact"
aws ec2 delete-snapshot --snapshot-id "${SNAPS_3}" >/dev/null
if ! wait_snapshot_gone "${SNAPS_3}"; then
  echo "[verify] FAIL: the snapshot ${SNAPS_3} still exists after its delete" >&2
  exit 1
fi

echo "[verify] step 4: destroy"
env -u BREAK VOL_AZ=b ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for v in "${VOL_1}" "${VOL_NEW}" "${VOL_3}"; do
  if ! wait_volume_gone "${v}"; then
    echo "[verify] FAIL: EBS volume ${v} still exists after destroy" >&2
    exit 1
  fi
  LEFT_SNAPS="$(snapshots_of "${v}")"
  if [ -n "${LEFT_SNAPS}" ]; then
    echo "[verify] FAIL: snapshots of ${v} remain after destroy (DeletionPolicy: Delete takes none): ${LEFT_SNAPS}" >&2
    exit 1
  fi
done
LEFT_VOLUMES="$(fixture_volumes)"
if [ -n "${LEFT_VOLUMES}" ]; then
  echo "[verify] FAIL: volumes tagged cdkd-integ-fixture=${FIXTURE_TAG} remain after destroy: ${LEFT_VOLUMES}" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "replace-predelete-snapshot-failed-rollback state teardown"

echo "[verify] PASS -- under UpdateReplacePolicy: Snapshot the old EBS volume's delete waited for the cleanup phase with its pre-delete snapshot (go-to-k/cdkd#6463): a failed deploy's rollback re-adopted it with no snapshot taken, and a successful one snapshotted it once, then deleted it"
