#!/usr/bin/env bash
# verify.sh — cdkd AWS::FSx::FileSystem ONTAP variant integ (issue #1088).
#
# PR #1085 shipped the Windows / ONTAP / OpenZFS variants of the SDK
# provider but live-integ-verified only OpenZFS SINGLE_AZ_1. This fixture
# closes the ONTAP half of that gap. The type is
# ProvisioningType: NON_PROVISIONABLE, so there is no Cloud Control
# fallback — this is the end-to-end proof of the ONTAP variant mapping.
#
# Cost bounding (see lib/fsx-ontap-stack.ts for the per-value citations):
# SINGLE_AZ_1, 1024 GiB (the ONTAP floor: 1024 * HAPairs), 128 MBps (the
# SINGLE_AZ_1 throughput floor), AutomaticBackupRetentionDays 0 so no
# chargeable backup can survive the run, and the UPDATE phase moves
# WeeklyMaintenanceStartTime rather than ThroughputCapacity (a throughput
# change is a live storage-optimization operation that would add tens of
# minutes of billed wall clock for the same code path).
#
# Phases:
#   1. Deploy the ONTAP file system (+ minimal VPC). Assert via
#      `aws fsx describe-file-systems` that it is AVAILABLE with the
#      baseline config (SINGLE_AZ_1, 1024 GiB, ThroughputCapacity 128,
#      AutomaticBackupRetentionDays 0, WeeklyMaintenanceStartTime
#      1:05:00), that the ResourceARN output (Fn::GetAtt) matches the
#      AWS-side value, and that state routes it via the SDK provider
#      (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: WeeklyMaintenanceStartTime
#      1:05:00 -> 2:06:00 (an UpdateFileSystem-mutable OntapConfiguration
#      sub-property) + tag value change AND tag removal (TagResource /
#      UntagResource). Assert the FileSystemId is UNCHANGED (in-place
#      update, no replacement).
#   3. Destroy + assert the file system is GONE from AWS (by id AND by the
#      fixture's constant tag — an ONTAP file system bills per hour on
#      1 TiB of SSD, so a leftover is never acceptable) and the cdkd
#      state file is removed.
#
# NOTE: FSx ONTAP creation takes ~20-25 minutes and deletion ~10 more —
# expect a total wall clock of 35-50 minutes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdFsxOntapExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="fsx-ontap"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# Tri-state existence probe. A bare `if ! aws ... >/dev/null 2>&1` treats
# ANY nonzero exit as "gone", so a throttle / expired credential / network
# blip would report a live, billing file system as deleted. Require the
# not-found error specifically.
#   0 = gone, 1 = still exists, 2 = indeterminate (API error)
# FSx FileSystemLifecycle = AVAILABLE | CREATING | DELETING | FAILED |
# MISCONFIGURED | MISCONFIGURED_UNAVAILABLE | UPDATING. There is NO
# terminal DELETED value (verified against the API model) — a deleted file
# system simply stops being returned, so the FileSystemNotFound error IS
# the only "gone" signal here. Note this does NOT generalise: Directory
# Service keeps returning a deleted directory with Stage=Deleted, which is
# why fsx-windows needs a different probe for it.
#
#   0 = gone, 1 = still exists, 2 = indeterminate (API error),
#   3 = terminal FAILED (never "gone" — must be loud)
fs_state() {
  local fs_id="$1" out rc
  out="$(aws fsx describe-file-systems --file-system-ids "${fs_id}" \
    --region "${REGION}" --query 'FileSystems[0].Lifecycle' \
    --output text 2>&1)" && rc=0 || rc=$?
  if [ "${rc}" -eq 0 ]; then
    case "${out}" in
      FAILED) return 3 ;;
      # AVAILABLE / DELETING / UPDATING / MISCONFIGURED* all mean it is
      # still there and still billing.
      *) return 1 ;;
    esac
  fi
  case "${out}" in
    *FileSystemNotFound*) return 0 ;;
    *) return 2 ;;
  esac
}

