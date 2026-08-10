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
  --query 'BackupPolicy.Status' --output text)
if [ "${BACKUP_STATUS}" != "ENABLED" ]; then
  echo "FAIL: BackupPolicy.Status is '${BACKUP_STATUS}', expected 'ENABLED' (PutBackupPolicy silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: BackupPolicy.Status == ENABLED (PutBackupPolicy wired)"

# --- Assertion 2: LifecyclePolicies AFTER_30_DAYS ---------------------
LIFECYCLE_TIA=$(aws efs describe-lifecycle-configuration \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'LifecyclePolicies[?TransitionToIA!=`null`].TransitionToIA | [0]' \
  --output text)
if [ "${LIFECYCLE_TIA}" != "AFTER_30_DAYS" ]; then
  echo "FAIL: LifecyclePolicies TransitionToIA is '${LIFECYCLE_TIA}', expected 'AFTER_30_DAYS' (PutLifecycleConfiguration silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: LifecyclePolicies TransitionToIA == AFTER_30_DAYS (PutLifecycleConfiguration wired)"

# --- Assertion 3: FileSystemProtection ENABLED ------------------------
PROTECTION=$(aws efs describe-file-systems \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].FileSystemProtection.ReplicationOverwriteProtection' \
  --output text)
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
  --query 'Policy' --output text)
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

# --- Assertion 5: baseline throughput is provisioned@1 ----------------
TM_P1=$(aws efs describe-file-systems \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].ThroughputMode' --output text)
if [ "${TM_P1}" != "provisioned" ]; then
  echo "FAIL: baseline ThroughputMode is '${TM_P1}', expected 'provisioned'" >&2
  exit 1
fi
echo "    OK: baseline ThroughputMode == provisioned"

# --- Phase 1b: throughput removal redeploy (issue #1160 efs batch) ----
# The removal template drops ThroughputMode + ProvisionedThroughputInMibps.
# EFS UpdateFileSystem merges (absent = "no change"), so pre-fix the live
# file system silently stayed provisioned (billing included); post-fix the
# provider mirrors CloudFormation's reset to the create default 'bursting'
# (live CFn A/B 2026-08-11: provisioned@1MiBps -> bursting on removal).
echo "==> Phase 1b: re-deploy dropping ThroughputMode/ProvisionedThroughputInMibps (removal reset)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# The provider waits for the file system to return to `available`, but poll
# with a bounded retry anyway so read-after-write lag cannot flake the run.
TM_P2=""
for _i in 1 2 3 4 5 6; do
  TM_P2=$(aws efs describe-file-systems \
    --file-system-id "${FS_ID}" --region "${REGION}" \
    --query 'FileSystems[0].ThroughputMode' --output text)
  [ "${TM_P2}" = "bursting" ] && break
  sleep 10
done
if [ "${TM_P2}" != "bursting" ]; then
  echo "FAIL: expected ThroughputMode=bursting after the removal redeploy (waited 60s), got '${TM_P2}' (removal silent-drop NOT closed)" >&2
  exit 1
fi
# Replacement guard: the removal must be an in-place UPDATE (the file system
# id must survive the redeploy).
STATE_P2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
FS_ID_P2=$(echo "${STATE_P2}" | jq -r '.outputs.FileSystemId // empty')
if [ "${FS_ID_P2}" != "${FS_ID}" ]; then
  echo "FAIL: FileSystem was REPLACED by the removal redeploy (${FS_ID} -> ${FS_ID_P2})" >&2
  exit 1
fi
echo "    OK: ThroughputMode reset to bursting in place (removal silent-drop closed)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "EFS FileSystem ${FS_ID} still exists after destroy" aws efs describe-file-systems --file-system-id "${FS_ID}" --region "${REGION}"
echo "    OK: EFS FileSystem is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> efs-standalone test passed (EFS::FileSystem #609 backfill closed + clean destroy)"
