#!/usr/bin/env bash
# verify.sh — cdkd AWS::FSx::FileSystem SDK provider integ (issue #1042).
#
# The type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this fixture proves the new SDK provider end to end
# with the smallest legal Lustre config (SCRATCH_2, 1200 GiB).
#
# Phases:
#   1. Deploy the Lustre file system (+ minimal VPC/SG). Assert via
#      `aws fsx describe-file-systems` that it is AVAILABLE with the
#      baseline config (SCRATCH_2, 1200 GiB, DataCompressionType NONE),
#      that the DNSName / LustreMountName outputs (Fn::GetAtt) match the
#      AWS-side values, and that state routes it via the SDK provider
#      (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: DataCompressionType NONE ->
#      LZ4 (UpdateFileSystem) + tag value change AND tag removal
#      (TagResource / UntagResource). Assert the FileSystemId is UNCHANGED
#      (in-place update, no replacement).
#   2b. Re-deploy with CDKD_TEST_REMOVAL=true (issue #1160): DataCompressionType
#      is DROPPED from the template while WeeklyMaintenanceStartTime is added.
#      Assert the deploy succeeds, warns naming the removed sub-property, the
#      live compression stays LZ4 (cdkd sends no reset), and the companion
#      maintenance window landed.
#   3. Destroy + assert the file system is GONE from AWS (by id AND by the
#      fixture's constant tag — an FSx file system bills per hour, so a
#      leftover is never acceptable) and the cdkd state file is removed.
#
# NOTE: FSx Lustre creation takes ~5-10 minutes and deletion a few more —
# expect a total wall clock of 15-30 minutes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdFsxLustreExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="fsx-lustre"
# Phase 2b (issue #1160): the provider's removal warning. The needle names the
# removed sub-property; the sentinel is an independent substring of the same
# line, so a reworded warning fails loudly instead of reading as "not fired".
REMOVAL_NEEDLE="property LustreConfiguration.DataCompressionType is no longer declared"
REMOVAL_SENTINEL="cdkd sends no reset"
# The companion change in Phase 2b. The stack declares MAINT_TARGET, or
# MAINT_ALT_TARGET under CDKD_TEST_MAINT_ALT=true -- picked when AWS already
# holds MAINT_TARGET, so the companion assertion can never pass vacuously.
MAINT_TARGET="7:03:30"
MAINT_ALT_TARGET="1:04:45"
# Deploy logs, streamed through `tee` and read back for the greps; removed by
# cleanup on every exit path.
PHASE2_LOG=""
PHASE2B_LOG=""

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

wait_fs_gone() {
  local fs_id="$1"
  local out
  local deadline=$((SECONDS + 1800))
  while [ ${SECONDS} -lt ${deadline} ]; do
    if ! out="$(aws fsx describe-file-systems --file-system-ids "${fs_id}" \
      --region "${REGION}" 2>&1)"; then
      # Strict gone-check (#1097 pattern 2): only a not-found error means the
      # file system is gone; on any other failure (throttle) keep waiting.
      if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
        return 0
      fi
    fi
    sleep 15
  done
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${PHASE2_LOG:-}" ] && rm -f "${PHASE2_LOG}"
  [ -n "${PHASE2B_LOG:-}" ] && rm -f "${PHASE2B_LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
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

state_json() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json 2>/dev/null
}

output_value() {
  state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.state.outputs&&j.state.outputs[process.argv[1]])||"")})' "$1"
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy Lustre SCRATCH_2 file system (this takes ~5-10 min)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL -u CDKD_TEST_MAINT_ALT node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FS_ID_P1="$(output_value FileSystemId)"
DNS_OUT="$(output_value DnsName)"
MOUNT_OUT="$(output_value MountName)"
if [ -z "${FS_ID_P1}" ]; then
  echo "FAIL: FileSystemId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    file system id: ${FS_ID_P1}"

read -r LIFECYCLE_P1 DEPLOY_TYPE_P1 CAPACITY_P1 COMPRESSION_P1 DNS_AWS MOUNT_AWS <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P1}" --region "${REGION}" \
  --query 'FileSystems[0].[Lifecycle,LustreConfiguration.DeploymentType,StorageCapacity,LustreConfiguration.DataCompressionType,DNSName,LustreConfiguration.MountName]' \
  --output text)
EOF

if [ "${LIFECYCLE_P1}" != "AVAILABLE" ]; then
  echo "FAIL: Phase 1 expected Lifecycle AVAILABLE, got '${LIFECYCLE_P1}'" >&2
  exit 1
fi
if [ "${DEPLOY_TYPE_P1}" != "SCRATCH_2" ] || [ "${CAPACITY_P1}" != "1200" ]; then
  echo "FAIL: Phase 1 expected SCRATCH_2/1200, got '${DEPLOY_TYPE_P1}'/'${CAPACITY_P1}'" >&2
  exit 1
fi
if [ "${COMPRESSION_P1}" != "NONE" ]; then
  echo "FAIL: Phase 1 expected DataCompressionType NONE, got '${COMPRESSION_P1}'" >&2
  exit 1
fi
echo "    file system is AVAILABLE (SCRATCH_2, 1200 GiB, compression NONE)"

# Fn::GetAtt outputs must match the AWS-side values.
if [ "${DNS_OUT}" != "${DNS_AWS}" ] || [ -z "${DNS_OUT}" ]; then
  echo "FAIL: DnsName output '${DNS_OUT}' does not match AWS DNSName '${DNS_AWS}'" >&2
  exit 1
fi
if [ "${MOUNT_OUT}" != "${MOUNT_AWS}" ] || [ -z "${MOUNT_OUT}" ]; then
  echo "FAIL: MountName output '${MOUNT_OUT}' does not match AWS MountName '${MOUNT_AWS}'" >&2
  exit 1
