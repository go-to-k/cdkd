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
#   2c. Fix-forward of a failed CREATE (issue #4606): a `--no-rollback`
#      deploy adding OrphanFs (INJECT_FS_ORPHAN=true) runs under a role this
#      script creates, denied fsx:DescribeFileSystems and fsx:DeleteFileSystem:
#      CreateFileSystem succeeds, the wait and the cleanup delete are refused,
#      and the journal holds the file system as a proven orphan. The
#      FS_FIX_FORWARD=true redeploy (as the caller, another security group so
#      FSx makes a NEW file system) succeeds, deletes the earlier one, keeps
#      the new one and exits 0. A plain deploy then removes OrphanFs.
#   3. Destroy + assert the file system is GONE from AWS (by id AND by the
#      fixture's constant tag — an FSx file system bills per hour, so a
#      leftover is never acceptable) and the cdkd state file is removed.
#
# NOTE: FSx Lustre creation takes ~5-10 minutes and deletion a few more —
# expect a total wall clock of 45-60 minutes (Phase 2c creates two more).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# The caller also needs iam:CreateRole / PutRolePolicy / DeleteRolePolicy /
# DeleteRole / ListRoles / ListRoleTags and sts:AssumeRole on the role Phase 2c
# creates.

set -euo pipefail
# Phase 2c's switches: set only by its own deploys.
unset INJECT_FS_ORPHAN FS_FIX_FORWARD

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
FF_LOG=""
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
# Phase 2c's deny role is this run's own, and the sweep finds any run's by the
# literal prefix.
DENY_ROLE="cdkd-fsx-orphan-deny-$(date +%s)-$$"
DENY_POLICY_NAME="cdkd-fsx-orphan-deny"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# List file system ids carrying the fixture's constant tag.
tagged_fs_ids() {
  aws fsx describe-file-systems --region "${REGION}" \
    --query "FileSystems[?Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']].FileSystemId" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

# Delete a file system and wait until it is gone, re-sending the delete until
# FSx has it DELETING: a file system still CREATING (a Phase 2c OrphanFs, or
# Phase 1's Fs when a FAIL fires early) can refuse the first delete, and one
# send would then leave it billing.
delete_fs_until_gone() {
  local fs_id="$1"
  local out lifecycle
  local deadline=$((SECONDS + 1800))
  while [ ${SECONDS} -lt ${deadline} ]; do
    if ! out="$(aws fsx describe-file-systems --file-system-ids "${fs_id}" \
      --region "${REGION}" --query 'FileSystems[0].Lifecycle' --output text 2>&1)"; then
      # Strict gone-check (#1097 pattern 2): only a not-found error means the
      # file system is gone; on any other failure (throttle) keep waiting.
      if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
        return 0
      fi
    else
      lifecycle="${out}"
      if [ "${lifecycle}" != "DELETING" ]; then
        aws fsx delete-file-system --file-system-id "${fs_id}" --region "${REGION}" >/dev/null 2>&1
      fi
    fi
    sleep 15
  done
  echo "    WARN: FSx file system ${fs_id} is still not gone after 30 minutes; delete it by hand to stop billing" >&2
  return 1
}

# Delete one Phase 2c deny role by name. Idempotent and soft-failing.
delete_deny_role() { # usage: delete_deny_role <role-name>
  (
    # Best-effort, in a subshell: the caller's errexit is untouched.
    set +eu
    aws iam delete-role-policy --role-name "$1" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
    if aws iam delete-role --role-name "$1" >/dev/null 2>&1; then
      echo "    deleted deny role $1"
    fi
  )
}

# Delete Phase 2c deny roles an earlier run left behind (a SIGKILL skips the
# trap): only roles with the literal prefix, carrying the fixture's tag, and
# created more than 2 hours ago -- their trust policy has expired by then
# (`DateLessThan`), so a concurrent run's live role is never one of them.
sweep_stale_deny_roles() {
  (
    set +eu
    cutoff="$(node -e 'process.stdout.write(new Date(Date.now()-2*3600e3).toISOString().slice(0,19))')"
    aws iam list-roles \
      --query "Roles[?starts_with(RoleName, 'cdkd-fsx-orphan-deny-')].[RoleName,CreateDate]" \
      --output text 2>/dev/null | while read -r r created; do
      [ -z "${r}" ] || [ "${r}" = "None" ] && continue
      # ISO-8601 UTC sorts lexically; compare to the second.
      [[ "${created:0:19}" < "${cutoff}" ]] || continue
      tagged="$(aws iam list-role-tags --role-name "${r}" \
        --query "Tags[?Key=='cdkd-integ' && Value=='fsx-lustre'] | length(@)" --output text 2>/dev/null)"
      [ "${tagged}" = "1" ] || continue
      delete_deny_role "${r}"
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${PHASE2_LOG:-}" ] && rm -f "${PHASE2_LOG}"
  [ -n "${PHASE2B_LOG:-}" ] && rm -f "${PHASE2B_LOG}"
  [ -n "${FF_LOG:-}" ] && rm -f "${FF_LOG}" "${FF_LOG}.id-err"
  # Only THIS run's role: another run's may be live.
  delete_deny_role "${DENY_ROLE}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete any leftover file system carrying the fixture's constant tag and
  # wait until it is gone (its ENIs block the VPC teardown below).
  for fsid in $(tagged_fs_ids); do
    echo "    deleting leftover FSx file system ${fsid}"
    delete_fs_until_gone "${fsid}"
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
    # Phase 2c's journal: its file system was swept by tag above.
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
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
sweep_stale_deny_roles
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

# --- Phase 2c: the fix-forward of a failed CREATE (go-to-k/cdkd#4606) -------
# A `--no-rollback` deploy whose CREATE fails after FSx made the file system,
# and whose cleanup delete fails too, journals it as a proven orphan. The
# fix-forward redeploy keeps the logical id, so the CREATE succeeds and a
# record under that id holds a NEW file system.
# `FSxFileSystemProvider.isSameResource` proves the earlier one is another
# file system: the deploy deletes it, keeps the new one, exits 0 and drops the
# journal. Before #4606 it warned, named the earlier one, exited 2 and left it
# billing. Every deploy here carries Phase 2b's switches, so `Fs` is unchanged.
P2B_ENV=(CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true "CDKD_TEST_MAINT_ALT=${MAINT_ALT}")
FF_LOG="$(mktemp)"

# The journal's failed operation for a logical id (compact JSON, empty if none).
journal_op() { # usage: journal_op <logical-id> <when>
  local body
  if ! body="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"; then
    echo "FAIL: no rollback journal $2" >&2
    exit 1
  fi
  printf '%s' "${body}" | jq -c --arg id "$1" \
    '[.segments[]?.failedOperations[]? | select(.logicalId == $id)] | last // empty'
}

state_physical_id() { # usage: state_physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "$1" '.resources[$id].physicalId // "<absent>"'
}

fs_lifecycle() { # usage: fs_lifecycle <file-system-id>
  aws fsx describe-file-systems --file-system-ids "$1" --region "${REGION}" \
    --query 'FileSystems[0].Lifecycle' --output text
}

echo "==> Phase 2c: a role denied fsx:DescribeFileSystems and fsx:DeleteFileSystem"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
if [ -z "${ACCOUNT_ID}" ] || [ -z "${CALLER_USERID}" ]; then
  echo "FAIL: precondition — account '${ACCOUNT_ID}' or caller '${CALLER_USERID}' is empty" >&2
  exit 1
fi
# Assumable by THIS caller identity only, not by the whole account, and only
# for 2 hours: a role a SIGKILL leaves behind (no trap) expires on its own.
TRUST="$(node -e 'const until=new Date(Date.now()+2*3600e3).toISOString().replace(/\.\d{3}Z$/,"Z");process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]},DateLessThan:{"aws:CurrentTime":until}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this stack's deploy calls, never `*`: the role is assumable by
# the caller for minutes, and an inline `Allow *` would hand it more than the
# caller may have (IAM included). The FSx service-linked role exists since
# Phase 1; creating it is allowed only for FSx in case FSx asks anyway.
DENY_POLICY="$(node -e 'const [bucket]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"s3:*",Resource:[`arn:aws:s3:::${bucket}`,`arn:aws:s3:::${bucket}/*`]},{Effect:"Allow",Action:["ec2:*","fsx:*","cloudformation:*","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Allow",Action:"iam:CreateServiceLinkedRole",Resource:"*",Condition:{StringLike:{"iam:AWSServiceName":"*fsx.amazonaws.com"}}},{Effect:"Deny",Action:["fsx:DescribeFileSystems","fsx:DeleteFileSystem"],Resource:"*"}]}))' "${STATE_BUCKET}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=fsx-lustre >/dev/null
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-fsx-orphan \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "FAIL: precondition — could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the deny role, in a subshell that EXPORTS the keys: on an
# `env` argv they would be readable in `ps`. A profile in the environment would
# win over the key variables in the SDK's credential chain, so it is dropped.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    "$@"
  )
}
# Credentials from assuming a role created seconds ago can be refused for a
# while, so poll until STS accepts them; the last refusal is named if it never
# does.
DENY_ARN=""
deny_id_err=""
for _ in $(seq 1 24); do
  if DENY_ARN="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${FF_LOG}.id-err")"; then
    break
  fi
  DENY_ARN=""
  deny_id_err="$(cat "${FF_LOG}.id-err" 2>/dev/null || true)"
  sleep 5
