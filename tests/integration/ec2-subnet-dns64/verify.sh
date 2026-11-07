#!/usr/bin/env bash
# SDK subnet create, CIDR replacement/removal and DNS64 removal parity, plus
# AssignIpv6AddressOnCreation / PrivateDnsNameOptionsOnLaunch / Ipv6Native (#5632).
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
DNS_SUBNET_ID=""
NATIVE_SUBNET_ID=""
BLOCK_SUBNET_ID=""
BLOCK_LOG=""
VPC_ID=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    # go-to-k/cdkd#5843: EC2 refuses to detach BlockSubnet's block while any
    # of the three is on, so a run that stopped mid-phase turns them off first.
    if [ -n "${BLOCK_SUBNET_ID}" ]; then
      for flag in --no-assign-ipv6-address-on-creation --no-enable-dns64 --no-enable-resource-name-dns-aaaa-record-on-launch; do
        aws ec2 modify-subnet-attribute --region "${REGION}" --subnet-id "${BLOCK_SUBNET_ID}" "${flag}"
      done
    fi
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    [ -n "${BLOCK_LOG}" ] && rm -f "${BLOCK_LOG}"
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
# go-to-k/cdkd#5944: the SubnetIpv6Blocks output is `blocks:` plus
# Fn::GetAtt [Subnet, Ipv6CidrBlocks] joined, which must name the block AWS
# holds after every phase, an in-place change included, since update() records
# no attributes. It resolved to the subnet ID before the fix.
check_getatt_blocks() { # state JSON, expected canonical CIDR (or none)
  local out blocks
  out=$(printf '%s' "$1" | jq -r '.outputs.SubnetIpv6Blocks') || return 1
  case "${out}" in
    blocks:*) blocks="${out#blocks:}" ;;
    *) echo "FAIL: SubnetIpv6Blocks output is '${out}', expected blocks:<GetAtt Ipv6CidrBlocks>" >&2; exit 1 ;;
  esac
  if [ "$2" = none ]; then
    [ -z "${blocks}" ] || { echo "FAIL: GetAtt Ipv6CidrBlocks is '${blocks}', expected an empty list" >&2; exit 1; }
  else
    case "${blocks}" in
      *,*|'') echo "FAIL: GetAtt Ipv6CidrBlocks is '${blocks}', expected exactly $2" >&2; exit 1 ;;
    esac
    blocks=$(canonical_ipv6_cidr "${blocks}") || { echo "FAIL: GetAtt Ipv6CidrBlocks '${out#blocks:}' is not an IPv6 CIDR" >&2; exit 1; }
    [ "${blocks}" = "$2" ] || { echo "FAIL: GetAtt Ipv6CidrBlocks is ${blocks}, expected $2" >&2; exit 1; }
  fi
  echo "    OK: Fn::GetAtt [Subnet, Ipv6CidrBlocks] = [${blocks}]"
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
      check_getatt_blocks "${state}" "${expected_cidr}"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: DNS64=${dns}, IPv6=${cidr}; expected $1, $2" >&2
  exit 1
}
# go-to-k/cdkd#5632: the DnsSubnet's values, read back from AWS, on the same
# SDK-created subnet. Args: assign, hostname type, A record, AAAA record; DNS64
# is declared true in every phase but the removal one, which keeps it.
check_dns_subnet() {
  local state current route live expected
  state=$(state_json) || return 1
  current=$(printf '%s' "${state}" | jq -r '.outputs.DnsSubnetId') || return 1
  [ "${current}" = "${DNS_SUBNET_ID}" ] || { echo "FAIL: DnsSubnet was replaced" >&2; exit 1; }
  route=$(printf '%s' "${state}" | jq -r '.resources.DnsSubnet.provisionedBy') || return 1
  [ "${route}" = sdk ] || { echo "FAIL: DnsSubnet route is ${route}, expected sdk" >&2; exit 1; }
  expected="$1 $2 $3 $4 true"
  for _ in 1 2 3 4 5 6; do
    live=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${DNS_SUBNET_ID}" \
      --query 'Subnets[0].[AssignIpv6AddressOnCreation, PrivateDnsNameOptionsOnLaunch.HostnameType, PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsARecord, PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord, EnableDns64]' \
      --output text | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/ $//') || return 1
    if [ "${live}" = "${expected}" ]; then
      echo "    OK: same SDK DnsSubnet, assign/hostname/A/AAAA/DNS64 = ${live}"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: DnsSubnet assign/hostname/A/AAAA/DNS64 = ${live}; expected ${expected}" >&2
  exit 1
}
# go-to-k/cdkd#5632: the IPv6-only subnet is the one the create made, IPv6
# native with no IPv4 block, on the SDK route, after every phase.
check_native_subnet() {
  local state current route live
  state=$(state_json) || return 1
  current=$(printf '%s' "${state}" | jq -r '.outputs.NativeSubnetId') || return 1
  [ "${current}" = "${NATIVE_SUBNET_ID}" ] || { echo "FAIL: NativeSubnet was replaced" >&2; exit 1; }
  route=$(printf '%s' "${state}" | jq -r '.resources.NativeSubnet.provisionedBy') || return 1
  [ "${route}" = sdk ] || { echo "FAIL: NativeSubnet route is ${route}, expected sdk" >&2; exit 1; }
  live=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${NATIVE_SUBNET_ID}" \
    --query 'Subnets[0].[Ipv6Native, CidrBlock, AssignIpv6AddressOnCreation, PrivateDnsNameOptionsOnLaunch.HostnameType, PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord]' \
    --output text | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/ $//') || return 1
  [ "${live}" = "true none true resource-name true" ] || {
    echo "FAIL: NativeSubnet native/IPv4/assign/hostname/AAAA = ${live}; expected true none true resource-name true" >&2; exit 1; }
  echo "    OK: same SDK IPv6-only NativeSubnet (${live})"
}
# go-to-k/cdkd#5632: the DnsSubnet's one associated IPv6 block is the one the
# template's DnsExpectedCidr output names.
check_dns_block() {
  local expected live
  expected=$(state_json | jq -r '.outputs.DnsExpectedCidr') || return 1
  expected=$(canonical_ipv6_cidr "${expected}") || return 1
  for _ in 1 2 3 4 5 6; do
    live=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${DNS_SUBNET_ID}" \
      --query 'Subnets[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`].Ipv6CidrBlock' --output text) || return 1
    if [ -n "${live}" ] && [ "$(canonical_ipv6_cidr "${live}")" = "${expected}" ]; then
      echo "    OK: DnsSubnet holds IPv6 block ${expected}"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: DnsSubnet IPv6 block is '${live}', expected ${expected}" >&2
  exit 1
}
check_drift() {
  local report
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || {
    echo "FAIL: cdkd drift failed after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  }
  local id
  for id in Subnet DnsSubnet NativeSubnet BlockSubnet; do
    if ! jq -e --arg stack "${STACK}" --arg id "${id}" '
      [.[] | select(.stack == $stack)] as $reports |
      ($reports | length) == 1 and
      ([$reports[0].clean[] | select(.logicalId == $id)] | length) == 1 and
      ([$reports[0].drifted[] | select(.logicalId == $id)] | length) == 0 and
      ([$reports[0].notCompared[] | select(.logicalId == $id)] | length) == 0
    ' <<<"${report}" >/dev/null; then
      echo "FAIL: ${id} was not fully compared and drift-clean after $1" >&2
      printf '%s\n' "${report}" >&2
      exit 1
    fi
  done
  echo "    OK: Subnet, DnsSubnet, NativeSubnet and BlockSubnet fully compared and drift-clean after $1"
}
# go-to-k/cdkd#5843: BlockSubnet's auto-assign, DNS64 and AAAA record, read
# back from AWS, on the same SDK-created subnet that holds an associated block.
check_block_subnet() { # expected value of all three
  local state current live expected
  state=$(state_json) || return 1
  current=$(printf '%s' "${state}" | jq -r '.outputs.BlockSubnetId') || return 1
  [ "${current}" = "${BLOCK_SUBNET_ID}" ] || { echo "FAIL: BlockSubnet was replaced" >&2; exit 1; }
  expected="$1 $1 $1 associated"
  for _ in 1 2 3 4 5 6; do
    live=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${BLOCK_SUBNET_ID}" \
      --query 'Subnets[0].[AssignIpv6AddressOnCreation, EnableDns64, PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord, Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`] | [0].Ipv6CidrBlockState.State]' \
      --output text | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/ $//') || return 1
    if [ "${live}" = "${expected}" ]; then
      echo "    OK: same SDK BlockSubnet, assign/DNS64/AAAA/block = ${live}"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: BlockSubnet assign/DNS64/AAAA/block = ${live}; expected ${expected}" >&2
  exit 1
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
DNS_SUBNET_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.DnsSubnetId')
NATIVE_SUBNET_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.NativeSubnetId')
BLOCK_SUBNET_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.BlockSubnetId')
FIRST_CIDR=$(printf '%s' "${STATE}" | jq -r '.outputs.ExpectedCidr')
case "${SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no subnet ID" >&2; exit 1 ;; esac
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: no VPC ID" >&2; exit 1 ;; esac
case "${DNS_SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no DnsSubnet ID" >&2; exit 1 ;; esac
case "${NATIVE_SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no NativeSubnet ID" >&2; exit 1 ;; esac
case "${BLOCK_SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no BlockSubnet ID" >&2; exit 1 ;; esac
check_live true "${FIRST_CIDR}"
# go-to-k/cdkd#5944: two more Subnet return values the SDK record lacks.
GETATT_VPC=$(printf '%s' "${STATE}" | jq -r '.outputs.SubnetVpcId')
[ "${GETATT_VPC}" = "${VPC_ID}" ] || { echo "FAIL: GetAtt [Subnet, VpcId] is '${GETATT_VPC}', expected ${VPC_ID}" >&2; exit 1; }
GETATT_NACL=$(printf '%s' "${STATE}" | jq -r '.outputs.SubnetNaclAssociationId')
LIVE_NACL=$(aws ec2 describe-network-acls --region "${REGION}" --filters "Name=association.subnet-id,Values=${SUBNET_ID}" \
  --query "NetworkAcls[].Associations[?SubnetId=='${SUBNET_ID}'].NetworkAclAssociationId | [] | [0]" --output text)
case "${LIVE_NACL}" in aclassoc-?*) ;; *) echo "FAIL: no live network ACL association for ${SUBNET_ID} (got '${LIVE_NACL}')" >&2; exit 1 ;; esac
[ "${GETATT_NACL}" = "${LIVE_NACL}" ] || { echo "FAIL: GetAtt [Subnet, NetworkAclAssociationId] is '${GETATT_NACL}', expected ${LIVE_NACL}" >&2; exit 1; }
echo "    OK: Fn::GetAtt [Subnet, VpcId] = ${GETATT_VPC}, [Subnet, NetworkAclAssociationId] = ${GETATT_NACL}"
check_dns_subnet true resource-name true true
check_native_subnet
check_drift "initial create"

