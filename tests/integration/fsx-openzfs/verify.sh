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
#      tag value change AND tag removal (TagResource / UntagResource) +
#      OpenZFSConfiguration.Options DELETE_CHILD_VOLUMES_AND_SNAPSHOTS added
#      (go-to-k/cdkd#5431: a delete-time option, accepted with nothing sent).
#      Assert the FileSystemId is UNCHANGED (in-place update, no
#      replacement).
#   2.5. `cdkd drift` must be CLEAN on the untouched file system (issue
#      #1089). readCurrentState reverse-maps the OpenZFSConfiguration block
#      back to CFn input shape; before #1089 the block was declared
#      drift-unknown so drift passed trivially. Now it is compared, so a
#      mapping bug surfaces here as phantom drift.
#   2b. Re-deploy with CDKD_TEST_REMOVAL=true (issue #1160): StorageCapacity,
#      StorageType and NetworkType leave the template. cdkd sends no reset,
#      as CloudFormation leaves them (CFn A/B on issue #1160): the deploy
#      succeeds, the values stay (64 / SSD / IPV4), the same file system is
#      kept, and ONE warning names all three. WeeklyMaintenanceStartTime is
#      added in the same deploy, so UpdateFileSystem fires beside them.
#   2c. Re-deploy with CDKD_TEST_TP_REMOVAL=true too (issue #1160):
#      ThroughputCapacity leaves the template. The CFn A/B measured
#      CloudFormation keeping it on MULTI_AZ_1 only, so on this SINGLE_AZ_1
#      file system the warning must claim nothing about CloudFormation, and
#      the value (128) must stay on the same file system.
#   2d. Create a child volume under the root volume, outside the stack
#      (go-to-k/cdkd#5431). FSx refuses to delete a file system with child
#      volumes unless DeleteFileSystem carries the Options above.
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

STACK="CdkdFsxOpenZfsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="fsx-openzfs"
# go-to-k/cdkd#5431: the child volume Phase 2d creates outside the stack.
CHILD_VOLUME_NAME="cdkd_child"
# Phase 2b (issue #1160): the provider's removal warning. The needle names the
# removed properties in the provider's order; the sentinel is an independent
# substring of the same line, so a reworded warning fails loudly instead of
# reading as "not fired".
REMOVAL_NEEDLE="properties StorageCapacity, StorageType, NetworkType are no longer declared and keep their current AWS value, as CloudFormation leaves them"
REMOVAL_SENTINEL="UpdateFileSystem keeps a setting it is not sent"
# Phase 2c (issue #1160): a removed ThroughputCapacity on this SINGLE_AZ_1 file
# system. CloudFormation was measured keeping it on MULTI_AZ_1 only, so the
# line must claim nothing about CloudFormation (TP_REMOVAL_NEEDLE) and must not
# carry the MULTI_AZ_1 claim (TP_OVERCLAIM_NEEDLE).
TP_REMOVAL_NEEDLE="property OpenZFSConfiguration.ThroughputCapacity is no longer declared; UpdateFileSystem keeps a setting it is not sent and cdkd sends no reset"
TP_OVERCLAIM_NEEDLE="property OpenZFSConfiguration.ThroughputCapacity is no longer declared and keeps its current AWS value, as CloudFormation leaves it"
# The companion change in Phase 2b. The stack declares MAINT_TARGET, or
# MAINT_ALT_TARGET under CDKD_TEST_MAINT_ALT=true -- picked when AWS already
# holds MAINT_TARGET, so the companion assertion can never pass vacuously.
MAINT_TARGET="7:03:30"
MAINT_ALT_TARGET="1:04:45"
# Deploy logs, streamed through `tee` and read back for the greps; removed by
# cleanup on every exit path.
PHASE2_LOG=""
PHASE2B_LOG=""
PHASE2C_LOG=""
DESTROY_LOG=""
# Set by Phase 2d once the child volume exists (go-to-k/cdkd#5431).
CHILD_VOLUME_ID=""

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

