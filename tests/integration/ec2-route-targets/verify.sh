#!/usr/bin/env bash
# verify.sh — AWS::EC2::Route extra target types integ (issue #609 backfill).
#
# Live coverage for the two formerly silent-drop Route properties that are
# testable without Wavelength / Outposts / Cloud WAN hardware:
#
#   - DestinationPrefixListId: a route whose DESTINATION is a customer-managed
#     prefix list (exercises the `rtb|pl-...` physicalId form end to end).
#   - TransitGatewayId: a route whose TARGET is a Transit Gateway.
#   - VPCGatewayAttachment.VpnGatewayId (issue #2762): a VPN gateway attachment
#     the SDK provider makes itself (before #2762 it routed through Cloud
#     Control), plus a route through the VPN gateway.
#
# Phases:
#   1. Deploy: prefix-list route -> IGW, CIDR route -> TGW. Assert both routes
#      exist in AWS with the exact destination/target pairs, the Route state
#      records carry the `|pl-` physicalId form, and `cdkd drift` reads back
#      clean (exercises readRouteCurrentState's prefix-list matching live).
#      Also: the VPN gateway attachment's state record is the SDK provider's
#      (`provisionedBy` sdk, physicalId `<vgwId>|<vpcId>`), AWS reports it
#      `attached`, and the route through the VPN gateway exists.
#   2. UPDATE (CDKD_TEST_UPDATE=true): swap the prefix-list route's target from
#      the IGW to the TGW. Assert the swap was one ReplaceRoute with no
#      DeleteRoute / CreateRoute (the SDK call log, issue #5068), the target
#      swapped in AWS, and drift is clean. Also swap the VPN gateway
#      attachment to a second VPN gateway in place (issue #5216): one
#      DetachVpnGateway + one AttachVpnGateway, the record names the new
#      gateway, and AWS reports it attached and the old one detached.
#   3. Destroy + assert the TGW attachment, TGW, prefix list, VPN gateway, and VPC are gone
#      and the cdkd state file is removed.
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

