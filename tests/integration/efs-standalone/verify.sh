#!/usr/bin/env bash
# verify.sh — cdkd EFS::FileSystem #609 property-backfill integ test.
#
# Asserts that the EFS FileSystem top-level properties backfilled in the #609
# slice actually reach AWS after `cdkd deploy`:
#   - LifecyclePolicies    → PutLifecycleConfiguration   (DescribeLifecycleConfiguration)
#   - BackupPolicy         → PutBackupPolicy             (DescribeBackupPolicy)
#   - FileSystemPolicy     → PutFileSystemPolicy         (DescribeFileSystemPolicy)
#   - FileSystemProtection → UpdateFileSystemProtection  (DescribeFileSystems)
# Each was a silent-drop before the backfill. Also asserts the MountTarget's
# IpAddressType / IpAddress stay on the SDK route and reach AWS, with its
# Fn::GetAtt IpAddress output (issue #2762), and that a FileSystemTags /
# AccessPointTags change is applied in place on redeploy (issue #5464), and that
# removing BackupPolicy / FileSystemPolicy / FileSystemProtection resets each as
# CloudFormation does (issue #1160). Also asserts the destroy path
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
      --state-bucket "${STATE_BUCKET:-}" \
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

# --- Assertion 3: FileSystemProtection DISABLED -----------------------
# The baseline declares DISABLED, the non-default value (a fresh file system
# reads ENABLED), so this proves the call landed and gives Phase 1b's removal
# reset something to observe (issue #1160).
PROTECTION=$(aws efs describe-file-systems \
  --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].FileSystemProtection.ReplicationOverwriteProtection' \
  --output text)
if [ "${PROTECTION}" != "DISABLED" ]; then
  echo "FAIL: ReplicationOverwriteProtection is '${PROTECTION}', expected 'DISABLED' (UpdateFileSystemProtection silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: ReplicationOverwriteProtection == DISABLED (UpdateFileSystemProtection wired)"

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

# --- Assertion 6: MountTarget addressing on the SDK route (issue #2762) ----
# The stack declares IpAddressType DUAL_STACK + IpAddress 10.0.0.100. Before
# the fix the SDK provider did not handle either, so declaring them routed the
# mount target through Cloud Control instead.
EXPECTED_MT_IP="10.0.0.100"
MT_ID=$(echo "${STATE}" | jq -r '.outputs.MountTargetId // empty')
if [ -z "${MT_ID}" ]; then
  echo "FAIL: MountTargetId output missing from deploy state" >&2
  exit 1
fi
MT_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources[] | select(.resourceType == "AWS::EFS::MountTarget")
  | .provisionedBy // "<absent>"] | join(" ")')
if [ "${MT_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: AWS::EFS::MountTarget routing layer is '${MT_PROVISIONED_BY}', expected 'sdk' (IpAddress / IpAddressType still route it to Cloud Control, #2762)" >&2
  exit 1
fi
echo "    OK: mount target provisioned by the SDK provider (#2762)"
MT_JSON=$(aws efs describe-mount-targets --mount-target-id "${MT_ID}" --region "${REGION}" \
  --query 'MountTargets[0]' --output json)
MT_IP=$(echo "${MT_JSON}" | jq -r '.IpAddress // empty')
MT_IPV6=$(echo "${MT_JSON}" | jq -r '.Ipv6Address // empty')
if [ "${MT_IP}" != "${EXPECTED_MT_IP}" ] || [ -z "${MT_IPV6}" ]; then
  echo "FAIL: mount target ${MT_ID} has IpAddress '${MT_IP}' / Ipv6Address '${MT_IPV6}', expected '${EXPECTED_MT_IP}' and an IPv6 address (DUAL_STACK) (#2762)" >&2
  echo "${MT_JSON}" >&2
  exit 1
fi
echo "    OK: mount target is DUAL_STACK at ${MT_IP} / ${MT_IPV6} (#2762)"

# Fn::GetAtt [MountTarget, IpAddress]: the SDK provider records the attribute
# (without it the resolver fell back to the mount target id).
MT_IP_OUTPUT=$(echo "${STATE}" | jq -r '.outputs.MountTargetIpAddress // empty')
if [ "${MT_IP_OUTPUT}" != "${EXPECTED_MT_IP}" ]; then
  echo "FAIL: MountTargetIpAddress output is '${MT_IP_OUTPUT}', expected '${EXPECTED_MT_IP}' (Fn::GetAtt IpAddress, #2762)" >&2
  exit 1
fi
echo "    OK: Fn::GetAtt [MountTarget, IpAddress] == ${MT_IP_OUTPUT} (#2762)"

# The readback (IpAddress / Ipv6Address, and IpAddressType derived from them)
# must agree with the baseline the deploy captured: cdkd drift reports the
# mount target clean.
MT_LOGICAL_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[]
  | select(.value.resourceType == "AWS::EFS::MountTarget") | .key] | if length == 1 then .[0] else empty end')