done
rm -f "${FF_LOG}.id-err"
if [ -z "${DENY_ARN}" ]; then
  echo "FAIL: precondition — STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${deny_id_err})" >&2
  exit 1
fi
case "${DENY_ARN}" in
  *":assumed-role/${DENY_ROLE}/"*) ;;
  *)
    echo "FAIL: precondition — the deny-role commands run as '${DENY_ARN}', not ${DENY_ROLE}" >&2
    exit 1
    ;;
esac
# The deny must be IN FORCE before the deploy, or the wait reads the file
# system and the arm never journals it. Two EXPLICIT denials in a row, since
# IAM propagation is eventually consistent: a role whose allow has not
# propagated yet is denied implicitly, which must not count. The ALLOW must be
# in force too (the state read is the deploy's first call).
denied=0
ready=0
probe_out=""
for _ in $(seq 1 36); do
  if probe_out="$(as_deny_role aws fsx describe-file-systems --region "${REGION}" \
    --file-system-ids "${FS_ID_P2B}" 2>&1)"; then
    denied=0
  elif grep -qi 'explicit deny' <<<"${probe_out}"; then
    denied=$((denied + 1))
    if [ "${denied}" -ge 2 ] && as_deny_role aws s3api head-object --bucket "${STATE_BUCKET}" \
      --key "${STATE_KEY}" >/dev/null 2>&1; then
      ready=1
      break
    fi
  else
    denied=0
  fi
  sleep 5
