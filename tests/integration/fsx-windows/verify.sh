#!/usr/bin/env bash
# verify.sh — cdkd AWS::FSx::FileSystem Windows variant integ (issue #1088).
#
# PR #1085 shipped the Windows / ONTAP / OpenZFS variants of the SDK
# provider but live-integ-verified only OpenZFS SINGLE_AZ_1. This fixture
# closes the Windows half of that gap (fsx-ontap closes the other). The
# type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this is the end-to-end proof of the Windows variant
# mapping.
#
# ## Why the directory is created here and not by cdkd
#
# A Windows file system must join an Active Directory at creation. The
# only practical option is an AWS Managed Microsoft AD, and cdkd cannot
# provision one: AWS reports the directory resource type as
# ProvisioningType: NON_PROVISIONABLE and cdkd ships no SDK provider for
# it, so it lives in src/provisioning/unsupported-types.generated.ts and
# is pre-flight rejected. This script therefore creates the directory out
# of band via `aws ds create-microsoft-ad`, in the VPC the cdkd stack
# deploys, and feeds its id back to the stack through FSX_AD_ID. The
# directory is deleted here too, and the script asserts it is GONE — a
# leftover Managed AD bills per hour.
#
# Cost bounding (see lib/fsx-windows-stack.ts for the per-value
# citations): SINGLE_AZ_1, SSD, 32 GiB (the SSD floor), 8 MBps (the
# documented minimum throughput capacity), AutomaticBackupRetentionDays 0
# so no chargeable backup can survive the run, Managed AD Edition
# Standard (the API default is the pricier Enterprise), and the UPDATE
# phase moves WeeklyMaintenanceStartTime rather than ThroughputCapacity
# (a throughput change swaps the file servers and adds ~30 minutes of
# billed wall clock for the same code path).
#
# Phases:
#   1. Deploy with FSX_AD_ID unset -> VPC only. This is the bootstrap the
#      directory needs (2 subnets in 2 AZs).
#   2. Create the Managed Microsoft AD out of band and wait for Active.
#   3. Re-deploy with FSX_AD_ID set -> cdkd CREATEs the AD-joined Windows
#      file system. Assert AVAILABLE, SINGLE_AZ_1 / SSD / 32 GiB /
#      8 MBps / retention 0 / maintenance 1:05:00, that
#      WindowsConfiguration.ActiveDirectoryId is the directory created in
#      phase 2, that the DNSName / ResourceARN Fn::GetAtt outputs match
#      AWS, and that state routes it via the SDK provider
#      (provisionedBy=sdk).
#   4. Re-deploy with CDKD_TEST_UPDATE=true: WeeklyMaintenanceStartTime
#      1:05:00 -> 2:06:00 (an UpdateFileSystem-mutable
#      WindowsConfiguration sub-property) + tag value change AND tag
#      removal. Assert the FileSystemId is UNCHANGED.
#   5. Re-deploy with FSX_AD_ID unset -> the file system is no longer in
#      the template, so cdkd DELETEs it while the VPC stands. Assert the
#      file system is GONE (by id AND by the fixture's constant tag).
#      Doing the delete here rather than in the final destroy keeps the
#      ordering safe: the file system leaves the domain before the domain
#      goes away.
#   6. Delete the Managed AD and assert it is GONE.
#   7. Destroy the stack and assert the VPC and the cdkd state file are
#      gone.
#
# NOTE: the Managed AD takes ~20-40 minutes to provision and ~10 to
# delete; the Windows file system ~20-30 to create and ~10 to delete.
# Expect a total wall clock of 80-110 minutes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdFsxWindowsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="fsx-windows"
# Fully qualified, resolvable inside the VPC only. Matches the
# CreateMicrosoftAD Name pattern ^([a-zA-Z0-9]+[\.-])+([a-zA-Z0-9])+$ and
# is not a Single Label Domain (FSx rejects SLDs). The NetBIOS ShortName
# defaults to the first label, "corp".
AD_DOMAIN="corp.cdkd-integ.com"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# List directory ids for the fixture's domain (the Directory Service API
# has no tag filter on DescribeDirectories, and the domain name is unique
# to this fixture).
fixture_directory_ids() {
  aws ds describe-directories --region "${REGION}" \
    --query "DirectoryDescriptions[?Name=='${AD_DOMAIN}'].DirectoryId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# Tri-state existence probes. A bare `if ! aws ... >/dev/null 2>&1` treats
# ANY nonzero exit as "gone", so a throttle / expired credential / network
# blip would report a live, billing file system or directory as deleted.
# Require the not-found error specifically.
#   0 = gone, 1 = still exists, 2 = indeterminate (API error)
fs_state() {
  local fs_id="$1" err
  if err="$(aws fsx describe-file-systems --file-system-ids "${fs_id}" \
    --region "${REGION}" 2>&1 >/dev/null)"; then
    return 1
  fi
  case "${err}" in
    *FileSystemNotFound*) return 0 ;;
    *) return 2 ;;
  esac
}