STACK="CdkdEc2RouteTargetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PL_NAME="cdkd-route-targets-pl"
TGW_TAG="cdkd-route-targets-tgw"
TGW_ATTACHMENT_TAG="cdkd-route-targets-tgw-attachment"
VPC_TAG="cdkd-route-targets-vpc"
VGW_TAG="cdkd-route-targets-vgw"
VGW2_TAG="cdkd-route-targets-vgw2"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi

  # Best-effort direct sweeps by deterministic tag/name, for the case where
  # state-based destroy could not run (state already gone, partial deploy).
  # TGW attachment first (blocks TGW + VPC deletion), then TGW, prefix list,
  # and the VPC family.
  local att_id
  att_id="$(aws ec2 describe-transit-gateway-vpc-attachments --region "${REGION}" \
    --filters "Name=tag:Name,Values=${TGW_ATTACHMENT_TAG}" "Name=state,Values=available,pending,modifying" \
    --query 'TransitGatewayVpcAttachments[0].TransitGatewayAttachmentId' --output text 2>/dev/null)"
  if [ -n "${att_id}" ] && [ "${att_id}" != "None" ]; then
    aws ec2 delete-transit-gateway-vpc-attachment --region "${REGION}" \
      --transit-gateway-attachment-id "${att_id}" >/dev/null 2>&1
    for _ in $(seq 1 30); do
      state="$(aws ec2 describe-transit-gateway-vpc-attachments --region "${REGION}" \
        --transit-gateway-attachment-ids "${att_id}" \
        --query 'TransitGatewayVpcAttachments[0].State' --output text 2>/dev/null)"
      [ "${state}" = "deleted" ] || [ -z "${state}" ] || [ "${state}" = "None" ] && break
      sleep 10
    done
  fi

  local tgw_id
  tgw_id="$(aws ec2 describe-transit-gateways --region "${REGION}" \
    --filters "Name=tag:Name,Values=${TGW_TAG}" "Name=state,Values=available,pending,modifying" \
    --query 'TransitGateways[0].TransitGatewayId' --output text 2>/dev/null)"
  if [ -n "${tgw_id}" ] && [ "${tgw_id}" != "None" ]; then
    aws ec2 delete-transit-gateway --region "${REGION}" --transit-gateway-id "${tgw_id}" >/dev/null 2>&1
  fi

  # VPN gateway before the VPC: AWS refuses DeleteVpc while a VPN gateway is
  # attached, and DeleteVpnGateway until the detach has finished (`detaching`
  # -> `detached` is asynchronous).
  local vgw_id vgw_vpc pending
  for vgw_id in $(aws ec2 describe-vpn-gateways --region "${REGION}" \
    --filters "Name=tag:Name,Values=${VGW_TAG},${VGW2_TAG}" "Name=state,Values=available,pending" \
    --query 'VpnGateways[].VpnGatewayId' --output text 2>/dev/null); do
    for vgw_vpc in $(aws ec2 describe-vpn-gateways --region "${REGION}" --vpn-gateway-ids "${vgw_id}" \
      --query 'VpnGateways[0].VpcAttachments[?contains(`["attached","attaching"]`, State)].VpcId' --output text 2>/dev/null); do
      aws ec2 detach-vpn-gateway --region "${REGION}" --vpn-gateway-id "${vgw_id}" --vpc-id "${vgw_vpc}" >/dev/null 2>&1
    done
    for _ in $(seq 1 30); do
      pending="$(aws ec2 describe-vpn-gateways --region "${REGION}" --vpn-gateway-ids "${vgw_id}" \
        --query "length(VpnGateways[0].VpcAttachments[?State!='detached'])" --output text 2>/dev/null)"
      [ "${pending}" = "0" ] || [ -z "${pending}" ] || [ "${pending}" = "None" ] && break
      sleep 10
    done
    aws ec2 delete-vpn-gateway --region "${REGION}" --vpn-gateway-id "${vgw_id}" >/dev/null 2>&1
  done

  local vpc_id
  vpc_id="$(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:Name,Values=${VPC_TAG}" \
    --query 'Vpcs[0].VpcId' --output text 2>/dev/null)"
  if [ -n "${vpc_id}" ] && [ "${vpc_id}" != "None" ]; then
    local igw_id
    igw_id="$(aws ec2 describe-internet-gateways --region "${REGION}" \
      --filters "Name=attachment.vpc-id,Values=${vpc_id}" \
      --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null)"
    if [ -n "${igw_id}" ] && [ "${igw_id}" != "None" ]; then
      aws ec2 detach-internet-gateway --region "${REGION}" --internet-gateway-id "${igw_id}" --vpc-id "${vpc_id}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --region "${REGION}" --internet-gateway-id "${igw_id}" >/dev/null 2>&1
    fi
    for rtb_id in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'RouteTables[?Associations[0].Main != `true`].RouteTableId' --output text 2>/dev/null); do
      aws ec2 delete-route-table --region "${REGION}" --route-table-id "${rtb_id}" >/dev/null 2>&1
    done
    for subnet_id in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
      --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --region "${REGION}" --subnet-id "${subnet_id}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --region "${REGION}" --vpc-id "${vpc_id}" >/dev/null 2>&1
  fi

  # Prefix list LAST: a leftover pl- route in the route table above holds a
  # DependencyViolation on the prefix list, so it only frees up once the
  # route table / VPC family is gone.
  local pl_id
  pl_id="$(aws ec2 describe-managed-prefix-lists --region "${REGION}" \
    --filters "Name=prefix-list-name,Values=${PL_NAME}" \
    --query 'PrefixLists[0].PrefixListId' --output text 2>/dev/null)"
  if [ -n "${pl_id}" ] && [ "${pl_id}" != "None" ]; then
    aws ec2 delete-managed-prefix-list --region "${REGION}" --prefix-list-id "${pl_id}" >/dev/null 2>&1
  fi

  # Phase 2's SDK call log, left behind when a run fails before it is read.
  if [ -n "${P2_CALLS:-}" ]; then
    rm -f "${P2_CALLS}"
  fi

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