wait_fs_gone() { # usage: wait_fs_gone <fs-id> [max-seconds, default 1800]
  local fs_id="$1"
  local out
  local deadline=$((SECONDS + ${2:-1800}))
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

# The FINAL BACKUP DeleteFileSystem takes by default (the API default cdkd
# keeps, as CloudFormation does) outlives the file system and is billed. Delete
# every backup of the given file system, waiting for one still CREATING /
# TRANSFERRING. Returns 1 when one is still there at the deadline.
# Backup id + lifecycle rows of one file system; returns 1 when the probe fails.
fs_backup_rows() { # usage: fs_backup_rows <fs-id>
  local out
  out="$(aws fsx describe-backups --region "${REGION}" \
    --filters "Name=file-system-id,Values=$1" \
    --query 'Backups[].[BackupId,Lifecycle]' --output text 2>/dev/null)" || return 1
  printf '%s\n' "${out}"
}

sweep_fs_backups() { # usage: sweep_fs_backups <fs-id> [max-seconds, default 900]
  local fs_id="$1"
  local deadline=$((SECONDS + ${2:-900}))
  local rows id lifecycle pending
  while :; do
    if ! rows="$(fs_backup_rows "${fs_id}")"; then
      # The probe failed (throttle, auth): undetermined, so keep waiting.
      pending=1
    else
      pending=0
      while read -r id lifecycle; do
        [ -z "${id}" ] && continue
        case "${lifecycle}" in
          DELETED) ;;
          AVAILABLE | FAILED)
            echo "    deleting FSx backup ${id} of ${fs_id} (${lifecycle})"
            aws fsx delete-backup --backup-id "${id}" --region "${REGION}" >/dev/null 2>&1
            pending=1
            ;;
          *) pending=1 ;;
        esac
      done <<<"${rows}"
    fi
    [ "${pending}" -eq 0 ] && return 0
    [ ${SECONDS} -ge ${deadline} ] && return 1
    sleep 15
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${PHASE2_LOG:-}" ] && rm -f "${PHASE2_LOG}"
  [ -n "${PHASE2B_LOG:-}" ] && rm -f "${PHASE2B_LOG}"
  [ -n "${PHASE2C_LOG:-}" ] && rm -f "${PHASE2C_LOG}"
  [ -n "${DESTROY_LOG:-}" ] && rm -f "${DESTROY_LOG}"
  # A child volume still CREATING (a run interrupted in Phase 2d) makes FSx
  # refuse the file system delete below, so let it settle first (#5431).
  if [ -n "${CHILD_VOLUME_ID:-}" ]; then
    local child_deadline=$((SECONDS + 900))
    while [ ${SECONDS} -lt ${child_deadline} ] && [ "$(aws fsx describe-volumes \
      --volume-ids "${CHILD_VOLUME_ID}" --region "${REGION}" \
      --query 'Volumes[0].Lifecycle' --output text 2>/dev/null)" = "CREATING" ]; do
      sleep 15
    done
  fi
  # Delete any leftover file system carrying the fixture's constant tag and
  # wait until it is gone (its ENIs block the VPC teardown below).
  for fsid in $(tagged_fs_ids); do
    echo "    deleting leftover FSx file system ${fsid}"
    # Phase 2d's child volume goes with it (go-to-k/cdkd#5431).
    aws fsx delete-file-system --file-system-id "${fsid}" --region "${REGION}" \
      --open-zfs-configuration 'Options=DELETE_CHILD_VOLUMES_AND_SNAPSHOTS' >/dev/null 2>&1
    if ! wait_fs_gone "${fsid}" 1200; then
      # e.g. a child volume still CREATING when an interrupted run got here
      echo "    WARNING: FSx file system ${fsid} is still present after cleanup; it bills per hour, delete it by hand" >&2
    fi
    CLEANUP_FS_IDS="${CLEANUP_FS_IDS:-} ${fsid}"
  done
  # Final backups of every file system this run made (go-to-k/cdkd#5431).
  for fsid in ${FS_ID_P1:-} ${CLEANUP_FS_IDS:-}; do
    if ! sweep_fs_backups "${fsid}" 600; then
      echo "    WARNING: an FSx backup of ${fsid} is still present after cleanup; it is billed, delete it by hand" >&2
    fi
  done
  # The file system is gone (or reported) by now, so `state destroy` no longer
  # waits on subnets its ENIs hold. Bounded all the same: a mutated binary
  # (the pre-fix probe) must not stall the trap.
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1 &
    local sd_pid=$!
    local sd_deadline=$((SECONDS + 600))
    while kill -0 "${sd_pid}" 2>/dev/null && [ ${SECONDS} -lt ${sd_deadline} ]; do
      sleep 5
    done
    if kill -0 "${sd_pid}" 2>/dev/null; then
      echo "    WARNING: cdkd state destroy did not finish in 600s; stopped it" >&2
      kill "${sd_pid}" 2>/dev/null
    fi
    wait "${sd_pid}" 2>/dev/null
  fi
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
echo "==> Phase 1: deploy OpenZFS SINGLE_AZ_1 file system (this takes ~5-15 min)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL -u CDKD_TEST_MAINT_ALT -u CDKD_TEST_TP_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
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
PHASE2_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_REMOVAL -u CDKD_TEST_MAINT_ALT -u CDKD_TEST_TP_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2_LOG}"
PHASE2_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2_RC}" -ne 0 ]; then
  if sed 's/\x1b\[[0-9;]*m//g' "${PHASE2_LOG}" | grep -qF "OpenZFSConfiguration.Options is immutable"; then
    echo "FAIL [phase 2]: adding OpenZFSConfiguration.Options was refused as immutable (issue #5431: it is a DeleteFileSystem option, CFn 'Update requires: No interruption')" >&2
  else
    echo "FAIL [phase 2]: deploy exited ${PHASE2_RC}" >&2
  fi
  exit 1
