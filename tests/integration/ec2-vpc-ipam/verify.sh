#!/usr/bin/env bash
# verify.sh - cdkd AWS::EC2::VPC with its CIDR allocated from an IPAM pool
# (issue #5633).
#
# Phases:
#   0. Pre-flight: the region must hold NO IPAM. An account has one IPAM per
#      region, and this fixture creates one, so it refuses to run beside an
#      existing IPAM rather than adopt, collide with or delete it.
#   1. Deploy, in two steps. 1a deploys the IPAM, its pool, the VPC and a
#      second VPC with a declared CIDR (SubnetVpc); the run then waits
#      (polling get-ipam-resource-cidrs, up to 30 minutes) until IPAM monitors
#      SubnetVpc, since EC2 refuses a pool sourced from a VPC it does not yet
#      monitor ("The source resource vpc-... is not monitored in the IPAM
#      scope."), and prints the measured lag (556 s on 2026-11-07). 1b adds a
#      planning pool sourced from SubnetVpc, a subnet pool carved from it, and
#      the subnet (CDKD_IPAM_WITH_SUBNET=true, kept for every later step).
#      The VPC declares Ipv4IpamPoolId + Ipv4NetmaskLength and no
#      CidrBlock. Assert it was provisioned by the SDK provider (before #5633
#      both properties routed it to Cloud Control), that its CIDR is a /28
#      inside the pool's 10.240.0.0/16 and is this pool's allocation for this
#      VPC, and that the VpcCidr Output (Fn::GetAtt Vpc.CidrBlock) equals it.
#      go-to-k/cdkd#5632: the same for the subnet, which takes a /28 of the
#      subnet pool's 10.241.0.0/24 in SubnetVpc, in the zone its
#      AvailabilityZoneId names; its SubnetCidr / SubnetAzId Outputs
#      (Fn::GetAtt) must equal what EC2 reports.
#      Then `cdkd drift` must report the VPC and the subnet compared and clean.
#   2. CDKD_TEST_UPDATE=true adds a tag to the VPC and the subnet: in-place
#      updates. Assert the same ids, the tags on AWS, and that the recorded
#      CidrBlock attributes (the VpcCidr / SubnetCidr Outputs) still equal the
#      live CIDRs.
#   3. Destroy. Assert the subnet, both VPCs, the pools, the private scope and
#      the IPAM are gone (IPAM deletes are asynchronous, so the gone-checks
#      wait), and the state file too.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdEc2VpcIpamExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_CIDR_PREFIX="10.240."
# go-to-k/cdkd#5632: the subnet pool's CIDR in lib/ (inside SubnetVpc's 10.241.0.0/20).
SUBNET_POOL_CIDR_PREFIX="10.241.0."

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Set once THIS stack's record names an IPAM. The record's state key is
# shared, so a concurrent run of this fixture can put ITS IPAM there: the
# fallback cascade delete below acts only on an IPAM carrying this run's own
# nonce tag (CDKD_IPAM_RUN_TAG, which the stack writes as `cdkd-integ-run`).
IPAM_ID=""
RUN_TAG="ec2-vpc-ipam-$$-$(date +%s)"
export CDKD_IPAM_RUN_TAG="${RUN_TAG}"
# go-to-k/cdkd#5632: the subnet and its pool join the stack only after IPAM
# monitors the VPC (Phase 1b exports this). Never inherited from the caller.
unset CDKD_IPAM_WITH_SUBNET
# Seconds between polls, and the cap, of the wait for IPAM to monitor the VPC.
MONITOR_POLL_S=15
MONITOR_CAP_S=1800

# Set once Phase 0 has proved the region holds no IPAM. Until then the stack's
# shared state key may belong to a LIVE concurrent run of this fixture (the
# very case Phase 0 refuses), so cleanup touches no state, lock or AWS
# resource.
OWNS_STACK=false

