#!/usr/bin/env bash
# verify.sh — cdkd EFS::FileSystem #609 property-backfill integ test.
#
# Asserts that the EFS FileSystem top-level properties backfilled in the #609
# slice actually reach AWS after `cdkd deploy`:
#   - LifecyclePolicies    → PutLifecycleConfiguration   (DescribeLifecycleConfiguration)
#   - BackupPolicy         → PutBackupPolicy             (DescribeBackupPolicy)
#   - FileSystemPolicy     → PutFileSystemPolicy         (DescribeFileSystemPolicy)
#   - FileSystemProtection → UpdateFileSystemProtection  (DescribeFileSystems)
# Each was a silent-drop before the backfill. Also asserts the destroy path
# cleans up the file system, mount target, access point, and state file.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe: no `grep -P`, no `date -d`; boolean assertions use jq `has(...)`.

set -euo pipefail

cd "$(dirname "$0")"

STACK="EfsStandaloneStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

FS_ID=$(echo "${STATE}" | jq -r '.outputs.FileSystemId // empty')
if [ -z "${FS_ID}" ]; then
  echo "FAIL: FileSystemId output missing from deploy state" >&2
  exit 1
fi
echo "    Using FileSystemId '${FS_ID}'"

# --- Assertion 1: BackupPolicy ENABLED --------------------------------
BACKUP_STATUS=$(aws efs describe-backup-policy \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'BackupPolicy.Status' --output text 2>/dev/null || echo "")
if [ "${BACKUP_STATUS}" != "ENABLED" ]; then
  echo "FAIL: BackupPolicy.Status is '${BACKUP_STATUS}', expected 'ENABLED' (PutBackupPolicy silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: BackupPolicy.Status == ENABLED (PutBackupPolicy wired)"

# --- Assertion 2: LifecyclePolicies AFTER_30_DAYS ---------------------
LIFECYCLE_TIA=$(aws efs describe-lifecycle-configuration \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'LifecyclePolicies[?TransitionToIA!=`null`].TransitionToIA | [0]' \
  --output text 2>/dev/null || echo "")
if [ "${LIFECYCLE_TIA}" != "AFTER_30_DAYS" ]; then
  echo "FAIL: LifecyclePolicies TransitionToIA is '${LIFECYCLE_TIA}', expected 'AFTER_30_DAYS' (PutLifecycleConfiguration silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: LifecyclePolicies TransitionToIA == AFTER_30_DAYS (PutLifecycleConfiguration wired)"

# --- Assertion 3: FileSystemProtection ENABLED ------------------------
PROTECTION=$(aws efs describe-file-systems \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].FileSystemProtection.ReplicationOverwriteProtection' \
  --output text 2>/dev/null || echo "")
if [ "${PROTECTION}" != "ENABLED" ]; then
  echo "FAIL: ReplicationOverwriteProtection is '${PROTECTION}', expected 'ENABLED' (UpdateFileSystemProtection silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: ReplicationOverwriteProtection == ENABLED (UpdateFileSystemProtection wired)"

# --- Assertion 4: FileSystemPolicy attached ---------------------------
# DescribeFileSystemPolicy returns the policy as a JSON string. Assert it
# is present and that our ClientMount statement made it through. Use jq
# `has(...)` (BSD-safe boolean) rather than relying on `//`-on-false.
POLICY_JSON=$(aws efs describe-file-system-policy \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'Policy' --output text 2>/dev/null || echo "")
if [ -z "${POLICY_JSON}" ]; then
  echo "FAIL: no FileSystemPolicy attached (PutFileSystemPolicy silent-drop NOT closed)" >&2
  exit 1
fi
HAS_STATEMENT=$(echo "${POLICY_JSON}" | jq -r 'if has("Statement") then "yes" else "no" end' 2>/dev/null || echo "no")
HAS_CLIENTMOUNT=$(echo "${POLICY_JSON}" \
  | jq -r '[.Statement[]?.Action] | flatten | index("elasticfilesystem:ClientMount") != null' 2>/dev/null || echo "false")
if [ "${HAS_STATEMENT}" != "yes" ] || [ "${HAS_CLIENTMOUNT}" != "true" ]; then
  echo "FAIL: FileSystemPolicy present but missing expected ClientMount statement" >&2
  echo "${POLICY_JSON}" | jq . 2>/dev/null || echo "${POLICY_JSON}"
  exit 1
fi
echo "    OK: FileSystemPolicy attached with ClientMount statement (PutFileSystemPolicy wired)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws efs describe-file-systems --file-system-id "${FS_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: EFS FileSystem ${FS_ID} still exists after destroy" >&2
  exit 1
fi
echo "    OK: EFS FileSystem is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> efs-standalone test passed (EFS::FileSystem #609 backfill closed + clean destroy)"