directory_state() {
  local dir_id="$1" err
  if err="$(aws ds describe-directories --directory-ids "${dir_id}" \
    --region "${REGION}" 2>&1 >/dev/null)"; then
    return 1
  fi
  case "${err}" in
    *EntityDoesNotExist* | *DirectoryDoesNotExist*) return 0 ;;
    *) return 2 ;;
  esac
}

wait_fs_gone() {
  local fs_id="$1"
  local deadline=$((SECONDS + 1800))
  while [ ${SECONDS} -lt ${deadline} ]; do
    fs_state "${fs_id}" && return 0
    sleep 15
  done
  return 1
}

wait_directory_gone() {
  local dir_id="$1"
  local deadline=$((SECONDS + 2400))
  while [ ${SECONDS} -lt ${deadline} ]; do
    directory_state "${dir_id}" && return 0
    sleep 20
  done
  return 1
}

# Final backups: cdkd's delete sends a bare DeleteFileSystem with no
# SkipFinalBackup (CloudFormation parity), and the Windows API default is
# to TAKE a final backup. AutomaticBackupRetentionDays 0 only disables
# SCHEDULED backups, so a final backup outlives the run and bills per
# GB-month. Sweep them explicitly.
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

delete_backups_for_fs() {
  local bid
  for bid in $(backup_ids_for_fs "$1"); do
    echo "    deleting FSx backup ${bid} (file system $1)"
    if ! aws fsx delete-backup --backup-id "${bid}" --region "${REGION}" >/dev/null 2>&1; then
      echo "    WARNING: possible leak — failed to delete FSx backup ${bid}" >&2
    fi
  done
}

delete_fixture_directories() {
  local dirid
  for dirid in $(fixture_directory_ids); do
    echo "    deleting Managed AD ${dirid} (${AD_DOMAIN})"
    aws ds delete-directory --directory-id "${dirid}" --region "${REGION}" >/dev/null 2>&1
    if ! wait_directory_gone "${dirid}"; then
      echo "    WARNING: possible leak — Managed AD ${dirid} did not disappear before the timeout" >&2
      echo "    WARNING: a Standard Managed AD bills per hour — check 'aws ds describe-directories'" >&2
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
  # Order matters: the file system leaves the domain first, then the
  # directory goes, then the VPC (both hold ENIs in the fixture subnets).
  # Each failure is announced loudly — cleanup runs under `set +eu`, so a
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
  delete_fixture_directories
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
# file system and directory concurrently with a still-running `node deploy`
# child (the harness signals the script PID, not the child) and potentially
# exiting 0, reporting PASS on a run that was torn down mid-flight. This
# run holds TWO per-hour-billed resources for 80-110 minutes, so getting
# this wrong is expensive in both directions.
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

# The Managed AD admin password is generated per run; fail fast with a
# clear message rather than 2 minutes into the VPC deploy.
if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate the Managed AD admin password" >&2
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

# --- Phase 1: deploy the VPC the directory needs ------------------------
echo "==> Phase 1: deploy the VPC only (FSX_AD_ID unset)"
env -u CDKD_TEST_UPDATE -u FSX_AD_ID node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VPC_ID="$(output_value VpcId)"
SUBNET_A="$(output_value SubnetIdA)"
SUBNET_B="$(output_value SubnetIdB)"
if [ -z "${VPC_ID}" ] || [ -z "${SUBNET_A}" ] || [ -z "${SUBNET_B}" ]; then
  echo "FAIL: VpcId/SubnetIdA/SubnetIdB outputs missing after Phase 1" >&2
  exit 1
fi
echo "    vpc ${VPC_ID}, subnets ${SUBNET_A} / ${SUBNET_B}"

# --- Phase 2: create the Managed Microsoft AD ---------------------------
# Random admin password, never committed. Satisfies the CreateMicrosoftAD
# complexity pattern (8-64 chars with upper + lower + digit + symbol).
AD_PASSWORD="Cdkd-$(openssl rand -hex 12)-Aa1!"
echo "==> Phase 2: create the Managed Microsoft AD (Standard edition; this takes ~20-40 min)"
# The request is piped in as JSON rather than passed on argv: a
# `--password` flag would put the AD admin password in the process table
# where any local user can read it via `ps`. The values reach `node` as
# environment variables (not argv) for the same reason.
DIRECTORY_ID="$(
  AD_NAME="${AD_DOMAIN}" AD_PW="${AD_PASSWORD}" AD_VPC="${VPC_ID}" \
    AD_SUB_A="${SUBNET_A}" AD_SUB_B="${SUBNET_B}" node -e '
      process.stdout.write(
        JSON.stringify({
          Name: process.env.AD_NAME,
          Password: process.env.AD_PW,
          Edition: "Standard",
          Description: "cdkd integ fsx-windows",
          VpcSettings: {
            VpcId: process.env.AD_VPC,
            SubnetIds: [process.env.AD_SUB_A, process.env.AD_SUB_B],
          },
        })
      );
    ' | aws ds create-microsoft-ad --cli-input-json file:///dev/stdin \
      --region "${REGION}" --query 'DirectoryId' --output text
)"
if [ -z "${DIRECTORY_ID}" ] || [ "${DIRECTORY_ID}" = "None" ]; then
  echo "FAIL: create-microsoft-ad returned no DirectoryId" >&2
  exit 1