set +e
DRIFT_JSON_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
DRIFT_RC=$?
set -e
MT_DRIFT_BUCKET=$(printf '%s' "${DRIFT_JSON_OUT}" | jq -r --arg id "${MT_LOGICAL_ID}" '[.. | objects | to_entries[]
  | select((.value | type) == "array") | .key as $bucket
  | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' 2>/dev/null || true)
if [ -z "${MT_LOGICAL_ID}" ] || [ "${MT_DRIFT_BUCKET}" != "clean" ]; then
  echo "FAIL: cdkd drift did not report mount target '${MT_LOGICAL_ID}' clean (bucket '${MT_DRIFT_BUCKET}', rc=${DRIFT_RC}) (#2762):" >&2
  printf '%s\n' "${DRIFT_JSON_OUT}" >&2
  exit 1
fi
echo "    OK: cdkd drift reported mount target ${MT_LOGICAL_ID} clean (#2762)"

# --- Assertion 7: baseline tags (issue #5464) ---------------------------
# fs_tag / ap_tag print a key's live value, or <absent>.
AP_ID=$(echo "${STATE}" | jq -r '.outputs.AccessPointId // empty')
if [ -z "${AP_ID}" ]; then
  echo "FAIL: AccessPointId output missing from deploy state" >&2
  exit 1
fi
fs_tag() {
  aws efs describe-file-systems --file-system-id "${FS_ID}" --region "${REGION}" --output json \
    | jq -r --arg k "$1" '[.FileSystems[0].Tags[]? | select(.Key == $k) | .Value] | .[0] // "<absent>"'
}
ap_tag() {
  aws efs describe-access-points --access-point-id "${AP_ID}" --region "${REGION}" --output json \
    | jq -r --arg k "$1" '[.AccessPoints[0].Tags[]? | select(.Key == $k) | .Value] | .[0] // "<absent>"'
}
FS_RETAG_P1=$(fs_tag cdkd-retag); FS_DROP_P1=$(fs_tag cdkd-drop)
AP_RETAG_P1=$(ap_tag cdkd-ap-retag); AP_DROP_P1=$(ap_tag cdkd-ap-drop)
if [ "${FS_RETAG_P1}" != "v1" ] || [ "${FS_DROP_P1}" != "x" ] \
  || [ "${AP_RETAG_P1}" != "v1" ] || [ "${AP_DROP_P1}" != "x" ]; then
  echo "FAIL: baseline tags wrong: file system cdkd-retag='${FS_RETAG_P1}' cdkd-drop='${FS_DROP_P1}', access point cdkd-ap-retag='${AP_RETAG_P1}' cdkd-ap-drop='${AP_DROP_P1}' (expected v1 / x / v1 / x)" >&2
  exit 1
fi
echo "    OK: baseline file system and access point tags applied on create"

# --- Phase 1a: provisioned mode without its value is refused (#5547) ---
# The template keeps ThroughputMode: provisioned, drops
# ProvisionedThroughputInMibps and retags cdkd-retag beside it. CloudFormation
# rejects that update before any EFS call (live CFn A/B, go-to-k/cdkd#5547);
# pre-fix cdkd deployed it, kept 1 MiB/s and applied the tag.
echo "==> Phase 1a: re-deploy dropping only ProvisionedThroughputInMibps (must be refused)"
set +e
VALUE_REMOVED_OUT=$(CDKD_TEST_THROUGHPUT_VALUE_REMOVED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
VALUE_REMOVED_RC=$?
set -e
# Strip ANSI colour codes so a styled span cannot split the needle.
VALUE_REMOVED_OUT="$(printf '%s\n' "${VALUE_REMOVED_OUT}" | sed $'s/\x1b\\[[0-9;]*m//g')"
if [ "${VALUE_REMOVED_RC}" -eq 0 ]; then
  echo "FAIL: the deploy dropping only ProvisionedThroughputInMibps succeeded; CloudFormation rejects it (#5547):" >&2
  printf '%s\n' "${VALUE_REMOVED_OUT}" >&2
  exit 1
fi
# A here-string, not a pipe: under pipefail grep -q's early exit can SIGPIPE
# the writer and fail the pipeline on a match.
if ! grep -qF 'Throughput value must be specified for provisioned throughput mode' \
  <<<"${VALUE_REMOVED_OUT}"; then
  echo "FAIL: the refused deploy did not name the missing throughput value (rc=${VALUE_REMOVED_RC}) (#5547):" >&2
  printf '%s\n' "${VALUE_REMOVED_OUT}" >&2
  exit 1
fi
TP_P1A=$(aws efs describe-file-systems --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].[ThroughputMode,ProvisionedThroughputInMibps]' --output text)
FS_RETAG_P1A=$(fs_tag cdkd-retag)
if [ "${TP_P1A}" != "$(printf 'provisioned\t1.0')" ] || [ "${FS_RETAG_P1A}" != "v1" ]; then
  echo "FAIL: the refused deploy changed the file system: throughput '${TP_P1A}', cdkd-retag '${FS_RETAG_P1A}' (expected provisioned 1.0 / v1) (#5547)" >&2
  exit 1
fi
echo "    OK: dropping only ProvisionedThroughputInMibps was refused before any change (#5547)"

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
# Issue #2762: the mount target's addressing is unchanged, so the redeploy
# must not replace it.
MT_ID_P2=$(echo "${STATE_P2}" | jq -r '.outputs.MountTargetId // empty')
if [ "${MT_ID_P2}" != "${MT_ID}" ]; then
  echo "FAIL: MountTarget was REPLACED by the removal redeploy (${MT_ID} -> ${MT_ID_P2})" >&2
  exit 1
fi
echo "    OK: mount target ${MT_ID} kept across the redeploy"

# Issue #5464: the same redeploy retags the file system (cdkd-retag v1 -> v2,
# cdkd-drop removed). Pre-fix a FileSystemTags change sent nothing: AWS kept
# v1 and cdkd-drop while state recorded the new tags.
FS_RETAG_P2=$(fs_tag cdkd-retag); FS_DROP_P2=$(fs_tag cdkd-drop)
if [ "${FS_RETAG_P2}" != "v2" ] || [ "${FS_DROP_P2}" != "<absent>" ]; then
  echo "FAIL: file system tags not updated in place: cdkd-retag='${FS_RETAG_P2}' (expected v2), cdkd-drop='${FS_DROP_P2}' (expected <absent>) (FileSystemTags update silent-drop NOT closed, #5464)" >&2
  exit 1
fi
echo "    OK: file system retagged in place (#5464)"

# Issue #1160 (efs-provider.ts row): the same redeploy drops BackupPolicy,
# FileSystemPolicy and FileSystemProtection. CloudFormation resets all three
# (live CFn A/B 2026-10-28: PutBackupPolicy DISABLED, DeleteFileSystemPolicy,
# UpdateFileSystemProtection ENABLED); pre-fix cdkd sent nothing, so backups
# stayed ENABLED, the policy stayed attached and protection stayed DISABLED.
# PutBackupPolicy answers DISABLING first, so poll for the settled value.
BACKUP_P2=""
for _i in 1 2 3 4 5 6; do
  BACKUP_P2=$(aws efs describe-backup-policy --file-system-id "${FS_ID}" --region "${REGION}" \
    --query 'BackupPolicy.Status' --output text)
  [ "${BACKUP_P2}" = "DISABLED" ] && break
  if [ "${_i}" -lt 6 ]; then sleep 10; fi
done
if [ "${BACKUP_P2}" != "DISABLED" ]; then
  echo "FAIL: BackupPolicy.Status is '${BACKUP_P2}' after the removal redeploy (waited 60s), expected 'DISABLED' as CloudFormation resets it (removed BackupPolicy silent-drop NOT closed, #1160)" >&2
  exit 1
fi
echo "    OK: removed BackupPolicy reset to DISABLED (#1160)"
if ! gone_probe aws efs describe-file-system-policy --file-system-id "${FS_ID}" --region "${REGION}"; then
  echo "FAIL: FileSystemPolicy still attached after the removal redeploy; CloudFormation deletes it (removed FileSystemPolicy silent-drop NOT closed, #1160)" >&2
  exit 1
fi
echo "    OK: removed FileSystemPolicy deleted (#1160)"
PROTECTION_P2=$(aws efs describe-file-systems --file-system-id "${FS_ID}" --region "${REGION}" \
  --query 'FileSystems[0].FileSystemProtection.ReplicationOverwriteProtection' --output text)
if [ "${PROTECTION_P2}" != "ENABLED" ]; then
  echo "FAIL: ReplicationOverwriteProtection is '${PROTECTION_P2}' after the removal redeploy, expected 'ENABLED' as CloudFormation resets it (removed FileSystemProtection silent-drop NOT closed, #1160)" >&2
  exit 1
fi
echo "    OK: removed FileSystemProtection reset to ENABLED (#1160)"

# --- Phase 1c: access point retag redeploy (issue #5464) -------------
# Only AccessPointTags changes (cdkd-ap-retag v1 -> v2, cdkd-ap-drop removed).
# Pre-fix the provider refused every AccessPoint update, so this deploy failed.
echo "==> Phase 1c: re-deploy retagging the access point"
set +e
CDKD_TEST_REMOVAL=true CDKD_TEST_AP_RETAG=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
AP_DEPLOY_RC=$?
set -e
if [ "${AP_DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: the access-point retag deploy failed (rc=${AP_DEPLOY_RC}); an AccessPointTags-only change must apply in place (#5464)" >&2
  exit 1
fi
AP_RETAG_P3=$(ap_tag cdkd-ap-retag); AP_DROP_P3=$(ap_tag cdkd-ap-drop)
if [ "${AP_RETAG_P3}" != "v2" ] || [ "${AP_DROP_P3}" != "<absent>" ]; then
  echo "FAIL: access point tags not updated in place: cdkd-ap-retag='${AP_RETAG_P3}' (expected v2), cdkd-ap-drop='${AP_DROP_P3}' (expected <absent>) (#5464)" >&2
  exit 1
fi
STATE_P3=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
AP_ID_P3=$(echo "${STATE_P3}" | jq -r '.outputs.AccessPointId // empty')
if [ "${AP_ID_P3}" != "${AP_ID}" ]; then
  echo "FAIL: AccessPoint was REPLACED by the retag redeploy (${AP_ID} -> ${AP_ID_P3}) (#5464)" >&2
  exit 1
fi
echo "    OK: access point ${AP_ID} retagged in place (#5464)"

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
echo "==> efs-standalone test passed (EFS::FileSystem #609 backfill closed + #1160 removal resets + #2762 MountTarget addressing + #5464 retag in place + clean destroy)"