fi
echo "    Fn::GetAtt outputs match AWS (DNSName, LustreMountName)"

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

# --- Phase 2: in-place update (compression + tags) ----------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (LZ4 compression, tag change + removal)"
PHASE2_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_REMOVAL -u CDKD_TEST_MAINT_ALT CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2_LOG}"
PHASE2_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2_RC}" -ne 0 ]; then
  echo "FAIL [phase 2]: deploy exited ${PHASE2_RC}" >&2
  exit 1
fi
PHASE2_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2_LOG}")"
# Negative control for Phase 2b's needle: this deploy CHANGES
# DataCompressionType and removes nothing from LustreConfiguration, so the
# removal warning must not appear here.
if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2_PLAIN}"; then
  echo "FAIL [phase 2]: the #1160 removal warning fired on a deploy that removed no LustreConfiguration sub-property" >&2
  exit 1
fi

FS_ID_P2="$(output_value FileSystemId)"
if [ "${FS_ID_P1}" != "${FS_ID_P2}" ]; then
  echo "FAIL: file system was REPLACED (${FS_ID_P1} -> ${FS_ID_P2})" >&2
  exit 1
fi
echo "    file system identity preserved (${FS_ID_P2}) — in-place update"

COMPRESSION_P2="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query 'FileSystems[0].LustreConfiguration.DataCompressionType' --output text)"
if [ "${COMPRESSION_P2}" != "LZ4" ]; then
  echo "FAIL: Phase 2 expected DataCompressionType LZ4, got '${COMPRESSION_P2}'" >&2
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
echo "    update reached AWS (compression LZ4, env=changed, dropme removed)"

# --- Phase 2b: removal of a mutable sub-property (issue #1160) ----------
# DataCompressionType leaves the template while its live value is LZ4 (AWS's
# non-default, asserted in Phase 2). UpdateFileSystem keeps a field it is not
# sent and cdkd sends no reset, so: the deploy succeeds, the value STAYS LZ4,
# and the deploy names the removal in a warning (pre-fix it was dropped
# silently). WeeklyMaintenanceStartTime is ADDED in the same deploy, so
# UpdateFileSystem demonstrably fires beside the removal.
echo "==> Phase 2b: re-deploy with CDKD_TEST_REMOVAL=true (DataCompressionType dropped, maintenance window added)"
MAINT_P2="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query 'FileSystems[0].LustreConfiguration.WeeklyMaintenanceStartTime' --output text)"
MAINT_ALT=false
if [ "${MAINT_P2}" = "${MAINT_TARGET}" ]; then
  echo "    AWS already holds WeeklyMaintenanceStartTime ${MAINT_TARGET}; using ${MAINT_ALT_TARGET} so the companion change is real"
  MAINT_TARGET="${MAINT_ALT_TARGET}"
  MAINT_ALT=true
fi
PHASE2B_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_MAINT_ALT="${MAINT_ALT}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2B_LOG}"
PHASE2B_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2B_RC}" -ne 0 ]; then
  echo "FAIL [phase 2b]: removing DataCompressionType failed the deploy (exit ${PHASE2B_RC}); cdkd must leave it in place and warn" >&2
  exit 1
fi
PHASE2B_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2B_LOG}")"
# Needle and sentinel are independent substrings of the SAME warning line: the
# sentinel without the needle means the wording drifted, not that the
# warning did not fire.
if ! grep -qF "${REMOVAL_NEEDLE}" <<<"${PHASE2B_PLAIN}"; then
  if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2B_PLAIN}"; then
    echo "FAIL [phase 2b]: a removal warning fired but no longer reads '${REMOVAL_NEEDLE}' -- the wording drifted; update this fixture" >&2
  else
    echo "FAIL [phase 2b]: removing DataCompressionType produced no warning (issue #1160: the removal was dropped silently)" >&2
  fi
  exit 1
fi
echo "    deploy warned that LustreConfiguration.DataCompressionType is left in place"

FS_ID_P2B="$(output_value FileSystemId)"
if [ "${FS_ID_P2}" != "${FS_ID_P2B}" ]; then
  echo "FAIL: file system was REPLACED in Phase 2b (${FS_ID_P2} -> ${FS_ID_P2B})" >&2
  exit 1
fi
read -r COMPRESSION_P2B MAINT_P2B <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2B}" --region "${REGION}" \
  --query 'FileSystems[0].[LustreConfiguration.DataCompressionType,LustreConfiguration.WeeklyMaintenanceStartTime]' \
  --output text)
EOF
if [ "${COMPRESSION_P2B}" != "LZ4" ]; then
  echo "FAIL [phase 2b]: expected DataCompressionType to stay LZ4 (cdkd sends no reset), got '${COMPRESSION_P2B}'" >&2
  exit 1
fi
if [ "${MAINT_P2B}" != "${MAINT_TARGET}" ]; then
  echo "FAIL [phase 2b]: expected the companion WeeklyMaintenanceStartTime ${MAINT_TARGET}, got '${MAINT_P2B}' (UpdateFileSystem did not apply)" >&2
  exit 1
fi
echo "    removal left in place (compression LZ4) beside an applied change (maintenance ${MAINT_P2B})"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (FSx deletion takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "FSx file system ${FS_ID_P2} still exists after destroy" aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}"
echo "    file system deleted (by id)"

LEFTOVERS="$(tagged_fs_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: FSx file system(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no file system with the fixture tag remains"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::FSx::FileSystem SDK provider: deploy + in-place update (incl. tag removal) + sub-property removal warning + destroy all passed"