cleanup() {
  if [ "${OWNS_STACK}" != "true" ]; then
    return 0
  fi
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # A run that created its IPAM and failed before the destroy finished: the
  # cascade delete takes the scopes, the pool and its CIDRs with it. Only the
  # id this stack recorded, never a listing, and only while it carries this
  # run's own tag.
  case "${IPAM_ID}" in
    ipam-?*)
      ipam_tag=$(aws ec2 describe-ipams --ipam-ids "${IPAM_ID}" --region "${REGION}" \
        --query 'Ipams[0].Tags[?Key==`cdkd-integ-run`].Value | [0]' --output text 2>/dev/null)
      if [ "${ipam_tag}" = "${RUN_TAG}" ]; then
        aws ec2 delete-ipam --ipam-id "${IPAM_ID}" --cascade --region "${REGION}" >/dev/null 2>&1 \
          && echo "    deleted this run's IPAM ${IPAM_ID} (cascade)"
      fi
      ;;
  esac
  if [ -n "${DRIFT_JSON:-}" ]; then
    rm -f "${DRIFT_JSON}"
  fi
  if [ -n "${DESTROY_LOG:-}" ]; then
    rm -f "${DESTROY_LOG}"
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Phase 0: the region must hold no IPAM ------------------------------
echo "==> Phase 0: pre-flight (no IPAM in ${REGION})"
# A deleted IPAM can stay described as `delete-complete` for a while; it
# holds no slot, so it is not counted.
EXISTING_IPAMS=$(aws ec2 describe-ipams --region "${REGION}" \
  --query 'Ipams[?State!=`delete-complete`].[IpamId, State, Tags[?Key==`cdkd-integ`].Value | [0]]' --output text 2>&1) || {
  echo "FAIL: describe-ipams failed in ${REGION}: ${EXISTING_IPAMS}" >&2
  exit 1
}
if [ -n "${EXISTING_IPAMS}" ]; then
  echo "FAIL: ${REGION} already holds an IPAM, and an account has one per region; this fixture neither adopts nor deletes one it did not create:" >&2
  echo "${EXISTING_IPAMS}" >&2
  echo "      A row tagged 'ec2-vpc-ipam' may be another run of this fixture (live, or a leftover whose teardown failed); check before deleting it with: aws ec2 delete-ipam --ipam-id <id> --cascade --region ${REGION}" >&2
  exit 1
fi
echo "    OK: no IPAM in ${REGION}"
OWNS_STACK=true

# go-to-k/cdkd#5632: the zone the subnet names by id. The LAST available zone,
# so EC2's own default pick (when AvailabilityZoneId is dropped) is less
# likely to coincide; the readback below names the zone either way.
AZ_ID=$(aws ec2 describe-availability-zones --region "${REGION}" \
  --filters "Name=state,Values=available" "Name=zone-type,Values=availability-zone" \
  --query 'AvailabilityZones[-1].ZoneId' --output text 2>&1) || {
  echo "FAIL: describe-availability-zones failed in ${REGION}: ${AZ_ID}" >&2
  exit 1
}
case "${AZ_ID}" in
  ""|None) echo "FAIL: could not resolve an AZ id in ${REGION}" >&2; exit 1 ;;
esac
export CDKD_TEST_AZ_ID="${AZ_ID}"
echo "    OK: the subnet uses AZ id ${AZ_ID}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Gone: not found, or still described in its terminal `delete-complete` state
# (IPAM, scope and pool all have one). Any other probe failure FAILs the run
# through gone_probe.
ipam_resource_gone() { # usage: ipam_resource_gone <state-query> aws ec2 describe-ipam* [args...]
  local query="$1"
  shift
  if gone_probe "$@"; then
    return 0
  fi
  local state
  state=$("$@" --query "${query}" --output text 2>&1) || return 1
  [ "${state}" = "delete-complete" ]
}

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -
}

