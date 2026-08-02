#!/usr/bin/env bash
# verify.sh - DeletionPolicy: Snapshot integ (issue #1352).
#
# CloudFormation creates a final snapshot BEFORE deleting a resource whose
# DeletionPolicy is Snapshot; cdkd historically plain-deleted (live-A/B
# confirmed data loss). This fixture proves BOTH cdkd delete paths now honor
# the policy on the cheapest Snapshot-capable type (AWS::EC2::Volume,
# CC-API-routed → the engine-side pre-delete CreateSnapshot+wait):
#
#   Phase 1: deploy two 1 GiB gp3 volumes, both DeletionPolicy: Snapshot.
#   Phase 2: redeploy with CDKD_TEST_UPDATE=true (VolumeRemove dropped from
#            the template) — the DEPLOY ENGINE's DELETE branch must create a
#            completed, tagged final snapshot before deleting the volume.
#   Phase 3: cdkd destroy — the DESTROY RUNNER must do the same for
#            VolumeKeep; state file gone afterwards.
#   Phase 4: delete the two final snapshots (test artifacts; a real user
#            would keep them) and verify zero orphans.
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

STACK="CdkdDeletionPolicySnapshotExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
IDS_FILE="/tmp/cdkd-integ-deletion-policy-snapshot-ids"

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
  if [ -f "${IDS_FILE}" ]; then
    while read -r vol_id; do
      [ -n "${vol_id}" ] || continue
      snap_id=$(snapshot_id_for "${vol_id}")
      if [ -n "${snap_id}" ]; then
        aws ec2 delete-snapshot --snapshot-id "${snap_id}" --region "${REGION}" >/dev/null 2>&1
      fi
    done < "${IDS_FILE}"
  fi
  # Volumes by this fixture's tags (survive a failed run without state).
  for tag in deletion-policy-snapshot-keep deletion-policy-snapshot-remove; do
    for vol_id in $(aws ec2 describe-volumes --region "${REGION}" \
      --filters "Name=tag:cdkd-integ,Values=${tag}" \
      --query 'Volumes[].VolumeId' --output text 2>/dev/null); do
      aws ec2 delete-volume --volume-id "${vol_id}" --region "${REGION}" >/dev/null 2>&1
    done
  done
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
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
echo "==> Phase 1: deploy (two Snapshot-policy volumes)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

VOL_KEEP_ID=$(aws ec2 describe-volumes --region "${REGION}" \
  --filters "Name=tag:cdkd-integ,Values=deletion-policy-snapshot-keep" \
  --query 'Volumes[0].VolumeId' --output text)
VOL_REMOVE_ID=$(aws ec2 describe-volumes --region "${REGION}" \
  --filters "Name=tag:cdkd-integ,Values=deletion-policy-snapshot-remove" \
  --query 'Volumes[0].VolumeId' --output text)
if [ -z "${VOL_KEEP_ID}" ] || [ "${VOL_KEEP_ID}" = "None" ] || \
   [ -z "${VOL_REMOVE_ID}" ] || [ "${VOL_REMOVE_ID}" = "None" ]; then
  echo "FAIL: deployed volumes not found (keep=${VOL_KEEP_ID}, remove=${VOL_REMOVE_ID})" >&2
  exit 1
fi
printf '%s\n%s\n' "${VOL_KEEP_ID}" "${VOL_REMOVE_ID}" > "${IDS_FILE}"
echo "    VolumeKeep=${VOL_KEEP_ID} VolumeRemove=${VOL_REMOVE_ID}"

# --- Phase 2: template-removal redeploy (deploy engine DELETE branch) -------
echo "==> Phase 2: redeploy with VolumeRemove dropped (engine DELETE path)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "VolumeRemove still exists after template-removal redeploy" \
  aws ec2 describe-volumes --volume-ids "${VOL_REMOVE_ID}" --region "${REGION}"

SNAP_REMOVE_ID=$(snapshot_id_for "${VOL_REMOVE_ID}")
if [ -z "${SNAP_REMOVE_ID}" ]; then
  echo "FAIL: no final snapshot created for removed volume ${VOL_REMOVE_ID} (DeletionPolicy: Snapshot ignored on the engine DELETE path)" >&2
  exit 1
fi
SNAP_REMOVE_STATE=$(aws ec2 describe-snapshots --snapshot-ids "${SNAP_REMOVE_ID}" \
  --region "${REGION}" --query 'Snapshots[0].State' --output text)
if [ "${SNAP_REMOVE_STATE}" != "completed" ]; then
  echo "FAIL: final snapshot ${SNAP_REMOVE_ID} not completed (state=${SNAP_REMOVE_STATE}) — the engine must wait for completion before deleting" >&2
  exit 1
fi
echo "    engine path OK: ${SNAP_REMOVE_ID} completed for ${VOL_REMOVE_ID}"

# --- Phase 3: destroy (destroy-runner path) ---------------------------------
echo "==> Phase 3: cdkd destroy (runner final-snapshot path)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "VolumeKeep still exists after destroy" \
  aws ec2 describe-volumes --volume-ids "${VOL_KEEP_ID}" --region "${REGION}"

SNAP_KEEP_ID=$(snapshot_id_for "${VOL_KEEP_ID}")
if [ -z "${SNAP_KEEP_ID}" ]; then
  echo "FAIL: no final snapshot created for destroyed volume ${VOL_KEEP_ID} (DeletionPolicy: Snapshot ignored on the destroy-runner path)" >&2
  exit 1
fi
SNAP_KEEP_STATE=$(aws ec2 describe-snapshots --snapshot-ids "${SNAP_KEEP_ID}" \
  --region "${REGION}" --query 'Snapshots[0].State' --output text)
if [ "${SNAP_KEEP_STATE}" != "completed" ]; then
  echo "FAIL: final snapshot ${SNAP_KEEP_ID} not completed (state=${SNAP_KEEP_STATE})" >&2
  exit 1
fi
echo "    runner path OK: ${SNAP_KEEP_ID} completed for ${VOL_KEEP_ID}"

assert_gone "state file still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

# --- Phase 4: artifact cleanup + zero-orphan verification -------------------
echo "==> Phase 4: deleting the two final snapshots (test artifacts)"
aws ec2 delete-snapshot --snapshot-id "${SNAP_REMOVE_ID}" --region "${REGION}"
aws ec2 delete-snapshot --snapshot-id "${SNAP_KEEP_ID}" --region "${REGION}"
assert_gone "final snapshot ${SNAP_REMOVE_ID} still present after artifact cleanup" \
  aws ec2 describe-snapshots --snapshot-ids "${SNAP_REMOVE_ID}" --region "${REGION}"
assert_gone "final snapshot ${SNAP_KEEP_ID} still present after artifact cleanup" \
  aws ec2 describe-snapshots --snapshot-ids "${SNAP_KEEP_ID}" --region "${REGION}"
rm -f "${IDS_FILE}"

echo "PASS: DeletionPolicy: Snapshot honored on both delete paths (engine + runner), zero orphans"
