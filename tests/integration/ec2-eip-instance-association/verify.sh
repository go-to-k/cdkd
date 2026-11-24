#!/usr/bin/env bash
# verify.sh — an Elastic IP associated with a RUNNING instance through its own
# `InstanceId`, in a non-default VPC, destroyed (go-to-k/cdkd#6752).
#
# In a non-default VPC, ReleaseAddress refuses an associated address
# (`InvalidIPAddress.InUse`), and the destroy deletes the EIP before the
# instance it names, so the address is still associated then. The #6715 fix
# disassociates the EIP's own association after that refusal and releases.
#
# Phases:
#   1. Deploy in the default mode. Assert the VPC is
#      not the default one, the instance is running, the address is associated
#      with it, and the EIP record is on the SDK route with the InstanceId the
#      delete reads.
#   2. Destroy with --verbose. Assert the destroy succeeded (before the fix it
#      fails on the InUse refusal, the address left allocated and associated),
#      that cdkd disassociated its own association, and that the address is
#      released, the instance terminated and the VPC and state record gone.
#   3. Deploy again under --no-wait (go-to-k/cdkd#6940, rule 3): the instance's
#      create returns while it is `pending`, and AWS refuses AssociateAddress
#      for an instance that is not running, so the EIP's association waits for
#      the instance's skipped `running` wait. Assert the deploy succeeds, the
#      readiness-wait line names the instance and the EIP, and the address is
#      associated with the instance. Destroy again and assert it gone.
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
export AWS_PAGER=""

STACK="CdkdEc2EipInstanceAssociationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The stack tags the address and the instance with this key (value: STACK).
SWEEP_TAG_KEY="cdkd-integ-6752"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DESTROY_LOG="${TMPDIR:-/tmp}/cdkd-6752-eip-destroy.$$.log"

# Best-effort sweep of the tagged address and instance. `disassociate` runs
# before `state destroy`: a destroy that failed on the association (the
# pre-#6715 binary) leaves it in place, and the same refusal would stop the
# sweep. `release` runs after it, for a survivor whose state record is gone.
sweep_tagged() { # usage: sweep_tagged disassociate|release
  ( set +eu
    case "${STACK}" in
      CdkdEc2Eip?*) ;;
      *)
        echo "    WARN: teardown sweep refused a stack scope outside CdkdEc2Eip*: '${STACK:-<empty>}'" >&2
        exit 0
        ;;
    esac
    # An unreadable listing ends this best-effort sweep (`return` leaves the
    # subshell only).
    rows="$(aws ec2 describe-addresses --region "${REGION}" \
      --filters "Name=tag:${SWEEP_TAG_KEY},Values=${STACK}" \
      --query 'Addresses[].[AllocationId,AssociationId]' --output text 2>/dev/null)" || return 0
    printf '%s\n' "${rows}" | while read -r alloc assoc || [ -n "${alloc}" ]; do
      [ -n "${alloc}" ] || continue
      if [ -n "${assoc}" ] && [ "${assoc}" != "None" ]; then
        aws ec2 disassociate-address --association-id "${assoc}" --region "${REGION}" >/dev/null 2>&1
      fi
      if [ "$1" = "release" ]; then
        aws ec2 release-address --allocation-id "${alloc}" --region "${REGION}" >/dev/null 2>&1
      fi
    done
    if [ "$1" = "release" ]; then
      ids="$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:${SWEEP_TAG_KEY},Values=${STACK}" \
        "Name=instance-state-name,Values=pending,running,stopping,stopped" \
        --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)" || return 0
      if [ -n "${ids}" ] && [ "${ids}" != "None" ]; then
        # shellcheck disable=SC2086
        aws ec2 terminate-instances --instance-ids ${ids} --region "${REGION}" >/dev/null 2>&1
      fi
    fi
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  sweep_tagged disassociate
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  sweep_tagged release
  rm -f "${DESTROY_LOG}"
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

# --- Phase 1: deploy ------------------------------------------------------
# The default mode: Phase 3 covers --no-wait.
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
VPC_ID="$(jq -r '.outputs.VpcId // empty' <<<"${STATE}")"
INSTANCE_ID="$(jq -r '.outputs.InstanceId // empty' <<<"${STATE}")"
ALLOC_ID="$(jq -r '.outputs.AllocationId // empty' <<<"${STATE}")"
EIP_LID="$(jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::EIP") | .key] | if length == 1 then .[0] else empty end' <<<"${STATE}")"
if [ -z "${VPC_ID}" ] || [ -z "${INSTANCE_ID}" ] || [ -z "${ALLOC_ID}" ] || [ -z "${EIP_LID}" ]; then
  echo "FAIL: could not read VpcId '${VPC_ID}', InstanceId '${INSTANCE_ID}', AllocationId '${ALLOC_ID}' or exactly one EIP record '${EIP_LID}' from state" >&2
  exit 1
fi
echo "    VPC ${VPC_ID}, instance ${INSTANCE_ID}, EIP ${EIP_LID} (${ALLOC_ID})"