# --- Phase 1: deploy ----------------------------------------------------
echo "==> Phase 1: deploy"
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
P1_RC=$?
set -e
# Record this run's IPAM BEFORE judging the deploy, so a failed deploy whose
# rollback and `state destroy` both fail still reaches cleanup's cascade
# delete. Phase 0 proved the region held no IPAM, so the one this stack's
# record names was created by this run.
if P1_STATE=$(read_state 2>&1); then
  IPAM_ID=$(jq -r '.resources.Ipam.physicalId // ""' <<<"${P1_STATE}") || IPAM_ID=""
fi
if [ "${P1_RC}" -ne 0 ]; then
  echo "FAIL: Phase 1 deploy exited ${P1_RC}" >&2
  exit 1
fi

STATE=$(read_state)
IPAM_ID=$(jq -r '.outputs.IpamId // ""' <<<"${STATE}")
SCOPE_ID=$(jq -r '.outputs.ScopeId // ""' <<<"${STATE}")
POOL_ID=$(jq -r '.outputs.PoolId // ""' <<<"${STATE}")
VPC_ID=$(jq -r '.outputs.VpcId // ""' <<<"${STATE}")
VPC_CIDR_OUTPUT=$(jq -r '.outputs.VpcCidr // ""' <<<"${STATE}")
case "${IPAM_ID}|${SCOPE_ID}|${POOL_ID}|${VPC_ID}" in
  ipam-?*\|ipam-scope-?*\|ipam-pool-?*\|vpc-?*) ;;
  *)
    echo "FAIL: outputs IpamId/ScopeId/PoolId/VpcId are '${IPAM_ID}' / '${SCOPE_ID}' / '${POOL_ID}' / '${VPC_ID}'" >&2
    exit 1
    ;;
esac

# The route guard: Cloud Control allocates from the pool too, so only
# provisionedBy tells the SDK wiring from the auto-route it replaced.
VPC_ROUTE=$(jq -r '.resources.Vpc.provisionedBy // "sdk"' <<<"${STATE}")
if [ "${VPC_ROUTE}" != "sdk" ]; then
  echo "FAIL: the VPC was provisioned by '${VPC_ROUTE}', expected the SDK provider (issue #5633)" >&2
  exit 1
fi

VPC_CIDR=$(aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" \
  --query 'Vpcs[0].CidrBlock' --output text 2>&1) || {
  echo "FAIL: describe-vpcs ${VPC_ID} failed: ${VPC_CIDR}" >&2
  exit 1
}
case "${VPC_CIDR}" in
  "${POOL_CIDR_PREFIX}"*/28) ;;
  *)
    echo "FAIL: VPC ${VPC_ID} CIDR is '${VPC_CIDR}', expected a /28 inside the pool's 10.240.0.0/16 (issue #5633)" >&2
    exit 1
    ;;
esac
ALLOCATED=$(aws ec2 get-ipam-pool-allocations --ipam-pool-id "${POOL_ID}" --region "${REGION}" \
  --query "IpamPoolAllocations[?ResourceId=='${VPC_ID}'].Cidr | [0]" --output text 2>&1) || {
  echo "FAIL: get-ipam-pool-allocations ${POOL_ID} failed: ${ALLOCATED}" >&2
  exit 1
}
if [ "${ALLOCATED}" != "${VPC_CIDR}" ]; then
  echo "FAIL: pool ${POOL_ID} allocates '${ALLOCATED}' to ${VPC_ID}, expected its CIDR ${VPC_CIDR} (issue #5633)" >&2
  exit 1
fi
if [ "${VPC_CIDR_OUTPUT}" != "${VPC_CIDR}" ]; then
  echo "FAIL: the VpcCidr Output (Fn::GetAtt Vpc.CidrBlock) is '${VPC_CIDR_OUTPUT}', expected the allocated ${VPC_CIDR} (issue #5633)" >&2
  exit 1
fi
echo "    OK: ${VPC_ID} on the SDK path with ${VPC_CIDR}, allocated from ${POOL_ID}; Fn::GetAtt CidrBlock agrees"

