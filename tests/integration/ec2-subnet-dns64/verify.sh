#!/usr/bin/env bash
# SDK subnet create, CIDR replacement/removal and DNS64 removal parity (#5632).
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
STACK="CdkdEc2SubnetDns64Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SUBNET_ID=""
VPC_ID=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    :
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: run vp run build first" >&2; exit 1; }
if [ ! -d node_modules ]; then pnpm install --ignore-workspace --prefer-offline; fi
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" --only-show-errors
}
canonical_ipv6_cidr() {
  python3 -c 'import ipaddress, sys
network = ipaddress.ip_network(sys.argv[1], strict=False)
if network.version != 6:
    raise ValueError("expected an IPv6 CIDR")
print(network)' "$1"
}
check_live() { # expected DNS64, expected CIDR (or none)
  local state current route cidr dns expected_cidr
  expected_cidr="$2"
  if [ "${expected_cidr}" != none ]; then
    expected_cidr=$(canonical_ipv6_cidr "${expected_cidr}") || return 1
  fi
  state=$(state_json) || return 1
  current=$(printf '%s' "${state}" | jq -r '.outputs.SubnetId') || return 1
  [ "${current}" = "${SUBNET_ID}" ] || { echo "FAIL: subnet was replaced" >&2; exit 1; }
  route=$(printf '%s' "${state}" | jq -r '.resources.Subnet.provisionedBy') || return 1
  [ "${route}" = sdk ] || { echo "FAIL: Subnet route is ${route}, expected sdk" >&2; exit 1; }
  for _ in 1 2 3 4 5 6; do
    dns=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
      --query 'Subnets[0].EnableDns64' --output text | tr '[:upper:]' '[:lower:]') || return 1
    cidr=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
      --query 'Subnets[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`].Ipv6CidrBlock' --output text) || return 1
    if [ -n "${cidr}" ]; then
      cidr=$(canonical_ipv6_cidr "${cidr}") || return 1
    fi
    if [ "${dns}" = "$1" ] && { [ "${cidr}" = "${expected_cidr}" ] || { [ "${expected_cidr}" = none ] && [ -z "${cidr}" ]; }; }; then
      echo "    OK: same SDK subnet, DNS64=$1, IPv6=$2"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: DNS64=${dns}, IPv6=${cidr}; expected $1, $2" >&2
  exit 1
}
check_drift() {
  local report
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || {
    echo "FAIL: cdkd drift failed after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  }
  if ! jq -e --arg stack "${STACK}" '
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[] | select(.logicalId == "Subnet")] | length) == 1 and
    ([$reports[0].drifted[] | select(.logicalId == "Subnet")] | length) == 0 and
    ([$reports[0].notCompared[] | select(.logicalId == "Subnet")] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: Subnet was not fully compared and drift-clean after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: Subnet fully compared and drift-clean after $1"
}
deploy_phase() {
  CDKD_TEST_UPDATE="$1" CDKD_TEST_REMOVAL="$2" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
}

cleanup
CLEANED_UP=0

echo "==> Create: IPv6 CIDR and DNS64=true on the SDK route"
deploy_phase create false
STATE=$(state_json)
SUBNET_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.SubnetId')
VPC_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.VpcId')
FIRST_CIDR=$(printf '%s' "${STATE}" | jq -r '.outputs.ExpectedCidr')
case "${SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no subnet ID" >&2; exit 1 ;; esac
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: no VPC ID" >&2; exit 1 ;; esac
check_live true "${FIRST_CIDR}"
check_drift "initial create"

echo "==> Disable DNS64 before the CIDR-only update"
deploy_phase disable-first false
check_live false "${FIRST_CIDR}"

echo "==> Update: change the IPv6 CIDR without replacing the subnet"
deploy_phase change-cidr false
STATE=$(state_json)
SECOND_CIDR=$(printf '%s' "${STATE}" | jq -r '.outputs.ExpectedCidr')
[ "${SECOND_CIDR}" != "${FIRST_CIDR}" ] || { echo "FAIL: fixture did not change its CIDR" >&2; exit 1; }
check_live false "${SECOND_CIDR}"

echo "==> Enable DNS64 explicitly on the new block"
deploy_phase enable-dns64 false
check_live true "${SECOND_CIDR}"

echo "==> Remove DNS64 property, change Phase tag: live DNS64 stays true"
deploy_phase remove-dns64 true
check_live true "${SECOND_CIDR}"
PHASE_TAG=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
  --query 'Subnets[0].Tags[?Key==`Phase`].Value | [0]' --output text)
[ "${PHASE_TAG}" = remove-dns64 ] || { echo "FAIL: companion tag update did not land" >&2; exit 1; }
check_drift "DNS64 property removal"

echo "==> Explicitly disable DNS64"
deploy_phase disable-dns64 false
check_live false "${SECOND_CIDR}"

echo "==> Remove IPv6 property: no associated block, same subnet"
deploy_phase remove-ipv6 false
check_live false none

echo "==> Restore initial CIDR and explicitly enable DNS64"
deploy_phase create false
check_live true "${FIRST_CIDR}"

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "subnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}"
assert_gone "VPC still exists" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
trap - EXIT INT TERM
echo "[verify] PASS: SDK subnet IPv6/DNS64 create, update, removals and clean destroy (#5632)"