# --- Phase 1: deploy baseline (pl-route -> IGW, cidr-route -> TGW) ----------
echo "==> Phase 1: deploy (prefix-list route -> IGW, CIDR route -> TGW)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RTB_ID="$(aws ec2 describe-route-tables --region "${REGION}" \
  --filters "Name=tag:Name,Values=cdkd-route-targets-rtb" \
  --query 'RouteTables[0].RouteTableId' --output text)"
# State filter pins the FRESH prefix list — a leaked prior-run PL that the
# pre-run cleanup just async-deleted still lists as delete-in-progress under
# the same name and would otherwise win the [0] slot. The API's --filters
# does NOT accept a 'state' key (InvalidFilter), so filter client-side.
# contains() instead of a JMESPath '||' — the probe lint reads '||' inside
# a capture as a shell swallow tail.
PL_ID="$(aws ec2 describe-managed-prefix-lists --region "${REGION}" \
  --filters "Name=prefix-list-name,Values=${PL_NAME}" \
  --query 'PrefixLists[?contains(`["create-complete","modify-complete"]`, State)] | [0].PrefixListId' \
  --output text)"
TGW_ID="$(aws ec2 describe-transit-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=${TGW_TAG}" "Name=state,Values=available" \
  --query 'TransitGateways[0].TransitGatewayId' --output text)"
IGW_ID="$(aws ec2 describe-internet-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=cdkd-route-targets-igw" \
  --query 'InternetGateways[0].InternetGatewayId' --output text)"
echo "    rtb=${RTB_ID} pl=${PL_ID} tgw=${TGW_ID} igw=${IGW_ID}"
for v in "${RTB_ID}" "${PL_ID}" "${TGW_ID}" "${IGW_ID}"; do
  if [ -z "${v}" ] || [ "${v}" = "None" ]; then
    echo "FAIL: a Phase 1 resource lookup came back empty" >&2
    exit 1
  fi
done

# Bounded re-read: DescribeRouteTables is eventually consistent right after
# CreateRoute, so one read can miss a route the deploy just created. Both
# Phase 1 routes are read this way before the drift read-back below, which
# reads the same table through cdkd.
PL_ROUTE_TARGET_P1=""
for _ in 1 2 3 4 5 6; do
  PL_ROUTE_TARGET_P1="$(aws ec2 describe-route-tables --region "${REGION}" --route-table-ids "${RTB_ID}" \
    --query "RouteTables[0].Routes[?DestinationPrefixListId=='${PL_ID}'].GatewayId | [0]" --output text)"
  [ "${PL_ROUTE_TARGET_P1}" = "${IGW_ID}" ] && break
  sleep 5
done
if [ "${PL_ROUTE_TARGET_P1}" != "${IGW_ID}" ]; then
  echo "FAIL: prefix-list route target expected ${IGW_ID}, got '${PL_ROUTE_TARGET_P1}'" >&2
  exit 1
fi
echo "    prefix-list route present, targeting the IGW"

TGW_ROUTE_TARGET=""
for _ in 1 2 3 4 5 6; do
  TGW_ROUTE_TARGET="$(aws ec2 describe-route-tables --region "${REGION}" --route-table-ids "${RTB_ID}" \
    --query "RouteTables[0].Routes[?DestinationCidrBlock=='10.200.0.0/16'].TransitGatewayId | [0]" --output text)"
  [ "${TGW_ROUTE_TARGET}" = "${TGW_ID}" ] && break
  sleep 5
done
if [ "${TGW_ROUTE_TARGET}" != "${TGW_ID}" ]; then
  echo "FAIL: CIDR route TransitGatewayId expected ${TGW_ID}, got '${TGW_ROUTE_TARGET}'" >&2
  exit 1
fi
echo "    TGW-target route present (10.200.0.0/16 -> ${TGW_ID})"

# --- Issue #2762: the VPN gateway attachment is the SDK provider's ----------
VPC_ID="$(aws ec2 describe-vpcs --region "${REGION}" \
  --filters "Name=tag:Name,Values=${VPC_TAG}" \
  --query 'Vpcs[0].VpcId' --output text)"
VGW_ID="$(aws ec2 describe-vpn-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=${VGW_TAG}" "Name=state,Values=available" \
  --query 'VpnGateways[0].VpnGatewayId' --output text)"