# --- Phase 1b: wait for IPAM to monitor SubnetVpc, then add the subnet -----
SUBNET_VPC_ID=$(jq -r '.outputs.SubnetVpcId // ""' <<<"${STATE}")
case "${SUBNET_VPC_ID}" in
  vpc-?*) ;;
  *) echo "FAIL: output SubnetVpcId is '${SUBNET_VPC_ID}'" >&2; exit 1 ;;
esac
echo "==> Phase 1b: wait for IPAM scope ${SCOPE_ID} to monitor ${SUBNET_VPC_ID}"
MONITOR_START=$(date +%s)
while :; do
  # Rows for THIS VPC only, counted over the whole JSON answer (not a
  # per-page `length`). A failed read stops the run with its own text.
  MONITOR_JSON=$(aws ec2 get-ipam-resource-cidrs --ipam-scope-id "${SCOPE_ID}" \
    --resource-id "${SUBNET_VPC_ID}" --region "${REGION}" --output json 2>&1) || {
    echo "FAIL: get-ipam-resource-cidrs ${SCOPE_ID} ${SUBNET_VPC_ID} failed: ${MONITOR_JSON}" >&2
    exit 1
  }
  MONITORED=$(jq --arg v "${SUBNET_VPC_ID}" '[.IpamResourceCidrs[]? | select(.ResourceId == $v and .ResourceType == "vpc")] | length' <<<"${MONITOR_JSON}")
  MONITOR_LAG=$(( $(date +%s) - MONITOR_START ))
  if [ "${MONITORED}" -gt 0 ]; then
    echo "    OK: IPAM monitors ${SUBNET_VPC_ID} after ${MONITOR_LAG}s (go-to-k/cdkd#5632 measurement)"
    break
  fi
  if [ "${MONITOR_LAG}" -ge "${MONITOR_CAP_S}" ]; then
    echo "FAIL: IPAM scope ${SCOPE_ID} still does not monitor ${SUBNET_VPC_ID} after ${MONITOR_LAG}s; the planning pool sourced from it cannot be created" >&2
    exit 1
  fi
  sleep "${MONITOR_POLL_S}"
done

export CDKD_IPAM_WITH_SUBNET=true
echo "==> Phase 1b: deploy the planning pool, the subnet pool and the subnet"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
STATE=$(read_state)
P1B_VPC_ID=$(jq -r '.outputs.VpcId // ""' <<<"${STATE}")
P1B_SUBNET_VPC_ID=$(jq -r '.outputs.SubnetVpcId // ""' <<<"${STATE}")
if [ "${P1B_VPC_ID}" != "${VPC_ID}" ] || [ "${P1B_SUBNET_VPC_ID}" != "${SUBNET_VPC_ID}" ]; then
  echo "FAIL: adding the subnet changed a VPC: '${VPC_ID}' -> '${P1B_VPC_ID}', '${SUBNET_VPC_ID}' -> '${P1B_SUBNET_VPC_ID}'" >&2
  exit 1
fi

# go-to-k/cdkd#5632: the subnet allocated from the subnet pool in SubnetVpc.
SUBNET_ID=$(jq -r '.outputs.SubnetId // ""' <<<"${STATE}")
SUBNET_POOL_ID=$(jq -r '.outputs.SubnetPoolId // ""' <<<"${STATE}")
PLANNING_POOL_ID=$(jq -r '.outputs.PlanningPoolId // ""' <<<"${STATE}")
SUBNET_CIDR_OUTPUT=$(jq -r '.outputs.SubnetCidr // ""' <<<"${STATE}")
SUBNET_AZ_OUTPUT=$(jq -r '.outputs.SubnetAzId // ""' <<<"${STATE}")
case "${SUBNET_ID}|${SUBNET_POOL_ID}|${PLANNING_POOL_ID}" in
  subnet-?*\|ipam-pool-?*\|ipam-pool-?*) ;;
  *)
    echo "FAIL: outputs SubnetId/SubnetPoolId/PlanningPoolId are '${SUBNET_ID}' / '${SUBNET_POOL_ID}' / '${PLANNING_POOL_ID}'" >&2
    exit 1
    ;;