wait_fs_gone() {
  local fs_id="$1" rc
  local deadline=$((SECONDS + 1800))
  while [ ${SECONDS} -lt ${deadline} ]; do
    fs_state "${fs_id}" && return 0 || rc=$?
    if [ "${rc}" -eq 3 ]; then
      echo "    ERROR: FSx file system ${fs_id} reached Lifecycle=FAILED during deletion" >&2
      return 3
    fi
    # rc 2 (transient API error) keeps polling — the deadline is the guard.
    sleep 15
  done
  return 1
}

# Final backups: cdkd's delete sends a bare DeleteFileSystem with no
# SkipFinalBackup (CloudFormation parity), and the ONTAP API default is to
# TAKE a final backup. AutomaticBackupRetentionDays 0 only disables
# SCHEDULED backups, so a final backup outlives the run and bills per
# GB-month on 1 TiB. Sweep them explicitly.
#
# Selection is by FileSystemId, NOT by the fixture tag: CopyTagsToBackups
# defaults to false, so the backup's persisted FileSystem metadata is not
# guaranteed to carry the fixture tag. A tag-based query can come back
# empty and make the assertion below "pass" over a billing backup.
backup_ids_for_fs() {
  aws fsx describe-backups --region "${REGION}" \
    --query "Backups[?FileSystem.FileSystemId=='$1'].BackupId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# AWS OMITS AutomaticBackupRetentionDays from DescribeFileSystems when
# automatic backups are disabled, rather than echoing 0 — and the CLI
# renders the absent field as "None". Observed live on ONTAP SINGLE_AZ_1
# (2026-07-20): retention AND DailyAutomaticBackupStartTime both came back
# absent, while a sibling property in the same config block
# (WeeklyMaintenanceStartTime) came back set, and describe-backups for the
# file system returned zero backups. The field is optional in every
# variant's response shape, so treat absent and 0 as the same state.
#
# This does NOT weaken the regression the check exists for: the create-time
# default is 30 for Windows, ONTAP and OpenZFS alike, so a template that
# failed to carry the property would report 30 — which this still rejects.
assert_backups_disabled() {
  case "$1" in
    None | none | null | "" | 0) return 0 ;;
    *)
      echo "FAIL: expected automatic backups DISABLED (absent or 0), got '$1'" >&2
      return 1
      ;;
  esac
}

delete_backups_for_fs() {
  local bid
  for bid in $(backup_ids_for_fs "$1"); do
    echo "    deleting FSx backup ${bid} (file system $1)"
    if ! aws fsx delete-backup --backup-id "${bid}" --region "${REGION}" >/dev/null 2>&1; then
      echo "    WARNING: possible leak — failed to delete FSx backup ${bid}" >&2
    fi
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete any leftover file system carrying the fixture's constant tag and
  # wait until it is gone (its ENIs block the VPC teardown below). Each
  # failure is announced loudly — cleanup runs under `set +eu`, so a
  # swallowed error here is exactly the signal that something leaked.
  for fsid in $(tagged_fs_ids); do
    echo "    deleting leftover FSx file system ${fsid}"
    aws fsx delete-file-system --file-system-id "${fsid}" --region "${REGION}" >/dev/null 2>&1
    if wait_fs_gone "${fsid}"; then
      # Only once the file system is gone can its final backup be reaped.
      delete_backups_for_fs "${fsid}"
    else
      echo "    WARNING: possible leak — FSx file system ${fsid} did not disappear before the timeout" >&2
      echo "    WARNING: its final backup (if any) was NOT swept — check 'aws fsx describe-backups'" >&2
    fi
  done
  # Best-effort teardown of the fixture VPC (found via the CDK Name tag).
  for vpcid in $(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:Name,Values=${STACK}/Vpc" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    echo "    deleting leftover VPC ${vpcid}"
    for sg in $(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    for igw in $(aws ec2 describe-internet-gateways --region "${REGION}" \
      --filters "Name=attachment.vpc-id,Values=${vpcid}" \
      --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null); do
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpcid}" \
        --region "${REGION}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --vpc-id "${vpcid}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

# INT/TERM need their OWN handlers that EXIT. Bash does not run an EXIT
# trap when killed by an untrapped SIGINT, but `trap cleanup INT` alone is
# just as wrong: a signal handler RETURNS to the interrupted point, so the
# script would clean up and then resume into the next phase — deleting the
# file system concurrently with a still-running `node deploy` child (the
# harness signals the script PID, not the child) and potentially exiting 0,
# reporting PASS on a run that was torn down mid-flight.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

state_json() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json 2>/dev/null
}

output_value() {
  state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.state.outputs&&j.state.outputs[process.argv[1]])||"")})' "$1"
}

