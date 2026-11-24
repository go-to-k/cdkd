#!/usr/bin/env bash
# verify.sh — replacing a VPC gateway attachment and a subnet route table
# association (go-to-k/cdkd#6958).
#
# AWS allows one internet gateway per VPC and one route table association per
# subnet, so a create-first replacement is refused with
# `Resource.AlreadyAssociated`. cdkd replaces both delete-first, as
# CloudFormation does.
#
# Phases:
#   1. Deploy: the gateway Igw is attached to VpcA, the subnet is associated
#      with RtA, and the L2 VPC Net (10.62.0.0/16) has its gateway attached and
#      an active default route.
#   2. `cdkd diff --fail-on=destructive` with CDKD_TEST_UPDATE=move names Att
#      and RtAssoc as replacements whose old copy is deleted before the new one
#      is created.
#   3. Deploy CDKD_TEST_UPDATE=move: Igw is attached to VpcB (and only VpcB),
#      the subnet is associated with RtB, and both records got new ids.
#   4. Deploy CDKD_TEST_UPDATE=move,cidr: Net is replaced (10.63.0.0/16), its
#      gateway is attached to the new VPC with an active default route, and
#      the old VPC is gone.
#   5. Destroy: every VPC, both gateways and the state file are gone.
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

STACK="CdkdEc2AssociationReplaceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_doc() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - || return 1
}
output() { # $1 = output name
  local doc
  doc="$(state_doc)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${doc}"
}
physical_id() { # $1 = logical id
  local doc
  doc="$(state_doc)" || return 1
  jq -r --arg k "$1" '.resources[$k].physicalId // empty' <<<"${doc}"
}
igw_vpcs() { # $1 = gateway id -> its attached VPC ids, sorted, space-joined
  aws ec2 describe-internet-gateways --internet-gateway-ids "$1" --region "${REGION}" \
    --query "join(' ', sort(InternetGateways[0].Attachments[].VpcId || \`[]\`))" --output text || return 1
}
subnet_route_table() { # $1 = subnet id -> the route table explicitly associated with it
  aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$1" --region "${REGION}" \
    --query "join(' ', sort(RouteTables[].RouteTableId || \`[]\`))" --output text || return 1
}
vpc_cidr() { # $1 = VPC id
  aws ec2 describe-vpcs --vpc-ids "$1" --region "${REGION}" --query 'Vpcs[0].CidrBlock' --output text || return 1
}
default_route_state() { # $1 = subnet id -> the state of its route table's 0.0.0.0/0 route
  aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$1" --region "${REGION}" \
    --query "join(' ', RouteTables[].Routes[] | [?DestinationCidrBlock=='0.0.0.0/0'].State)" --output text || return 1
}
expect_eq() { # $1 = what, $2 = got, $3 = want
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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
CLEANED_UP=0

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VPC_A="$(output VpcAId)"
VPC_B="$(output VpcBId)"
IGW="$(output IgwId)"
SUBNET="$(output SubnetId)"
RT_A="$(output RtAId)"
RT_B="$(output RtBId)"
NET_VPC_OLD="$(output NetVpcId)"
NET_IGW="$(output NetIgwId)"
NET_SUBNET_OLD="$(output NetSubnetId)"
for v in "${VPC_A}" "${VPC_B}" "${IGW}" "${SUBNET}" "${RT_A}" "${RT_B}" "${NET_VPC_OLD}" "${NET_IGW}" "${NET_SUBNET_OLD}"; do
  case "${v}" in
    vpc-?* | igw-?* | subnet-?* | rtb-?*) ;;
    *) echo "FAIL: an output id is '${v}'" >&2; exit 1 ;;
  esac
done
ATT_ID_1="$(physical_id Att)"
ASSOC_ID_1="$(physical_id RtAssoc)"
expect_eq "Igw's attached VPCs" "$(igw_vpcs "${IGW}")" "${VPC_A}"
expect_eq "the subnet's route table" "$(subnet_route_table "${SUBNET}")" "${RT_A}"
expect_eq "Net's gateway's attached VPCs" "$(igw_vpcs "${NET_IGW}")" "${NET_VPC_OLD}"
expect_eq "Net's CIDR" "$(vpc_cidr "${NET_VPC_OLD}")" "10.62.0.0/16"
expect_eq "Net's default route" "$(default_route_state "${NET_SUBNET_OLD}")" "active"
echo "    Igw on ${VPC_A}, subnet on ${RT_A}, Net ${NET_VPC_OLD} routed through ${NET_IGW}"

# --- Phase 2: the plan names the delete-first order ---------------------------
echo "==> Phase 2: cdkd diff --fail-on=destructive (CDKD_TEST_UPDATE=move)"
set +e
diff_out=$(CDKD_TEST_UPDATE=move node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail-on=destructive </dev/null 2>&1)
diff_rc=$?
set -e
diff_txt=$(printf '%s' "${diff_out}" | sed $'s/\033\[[0-9;]*m//g')
for id in Att RtAssoc; do
  # Sentinel: the replacement line itself, independent of the note.
  if ! grep -q "${id} will be replaced" <<<"${diff_txt}"; then
    echo "FAIL: cdkd diff --fail-on=destructive listed no replacement of ${id}" >&2
    echo "${diff_txt}" >&2
    exit 1
  fi
  if ! grep -q "${id} will be replaced — the deploy deletes the old resource before creating its replacement" <<<"${diff_txt}"; then
    echo "FAIL: ${id}'s replacement line does not say the old one is deleted first (issue #6958)" >&2
    echo "${diff_txt}" >&2
    exit 1
  fi
done
if [ "${diff_rc}" -ne 1 ]; then
  echo "FAIL: diff --fail-on=destructive exited ${diff_rc}, expected 1" >&2
  echo "${diff_txt}" >&2
  exit 1
fi
echo "    Att and RtAssoc are listed as delete-first replacements"

# --- Phase 3: move the attachment and the association -------------------------
echo "==> Phase 3: deploy CDKD_TEST_UPDATE=move"
CDKD_TEST_UPDATE=move node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
expect_eq "Igw's attached VPCs after the move" "$(igw_vpcs "${IGW}")" "${VPC_B}"
expect_eq "the subnet's route table after the move" "$(subnet_route_table "${SUBNET}")" "${RT_B}"
ATT_ID_2="$(physical_id Att)"
ASSOC_ID_2="$(physical_id RtAssoc)"
if [ -z "${ATT_ID_2}" ] || [ "${ATT_ID_2}" = "${ATT_ID_1}" ]; then
  echo "FAIL: Att's record was not replaced ('${ATT_ID_1}' -> '${ATT_ID_2}')" >&2
  exit 1
fi
if [ -z "${ASSOC_ID_2}" ] || [ "${ASSOC_ID_2}" = "${ASSOC_ID_1}" ]; then
  echo "FAIL: RtAssoc's record was not replaced ('${ASSOC_ID_1}' -> '${ASSOC_ID_2}')" >&2
  exit 1
fi
echo "    Igw moved to ${VPC_B}, subnet moved to ${RT_B}"

# --- Phase 4: replace the L2 VPC ---------------------------------------------
echo "==> Phase 4: deploy CDKD_TEST_UPDATE=move,cidr (Net's CIDR changes)"
CDKD_TEST_UPDATE=move,cidr node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
NET_VPC_NEW="$(output NetVpcId)"
NET_SUBNET_NEW="$(output NetSubnetId)"
case "${NET_VPC_NEW}" in
  vpc-?*) ;;
  *) echo "FAIL: Net's VPC id after the CIDR change is '${NET_VPC_NEW}'" >&2; exit 1 ;;
esac
if [ "${NET_VPC_NEW}" = "${NET_VPC_OLD}" ]; then
  echo "FAIL: Net's VPC was not replaced (${NET_VPC_OLD})" >&2
  exit 1
fi
expect_eq "Net's gateway id" "$(output NetIgwId)" "${NET_IGW}"
expect_eq "Net's CIDR after the change" "$(vpc_cidr "${NET_VPC_NEW}")" "10.63.0.0/16"
expect_eq "Net's gateway's attached VPCs after the change" "$(igw_vpcs "${NET_IGW}")" "${NET_VPC_NEW}"
expect_eq "Net's default route after the change" "$(default_route_state "${NET_SUBNET_NEW}")" "active"
assert_gone "Net's old VPC ${NET_VPC_OLD} still exists after its replacement" \
  aws ec2 describe-vpcs --vpc-ids "${NET_VPC_OLD}" --region "${REGION}"
# The L1 arm is untouched by this deploy.
expect_eq "Igw's attached VPCs after the CIDR change" "$(igw_vpcs "${IGW}")" "${VPC_B}"
echo "    Net replaced (${NET_VPC_OLD} -> ${NET_VPC_NEW}), ${NET_IGW} re-attached, old VPC gone"

# --- Phase 5: destroy --------------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for vpc in "${VPC_A}" "${VPC_B}" "${NET_VPC_NEW}"; do
  assert_gone "VPC ${vpc} still exists after destroy" \
    aws ec2 describe-vpcs --vpc-ids "${vpc}" --region "${REGION}"
done
for gw in "${IGW}" "${NET_IGW}"; do
  assert_gone "internet gateway ${gw} still exists after destroy" \
    aws ec2 describe-internet-gateways --internet-gateway-ids "${gw}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "[verify] PASS — gateway attachment and route table association replaced delete-first (move), Net's VPC replaced on a CIDR change with its gateway re-attached, destroyed clean"