esac
SUBNET_ROUTE=$(jq -r '.resources.Subnet.provisionedBy // "sdk"' <<<"${STATE}")
if [ "${SUBNET_ROUTE}" != "sdk" ]; then
  echo "FAIL: the subnet was provisioned by '${SUBNET_ROUTE}', expected the SDK provider (issue #5632)" >&2
  exit 1
fi
SUBNET_LIVE=$(aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}" \
  --query 'Subnets[0].[CidrBlock, AvailabilityZoneId, VpcId]' --output text 2>&1) || {
  echo "FAIL: describe-subnets ${SUBNET_ID} failed: ${SUBNET_LIVE}" >&2
  exit 1
}
read -r SUBNET_CIDR SUBNET_AZ SUBNET_LIVE_VPC <<<"${SUBNET_LIVE}"
if [ "${SUBNET_LIVE_VPC}" != "${SUBNET_VPC_ID}" ]; then
  echo "FAIL: subnet ${SUBNET_ID} is in VPC '${SUBNET_LIVE_VPC}', expected SubnetVpc ${SUBNET_VPC_ID}" >&2
  exit 1
fi
case "${SUBNET_CIDR}" in
  "${SUBNET_POOL_CIDR_PREFIX}"*/28) ;;
  *)
    echo "FAIL: subnet ${SUBNET_ID} CIDR is '${SUBNET_CIDR}', expected a /28 inside the subnet pool's 10.241.0.0/24 (issue #5632)" >&2
    exit 1
    ;;
esac
if [ "${SUBNET_AZ}" != "${AZ_ID}" ]; then
  echo "FAIL: subnet ${SUBNET_ID} is in zone '${SUBNET_AZ}', expected AvailabilityZoneId ${AZ_ID} (issue #5632)" >&2
  exit 1
fi
SUBNET_ALLOCATED=$(aws ec2 get-ipam-pool-allocations --ipam-pool-id "${SUBNET_POOL_ID}" --region "${REGION}" \
  --query "IpamPoolAllocations[?ResourceId=='${SUBNET_ID}'].Cidr | [0]" --output text 2>&1) || {
  echo "FAIL: get-ipam-pool-allocations ${SUBNET_POOL_ID} failed: ${SUBNET_ALLOCATED}" >&2
  exit 1
}
if [ "${SUBNET_ALLOCATED}" != "${SUBNET_CIDR}" ]; then
  echo "FAIL: pool ${SUBNET_POOL_ID} allocates '${SUBNET_ALLOCATED}' to ${SUBNET_ID}, expected its CIDR ${SUBNET_CIDR} (issue #5632)" >&2
  exit 1
fi
if [ "${SUBNET_CIDR_OUTPUT}" != "${SUBNET_CIDR}" ] || [ "${SUBNET_AZ_OUTPUT}" != "${SUBNET_AZ}" ]; then
  echo "FAIL: the SubnetCidr / SubnetAzId Outputs (Fn::GetAtt) are '${SUBNET_CIDR_OUTPUT}' / '${SUBNET_AZ_OUTPUT}', expected ${SUBNET_CIDR} / ${SUBNET_AZ} (issue #5632)" >&2
  exit 1
fi
echo "    OK: ${SUBNET_ID} on the SDK path with ${SUBNET_CIDR} in ${SUBNET_AZ}, allocated from ${SUBNET_POOL_ID}; Fn::GetAtt agrees"

# `cdkd drift` compares the VPC through the SDK provider's readCurrentState
# (Ipv4NetmaskLength from the CIDR; Ipv4IpamPoolId is declared unreadable):
# it must be compared and CLEAN right after the deploy.
DRIFT_JSON="$(mktemp -t cdkd-ec2-vpc-ipam-drift.XXXXXX)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_JSON}"
DRIFT_RC=$?
set -e
VPC_CLEAN=$(jq '[.[].clean[] | select(.logicalId == "Vpc")] | length' "${DRIFT_JSON}") || VPC_CLEAN="?"
if [ "${VPC_CLEAN}" != "1" ]; then
  echo "FAIL: the VPC is not drift-clean right after the deploy (clean=${VPC_CLEAN} rc=${DRIFT_RC}) (issue #5633):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
