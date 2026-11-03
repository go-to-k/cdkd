#!/usr/bin/env bash
# verify.sh - cdkd AWS::EC2::VPC with its CIDR allocated from an IPAM pool
# (issue #5633).
#
# Phases:
#   0. Pre-flight: the region must hold NO IPAM. An account has one IPAM per
#      region, and this fixture creates one, so it refuses to run beside an
#      existing IPAM rather than adopt, collide with or delete it.
#   1. Deploy. The VPC declares Ipv4IpamPoolId + Ipv4NetmaskLength and no
#      CidrBlock. Assert it was provisioned by the SDK provider (before #5633
#      both properties routed it to Cloud Control), that its CIDR is a /28
#      inside the pool's 10.240.0.0/16 and is this pool's allocation for this
#      VPC, and that the VpcCidr Output (Fn::GetAtt Vpc.CidrBlock) equals it.
#   2. CDKD_TEST_UPDATE=true adds a tag to the VPC: an in-place update. Assert
#      the same VPC id, the tag on AWS, and that the recorded CidrBlock
#      attribute (the VpcCidr Output) still equals the live CIDR.
#   3. Destroy. Assert the VPC, the pool, the private scope and the IPAM are
#      gone (IPAM deletes are asynchronous, so the gone-checks wait), and the
#      state file too.
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

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Set only once THIS run's deploy has recorded the IPAM it created, so the
# fallback teardown below can never reach an IPAM this run did not make.
IPAM_ID=""

cleanup() {
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
  # id this run recorded, never a listing.
  case "${IPAM_ID}" in
    ipam-?*)
      if aws ec2 describe-ipams --ipam-ids "${IPAM_ID}" --region "${REGION}" >/dev/null 2>&1; then
        aws ec2 delete-ipam --ipam-id "${IPAM_ID}" --cascade --region "${REGION}" >/dev/null 2>&1 \
          && echo "    deleted this run's IPAM ${IPAM_ID} (cascade)"
      fi
      ;;
  esac
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
EXISTING_IPAMS=$(aws ec2 describe-ipams --region "${REGION}" \
  --query 'Ipams[].[IpamId, State, Tags[?Key==`cdkd-integ`].Value | [0]]' --output text 2>&1) || {
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -
}

# --- Phase 1: deploy ----------------------------------------------------
echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

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

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "VPC '${VPC_ID}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
# IPAM, scope and pool deletes finish asynchronously: wait for each to stop
# being described (up to 10 minutes), then assert it is gone.
for _ in $(seq 1 60); do
  if gone_probe aws ec2 describe-ipams --ipam-ids "${IPAM_ID}" --region "${REGION}" \
    && gone_probe aws ec2 describe-ipam-scopes --ipam-scope-ids "${SCOPE_ID}" --region "${REGION}" \
    && gone_probe aws ec2 describe-ipam-pools --ipam-pool-ids "${POOL_ID}" --region "${REGION}"; then
    break
  fi
  sleep 10
done
assert_gone "IPAM pool '${POOL_ID}' still exists after destroy" aws ec2 describe-ipam-pools --ipam-pool-ids "${POOL_ID}" --region "${REGION}"
assert_gone "IPAM scope '${SCOPE_ID}' still exists after destroy" aws ec2 describe-ipam-scopes --ipam-scope-ids "${SCOPE_ID}" --region "${REGION}"
assert_gone "IPAM '${IPAM_ID}' still exists after destroy" aws ec2 describe-ipams --ipam-ids "${IPAM_ID}" --region "${REGION}"
echo "    OK: the VPC, the pool, the private scope and the IPAM are gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS — ec2-vpc-ipam: VPC CIDR allocated from an IPAM pool on the SDK path, kept across an in-place update, clean destroy"
