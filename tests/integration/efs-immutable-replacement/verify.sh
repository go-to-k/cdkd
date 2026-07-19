#!/usr/bin/env bash
# verify.sh — cdkd createOnly replacement detection + stateful-replace guard integ.
#
# `AWS::EFS::FileSystem.PerformanceMode` is a createOnly (immutable) property per
# the CFn registry schema, and EFS has NO hand-authored ReplacementRulesRegistry
# rule. Before the createOnly fallback, cdkd's diff mis-classified the change as
# an in-place UPDATE. This verifies the full corrected flow:
#
#   1. Deploy PerformanceMode=maxIO; capture FileSystemId.
#   2. `cdkd diff` (maxIO -> generalPurpose) now reports a REPLACEMENT
#      (the createOnly fallback), not "1 to update".
#   3. `cdkd deploy` WITHOUT --force-stateful-recreation is BLOCKED
#      (EFS is stateful) — assert it fails AND the filesystem is unchanged
#      (same FileSystemId, still maxIO).
#   4. `cdkd deploy --force-stateful-recreation` performs the DELETE+CREATE
#      replacement — assert a NEW FileSystemId with generalPurpose.
#   5. Destroy; assert the filesystem is gone and state is removed.
#
# Required env vars: STATE_BUCKET, AWS_REGION (defaults us-east-1).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdEfsImmutableReplacementExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TAG_NAME="${STACK}-fs"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

fs_id_by_tag() {
  aws efs describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='Name'&&Value=='${TAG_NAME}']].FileSystemId | [0]" \
    --output text 2>/dev/null
}
fs_mode_by_id() {
  aws efs describe-file-systems --region "${REGION}" --file-system-id "$1" \
    --query 'FileSystems[0].PerformanceMode' --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Sweep any filesystem(s) carrying our tag (an interrupted run may leave one).
  for fsid in $(aws efs describe-file-systems --region "${REGION}" \
      --query "FileSystems[?Tags[?Key=='Name'&&Value=='${TAG_NAME}']].FileSystemId" --output text 2>/dev/null); do
    aws efs delete-file-system --file-system-id "${fsid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy maxIO --------------------------------------------
echo "==> Phase 1: deploy EFS PerformanceMode=maxIO"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P1="$(fs_id_by_tag)"
if [ -z "${FS_ID_P1}" ] || [ "${FS_ID_P1}" = "None" ]; then
  echo "FAIL: no EFS filesystem found after Phase 1" >&2; exit 1
fi
MODE_P1="$(fs_mode_by_id "${FS_ID_P1}")"
if [ "${MODE_P1}" != "maxIO" ]; then
  echo "FAIL: expected PerformanceMode=maxIO, got ${MODE_P1}" >&2; exit 1
fi
echo "    created ${FS_ID_P1} (PerformanceMode=maxIO)"

# --- Phase 2: diff must show a REPLACEMENT ----------------------------
echo "==> Phase 2: cdkd diff (maxIO -> generalPurpose) must report a replacement"
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
echo "${DIFF_OUT}" | grep -iE "replace" >/dev/null || {
  echo "FAIL: diff did not report a replacement for the createOnly PerformanceMode change" >&2
  echo "----- diff output -----" >&2; echo "${DIFF_OUT}" >&2
  exit 1
}
echo "    diff reports replacement (createOnly fallback working)"

# --- Phase 3: deploy WITHOUT the flag must be BLOCKED -----------------
echo "==> Phase 3: deploy without --force-stateful-recreation must be blocked"
set +e
BLOCK_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
BLOCK_RC=$?
set -e
if [ "${BLOCK_RC}" -eq 0 ]; then
  echo "FAIL: deploy SUCCEEDED without --force-stateful-recreation (stateful guard did not fire)" >&2
  exit 1
fi
echo "${BLOCK_OUT}" | grep -iE "force-stateful-recreation|stateful" >/dev/null || {
  echo "FAIL: deploy failed but not with the stateful-replace guard message" >&2
  echo "----- output -----" >&2; echo "${BLOCK_OUT}" >&2
  exit 1
}
# Filesystem must be UNCHANGED (same id, still maxIO).
FS_ID_BLOCK="$(fs_id_by_tag)"
if [ "${FS_ID_BLOCK}" != "${FS_ID_P1}" ]; then
  echo "FAIL: filesystem changed (${FS_ID_P1} -> ${FS_ID_BLOCK}) despite the block" >&2; exit 1
fi
if [ "$(fs_mode_by_id "${FS_ID_P1}")" != "maxIO" ]; then
  echo "FAIL: PerformanceMode changed despite the block" >&2; exit 1
fi
echo "    blocked as expected; filesystem unchanged (${FS_ID_P1}, still maxIO)"

# --- Phase 4: deploy WITH the flag performs the replacement -----------
echo "==> Phase 4: deploy --force-stateful-recreation performs DELETE+CREATE"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force-stateful-recreation --yes

FS_ID_P4="$(fs_id_by_tag)"
if [ -z "${FS_ID_P4}" ] || [ "${FS_ID_P4}" = "None" ]; then
  echo "FAIL: no EFS filesystem after Phase 4" >&2; exit 1
fi
if [ "${FS_ID_P4}" = "${FS_ID_P1}" ]; then
  echo "FAIL: filesystem was NOT replaced (same id ${FS_ID_P1})" >&2; exit 1
fi
if [ "$(fs_mode_by_id "${FS_ID_P4}")" != "generalPurpose" ]; then
  echo "FAIL: replacement filesystem is not generalPurpose" >&2; exit 1
fi
# old filesystem must be gone
if aws efs describe-file-systems --region "${REGION}" --file-system-id "${FS_ID_P1}" >/dev/null 2>&1; then
  echo "FAIL: old filesystem ${FS_ID_P1} still exists after replacement" >&2; exit 1
fi
echo "    replaced: ${FS_ID_P1} -> ${FS_ID_P4} (generalPurpose), old gone"

# --- Phase 5: destroy --------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if [ -n "$(fs_id_by_tag)" ] && [ "$(fs_id_by_tag)" != "None" ]; then
  echo "FAIL: filesystem still present after destroy" >&2; exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2; exit 1
fi
echo "    filesystem deleted, cdkd state removed"

echo "[verify] PASS — createOnly replacement detection + stateful guard + forced replacement + destroy, all phases passed"