# The refusal under test is a NON-default VPC's: the default VPC's EC2-Classic
# heritage is not what the fix handles.
IS_DEFAULT="$(aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" \
  --query 'Vpcs[0].IsDefault' --output text)"
if [ "${IS_DEFAULT}" != "False" ]; then
  echo "FAIL: VPC ${VPC_ID} IsDefault is '${IS_DEFAULT}', expected False" >&2
  exit 1
fi
echo "    OK: VPC ${VPC_ID} is not the default VPC"

INSTANCE_STATE="$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [ "${INSTANCE_STATE}" != "running" ]; then
  echo "FAIL: instance ${INSTANCE_ID} is '${INSTANCE_STATE}' after deploy, expected running" >&2
  exit 1
fi
echo "    OK: instance ${INSTANCE_ID} is running"

# The blocker itself: the address is associated with the stack's instance.
ADDR="$(aws ec2 describe-addresses --allocation-ids "${ALLOC_ID}" --region "${REGION}" \
  --query 'Addresses[0].[InstanceId,AssociationId]' --output text)"
ADDR_INSTANCE="$(printf '%s\n' "${ADDR}" | cut -f1)"
ADDR_ASSOC="$(printf '%s\n' "${ADDR}" | cut -f2)"
if [ "${ADDR_INSTANCE}" != "${INSTANCE_ID}" ]; then
  echo "FAIL: EIP ${ALLOC_ID} is associated with '${ADDR_INSTANCE}', expected ${INSTANCE_ID}" >&2
  exit 1
fi
case "${ADDR_ASSOC}" in
  eipassoc-?*) ;;
  *)
    echo "FAIL: EIP ${ALLOC_ID} has association id '${ADDR_ASSOC}', expected an eipassoc- id" >&2
    exit 1
    ;;
esac
echo "    OK: EIP ${ALLOC_ID} is associated with ${INSTANCE_ID} (${ADDR_ASSOC})"

# The fix is in the SDK provider's delete, which reads the recorded InstanceId.
EIP_ROUTE="$(jq -r --arg id "${EIP_LID}" '.resources[$id].provisionedBy // "sdk"' <<<"${STATE}")"
if [ "${EIP_ROUTE}" != "sdk" ]; then
  echo "FAIL: EIP ${EIP_LID} is provisionedBy '${EIP_ROUTE}', expected sdk (the #6715 fix is in the SDK provider)" >&2
  exit 1
fi
EIP_REC_INSTANCE="$(jq -r --arg id "${EIP_LID}" '.resources[$id].properties.InstanceId // empty' <<<"${STATE}")"
if [ "${EIP_REC_INSTANCE}" != "${INSTANCE_ID}" ]; then
  echo "FAIL: the EIP record's InstanceId is '${EIP_REC_INSTANCE}', expected ${INSTANCE_ID}" >&2
  exit 1
fi
echo "    OK: EIP ${EIP_LID} is on the SDK route and records InstanceId ${INSTANCE_ID}"

# --- Phase 2: destroy -----------------------------------------------------
# `--verbose` is load-bearing: the disassociation is announced at debug level.
echo "==> Phase 2: destroy"
DESTROY_RC=0
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force --verbose >"${DESTROY_LOG}" 2>&1 || DESTROY_RC=$?
cat "${DESTROY_LOG}"
DESTROY_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DESTROY_LOG}")"

if [ "${DESTROY_RC}" -ne 0 ]; then
  # Name what is left. Before the fix this is the address, refused with
  # InvalidIPAddress.InUse and still associated with the instance.
  if gone_probe aws ec2 describe-addresses --allocation-ids "${ALLOC_ID}" --region "${REGION}"; then
    LEFT="released"
  elif LEFT_INSTANCE="$(aws ec2 describe-addresses --allocation-ids "${ALLOC_ID}" --region "${REGION}" \
      --query 'Addresses[0].InstanceId' --output text 2>&1)"; then
    LEFT="still allocated, associated with '${LEFT_INSTANCE}'"
  else
    # Keep the FAIL line below: an unreadable association is not this arm's verdict.
    LEFT="still allocated (association unreadable: ${LEFT_INSTANCE})"
  fi
  echo "FAIL: issue #6715 — destroy exited ${DESTROY_RC}; EIP ${ALLOC_ID} is ${LEFT}; InvalidIPAddress.InUse in the log: $(grep -cF 'InvalidIPAddress.InUse' <<<"${DESTROY_PLAIN}" || true)" >&2
  exit 1
fi

# The arm reached the blocker: AWS refused the release and cdkd disassociated
# its own association. The sentinel (the delete's own first line) proves the
# debug channel was captured, so a missing needle is never a quiet log.
EIP_DELETE_SENTINEL="Deleting EIP ${EIP_LID}: "
EIP_DISASSOCIATE_NEEDLE="Disassociating EIP ${EIP_LID} (${ALLOC_ID}) from its instance before release"
if ! grep -qF "${EIP_DELETE_SENTINEL}" <<<"${DESTROY_PLAIN}"; then
  echo "FAIL: the --verbose destroy log has no '${EIP_DELETE_SENTINEL}' line: debug output was not captured or its wording changed" >&2
  exit 1