done
if [ "${ready}" -ne 1 ]; then
  echo "FAIL: precondition — after 3 minutes ${DENY_ROLE} is not both explicitly denied DescribeFileSystems (${denied} consecutive) and able to read the state file (last answer: ${probe_out})" >&2
  exit 1
fi
echo "    ${DENY_ROLE} is denied fsx:DescribeFileSystems"

echo "==> Phase 2c: --no-rollback deploy as ${DENY_ROLE} whose OrphanFs CREATE fails after CreateFileSystem"
set +e
as_deny_role env "${P2B_ENV[@]}" INJECT_FS_ORPHAN=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback >"${FF_LOG}" 2>&1
FS_FAIL_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
# The role's job is done: from here every call is the caller's. Only THIS
# run's role; the prefix sweep is the exit trap's backstop.
aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null
aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null
echo "    deleted deny role ${DENY_ROLE}"
if [ "${FS_FAIL_RC}" -eq 0 ]; then
  echo "FAIL: the OrphanFs injection deploy unexpectedly SUCCEEDED (the role is denied DescribeFileSystems)" >&2
  exit 1
fi
# Assigned first: a failed read inside `[ ... ]` would escape `set -e` and
# read as a record.
INJECTED_FS_RECORD="$(state_physical_id OrphanFs)"
if [ "${INJECTED_FS_RECORD}" != "<absent>" ]; then
  echo "FAIL: state records OrphanFs as '${INJECTED_FS_RECORD}' after a CREATE that threw (expected no record)" >&2
  exit 1