fi
echo "    directory id: ${DIRECTORY_ID}"

AD_DEADLINE=$((SECONDS + 3600))
AD_STAGE=""
while [ ${SECONDS} -lt ${AD_DEADLINE} ]; do
  AD_STAGE="$(aws ds describe-directories --directory-ids "${DIRECTORY_ID}" --region "${REGION}" \
    --query 'DirectoryDescriptions[0].Stage' --output text)"
  case "${AD_STAGE}" in
    Active) break ;;
    Failed | Deleted | Deleting)
      echo "FAIL: directory ${DIRECTORY_ID} reached terminal stage '${AD_STAGE}'" >&2
      exit 1
      ;;
    *) sleep 30 ;;
  esac
done
if [ "${AD_STAGE}" != "Active" ]; then
  echo "FAIL: directory ${DIRECTORY_ID} did not become Active in time (stage '${AD_STAGE}')" >&2
  exit 1
fi
echo "    directory is Active"

# --- Phase 3: deploy the AD-joined Windows file system ------------------
echo "==> Phase 3: deploy the Windows file system (this takes ~20-30 min)"
env -u CDKD_TEST_UPDATE FSX_AD_ID="${DIRECTORY_ID}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P3="$(output_value FileSystemId)"
DNS_OUT="$(output_value DnsName)"
ARN_OUT="$(output_value ResourceArn)"
if [ -z "${FS_ID_P3}" ]; then
  echo "FAIL: FileSystemId output missing from cdkd state after Phase 3" >&2
  exit 1
fi
echo "    file system id: ${FS_ID_P3}"

read -r LIFECYCLE_P3 DEPLOY_TYPE_P3 CAPACITY_P3 STORAGE_TYPE_P3 THROUGHPUT_P3 RETENTION_P3 MAINT_P3 AD_ID_P3 DNS_AWS ARN_AWS <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P3}" --region "${REGION}" \
  --query 'FileSystems[0].[Lifecycle,WindowsConfiguration.DeploymentType,StorageCapacity,StorageType,WindowsConfiguration.ThroughputCapacity,WindowsConfiguration.AutomaticBackupRetentionDays,WindowsConfiguration.WeeklyMaintenanceStartTime,WindowsConfiguration.ActiveDirectoryId,DNSName,ResourceARN]' \
  --output text)
EOF

if [ "${LIFECYCLE_P3}" != "AVAILABLE" ]; then
  echo "FAIL: Phase 3 expected Lifecycle AVAILABLE, got '${LIFECYCLE_P3}'" >&2
  exit 1
fi
if [ "${DEPLOY_TYPE_P3}" != "SINGLE_AZ_1" ] || [ "${CAPACITY_P3}" != "32" ] || [ "${STORAGE_TYPE_P3}" != "SSD" ]; then
  echo "FAIL: Phase 3 expected SINGLE_AZ_1/32/SSD, got '${DEPLOY_TYPE_P3}'/'${CAPACITY_P3}'/'${STORAGE_TYPE_P3}'" >&2
  exit 1