# go-to-k/cdkd#5632: Ipv4NetmaskLength reads back from the CIDR,
# AvailabilityZoneId from DescribeSubnets; Ipv4IpamPoolId is unreadable.
SUBNET_CLEAN=$(jq '[.[].clean[] | select(.logicalId == "Subnet")] | length' "${DRIFT_JSON}") || SUBNET_CLEAN="?"
if [ "${SUBNET_CLEAN}" != "1" ]; then
  echo "FAIL: the subnet is not drift-clean right after the deploy (clean=${SUBNET_CLEAN} rc=${DRIFT_RC}) (issue #5632):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    OK: ${VPC_ID} and ${SUBNET_ID} read back drift-clean"

# --- Phase 2: in-place update keeps the CidrBlock attribute --------------
echo "==> Phase 2: CDKD_TEST_UPDATE=true (tag the VPC in place)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(read_state)
P2_VPC_ID=$(jq -r '.outputs.VpcId // ""' <<<"${STATE}")
P2_CIDR_ATTR=$(jq -r '.resources.Vpc.attributes.CidrBlock // ""' <<<"${STATE}")
P2_CIDR_OUTPUT=$(jq -r '.outputs.VpcCidr // ""' <<<"${STATE}")
if [ "${P2_VPC_ID}" != "${VPC_ID}" ]; then
  echo "FAIL: the tag update replaced the VPC: '${VPC_ID}' -> '${P2_VPC_ID}'" >&2
  exit 1
fi
P2_TAG=$(aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}" \
  --query "Vpcs[0].Tags[?Key=='cdkd-5633'].Value | [0]" --output text 2>&1) || {
  echo "FAIL: describe-vpcs ${VPC_ID} failed: ${P2_TAG}" >&2
  exit 1
}
if [ "${P2_TAG}" != "updated" ]; then
  echo "FAIL: the cdkd-5633 tag on ${VPC_ID} is '${P2_TAG}', expected 'updated'; the update did not run" >&2
  exit 1
fi
if [ "${P2_CIDR_ATTR}" != "${VPC_CIDR}" ] || [ "${P2_CIDR_OUTPUT}" != "${VPC_CIDR}" ]; then
  echo "FAIL: after the in-place update the recorded CidrBlock attribute is '${P2_CIDR_ATTR}' and the VpcCidr Output '${P2_CIDR_OUTPUT}', expected ${VPC_CIDR} for both (issue #5633)" >&2
  exit 1
fi
echo "    OK: ${VPC_ID} updated in place and still records CidrBlock ${VPC_CIDR}"

P2_SUBNET_ID=$(jq -r '.outputs.SubnetId // ""' <<<"${STATE}")
P2_SUBNET_ATTR=$(jq -r '.resources.Subnet.attributes.CidrBlock // ""' <<<"${STATE}")
P2_SUBNET_OUTPUT=$(jq -r '.outputs.SubnetCidr // ""' <<<"${STATE}")
if [ "${P2_SUBNET_ID}" != "${SUBNET_ID}" ]; then
  echo "FAIL: the tag update replaced the subnet: '${SUBNET_ID}' -> '${P2_SUBNET_ID}' (issue #5632)" >&2
  exit 1
fi
P2_SUBNET_TAG=$(aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}" \
  --query "Subnets[0].Tags[?Key=='cdkd-5632'].Value | [0]" --output text 2>&1) || {
  echo "FAIL: describe-subnets ${SUBNET_ID} failed: ${P2_SUBNET_TAG}" >&2
  exit 1
}
if [ "${P2_SUBNET_TAG}" != "updated" ]; then
  echo "FAIL: the cdkd-5632 tag on ${SUBNET_ID} is '${P2_SUBNET_TAG}', expected 'updated'; the update did not run" >&2
  exit 1