echo "==> Disable DNS64 before the CIDR-only update"
deploy_phase disable-first false
check_live false "${FIRST_CIDR}"
check_dns_subnet false ip-name true true

echo "==> Update: change the IPv6 CIDR without replacing the subnet"
deploy_phase change-cidr false
STATE=$(state_json)
SECOND_CIDR=$(printf '%s' "${STATE}" | jq -r '.outputs.ExpectedCidr')
[ "${SECOND_CIDR}" != "${FIRST_CIDR}" ] || { echo "FAIL: fixture did not change its CIDR" >&2; exit 1; }
check_live false "${SECOND_CIDR}"

echo "==> Enable DNS64 explicitly on the new block"
deploy_phase enable-dns64 false
check_live true "${SECOND_CIDR}"
check_dns_subnet true resource-name false true
DNS_FIRST_CIDR=$(state_json | jq -r '.outputs.DnsExpectedCidr')

echo "==> Move DnsSubnet's IPv6 block while auto-assign, the AAAA record and DNS64 stay true"
# EC2 refuses to detach a block while any of the three is on
# (InvalidCidrBlock.InUse): the deploy turns each off for the move and back on.
deploy_phase move-dns-block false
DNS_SECOND_CIDR=$(state_json | jq -r '.outputs.DnsExpectedCidr')
[ "${DNS_SECOND_CIDR}" != "${DNS_FIRST_CIDR}" ] || { echo "FAIL: fixture did not move DnsSubnet's block" >&2; exit 1; }
check_dns_block
check_dns_subnet true resource-name false true
check_drift "moving DnsSubnet's IPv6 block"

