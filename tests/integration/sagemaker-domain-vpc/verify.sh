#!/usr/bin/env bash
# verify.sh — cdkd SageMaker domain VpcId change (go-to-k/cdkd#7126).
#
# CloudFormation replaces an AWS::SageMaker::Domain on a VpcId change; Cloud
# Control refuses it in place (NotUpdatable). The type is stateful, so cdkd
# plans the replacement and refuses it before any call without
# --force-stateful-recreation. DomainName is required and create-only, so with
# the flag the create-first replacement collides with the domain keeping the
# name, and cdkd refuses that too, deleting nothing (CloudFormation's execution
# failed the same way, AlreadyExists).
#
# Phases:
#   1. Deploy the domain in the account's default VPC. Assert it is InService
#      there, and record its id and home EFS.
#   2. Re-deploy with CDKD_TEST_VPC_MOVE=true (VpcId -> the stack's second VPC):
#      2a. WITHOUT --force-stateful-recreation: refused before any call, naming
#          Domain, VpcId, the CloudFormation measurement and the flag. Never the
#          pre-fix in-place update Cloud Control refuses (NotUpdatable).
#      2b. WITH the flag: the create-first replacement collides on DomainName
#          and is refused, deleting nothing.
#      Each: the domain keeps its id and VPC, and no second domain exists.
#   3. Destroy. Assert the domain and the state are gone, then sweep the home
#      EFS and the two NFS security groups SageMaker leaves behind.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdSageMakerDomainVpcExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Per run, so the cleanup's by-name sweep only ever finds this run's domains.
DOMAIN_NAME="cdkd-integ-sm-dvpc-$(date +%s)-$$"
export CDKD_TEST_DOMAIN_NAME="${DOMAIN_NAME}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The ids of every domain named DOMAIN_NAME, one per word. No `| [0]` or
# `length()`: the CLI applies --query per page.
domain_ids() {
  local out
  out="$(aws sagemaker list-domains --region "${REGION}" \
    --query "Domains[?DomainName=='${DOMAIN_NAME}'].DomainId" --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' | grep '^d-' || true
}

# "<id>\t<status>\t<vpc>" of the domain named DOMAIN_NAME, or empty.
domain_row() {
  local ids id
  ids="$(domain_ids)" || return 1
  id="${ids%%$'\n'*}"
  case "${id}" in
    d-?*) aws sagemaker describe-domain --domain-id "${id}" --region "${REGION}" \
      --query '[DomainId,Status,VpcId]' --output text ;;
  esac
}

domain_count() {
  local ids
  ids="$(domain_ids)" || return 1
  printf '%s\n' "${ids}" | grep -c '^d-' || true
}