fi
# Negative control for Phase 2b's needle: this deploy removes no top-level
# property, so the removal warning must not appear here.
if grep -qF "${REMOVAL_SENTINEL}" <<<"$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2_LOG}")"; then
  echo "FAIL [phase 2]: the #1160 removal warning fired on a deploy that removed no top-level property" >&2
  exit 1
fi

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

# --- Phase 2.5: clean-drift check (issue #1089) --------------------------
# readCurrentState reverse-maps the OpenZFSConfiguration block back to CFn
# input shape. Before #1089 the whole block was declared drift-unknown, so
# drift passed trivially; now it is compared field-by-field against the
# deploy-time state. A mapping bug (wrong key name, a read-only AWS field
# leaking in, a type mismatch) therefore shows up right here as a phantom
# drift on a file system nobody touched. `cdkd drift` exits 0 = no drift,
# 1 = drift detected, 2 = error.
echo "==> Phase 2.5: drift must be CLEAN immediately after a successful deploy"
DRIFT_OUT="$(mktemp)"
DRIFT_ERR="$(mktemp)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json >"${DRIFT_OUT}" 2>"${DRIFT_ERR}"
DRIFT_RC=$?
set -e

if [ "${DRIFT_RC}" -eq 2 ]; then
  echo "FAIL: cdkd drift errored (exit 2) — readCurrentState raised" >&2
  cat "${DRIFT_ERR}" >&2
  rm -f "${DRIFT_OUT}" "${DRIFT_ERR}"
  exit 1
fi
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: phantom drift on an untouched file system (exit ${DRIFT_RC}) — the OpenZFSConfiguration reverse-map does not round-trip" >&2
  cat "${DRIFT_OUT}" >&2
  rm -f "${DRIFT_OUT}" "${DRIFT_ERR}"
  exit 1
fi
rm -f "${DRIFT_OUT}" "${DRIFT_ERR}"
echo "    no drift detected (OpenZFSConfiguration reverse-map round-trips cleanly)"

# A clean exit alone is NOT sufficient proof: drift classifies a resource whose
# readCurrentState returns undefined as `unsupported`, which also exits 0. So
# assert the reverse-mapper actually PRODUCED the block. `observedProperties`
# (not `properties`) is the deploy-time readCurrentState snapshot captured by
# deploy-engine — reading `properties` here would be tautological, since that is
# the template input and is present whether or not readCurrentState ever ran.
OBSERVED_TP="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::FSx::FileSystem");const o=(r[k]&&r[k].observedProperties&&r[k].observedProperties.OpenZFSConfiguration)||{};process.stdout.write(String(o.ThroughputCapacity===undefined?"":o.ThroughputCapacity))})')"
if [ "${OBSERVED_TP}" != "128" ]; then
  echo "FAIL: expected observedProperties.OpenZFSConfiguration.ThroughputCapacity 128 after Phase 2, got '${OBSERVED_TP}' — the OpenZFS reverse-map did not run or did not emit the block" >&2
  exit 1