echo "==> Remove DNS64 / assign / private DNS properties, change Phase tags: live values stay"
deploy_phase remove-dns64 true
check_live true "${SECOND_CIDR}"
check_dns_subnet true resource-name false true
DNS_PHASE_TAG=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${DNS_SUBNET_ID}" \
  --query 'Subnets[0].Tags[?Key==`Phase`].Value | [0]' --output text)
[ "${DNS_PHASE_TAG}" = remove-dns64 ] || { echo "FAIL: DnsSubnet companion tag update did not land" >&2; exit 1; }
PHASE_TAG=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
  --query 'Subnets[0].Tags[?Key==`Phase`].Value | [0]' --output text)
[ "${PHASE_TAG}" = remove-dns64 ] || { echo "FAIL: companion tag update did not land" >&2; exit 1; }
check_drift "DNS64 property removal"

echo "==> Explicitly disable DNS64"
deploy_phase disable-dns64 false
check_live false "${SECOND_CIDR}"
check_dns_subnet false ip-name false false

echo "==> Remove IPv6 property: no associated block, same subnet"
deploy_phase remove-ipv6 false
check_live false none

echo "==> Restore initial CIDR and explicitly enable DNS64"
deploy_phase create false
check_live true "${FIRST_CIDR}"
check_dns_block
check_dns_subnet true resource-name true true
check_native_subnet
check_drift "restoring the initial template"