# Deletes a domain's leftover home EFS (mount targets first) and the two
# security groups SageMaker made for it. Each id is guarded: an empty one
# would match every file system or group.
sweep_domain_leftovers() { ( # usage: sweep_domain_leftovers <domain-id> <efs-id>
  set +eu
  dom="$1" efs="$2"
  case "${dom}" in
    d-?*) ;;
    *) echo "    WARN: teardown sweep refused a domain id outside d-*: '${dom:-<empty>}'" >&2
       exit 0 ;;
  esac
  case "${efs}" in
    fs-?*)
      for mt in $(aws efs describe-mount-targets --file-system-id "${efs}" --region "${REGION}" \
        --query 'MountTargets[].MountTargetId' --output text 2>/dev/null); do
        aws efs delete-mount-target --mount-target-id "${mt}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      for i in $(seq 1 30); do
        n="$(aws efs describe-mount-targets --file-system-id "${efs}" --region "${REGION}" \
          --query 'length(MountTargets)' --output text 2>/dev/null)"
        [ "${n}" = "0" ] && break
        sleep 10
      done
      aws efs delete-file-system --file-system-id "${efs}" --region "${REGION}" >/dev/null 2>&1 || true
      ;;
    *) echo "    WARN: teardown sweep refused an EFS id outside fs-*: '${efs:-<empty>}'" >&2 ;;
  esac
  # The inbound group allows the outbound one: revoke both sides first.
  sgs="$(aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=group-name,Values=security-group-for-inbound-nfs-${dom},security-group-for-outbound-nfs-${dom}" \
    --query 'SecurityGroups[].GroupId' --output text 2>/dev/null)"
  for sg in ${sgs}; do
    perms="$(aws ec2 describe-security-groups --group-ids "${sg}" --region "${REGION}" \
      --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null)"
    [ -n "${perms}" ] && [ "${perms}" != "[]" ] \
      && aws ec2 revoke-security-group-ingress --group-id "${sg}" --ip-permissions "${perms}" --region "${REGION}" >/dev/null 2>&1
    perms="$(aws ec2 describe-security-groups --group-ids "${sg}" --region "${REGION}" \
      --query 'SecurityGroups[0].IpPermissionsEgress' --output json 2>/dev/null)"
    [ -n "${perms}" ] && [ "${perms}" != "[]" ] \
      && aws ec2 revoke-security-group-egress --group-id "${sg}" --ip-permissions "${perms}" --region "${REGION}" >/dev/null 2>&1
  done
  for sg in ${sgs}; do
    for i in $(seq 1 12); do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1 && break
      sleep 10
    done
  done
) }

wait_domain_gone() { # usage: wait_domain_gone <domain-id>
  local i
  for i in $(seq 1 60); do
    gone_probe aws sagemaker describe-domain --domain-id "$1" --region "${REGION}" && return 0
    sleep 10
  done
  return 1
}

DOMAIN_ID=""
EFS_ID=""

cdkd_state_destroy() {
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Every live domain under the name, read BEFORE `state destroy` (which may
  # delete one and leave its EFS and groups with no id to find them by).
  local id efs pairs=""
  for id in $(domain_ids 2>/dev/null); do
    efs="$(aws sagemaker describe-domain --domain-id "${id}" --region "${REGION}" \
      --query HomeEfsFileSystemId --output text 2>/dev/null)"
    pairs="${pairs} ${id}:${efs}"
  done
  cdkd_state_destroy
  for pair in ${pairs}; do
    id="${pair%%:*}"
    efs="${pair#*:}"
    aws sagemaker delete-domain --domain-id "${id}" --region "${REGION}" \
      --retention-policy HomeEfsFileSystem=Delete >/dev/null 2>&1
    # In a subshell: gone_probe exits on an undetermined probe.
    ( wait_domain_gone "${id}" ) >/dev/null 2>&1
    sweep_domain_leftovers "${id}" "${efs}"
  done
  # A domain this run deleted itself (destroy) leaves its EFS and groups.
  [ -n "${DOMAIN_ID}" ] && sweep_domain_leftovers "${DOMAIN_ID}" "${EFS_ID}"
  # Again, now the sweep is done: a domain a replacement put in the stack's
  # target VPC leaves an EFS and groups there that block that VPC's delete
  # in the first pass.
  [ -n "${pairs}" ] && cdkd_state_destroy
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

DEFAULT_VPC="$(aws ec2 describe-vpcs --region "${REGION}" --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
case "${DEFAULT_VPC}" in
  vpc-?*) ;;
  *) echo "FAIL: #7126 premise: no default VPC in ${REGION} (got '${DEFAULT_VPC}')" >&2
     exit 1 ;;
esac
DEFAULT_SUBNET="$(aws ec2 describe-subnets --region "${REGION}" \
  --filters "Name=vpc-id,Values=${DEFAULT_VPC}" Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)"
case "${DEFAULT_SUBNET}" in
  subnet-?*) ;;
  *) echo "FAIL: #7126 premise: no default subnet in ${DEFAULT_VPC} (got '${DEFAULT_SUBNET}')" >&2
     exit 1 ;;