fi
echo "    observedProperties carries the reverse-mapped OpenZFS block (readCurrentState ran)"

# --- Phase 2b: removal of the top-level settings (issue #1160) ----------
# StorageCapacity, StorageType and NetworkType leave the template. Their live
# values are read first, so the "stays" assertions compare against what AWS
# held, not against a constant.
echo "==> Phase 2b: re-deploy with CDKD_TEST_REMOVAL=true (StorageCapacity / StorageType / NetworkType dropped, maintenance window added)"
read -r CAPACITY_P2 STORAGE_TYPE_P2 NETWORK_TYPE_P2 MAINT_P2 <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}" \
  --query 'FileSystems[0].[StorageCapacity,StorageType,NetworkType,OpenZFSConfiguration.WeeklyMaintenanceStartTime]' \
  --output text)
EOF
if [ "${CAPACITY_P2}" != "64" ] || [ "${STORAGE_TYPE_P2}" != "SSD" ] || [ "${NETWORK_TYPE_P2}" != "IPV4" ]; then
  echo "FAIL [phase 2b]: expected the declared 64 / SSD / IPV4 before the removal, got '${CAPACITY_P2}' / '${STORAGE_TYPE_P2}' / '${NETWORK_TYPE_P2}'" >&2
  exit 1
fi
MAINT_ALT=false
if [ "${MAINT_P2}" = "${MAINT_TARGET}" ]; then
  echo "    AWS already holds WeeklyMaintenanceStartTime ${MAINT_TARGET}; using ${MAINT_ALT_TARGET} so the companion change is real"
  MAINT_TARGET="${MAINT_ALT_TARGET}"
  MAINT_ALT=true
fi
PHASE2B_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_TP_REMOVAL CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_MAINT_ALT="${MAINT_ALT}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2B_LOG}"
PHASE2B_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2B_RC}" -ne 0 ]; then
  echo "FAIL [phase 2b]: removing StorageCapacity / StorageType / NetworkType failed the deploy (exit ${PHASE2B_RC}); cdkd must leave them in place and warn" >&2
  exit 1
fi
PHASE2B_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2B_LOG}")"
# Needle and sentinel are independent substrings of the SAME warning line: the
# sentinel without the needle means the wording drifted, not that the
# warning did not fire.
if ! grep -qF "${REMOVAL_NEEDLE}" <<<"${PHASE2B_PLAIN}"; then
  if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2B_PLAIN}"; then
    echo "FAIL [phase 2b]: the removal warning fired without the CloudFormation-keeps wording '${REMOVAL_NEEDLE}' -- the measured claim regressed in src/provisioning/providers/fsx-filesystem-provider.ts (CFN_KEEPS_TOP_LEVEL_ON_REMOVAL / cfnKeepsOnRemoval), or the wording drifted and this needle needs updating" >&2
  else
    echo "FAIL [phase 2b]: removing StorageCapacity / StorageType / NetworkType produced no warning (issue #1160: the removal was dropped silently)" >&2
  fi
  exit 1
fi
echo "    deploy warned that StorageCapacity, StorageType and NetworkType are left in place"

FS_ID_P2B="$(output_value FileSystemId)"
if [ "${FS_ID_P2}" != "${FS_ID_P2B}" ]; then
  echo "FAIL: file system was REPLACED in Phase 2b (${FS_ID_P2} -> ${FS_ID_P2B})" >&2
  exit 1
fi
read -r CAPACITY_P2B STORAGE_TYPE_P2B NETWORK_TYPE_P2B MAINT_P2B <<EOF
$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2B}" --region "${REGION}" \
  --query 'FileSystems[0].[StorageCapacity,StorageType,NetworkType,OpenZFSConfiguration.WeeklyMaintenanceStartTime]' \
  --output text)
EOF
if [ "${CAPACITY_P2B}" != "${CAPACITY_P2}" ] || [ "${STORAGE_TYPE_P2B}" != "${STORAGE_TYPE_P2}" ] \
  || [ "${NETWORK_TYPE_P2B}" != "${NETWORK_TYPE_P2}" ]; then
  echo "FAIL [phase 2b]: expected ${CAPACITY_P2} / ${STORAGE_TYPE_P2} / ${NETWORK_TYPE_P2} to stay (cdkd sends no reset), got '${CAPACITY_P2B}' / '${STORAGE_TYPE_P2B}' / '${NETWORK_TYPE_P2B}'" >&2
  exit 1