fi
if [ "${P2_SUBNET_ATTR}" != "${SUBNET_CIDR}" ] || [ "${P2_SUBNET_OUTPUT}" != "${SUBNET_CIDR}" ]; then
  echo "FAIL: after the in-place update the subnet's recorded CidrBlock attribute is '${P2_SUBNET_ATTR}' and the SubnetCidr Output '${P2_SUBNET_OUTPUT}', expected ${SUBNET_CIDR} for both (issue #5632)" >&2
  exit 1
fi
echo "    OK: ${SUBNET_ID} updated in place and still records CidrBlock ${SUBNET_CIDR}"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
DESTROY_LOG="$(mktemp -t cdkd-ec2-vpc-ipam-destroy.XXXXXX)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${DESTROY_LOG}"
# go-to-k/cdkd#5632: the subnet delete waited on its pool. The VPC's line is
# the sentinel: present while the subnet's is absent means the wording moved.
DESTROY_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' "${DESTROY_LOG}")
rm -f "${DESTROY_LOG}"
if ! grep -qF "release the allocation of deleted subnet ${SUBNET_ID}" <<<"${DESTROY_PLAIN}"; then
  if grep -qF "release the allocation of deleted VPC ${VPC_ID}" <<<"${DESTROY_PLAIN}"; then
    echo "FAIL: the destroy waited on the VPC's pool but printed no wait for subnet ${SUBNET_ID}'s (issue #5632)" >&2
  else
    echo "FAIL: the destroy printed neither IPAM release wait; their wording may have changed (issue #5632)" >&2
  fi
  exit 1
fi
echo "    OK: the subnet delete waited for ${SUBNET_POOL_ID} to release its allocation"

assert_gone "subnet '${SUBNET_ID}' still exists after destroy" aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}"
assert_gone "VPC '${VPC_ID}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "VPC '${SUBNET_VPC_ID}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${SUBNET_VPC_ID}" --region "${REGION}"
# IPAM, scope and pool deletes finish asynchronously: wait for each to stop
# being described (up to 10 minutes), then assert it is gone.
IPAM_FAMILY_GONE=false
for _ in $(seq 1 60); do
  if ipam_resource_gone 'IpamPools[0].State' aws ec2 describe-ipam-pools --ipam-pool-ids "${POOL_ID}" --region "${REGION}" \
    && ipam_resource_gone 'IpamPools[0].State' aws ec2 describe-ipam-pools --ipam-pool-ids "${SUBNET_POOL_ID}" --region "${REGION}" \
    && ipam_resource_gone 'IpamPools[0].State' aws ec2 describe-ipam-pools --ipam-pool-ids "${PLANNING_POOL_ID}" --region "${REGION}" \
    && ipam_resource_gone 'IpamScopes[0].State' aws ec2 describe-ipam-scopes --ipam-scope-ids "${SCOPE_ID}" --region "${REGION}" \
    && ipam_resource_gone 'Ipams[0].State' aws ec2 describe-ipams --ipam-ids "${IPAM_ID}" --region "${REGION}"; then
    IPAM_FAMILY_GONE=true
    break
  fi
  sleep 10
done
if [ "${IPAM_FAMILY_GONE}" != "true" ]; then
  echo "FAIL: after destroy, the IPAM '${IPAM_ID}', scope '${SCOPE_ID}', pool '${POOL_ID}', subnet pool '${SUBNET_POOL_ID}' or planning pool '${PLANNING_POOL_ID}' is still described in a state other than delete-complete after 10 minutes" >&2
  exit 1
fi
echo "    OK: the subnet, both VPCs, the three pools, the private scope and the IPAM are gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS — ec2-vpc-ipam: VPC and subnet CIDRs allocated from IPAM pools on the SDK path, kept across an in-place update, clean destroy"