for v in "${VPC_ID}" "${VGW_ID}"; do
  if [ -z "${v}" ] || [ "${v}" = "None" ]; then
    echo "FAIL: the VPC / VPN gateway lookup came back empty (vpc='${VPC_ID}' vgw='${VGW_ID}')" >&2
    exit 1
  fi
done
VGW_RECORD="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources;const k=Object.keys(r).find(x=>x.startsWith("VgwAttachment"));const e=k&&r[k];process.stdout.write(e?`${e.provisionedBy??"<absent>"} ${e.physicalId}`:"<missing>")})')"
# Before #2762 the template's VpnGatewayId routed the attachment through Cloud
# Control: `cc-api VGW|<vpcId>`. The SDK provider records the gateway id itself.
if [ "${VGW_RECORD}" != "sdk ${VGW_ID}|${VPC_ID}" ]; then
  echo "FAIL: VPN gateway attachment record expected 'sdk ${VGW_ID}|${VPC_ID}', got '${VGW_RECORD}' (issue #2762)" >&2
  exit 1
fi
echo "    VPN gateway attachment provisioned by the SDK provider (${VGW_RECORD})"
VGW_ATTACH_STATE="$(aws ec2 describe-vpn-gateways --region "${REGION}" --vpn-gateway-ids "${VGW_ID}" \
  --query "VpnGateways[0].VpcAttachments[?VpcId=='${VPC_ID}'].State | [0]" --output text)"
if [ "${VGW_ATTACH_STATE}" != "attached" ]; then
  echo "FAIL: VPN gateway ${VGW_ID} attachment to ${VPC_ID} expected 'attached' after deploy, got '${VGW_ATTACH_STATE}'" >&2
  exit 1
fi
VGW_ROUTE_TARGET=""
for _ in 1 2 3 4 5 6; do
  VGW_ROUTE_TARGET="$(aws ec2 describe-route-tables --region "${REGION}" --route-table-ids "${RTB_ID}" \
    --query "RouteTables[0].Routes[?DestinationCidrBlock=='10.210.0.0/16'].GatewayId | [0]" --output text)"
  [ "${VGW_ROUTE_TARGET}" = "${VGW_ID}" ] && break
  sleep 5
done
if [ "${VGW_ROUTE_TARGET}" != "${VGW_ID}" ]; then
  echo "FAIL: VPN gateway route GatewayId expected ${VGW_ID}, got '${VGW_ROUTE_TARGET}'" >&2
  exit 1
fi
echo "    VPN gateway attached and routed (10.210.0.0/16 -> ${VGW_ID})"

# The prefix-list route's state record must be keyed on the pl- destination.
PL_PHYSICAL_ID="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>x.startsWith("PrefixListRoute"));process.stdout.write((r[k]&&r[k].physicalId)||"")})')"
case "${PL_PHYSICAL_ID}" in
  *"|pl-"*) echo "    prefix-list route physicalId keyed on the prefix list (${PL_PHYSICAL_ID})" ;;
  *)
    echo "FAIL: prefix-list route physicalId expected '<rtb>|pl-...', got '${PL_PHYSICAL_ID}'" >&2
    exit 1
    ;;
esac

# Drift must read back clean — this exercises readRouteCurrentState's
# prefix-list matching + target-field surfacing against live AWS.
echo "==> Phase 1: drift read-back (expect no drift)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    drift clean after deploy"

# --- Phase 2: swap the prefix-list route's target IGW -> TGW ----------------
# Issue #5068: a target change is "Update requires: No interruption" in
# CloudFormation, served by one atomic ReplaceRoute. A DeleteRoute + CreateRoute
# leaves the route table without the route between the two calls, so the SDK
# call log pins which calls the update sent even when the timing does not bite.
echo "==> Phase 2: re-deploy swapping prefix-list route target to the TGW"
P2_CALLS="$(mktemp -t cdkd-route-targets-p2-calls.XXXXXX)"
# cdkd APPENDS one line at exit: start from no file, so its existence below
# proves the log took effect.
rm -f "${P2_CALLS}"
CDKD_SDK_CALL_LOG="${P2_CALLS}" CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ ! -s "${P2_CALLS}" ]; then
  echo "FAIL: the SDK call log ${P2_CALLS} was not written — CDKD_SDK_CALL_LOG did not take effect" >&2
  exit 1
