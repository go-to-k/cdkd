#!/usr/bin/env bash
# verify.sh — cdkd AWS::FSx::FileSystem OpenZFS variant integ (issue #1068).
#
# The type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this fixture proves the OpenZFS variant of the SDK
# provider end to end with the smallest legal config (SINGLE_AZ_1, 64 GiB,
# 64 MB/s, no Active Directory). OpenZFS is the cheapest non-Lustre variant;
# Windows / ONTAP are unit-tested and share this fixture's create-poll /
# delete-poll path.
#
# Phases:
#   1. Deploy the OpenZFS file system (+ minimal VPC). Assert via
#      `aws fsx describe-file-systems` that it is AVAILABLE with the
#      baseline config (SINGLE_AZ_1, 64 GiB, ThroughputCapacity 64), that
#      the DNSName / RootVolumeId outputs (Fn::GetAtt) match the AWS-side
#      values, and that state routes it via the SDK provider
#      (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: ThroughputCapacity 64 -> 128
#      (UpdateFileSystem — a mutable OpenZFSConfiguration sub-property) +
#      tag value change AND tag removal (TagResource / UntagResource).
#      Assert the FileSystemId is UNCHANGED (in-place update, no
#      replacement).
#   3. Destroy + assert the file system is GONE from AWS (by id AND by the
#      fixture's constant tag — an FSx file system bills per hour, so a
#      leftover is never acceptable) and the cdkd state file is removed.
#
# NOTE: FSx OpenZFS creation takes ~5-15 minutes and deletion a few more —
# expect a total wall clock of 15-30 minutes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdFsxOpenZfsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="fsx-openzfs"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

wait_fs_gone() {
  local fs_id="$1"
  local deadline=$((SECONDS + 1800))
  while [ ${SECONDS} -lt ${deadline} ]; do
    if ! aws fsx describe-file-systems --file-system-ids "${fs_id}" \
      --region "${REGION}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 15
  done
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete any leftover file system carrying the fixture's constant tag and
  # wait until it is gone (its ENIs block the VPC teardown below).
  for fsid in $(tagged_fs_ids); do
    echo "    deleting leftover FSx file system ${fsid}"
    aws fsx delete-file-system --file-system-id "${fsid}" --region "${REGION}" >/dev/null 2>&1
    wait_fs_gone "${fsid}"
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

trap cleanup EXIT

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

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy OpenZFS SINGLE_AZ_1 file system (this takes ~5-15 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P1="$(output_value FileSystemId)"
DNS_OUT="$(output_value DnsName)"
ROOTVOL_OUT="$(output_value RootVolumeId)"
if [ -z "${FS_ID_P1}" ]; then
  echo "FAIL: FileSystemId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    file system id: ${FS_ID_P1}"

read -r LIFECYCLE_P1 DEPLOY_TYPE_P1 CAPACITY_P1 THROUGHPUT_P1 DNS_AWS ROOTVOL_AWS <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P1}" --region "${REGION}" \
  --query 'FileSystems[0].[Lifecycle,OpenZFSConfiguration.DeploymentType,StorageCapacity,OpenZFSConfiguration.ThroughputCapacity,DNSName,OpenZFSConfiguration.RootVolumeId]' \
  --output text)
EOF

if [ "${LIFECYCLE_P1}" != "AVAILABLE" ]; then
  echo "FAIL: Phase 1 expected Lifecycle AVAILABLE, got '${LIFECYCLE_P1}'" >&2
  exit 1
fi
if [ "${DEPLOY_TYPE_P1}" != "SINGLE_AZ_1" ] || [ "${CAPACITY_P1}" != "64" ]; then
  echo "FAIL: Phase 1 expected SINGLE_AZ_1/64, got '${DEPLOY_TYPE_P1}'/'${CAPACITY_P1}'" >&2
  exit 1
fi
if [ "${THROUGHPUT_P1}" != "64" ]; then
  echo "FAIL: Phase 1 expected ThroughputCapacity 64, got '${THROUGHPUT_P1}'" >&2
  exit 1
fi
echo "    file system is AVAILABLE (SINGLE_AZ_1, 64 GiB, 64 MB/s)"

# Fn::GetAtt outputs must match the AWS-side values.
if [ "${DNS_OUT}" != "${DNS_AWS}" ] || [ -z "${DNS_OUT}" ]; then
  echo "FAIL: DnsName output '${DNS_OUT}' does not match AWS DNSName '${DNS_AWS}'" >&2
  exit 1
fi
if [ "${ROOTVOL_OUT}" != "${ROOTVOL_AWS}" ] || [ -z "${ROOTVOL_OUT}" ]; then
  echo "FAIL: RootVolumeId output '${ROOTVOL_OUT}' does not match AWS RootVolumeId '${ROOTVOL_AWS}'" >&2
  exit 1
fi
echo "    Fn::GetAtt outputs match AWS (DNSName, RootVolumeId)"

# Baseline tags reached AWS.
ENV_TAG_P1="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P1}" --region "${REGION}" \
  --query "FileSystems[0].Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P1="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P1}" --region "${REGION}" \
  --query "FileSystems[0].Tags[?Key=='dropme'].Value | [0]" --output text)"
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

# --- Phase 2: in-place update (throughput + tags) -----------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (ThroughputCapacity 64->128, tag change + removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P2="$(output_value FileSystemId)"
if [ "${FS_ID_P1}" != "${FS_ID_P2}" ]; then
  echo "FAIL: file system was REPLACED (${FS_ID_P1} -> ${FS_ID_P2})" >&2
  exit 1
fi
echo "    file system identity preserved (${FS_ID_P2}) — in-place update"

THROUGHPUT_P2="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query 'FileSystems[0].OpenZFSConfiguration.ThroughputCapacity' --output text)"
if [ "${THROUGHPUT_P2}" != "128" ]; then
  echo "FAIL: Phase 2 expected ThroughputCapacity 128, got '${THROUGHPUT_P2}'" >&2
  exit 1
fi
ENV_TAG_P2="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query "FileSystems[0].Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P2="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query "FileSystems[0].Tags[?Key=='dropme'].Value | [0]" --output text)"
if [ "${ENV_TAG_P2}" != "changed" ]; then
  echo "FAIL: Phase 2 expected tag env=changed, got '${ENV_TAG_P2}'" >&2
  exit 1
fi
if [ "${DROPME_P2}" != "None" ] && [ -n "${DROPME_P2}" ]; then
  echo "FAIL: Phase 2 expected tag 'dropme' to be REMOVED (UntagResource), still '${DROPME_P2}'" >&2
  exit 1
fi
echo "    update reached AWS (ThroughputCapacity 128, env=changed, dropme removed)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (FSx deletion takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: FSx file system ${FS_ID_P2} still exists after destroy" >&2
  exit 1
fi
echo "    file system deleted (by id)"

LEFTOVERS="$(tagged_fs_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: FSx file system(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no file system with the fixture tag remains"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AWS::FSx::FileSystem OpenZFS variant: deploy + in-place update (incl. tag removal) + destroy all passed"