esac
export CDKD_TEST_DEFAULT_VPC_ID="${DEFAULT_VPC}" CDKD_TEST_DEFAULT_SUBNET_ID="${DEFAULT_SUBNET}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy in the default VPC -------------------------------
echo "==> Phase 1: deploy the domain in the default VPC ${DEFAULT_VPC}"
env -u CDKD_TEST_VPC_MOVE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

read -r DOMAIN_ID P1_STATUS P1_VPC <<<"$(domain_row)"
case "${DOMAIN_ID}" in
  d-?*) ;;
  *) echo "FAIL: domain ${DOMAIN_NAME} not found after Phase 1" >&2
     exit 1 ;;
esac
if [ "${P1_STATUS}" != "InService" ] || [ "${P1_VPC}" != "${DEFAULT_VPC}" ]; then
  echo "FAIL: domain ${DOMAIN_ID} is '${P1_STATUS}' in '${P1_VPC}' after Phase 1 (expected InService in ${DEFAULT_VPC})" >&2
  exit 1
fi
EFS_ID="$(aws sagemaker describe-domain --domain-id "${DOMAIN_ID}" --region "${REGION}" \
  --query HomeEfsFileSystemId --output text)"
# Premises of the leftover sweep: the home EFS and the two NFS groups it names.
case "${EFS_ID}" in
  fs-?*) ;;
  *) echo "FAIL: #7126 premise: domain ${DOMAIN_ID} reports no home EFS (got '${EFS_ID}')" >&2
     exit 1 ;;
esac
NFS_SGS="$(aws ec2 describe-security-groups --region "${REGION}" \
  --filters "Name=group-name,Values=security-group-for-inbound-nfs-${DOMAIN_ID},security-group-for-outbound-nfs-${DOMAIN_ID}" \
  --query 'SecurityGroups[].GroupId' --output text)"
NFS_SG_COUNT="$(printf '%s\n' "${NFS_SGS}" | tr '\t' '\n' | grep -c '^sg-' || true)"
if [ "${NFS_SG_COUNT}" != "2" ]; then
  echo "FAIL: #7126 premise: ${NFS_SG_COUNT} NFS security groups named for ${DOMAIN_ID} (expected 2: the sweep would miss them)" >&2
  exit 1
fi
echo "    domain ${DOMAIN_ID} InService in ${DEFAULT_VPC} (home EFS ${EFS_ID})"

# The domain keeps its id and VPC, and no second domain holds the name.
assert_domain_untouched() { # usage: assert_domain_untouched <phase>
  local id status vpc count
  read -r id status vpc <<<"$(domain_row)"
  if [ "${id}" != "${DOMAIN_ID}" ] || [ "${vpc}" != "${DEFAULT_VPC}" ]; then
    echo "FAIL: #7126 ($1): the refused deploy changed the domain (id '${id}', VPC '${vpc}'; expected ${DOMAIN_ID} in ${DEFAULT_VPC})" >&2
    exit 1
  fi
  count="$(domain_count)"
  if [ "${count}" != "1" ]; then
    echo "FAIL: #7126 ($1): ${count} domains named ${DOMAIN_NAME} after the refused deploy (expected 1)" >&2
    exit 1
  fi
}

# --- Phase 2a: move the VPC without the flag ---------------------------
echo "==> Phase 2a: the VpcId change WITHOUT --force-stateful-recreation (#7126)"
P2A_LOG="$(mktemp)"
set +e
CDKD_TEST_VPC_MOVE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${P2A_LOG}"
P2A_RC=${PIPESTATUS[0]}
set -e
# The pre-fix shape: an in-place update Cloud Control refuses.
if grep -qE 'NotUpdatable|VpcId change requires replacement' "${P2A_LOG}"; then
  echo "FAIL: #7126: the VpcId change was sent as an in-place update (Cloud Control refused it) instead of a replacement" >&2
  exit 1