fi
# Summed over every line (one per cdkd process); 0 when the command is absent.
p2_calls() { # <command name>
  node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(l.trim()==="")continue;n+=JSON.parse(l).counts["EC2Client."+process.argv[2]]??0}process.stdout.write(String(n))' "${P2_CALLS}" "$1"
}
P2_REPLACE="$(p2_calls ReplaceRouteCommand)"
P2_DELETE="$(p2_calls DeleteRouteCommand)"
P2_CREATE="$(p2_calls CreateRouteCommand)"
echo "    Phase 2 EC2 route calls: ReplaceRoute=${P2_REPLACE} DeleteRoute=${P2_DELETE} CreateRoute=${P2_CREATE}"
if [ "${P2_REPLACE}" != "1" ] || [ "${P2_DELETE}" != "0" ] || [ "${P2_CREATE}" != "0" ]; then
  echo "FAIL: the target swap must be exactly one ReplaceRoute and no DeleteRoute / CreateRoute (issue #5068)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
# Issue #5216: the VPN gateway swap is one in-place detach + attach, not a
# Cloud Control update and not a create-first replacement (which AWS refuses:
# one VPN gateway per VPC).
P2_VGW_DETACH="$(p2_calls DetachVpnGatewayCommand)"
P2_VGW_ATTACH="$(p2_calls AttachVpnGatewayCommand)"
echo "    Phase 2 VPN gateway calls: DetachVpnGateway=${P2_VGW_DETACH} AttachVpnGateway=${P2_VGW_ATTACH}"
if [ "${P2_VGW_DETACH}" != "1" ] || [ "${P2_VGW_ATTACH}" != "1" ]; then
  echo "FAIL: the VPN gateway swap must be exactly one DetachVpnGateway and one AttachVpnGateway (issue #5216)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
rm -f "${P2_CALLS}"
echo "    target swap sent one ReplaceRoute, no DeleteRoute / CreateRoute"

# The whole route entry for the prefix-list destination, as JSON ('null' when
# absent), and one field of it ('' when absent).
pl_route_entry() {
  aws ec2 describe-route-tables --region "${REGION}" --route-table-ids "${RTB_ID}" \
    --query "RouteTables[0].Routes[?DestinationPrefixListId=='${PL_ID}'] | [0]" --output json
}
route_field() { # <route entry JSON> <field>
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.trim()===""?"null":s);const v=r===null?undefined:r[process.argv[1]];process.stdout.write(v===undefined||v===null?"":String(v))})' "$2"
}
# Bounded read: EC2's describe APIs are eventually consistent.
PL_ROUTE_P2=""
for _ in 1 2 3 4 5 6; do
  PL_ROUTE_P2="$(pl_route_entry)"
  [ "$(route_field "${PL_ROUTE_P2}" TransitGatewayId)" = "${TGW_ID}" ] && break
  sleep 5
done
p2_route_fail() {
  echo "FAIL: after update, $1" >&2
  echo "    prefix-list route entry: ${PL_ROUTE_P2}" >&2
  exit 1
}
[ "$(route_field "${PL_ROUTE_P2}" TransitGatewayId)" = "${TGW_ID}" ] \
  || p2_route_fail "prefix-list route TransitGatewayId expected ${TGW_ID}"
[ -z "$(route_field "${PL_ROUTE_P2}" GatewayId)" ] \
  || p2_route_fail "prefix-list route still carries a GatewayId"
# A route ReplaceRoute rewrote keeps the origin of the CreateRoute that made it.
[ "$(route_field "${PL_ROUTE_P2}" Origin)" = "CreateRoute" ] \
  || p2_route_fail "prefix-list route Origin expected CreateRoute"
echo "    prefix-list route target swapped to the TGW"

VGW2_ID="$(aws ec2 describe-vpn-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=${VGW2_TAG}" "Name=state,Values=available" \
  --query 'VpnGateways[0].VpnGatewayId' --output text)"
if [ -z "${VGW2_ID}" ] || [ "${VGW2_ID}" = "None" ]; then
  echo "FAIL: the Phase 2 VPN gateway lookup came back empty" >&2
  exit 1
