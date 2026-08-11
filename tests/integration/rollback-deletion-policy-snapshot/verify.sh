#!/usr/bin/env bash
# verify.sh - DeletionPolicy: Snapshot on a ROLLED-BACK CREATE (issue #1358).
#
# A deploy that creates two resources and fails on the second rolls the first
# one back. cdkd used to ORPHAN a rolled-back CREATE carrying
# `DeletionPolicy: Snapshot` (left in AWS, dropped from state) — an untracked,
# billing resource after a deploy that reported a completed rollback.
# CloudFormation deletes it and honors the policy: final snapshot, then delete.
#
#   Phase 1: deploy — MUST fail (BadQueue has an out-of-range
#            MessageRetentionPeriod) and MUST roll VolumeSnap back.
#   Phase 2: assert the rollback took a COMPLETED final snapshot of the
#            volume and then DELETED it; assert the old orphan log line is
#            absent; assert state.json is gone.
#   Phase 3: delete the final snapshot (test artifact; a real user would keep
#            it) and verify zero orphans.
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

STACK="CdkdRollbackSnapshotExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
FIXTURE_TAG="rollback-deletion-policy-snapshot"
IDS_FILE="/tmp/cdkd-integ-rollback-deletion-policy-snapshot-ids"
DEPLOY_LOG="/tmp/cdkd-integ-rollback-deletion-policy-snapshot-deploy.log"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# snapshot_id_for <volume-id> — first cdkd-tagged snapshot of the volume, or
# empty when none exists (`--query` returns the literal None on an empty
# result set; a filtered describe never not-founds). Deliberately strict: a
# real probe failure (throttle, auth) aborts the run instead of reading as
# "no snapshot" (in cleanup the surrounding `set +eu` keeps it best-effort).
snapshot_id_for() {
  local id
  id=$(aws ec2 describe-snapshots --owner-ids self --region "${REGION}" \
    --filters "Name=volume-id,Values=$1" "Name=tag-key,Values=cdkd:final-snapshot-of" \
    --query 'Snapshots[0].SnapshotId' --output text) || return 1
  if [ "${id}" = "None" ]; then id=""; fi
  printf '%s' "${id}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover snapshots + volumes + state"
  set +eu
  # Recorded volume ids from this (or a previous failed) run — snapshots
  # outlive their volumes, so the sweep is keyed on the recorded ids, never
  # on a broad tag scan that could touch a parallel session's snapshots.
  # `sweep_failed` keeps the ids file when a snapshot could not be deleted:
  # the sweep is keyed ONLY on these recorded ids (a broad tag scan could
  # touch a parallel session's snapshots), so discarding the file after a
  # failed delete would strand the snapshot with nothing able to find it.
  sweep_failed=""
  if [ -f "${IDS_FILE}" ]; then
    while read -r vol_id; do
      [ -n "${vol_id}" ] || continue
      snap_id=$(snapshot_id_for "${vol_id}")
      if [ -n "${snap_id}" ]; then
        if ! aws ec2 delete-snapshot --snapshot-id "${snap_id}" --region "${REGION}" >/dev/null 2>&1; then
          sweep_failed=yes
          echo "WARN: could not delete final snapshot ${snap_id} of ${vol_id} — keeping ${IDS_FILE} so the next run retries" >&2
        fi
      fi
    done < "${IDS_FILE}"
  fi
  # Volumes by this fixture's tag (an ORPHANED volume — the pre-#1358
  # behavior — survives with its tags, and so does one left by a failed run).
  for vol_id in $(aws ec2 describe-volumes --region "${REGION}" \
    --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
    --query 'Volumes[].VolumeId' --output text 2>/dev/null); do
    aws ec2 delete-volume --volume-id "${vol_id}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --skip-final-snapshot --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    # `state destroy` above fails (and leaves state.json behind) whenever a
    # resource cannot be deleted — e.g. an EBS volume AWS is still reaping.
    # The tag sweep already covers this fixture's only AWS resource, so drop
    # the record unconditionally; a surviving state.json would make the next
    # run see the volume as already-created and never exercise the rollback.
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    # The rollback journal is a state.json SIBLING that `state destroy` does
    # not sweep; a leftover would make the next run resume a stale plan.
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  if [ -z "${sweep_failed}" ]; then
    rm -f "${IDS_FILE}"
  fi
  rm -f "${DEPLOY_LOG}"
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

# --- Phase 1: deploy, expected to FAIL and roll back ------------------------
echo "==> Phase 1: deploy (VolumeSnap succeeds, BadQueue fails -> rollback)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
cat "${DEPLOY_LOG}"
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: deploy succeeded — BadQueue was supposed to fail and trigger a rollback" >&2
  exit 1
fi

# --- Phase 2: the rollback must have snapshotted, then deleted --------------
# The pre-#1358 behavior. Asserted explicitly so a regression names itself
# instead of surfacing only as a missing snapshot.
if grep -q 'Leaving VolumeSnap' "${DEPLOY_LOG}"; then
  echo "FAIL: the rolled-back CREATE was ORPHANED instead of snapshot-deleted (issue #1358 regression)" >&2
  exit 1
fi

VOL_ID=$(grep -oE 'Final snapshot snap-[0-9a-f]+ completed for VolumeSnap \(vol-[0-9a-f]+\)' "${DEPLOY_LOG}" \
  | grep -oE 'vol-[0-9a-f]+' | head -1)
SNAP_ID=$(grep -oE 'Final snapshot snap-[0-9a-f]+ completed for VolumeSnap' "${DEPLOY_LOG}" \
  | grep -oE 'snap-[0-9a-f]+' | head -1)
if [ -z "${VOL_ID}" ] || [ -z "${SNAP_ID}" ]; then
  echo "FAIL: no completed final snapshot reported for VolumeSnap — DeletionPolicy: Snapshot was not honored on the rollback delete" >&2
  exit 1
fi
printf '%s\n' "${VOL_ID}" > "${IDS_FILE}"
echo "    rollback reported ${SNAP_ID} for ${VOL_ID}"

SNAP_STATE=$(aws ec2 describe-snapshots --snapshot-ids "${SNAP_ID}" \
  --region "${REGION}" --query 'Snapshots[0].State' --output text)
if [ "${SNAP_STATE}" != "completed" ]; then
  echo "FAIL: final snapshot ${SNAP_ID} not completed (state=${SNAP_STATE}) — the rollback must wait for completion before deleting" >&2
  exit 1
fi
SNAP_SOURCE=$(aws ec2 describe-snapshots --snapshot-ids "${SNAP_ID}" \
  --region "${REGION}" --query 'Snapshots[0].VolumeId' --output text)
if [ "${SNAP_SOURCE}" != "${VOL_ID}" ]; then
  echo "FAIL: final snapshot ${SNAP_ID} sources ${SNAP_SOURCE}, expected ${VOL_ID}" >&2
  exit 1
fi

if grep -q 'Rollback failed for VolumeSnap' "${DEPLOY_LOG}"; then
  echo "FAIL: cdkd reported a failed rollback for VolumeSnap — the snapshot-then-delete did not complete" >&2
  exit 1
fi

# EBS DeleteVolume is asynchronous: the volume sits in `deleting` for a while
# and describe-volumes keeps returning it, so a single immediate gone-probe
# false-FAILs. Poll to a bound instead (observed: seconds normally, minutes on
# a volume deleted moments after it was created + snapshotted).
VOLUME_GONE=no
for _ in $(seq 1 60); do
  if gone_probe aws ec2 describe-volumes --volume-ids "${VOL_ID}" --region "${REGION}"; then
    VOLUME_GONE=yes
    break
  fi
  sleep 10
done
if [ "${VOLUME_GONE}" != "yes" ]; then
  echo "FAIL: rolled-back VolumeSnap ${VOL_ID} still exists in AWS after 10 minutes" >&2
  exit 1
fi

# `deleting` / `deleted` excluded: the pre-run cleanup's `delete-volume` is
# async and a just-swept leftover keeps showing up in describe-volumes for a
# while — it is not a leak of THIS run.
REMAINING=$(aws ec2 describe-volumes --region "${REGION}" \
  --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
  --query "Volumes[?State!='deleting' && State!='deleted'].VolumeId" --output text)
if [ -n "${REMAINING}" ]; then
  echo "FAIL: fixture-tagged volume(s) still present after the rollback: ${REMAINING}" >&2
  exit 1
fi

# State: the rolled-back CREATE must be GONE from the resource map. The FILE
# itself legitimately survives — since issue #1208 a clean automatic rollback
# keeps the failed resource's pre-failure record (and the failed-only journal)
# so `cdkd rollback --revert-failed` can still reach it — so asserting the
# file is absent would be asserting the wrong thing.
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "    state file absent (nothing left to record)"
else
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  if printf '%s' "${STATE_JSON}" | grep -q '"VolumeSnap"'; then
    echo "FAIL: VolumeSnap is still recorded in cdkd state after the rollback" >&2
    exit 1
  fi
  echo "    state file kept for the failed resource; VolumeSnap record removed"
fi

echo "    rollback path OK: ${SNAP_ID} completed, ${VOL_ID} deleted, state clean"

# --- Phase 3: artifact cleanup + zero-orphan verification -------------------
echo "==> Phase 3: deleting the final snapshot (test artifact)"
aws ec2 delete-snapshot --snapshot-id "${SNAP_ID}" --region "${REGION}"
assert_gone "final snapshot ${SNAP_ID} still present after artifact cleanup" \
  aws ec2 describe-snapshots --snapshot-ids "${SNAP_ID}" --region "${REGION}"
rm -f "${IDS_FILE}"

echo "PASS: DeletionPolicy: Snapshot honored on a rolled-back CREATE (snapshot then delete, not orphan), zero orphans"