fi
if [ "${MAINT_P2B}" != "${MAINT_TARGET}" ]; then
  echo "FAIL [phase 2b]: expected the companion WeeklyMaintenanceStartTime ${MAINT_TARGET}, got '${MAINT_P2B}' (UpdateFileSystem did not apply)" >&2
  exit 1
fi
echo "    removals left in place (${CAPACITY_P2B} / ${STORAGE_TYPE_P2B} / ${NETWORK_TYPE_P2B}) beside an applied change (maintenance ${MAINT_P2B})"

# --- Phase 2c: ThroughputCapacity removal on SINGLE_AZ_1 (issue #1160) ---
# The CFn A/B on #1160 measured CloudFormation keeping a removed
# ThroughputCapacity on MULTI_AZ_1 only. On this SINGLE_AZ_1 file system cdkd
# must leave the value in place and warn WITHOUT the CloudFormation claim. The
# template is phase 2b's otherwise (same maintenance window), so ThroughputCapacity
# is the deploy's only difference and nothing else reaches UpdateFileSystem.
echo "==> Phase 2c: re-deploy with CDKD_TEST_TP_REMOVAL=true (ThroughputCapacity dropped on SINGLE_AZ_1)"
TP_P2C_BEFORE="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2B}" --region "${REGION}" \
  --query 'FileSystems[0].OpenZFSConfiguration.ThroughputCapacity' --output text)"
if [ "${TP_P2C_BEFORE}" != "128" ]; then
  echo "FAIL [phase 2c]: expected the declared ThroughputCapacity 128 before the removal, got '${TP_P2C_BEFORE}'" >&2
  exit 1
fi
PHASE2C_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_MAINT_ALT="${MAINT_ALT}" CDKD_TEST_TP_REMOVAL=true \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2C_LOG}"
PHASE2C_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2C_RC}" -ne 0 ]; then
  echo "FAIL [phase 2c]: removing ThroughputCapacity failed the deploy (exit ${PHASE2C_RC}); cdkd must leave it in place and warn" >&2
  exit 1
fi
PHASE2C_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2C_LOG}")"
if grep -qF "${TP_OVERCLAIM_NEEDLE}" <<<"${PHASE2C_PLAIN}"; then
  echo "FAIL [phase 2c]: the warning claims CloudFormation keeps a removed ThroughputCapacity on SINGLE_AZ_1, a shape the CFn A/B on #1160 never measured -- the MULTI_AZ_1 gate in src/provisioning/providers/fsx-filesystem-provider.ts (CFN_KEEPS_ON_REMOVAL_FOR_SHAPE) regressed" >&2
  exit 1
fi
if ! grep -qF "${TP_REMOVAL_NEEDLE}" <<<"${PHASE2C_PLAIN}"; then
  if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2C_PLAIN}"; then
    echo "FAIL [phase 2c]: the removal warning fired without the expected wording '${TP_REMOVAL_NEEDLE}' -- the wording drifted and this needle needs updating" >&2
  else
    echo "FAIL [phase 2c]: removing ThroughputCapacity produced no warning (issue #1160: the removal was dropped silently)" >&2
  fi
  exit 1
fi
echo "    deploy warned that ThroughputCapacity is left in place, with no CloudFormation claim"

FS_ID_P2C="$(output_value FileSystemId)"
if [ "${FS_ID_P2B}" != "${FS_ID_P2C}" ]; then
  echo "FAIL: file system was REPLACED in Phase 2c (${FS_ID_P2B} -> ${FS_ID_P2C})" >&2
  exit 1
fi
TP_P2C_AFTER="$(aws fsx describe-file-systems --file-system-ids "${FS_ID_P2C}" --region "${REGION}" \
  --query 'FileSystems[0].OpenZFSConfiguration.ThroughputCapacity' --output text)"
if [ "${TP_P2C_AFTER}" != "${TP_P2C_BEFORE}" ]; then
  echo "FAIL [phase 2c]: expected ThroughputCapacity ${TP_P2C_BEFORE} to stay (cdkd sends no reset), got '${TP_P2C_AFTER}'" >&2
  exit 1
fi
echo "    ThroughputCapacity left in place (${TP_P2C_AFTER})"