fi
if [ "${THROUGHPUT_P3}" != "8" ]; then
  echo "FAIL: Phase 3 expected ThroughputCapacity 8, got '${THROUGHPUT_P3}'" >&2
  exit 1
fi
if [ "${RETENTION_P3}" != "0" ]; then
  echo "FAIL: Phase 3 expected AutomaticBackupRetentionDays 0 (no chargeable backups), got '${RETENTION_P3}'" >&2
  exit 1
fi
if [ "${MAINT_P3}" != "1:05:00" ]; then
  echo "FAIL: Phase 3 expected WeeklyMaintenanceStartTime 1:05:00, got '${MAINT_P3}'" >&2
  exit 1
fi
if [ "${AD_ID_P3}" != "${DIRECTORY_ID}" ]; then
  echo "FAIL: Phase 3 expected ActiveDirectoryId ${DIRECTORY_ID}, got '${AD_ID_P3}'" >&2
  exit 1
fi
echo "    file system is AVAILABLE and joined to ${DIRECTORY_ID} (SINGLE_AZ_1, SSD 32 GiB, 8 MBps, backups off)"

# Fn::GetAtt outputs must match the AWS-side values.
if [ "${DNS_OUT}" != "${DNS_AWS}" ] || [ -z "${DNS_OUT}" ]; then
  echo "FAIL: DnsName output '${DNS_OUT}' does not match AWS DNSName '${DNS_AWS}'" >&2
  exit 1
fi
if [ "${ARN_OUT}" != "${ARN_AWS}" ] || [ -z "${ARN_OUT}" ]; then
  echo "FAIL: ResourceArn output '${ARN_OUT}' does not match AWS ResourceARN '${ARN_AWS}'" >&2
  exit 1
fi
# The DNS name of an AD-joined file system lives under the domain, so this
# also witnesses the domain join.
case "${DNS_AWS}" in
  *".${AD_DOMAIN}") ;;
  *)
    echo "FAIL: DNSName '${DNS_AWS}' is not under the fixture domain ${AD_DOMAIN}" >&2
    exit 1
    ;;
esac
echo "    Fn::GetAtt outputs match AWS (DNSName under ${AD_DOMAIN}, ResourceARN)"

# Baseline tags reached AWS.
ENV_TAG_P3="$(fs_field "${FS_ID_P3}" "Tags[?Key=='env'].Value | [0]")"
DROPME_P3="$(fs_field "${FS_ID_P3}" "Tags[?Key=='dropme'].Value | [0]")"
if [ "${ENV_TAG_P3}" != "test" ] || [ "${DROPME_P3}" != "yes" ]; then
  echo "FAIL: Phase 3 expected tags env=test dropme=yes, got env='${ENV_TAG_P3}' dropme='${DROPME_P3}'" >&2
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

# --- Phase 4: in-place update (maintenance window + tags) ---------------
echo "==> Phase 4: re-deploy with CDKD_TEST_UPDATE=true (WeeklyMaintenanceStartTime 1:05:00->2:06:00, tag change + removal)"
CDKD_TEST_UPDATE=true FSX_AD_ID="${DIRECTORY_ID}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P4="$(output_value FileSystemId)"
if [ "${FS_ID_P3}" != "${FS_ID_P4}" ]; then
  echo "FAIL: file system was REPLACED (${FS_ID_P3} -> ${FS_ID_P4})" >&2
  exit 1
fi
echo "    file system identity preserved (${FS_ID_P4}) — in-place update"

MAINT_P4="$(fs_field "${FS_ID_P4}" 'WindowsConfiguration.WeeklyMaintenanceStartTime')"
if [ "${MAINT_P4}" != "2:06:00" ]; then
  echo "FAIL: Phase 4 expected WeeklyMaintenanceStartTime 2:06:00, got '${MAINT_P4}'" >&2
  exit 1
fi
ENV_TAG_P4="$(fs_field "${FS_ID_P4}" "Tags[?Key=='env'].Value | [0]")"
DROPME_P4="$(fs_field "${FS_ID_P4}" "Tags[?Key=='dropme'].Value | [0]")"
if [ "${ENV_TAG_P4}" != "changed" ]; then
  echo "FAIL: Phase 4 expected tag env=changed, got '${ENV_TAG_P4}'" >&2
  exit 1