fi
if ! grep -qF "${EIP_DISASSOCIATE_NEEDLE}" <<<"${DESTROY_PLAIN}"; then
  echo "FAIL: issue #6715 — the destroy released EIP ${ALLOC_ID} without disassociating it first: AWS did not refuse the release, so this arm did not reach the InvalidIPAddress.InUse blocker (or the disassociation line was reworded)" >&2
  exit 1
fi
echo "    OK: cdkd disassociated EIP ${EIP_LID} from its instance before release"

assert_gone "EIP ${ALLOC_ID} is still allocated after destroy" \
  aws ec2 describe-addresses --allocation-ids "${ALLOC_ID}" --region "${REGION}"
echo "    OK: EIP ${ALLOC_ID} is released"

# A terminated instance stays describable for a while; it may also be gone.
INSTANCE_FINAL=""
for _ in $(seq 1 30); do
  if gone_probe aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}"; then
    INSTANCE_FINAL="GONE"
  elif ! INSTANCE_FINAL="$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
      --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1)"; then
    # TOCTOU: the instance can vanish between gone_probe and this requery.
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${INSTANCE_FINAL}" \
      && INSTANCE_FINAL="GONE" \
      || { echo "FAIL: describe-instances requery undetermined: ${INSTANCE_FINAL}" >&2; exit 1; }
  fi
  if [ "${INSTANCE_FINAL}" = "terminated" ] || [ "${INSTANCE_FINAL}" = "GONE" ]; then
    break
  fi
  sleep 10
done
if [ "${INSTANCE_FINAL}" != "terminated" ] && [ "${INSTANCE_FINAL}" != "GONE" ]; then
  echo "FAIL: instance ${INSTANCE_ID} is '${INSTANCE_FINAL}' after destroy, expected terminated" >&2
  exit 1
fi
echo "    OK: instance ${INSTANCE_ID} is ${INSTANCE_FINAL}"

assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC ${VPC_ID} is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Phase 3: deploy under --no-wait (go-to-k/cdkd#6940, rule 3) ---------
echo "==> Phase 3: deploy --no-wait"
NO_WAIT_LOG="$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes --no-wait 2>&1)" || {
  printf '%s\n' "${NO_WAIT_LOG}"
  echo "FAIL: the --no-wait deploy failed" >&2
  exit 1
}
printf '%s\n' "${NO_WAIT_LOG}"
NO_WAIT_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' <<<"${NO_WAIT_LOG}")"
if ! grep -qE '\(AWS::EC2::Instance\), whose readiness wait --no-wait skipped: Elastic IP [A-Za-z0-9]+ is associated with it' <<<"${NO_WAIT_PLAIN}"; then
  echo "FAIL: no readiness-wait line for the instance before the EIP's association" >&2
  exit 1
fi
if grep -qF 'was NOT associated with' <<<"${NO_WAIT_PLAIN}"; then
  echo "FAIL: the EIP's association was skipped under --no-wait" >&2
  exit 1
fi
echo "    OK: the EIP's association waited for the instance --no-wait had not waited for"
STATE3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
INSTANCE3="$(jq -r '.outputs.InstanceId // empty' <<<"${STATE3}")"
ALLOC3="$(jq -r '.outputs.AllocationId // empty' <<<"${STATE3}")"
VPC3="$(jq -r '.outputs.VpcId // empty' <<<"${STATE3}")"
if [ -z "${INSTANCE3}" ] || [ -z "${ALLOC3}" ] || [ -z "${VPC3}" ]; then
  echo "FAIL: could not read InstanceId '${INSTANCE3}', AllocationId '${ALLOC3}' or VpcId '${VPC3}' after the --no-wait deploy" >&2
  exit 1
fi
ADDR3_INSTANCE="$(aws ec2 describe-addresses --allocation-ids "${ALLOC3}" --region "${REGION}" \
  --query 'Addresses[0].InstanceId' --output text)"
if [ "${ADDR3_INSTANCE}" != "${INSTANCE3}" ]; then
  echo "FAIL: after the --no-wait deploy EIP ${ALLOC3} is associated with '${ADDR3_INSTANCE}', expected ${INSTANCE3}" >&2
  exit 1
fi
echo "    OK: EIP ${ALLOC3} is associated with ${INSTANCE3}"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
assert_gone "EIP ${ALLOC3} is still allocated after the Phase 3 destroy" \
  aws ec2 describe-addresses --allocation-ids "${ALLOC3}" --region "${REGION}"
assert_gone "VPC ${VPC3} still exists after the Phase 3 destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC3}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the Phase 3 destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: Phase 3 address, VPC and state gone"

rm -f "${DESTROY_LOG}"
trap - EXIT INT TERM

echo ""
echo "[verify] PASS — ec2-eip-instance-association: an EIP associated with a running instance in a non-default VPC was disassociated, released and its instance terminated on destroy (issue #6752), and under --no-wait the association waited for the instance (issue #6940)"