# --- Phase 2d: a child volume outside the stack (issue #5431) ------------
# FSx refuses DeleteFileSystem on a file system with child volumes unless it
# carries OpenZFSConfiguration.Options DELETE_CHILD_VOLUMES_AND_SNAPSHOTS,
# which the template declares from Phase 2. The volume is made with the CLI,
# not the stack, so the destroy cannot delete it first.
echo "==> Phase 2d: create child volume ${CHILD_VOLUME_NAME} under ${ROOTVOL_OUT}"
CHILD_VOLUME_ID="$(aws fsx create-volume --volume-type OPENZFS --name "${CHILD_VOLUME_NAME}" \
  --open-zfs-configuration "ParentVolumeId=${ROOTVOL_OUT}" \
  --tags "Key=${CLEANUP_TAG_KEY},Value=${CLEANUP_TAG_VALUE}" \
  --region "${REGION}" --query 'Volume.VolumeId' --output text)"
if [ -z "${CHILD_VOLUME_ID}" ] || [ "${CHILD_VOLUME_ID}" = "None" ]; then
  echo "FAIL [phase 2d]: create-volume returned no volume id" >&2
  exit 1
fi
CHILD_LIFECYCLE=""
CHILD_DEADLINE=$((SECONDS + 900))
while [ ${SECONDS} -lt ${CHILD_DEADLINE} ]; do
  CHILD_LIFECYCLE="$(aws fsx describe-volumes --volume-ids "${CHILD_VOLUME_ID}" --region "${REGION}" \
    --query 'Volumes[0].Lifecycle' --output text)"
  case "${CHILD_LIFECYCLE}" in AVAILABLE | FAILED | MISCONFIGURED) break ;; esac
  sleep 15
done
if [ "${CHILD_LIFECYCLE}" != "AVAILABLE" ]; then
  echo "FAIL [phase 2d]: child volume ${CHILD_VOLUME_ID} did not become AVAILABLE (last '${CHILD_LIFECYCLE}')" >&2
  exit 1
fi
echo "    child volume ${CHILD_VOLUME_ID} is AVAILABLE"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (FSx deletion takes a few minutes)"
DESTROY_LOG="$(mktemp)"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${DESTROY_LOG}"
DESTROY_RC=${PIPESTATUS[0]}
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  # Copied from the pre-fix probe's red run. AWS's own body ("Unable to
  # delete the file system because the file system root volume has child
  # volumes ... DELETE_CHILD_VOLUMES_AND_SNAPSHOTS option has been provided.")
  # shows only under --verbose; cdkd prints the error class.
  if sed 's/\x1b\[[0-9;]*m//g' "${DESTROY_LOG}" | grep -qF "Failed to delete FSx FileSystem Fs: BadRequest"; then
    echo "FAIL [phase 3]: FSx refused to delete the file system with child volume ${CHILD_VOLUME_ID} present (issue #5431: DeleteFileSystem must carry the recorded OpenZFSConfiguration.Options)" >&2
  else
    echo "FAIL [phase 3]: destroy exited ${DESTROY_RC}" >&2
  fi
  exit 1
fi

assert_gone "FSx file system ${FS_ID_P2} still exists after destroy" aws fsx describe-file-systems --file-system-ids "${FS_ID_P2}" --region "${REGION}"
echo "    file system deleted (by id)"
assert_gone "child volume ${CHILD_VOLUME_ID} still exists after destroy" aws fsx describe-volumes --volume-ids "${CHILD_VOLUME_ID}" --region "${REGION}"
echo "    child volume deleted with it"

# DeleteFileSystem keeps the API's final-backup default, as CloudFormation
# does, so a final backup of the file system is expected; it is billed, so the
# run deletes it and asserts none remains (go-to-k/cdkd#5431).
if ! sweep_fs_backups "${FS_ID_P2}" 900; then
  echo "FAIL [phase 3]: an FSx backup of ${FS_ID_P2} is still present after the sweep" >&2
  exit 1
fi
echo "    no backup of ${FS_ID_P2} remains"

LEFTOVERS="$(tagged_fs_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: FSx file system(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no file system with the fixture tag remains"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::FSx::FileSystem OpenZFS variant: deploy + in-place update (incl. tag removal) + clean-drift + top-level removal + ThroughputCapacity removal (#1160) + destroy all passed"