fi
if [ "${DROPME_P4}" != "None" ] && [ -n "${DROPME_P4}" ]; then
  echo "FAIL: Phase 4 expected tag 'dropme' to be REMOVED (UntagResource), still '${DROPME_P4}'" >&2
  exit 1
fi
# The AD binding must have survived the update untouched (ActiveDirectoryId
# is create-only; a silent re-join would be a bug).
AD_ID_P4="$(fs_field "${FS_ID_P4}" 'WindowsConfiguration.ActiveDirectoryId')"
if [ "${AD_ID_P4}" != "${DIRECTORY_ID}" ]; then
  echo "FAIL: Phase 4 expected ActiveDirectoryId to stay ${DIRECTORY_ID}, got '${AD_ID_P4}'" >&2
  exit 1
fi
echo "    update reached AWS (WeeklyMaintenanceStartTime 2:06:00, env=changed, dropme removed, AD binding intact)"

# --- Phase 5: delete the file system through cdkd -----------------------
# Dropping FSX_AD_ID takes the file system out of the template, so cdkd
# plans a DELETE for it while the VPC stays. This unjoins the domain
# BEFORE the directory is deleted in phase 6.
echo "==> Phase 5: re-deploy with FSX_AD_ID unset — cdkd deletes the file system (~10 min)"
env -u CDKD_TEST_UPDATE -u FSX_AD_ID node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# `set -e` would abort on a bare `fs_state` returning 1/2, making the
# non-zero branches below unreachable — capture the status explicitly.
fs_state "${FS_ID_P4}" && FS_RC=0 || FS_RC=$?
case ${FS_RC} in
  0) ;;
  1)
    echo "FAIL: FSx file system ${FS_ID_P4} still exists after cdkd removed it from the template" >&2
    exit 1
    ;;
  *)
    echo "FAIL: could not determine whether ${FS_ID_P4} was deleted (FSx API error)" >&2
    exit 1
    ;;
esac
LEFTOVERS="$(tagged_fs_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: FSx file system(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    file system deleted (by id and by fixture tag)"

# cdkd deletes with API defaults (CloudFormation parity), and the Windows
# default is to take a FINAL backup — chargeable, and invisible to the
# file-system assertions above.
LEFTOVER_BACKUPS="$(backup_ids_for_fs "${FS_ID_P4}")"
if [ -n "${LEFTOVER_BACKUPS}" ]; then
  echo "    final backup(s) left by DeleteFileSystem: ${LEFTOVER_BACKUPS} — deleting"
  delete_backups_for_fs "${FS_ID_P4}"
  REMAINING_BACKUPS="$(backup_ids_for_fs "${FS_ID_P4}")"
  if [ -n "${REMAINING_BACKUPS}" ]; then
    echo "FAIL: FSx backup(s) still exist after cleanup: ${REMAINING_BACKUPS}" >&2
    exit 1
  fi
fi
echo "    no chargeable backup remains"

# --- Phase 6: delete the Managed AD -------------------------------------
echo "==> Phase 6: delete the Managed Microsoft AD (~10 min)"
aws ds delete-directory --directory-id "${DIRECTORY_ID}" --region "${REGION}" >/dev/null
if ! wait_directory_gone "${DIRECTORY_ID}"; then
  echo "FAIL: directory ${DIRECTORY_ID} still exists after delete-directory" >&2
  exit 1
fi
REMAINING_DIRS="$(fixture_directory_ids)"
if [ -n "${REMAINING_DIRS}" ]; then
  echo "FAIL: directory/directories for ${AD_DOMAIN} still exist: ${REMAINING_DIRS}" >&2
  exit 1
fi
echo "    Managed AD deleted (by id and by domain name)"

# --- Phase 7: destroy the stack -----------------------------------------
echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if VPC_ERR="$(aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" 2>&1 >/dev/null)"; then
  echo "FAIL: VPC ${VPC_ID} still exists after destroy" >&2
  exit 1
fi
case "${VPC_ERR}" in
  *InvalidVpcID.NotFound*) ;;
  *)
    echo "FAIL: could not determine whether ${VPC_ID} was deleted (EC2 API error): ${VPC_ERR}" >&2
    exit 1
    ;;
esac
echo "    VPC deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AWS::FSx::FileSystem Windows variant: AD-joined create + in-place update (incl. tag removal) + delete + destroy all passed"