fi
if [ "${P2A_RC}" -eq 0 ]; then
  echo "FAIL: #7126: the VpcId change deployed without --force-stateful-recreation (the stateful replacement gate did not refuse)" >&2
  exit 1
fi
if ! grep -qE 'Domain.*requires replacement.*VpcId' "${P2A_LOG}" \
  || ! grep -qF 'CloudFormation was measured replacing it on a VpcId change, and failing that replacement on the DomainName it keeps' "${P2A_LOG}" \
  || ! grep -qF -- '--force-stateful-recreation' "${P2A_LOG}"; then
  echo "FAIL: #7126: the deploy exited ${P2A_RC} without the stateful refusal naming Domain, VpcId, the CloudFormation measurement and --force-stateful-recreation" >&2
  exit 1
fi
assert_domain_untouched 2a
echo "    refused without the flag; domain ${DOMAIN_ID} untouched"

# --- Phase 2b: the same move with the flag -----------------------------
echo "==> Phase 2b: the VpcId change WITH --force-stateful-recreation (#7126)"
P2B_LOG="$(mktemp)"
set +e
CDKD_TEST_VPC_MOVE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force-stateful-recreation 2>&1 | tee "${P2B_LOG}"
P2B_RC=${PIPESTATUS[0]}
set -e
if grep -qE 'NotUpdatable|VpcId change requires replacement' "${P2B_LOG}"; then
  echo "FAIL: #7126: with the flag, the VpcId change was sent as an in-place update instead of a replacement" >&2
  exit 1
fi
if [ "${P2B_RC}" -eq 0 ]; then
  echo "FAIL: #7126: with the flag, the VpcId replacement deployed although DomainName is kept (expected the create-first collision)" >&2
  exit 1
fi
# create-first.ts's refusal when cdkd cannot prove the old domain holds the
# name (the type has no name key): it deletes nothing under any flag. Not the
# Retain branch: the fixture's policy is Delete.
if ! grep -qF 'requires replacement, but the create-first attempt collided' "${P2B_LOG}" \
  || ! grep -qF 'Nothing was deleted' "${P2B_LOG}"; then
  echo "FAIL: #7126: with the flag, the deploy exited ${P2B_RC} without the create-first collision refusal for DomainName" >&2
  exit 1
fi
assert_domain_untouched 2b
echo "    refused with the flag (DomainName collision); domain ${DOMAIN_ID} untouched"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if ! wait_domain_gone "${DOMAIN_ID}"; then
  echo "FAIL: domain ${DOMAIN_ID} still exists 10 minutes after destroy" >&2
  exit 1
fi
echo "    domain deleted"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "==> Sweeping the home EFS and NFS security groups the domain left"
sweep_domain_leftovers "${DOMAIN_ID}" "${EFS_ID}"
case "${EFS_ID}" in
  fs-?*)
    for i in $(seq 1 30); do
      gone_probe aws efs describe-file-systems --file-system-id "${EFS_ID}" --region "${REGION}" && break
      sleep 10
    done
    assert_gone "home EFS ${EFS_ID} still exists after the sweep" \
      aws efs describe-file-systems --file-system-id "${EFS_ID}" --region "${REGION}"
    ;;
esac
LEFT_SGS="$(aws ec2 describe-security-groups --region "${REGION}" \
  --filters "Name=group-name,Values=security-group-for-inbound-nfs-${DOMAIN_ID},security-group-for-outbound-nfs-${DOMAIN_ID}" \
  --query 'SecurityGroups[].GroupId' --output text)"
if [ -n "${LEFT_SGS}" ]; then
  echo "FAIL: NFS security groups of ${DOMAIN_ID} still exist after the sweep: ${LEFT_SGS}" >&2
  exit 1
fi
echo "    leftovers swept"

echo "[verify] PASS — a SageMaker domain VpcId change is a stateful replacement refused without --force-stateful-recreation, refused with it on the kept DomainName, and destroy is clean (#7126)"