echo "==> BlockSubnet: a SubnetCidrBlock attaches its block in the deploy that declares auto-assign, DNS64 and AAAA true (#5843)"
# The SubnetCidrBlock depends on the subnet, so the subnet update runs with no
# block: EC2 refuses the three, cdkd warns and records the false AWS holds.
BLOCK_LOG=$(mktemp)
deploy_phase cidr-block-on false 2>&1 | tee "${BLOCK_LOG}"
for name in AssignIpv6AddressOnCreation EnableDns64 PrivateDnsNameOptionsOnLaunch.EnableResourceNameDnsAAAARecord; do
  grep -qF "BlockSubnet: ${name} is true but the subnet has no IPv6 block" "${BLOCK_LOG}" || {
    echo "FAIL: no blockless warning for BlockSubnet ${name}: the subnet update did not run before the block attached, so this phase does not reach #5843's shape" >&2
    exit 1
  }
done
echo "    OK: the BlockSubnet update ran before its block attached, and warned for all three"
echo "==> Redeploy the same template: the block is there now, so all three go on"
deploy_phase cidr-block-on false
check_block_subnet true
check_drift "re-sending BlockSubnet's three values once its block attached"
echo "==> Turn the three off so the destroy can detach BlockSubnet's block"
deploy_phase cidr-block-off false
check_block_subnet false

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "subnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}"
assert_gone "DnsSubnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${DNS_SUBNET_ID}"
assert_gone "NativeSubnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${NATIVE_SUBNET_ID}"
assert_gone "BlockSubnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${BLOCK_SUBNET_ID}"
assert_gone "VPC still exists" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
trap - EXIT INT TERM
rm -f "${BLOCK_LOG}"
echo "[verify] PASS: SDK subnet IPv6/DNS64/assign/private-DNS/IPv6-native create, update, removals, SubnetCidrBlock re-send (#5843) and clean destroy (#5632)"