fi
VGW_RECORD_P2="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources;const k=Object.keys(r).find(x=>x.startsWith("VgwAttachment"));const e=k&&r[k];process.stdout.write(e?`${e.provisionedBy??"<absent>"} ${e.physicalId}`:"<missing>")})')"
if [ "${VGW_RECORD_P2}" != "sdk ${VGW2_ID}|${VPC_ID}" ]; then
  echo "FAIL: after the swap, VPN gateway attachment record expected 'sdk ${VGW2_ID}|${VPC_ID}', got '${VGW_RECORD_P2}' (issue #5216)" >&2
  exit 1
fi
VGW2_STATE="$(aws ec2 describe-vpn-gateways --region "${REGION}" --vpn-gateway-ids "${VGW2_ID}" \
  --query "VpnGateways[0].VpcAttachments[?VpcId=='${VPC_ID}'].State | [0]" --output text)"
VGW1_LIVE="$(aws ec2 describe-vpn-gateways --region "${REGION}" --vpn-gateway-ids "${VGW_ID}" \
  --query "length(not_null(VpnGateways[0].VpcAttachments, \`[]\`)[?State!='detached'])" --output text)"
if [ "${VGW2_STATE}" != "attached" ] || [ "${VGW1_LIVE}" != "0" ]; then
  echo "FAIL: after the swap expected ${VGW2_ID} attached and ${VGW_ID} detached, got '${VGW2_STATE}' / ${VGW1_LIVE} live attachment(s) on the old gateway" >&2
  exit 1
fi
echo "    VPN gateway attachment swapped in place (${VGW_ID} -> ${VGW2_ID})"

echo "==> Phase 2: drift read-back (expect no drift)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    drift clean after update"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

ATT_LEFT="$(aws ec2 describe-transit-gateway-vpc-attachments --region "${REGION}" \
  --filters "Name=tag:Name,Values=${TGW_ATTACHMENT_TAG}" "Name=state,Values=available,pending,modifying,deleting" \
  --query 'length(TransitGatewayVpcAttachments)' --output text)"
if [ "${ATT_LEFT}" != "0" ]; then
  echo "FAIL: TGW attachment still present after destroy (count=${ATT_LEFT})" >&2
  exit 1
fi
TGW_LEFT="$(aws ec2 describe-transit-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=${TGW_TAG}" "Name=state,Values=available,pending,modifying" \
  --query 'length(TransitGateways)' --output text)"
if [ "${TGW_LEFT}" != "0" ]; then
  echo "FAIL: TGW still present after destroy (count=${TGW_LEFT})" >&2
  exit 1
fi
PL_LEFT="$(aws ec2 describe-managed-prefix-lists --region "${REGION}" \
  --filters "Name=prefix-list-name,Values=${PL_NAME}" \
  --query 'length(PrefixLists)' --output text)"
if [ "${PL_LEFT}" != "0" ]; then
  echo "FAIL: prefix list still present after destroy (count=${PL_LEFT})" >&2
  exit 1
fi
VGW_LEFT="$(aws ec2 describe-vpn-gateways --region "${REGION}" \
  --filters "Name=tag:Name,Values=${VGW_TAG},${VGW2_TAG}" "Name=state,Values=available,pending" \
  --query 'length(VpnGateways)' --output text)"
if [ "${VGW_LEFT}" != "0" ]; then
  echo "FAIL: VPN gateway(s) still present after destroy (count=${VGW_LEFT})" >&2
  exit 1
fi
VPC_LEFT="$(aws ec2 describe-vpcs --region "${REGION}" \
  --filters "Name=tag:Name,Values=${VPC_TAG}" \
  --query 'length(Vpcs)' --output text)"
if [ "${VPC_LEFT}" != "0" ]; then
  echo "FAIL: VPC still present after destroy (count=${VPC_LEFT})" >&2
  exit 1
fi
echo "    TGW attachment, TGW, prefix list, VPN gateway, and VPC all gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — EC2 Route prefix-list destination + TGW target + VPN gateway attachment: deploy, target-swap update, drift read-back, and destroy all verified"