fs_field() {
  aws fsx describe-file-systems --file-system-ids "$1" --region "${REGION}" \
    --query "FileSystems[0].$2" --output text
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy ONTAP SINGLE_AZ_1 file system (this takes ~20-25 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P1="$(output_value FileSystemId)"
ARN_OUT="$(output_value ResourceArn)"
if [ -z "${FS_ID_P1}" ]; then
  echo "FAIL: FileSystemId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    file system id: ${FS_ID_P1}"

read -r LIFECYCLE_P1 DEPLOY_TYPE_P1 CAPACITY_P1 THROUGHPUT_P1 RETENTION_P1 MAINT_P1 ARN_AWS <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P1}" --region "${REGION}" \
  --query 'FileSystems[0].[Lifecycle,OntapConfiguration.DeploymentType,StorageCapacity,OntapConfiguration.ThroughputCapacity,OntapConfiguration.AutomaticBackupRetentionDays,OntapConfiguration.WeeklyMaintenanceStartTime,ResourceARN]' \
  --output text)
EOF

if [ "${LIFECYCLE_P1}" != "AVAILABLE" ]; then
  echo "FAIL: Phase 1 expected Lifecycle AVAILABLE, got '${LIFECYCLE_P1}'" >&2
  exit 1
fi
if [ "${DEPLOY_TYPE_P1}" != "SINGLE_AZ_1" ] || [ "${CAPACITY_P1}" != "1024" ]; then
  echo "FAIL: Phase 1 expected SINGLE_AZ_1/1024, got '${DEPLOY_TYPE_P1}'/'${CAPACITY_P1}'" >&2
  exit 1
fi
if [ "${THROUGHPUT_P1}" != "128" ]; then
  echo "FAIL: Phase 1 expected ThroughputCapacity 128, got '${THROUGHPUT_P1}'" >&2
  exit 1
fi
assert_backups_disabled "${RETENTION_P1}" || exit 1

# The retention field is only a PROXY. The invariant that actually costs
# money is "no backup exists for this file system" — assert that directly,
# keyed on FileSystemId (backups carry no fixture tags).
BACKUPS_P1="$(backup_ids_for_fs "${FS_ID_P1}")"
if [ -n "${BACKUPS_P1}" ]; then
  echo "FAIL: Phase 1 expected no backups for ${FS_ID_P1}, found: ${BACKUPS_P1}" >&2
  exit 1
fi
if [ "${MAINT_P1}" != "1:05:00" ]; then
  echo "FAIL: Phase 1 expected WeeklyMaintenanceStartTime 1:05:00, got '${MAINT_P1}'" >&2
  exit 1
fi
echo "    file system is AVAILABLE (SINGLE_AZ_1, 1024 GiB, 128 MBps, backups off)"

# Fn::GetAtt output must match the AWS-side value.
if [ "${ARN_OUT}" != "${ARN_AWS}" ] || [ -z "${ARN_OUT}" ]; then
  echo "FAIL: ResourceArn output '${ARN_OUT}' does not match AWS ResourceARN '${ARN_AWS}'" >&2
  exit 1
fi
echo "    Fn::GetAtt output matches AWS (ResourceARN)"

# Baseline tags reached AWS.
ENV_TAG_P1="$(fs_field "${FS_ID_P1}" "Tags[?Key=='env'].Value | [0]")"
DROPME_P1="$(fs_field "${FS_ID_P1}" "Tags[?Key=='dropme'].Value | [0]")"
if [ "${ENV_TAG_P1}" != "test" ] || [ "${DROPME_P1}" != "yes" ]; then
  echo "FAIL: Phase 1 expected tags env=test dropme=yes, got env='${ENV_TAG_P1}' dropme='${DROPME_P1}'" >&2
  exit 1
fi
echo "    baseline tags reached AWS (env=test, dropme=yes)"

# The file system must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::FSx::FileSystem");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected FSx file system provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    file system routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2: in-place update (maintenance window + tags) ---------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (WeeklyMaintenanceStartTime 1:05:00->2:06:00, tag change + removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P2="$(output_value FileSystemId)"
if [ "${FS_ID_P1}" != "${FS_ID_P2}" ]; then
  echo "FAIL: file system was REPLACED (${FS_ID_P1} -> ${FS_ID_P2})" >&2
  exit 1
fi
echo "    file system identity preserved (${FS_ID_P2}) — in-place update"

MAINT_P2="$(fs_field "${FS_ID_P2}" 'OntapConfiguration.WeeklyMaintenanceStartTime')"
if [ "${MAINT_P2}" != "2:06:00" ]; then
  echo "FAIL: Phase 2 expected WeeklyMaintenanceStartTime 2:06:00, got '${MAINT_P2}'" >&2
  exit 1
fi
ENV_TAG_P2="$(fs_field "${FS_ID_P2}" "Tags[?Key=='env'].Value | [0]")"
DROPME_P2="$(fs_field "${FS_ID_P2}" "Tags[?Key=='dropme'].Value | [0]")"
if [ "${ENV_TAG_P2}" != "changed" ]; then
  echo "FAIL: Phase 2 expected tag env=changed, got '${ENV_TAG_P2}'" >&2
  exit 1
fi
if [ "${DROPME_P2}" != "None" ] && [ -n "${DROPME_P2}" ]; then
  echo "FAIL: Phase 2 expected tag 'dropme' to be REMOVED (UntagResource), still '${DROPME_P2}'" >&2
  exit 1
fi
echo "    update reached AWS (WeeklyMaintenanceStartTime 2:06:00, env=changed, dropme removed)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (ONTAP deletion takes ~10 min)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# `set -e` would abort on a bare `fs_state` returning 1/2, making the
# non-zero branches below unreachable — capture the status explicitly.
fs_state "${FS_ID_P2}" && FS_RC=0 || FS_RC=$?
case ${FS_RC} in
  0) ;;
  1)
    echo "FAIL: FSx file system ${FS_ID_P2} still exists after destroy" >&2
    exit 1
    ;;
  3)
    echo "FAIL: FSx file system ${FS_ID_P2} is in Lifecycle=FAILED, not deleted" >&2
    exit 1
    ;;
  *)
    echo "FAIL: could not determine whether ${FS_ID_P2} was deleted (FSx API error)" >&2
    exit 1
    ;;
esac
echo "    file system deleted (by id)"

LEFTOVERS="$(tagged_fs_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: FSx file system(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no file system with the fixture tag remains"

# cdkd deletes with API defaults (CloudFormation parity), and the ONTAP
# default is to take a FINAL backup — which bills per GB-month on 1 TiB
# and is invisible to the file-system assertions above.
LEFTOVER_BACKUPS="$(backup_ids_for_fs "${FS_ID_P2}")"
if [ -n "${LEFTOVER_BACKUPS}" ]; then
  echo "    final backup(s) left by DeleteFileSystem: ${LEFTOVER_BACKUPS} — deleting"
  delete_backups_for_fs "${FS_ID_P2}"
  REMAINING_BACKUPS="$(backup_ids_for_fs "${FS_ID_P2}")"
  if [ -n "${REMAINING_BACKUPS}" ]; then
    echo "FAIL: FSx backup(s) still exist after cleanup: ${REMAINING_BACKUPS}" >&2
    exit 1
  fi
fi
echo "    no chargeable backup remains"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AWS::FSx::FileSystem ONTAP variant: deploy + in-place update (incl. tag removal) + destroy all passed"