fi
ORPHAN_OP="$(journal_op OrphanFs 'after the --no-rollback deploy of Phase 2c')"
if [ -z "${ORPHAN_OP}" ] || [ "$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ]; then
  echo "FAIL: the journal does not carry OrphanFs as a proven orphan after the --no-rollback deploy of Phase 2c (op: ${ORPHAN_OP:-<none>})" >&2
  exit 1
fi
ORPHAN_FS_ID="$(printf '%s' "${ORPHAN_OP}" | jq -r '.physicalId // ""')"
case "${ORPHAN_FS_ID}" in fs-*) ;; *) echo "FAIL: journaled OrphanFs id is not a file system id: '${ORPHAN_FS_ID}'" >&2; exit 1;; esac
# The settle's delete needs a file system FSx will delete, and the arm
# discriminates only while the earlier one is still in AWS: wait for the
# create the injection started to finish.
ORPHAN_FS_STATE=""
for _ in $(seq 1 120); do
  ORPHAN_FS_STATE="$(fs_lifecycle "${ORPHAN_FS_ID}")"
  [ "${ORPHAN_FS_STATE}" = "CREATING" ] || break
  sleep 15
done
if [ "${ORPHAN_FS_STATE}" != "AVAILABLE" ]; then
  echo "FAIL: the journaled ${ORPHAN_FS_ID} is '${ORPHAN_FS_STATE}' before the fix-forward, expected AVAILABLE" >&2
  exit 1
fi
echo "    OK: OrphanFs ${ORPHAN_FS_ID} (${ORPHAN_FS_STATE}) is journaled as a proven orphan, no state record"

echo "==> Phase 2c: the fix-forward deploy (same logical id, another security group; ~5-10 min)"
set +e
env "${P2B_ENV[@]}" INJECT_FS_ORPHAN=true FS_FIX_FORWARD=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FF_LOG}" 2>&1
FS_FF_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
if [ "${FS_FF_RC}" -ne 0 ]; then
  echo "FAIL: the OrphanFs fix-forward deploy exited ${FS_FF_RC} (expected 0: the earlier attempt is proven another file system and deleted -- output above)" >&2
  echo "      (before go-to-k/cdkd#4606 it exited 2 and left the earlier OrphanFs)" >&2
  exit 1
fi
if ! grep -q "deleting partially-created OrphanFs" "${FF_LOG}"; then
  echo "FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanFs (output above)" >&2
  exit 1
fi
if grep -q "Skipping failed CREATE of OrphanFs" "${FF_LOG}"; then
  echo "FAIL: the fix-forward deploy still warned about the earlier OrphanFs instead of deleting it (output above)" >&2
  exit 1
fi
assert_gone "rollback journal s3://${STATE_BUCKET}/${JOURNAL_KEY} still present after the OrphanFs fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_gone "the earlier attempt's ${ORPHAN_FS_ID} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws fsx describe-file-systems --file-system-ids "${ORPHAN_FS_ID}" --region "${REGION}"
FF_FS_ID="$(state_physical_id OrphanFs)"
case "${FF_FS_ID}" in fs-*) ;; *) echo "FAIL: state records OrphanFs as '${FF_FS_ID}' after the fix-forward (expected a file system id)" >&2; exit 1;; esac
if [ "${FF_FS_ID}" = "${ORPHAN_FS_ID}" ]; then
  echo "FAIL: state records OrphanFs as the earlier attempt's ${ORPHAN_FS_ID}" >&2
  exit 1
fi
# The new file system is the record's: deleting the earlier one must not touch it.
FF_FS_STATE="$(fs_lifecycle "${FF_FS_ID}")"
if [ "${FF_FS_STATE}" != "AVAILABLE" ]; then
  echo "FAIL: the fix-forward file system ${FF_FS_ID} is ${FF_FS_STATE} (expected AVAILABLE -- the settle must not delete the record's file system)" >&2
  exit 1
fi
echo "    OK: the fix-forward deleted ${ORPHAN_FS_ID}, kept ${FF_FS_ID}, exited 0 and dropped the journal"

# The fix-forward file system is a normal state resource: the next plain
# deploy removes it (and OrphanFsSg) from the template and deletes it.
echo "==> Phase 2c: plain deploy removing OrphanFs"
env "${P2B_ENV[@]}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "the fix-forward ${FF_FS_ID} still exists after the deploy that removed it" \
  aws fsx describe-file-systems --file-system-ids "${FF_FS_ID}" --region "${REGION}"
rm -f "${FF_LOG}"
echo "    OK: Phase 2c passed"

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
