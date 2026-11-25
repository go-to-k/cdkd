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
#   4b. CDKD_TEST_UPDATE=move,cidr,eip replaces the instance in VpcC, so its
#      Elastic IP association EipAssoc is replaced (go-to-k/cdkd#6990): the
#      diff names it a delete-first replacement, the deploy succeeds, and the
#      Elastic IP is associated with the new instance. Every later phase keeps
#      the eip token.
#   5. Deploy CDKD_TEST_UPDATE=move,cidr,eip,failatt (Att -> VpcC, which already
#      holds IgwC): cdkd deletes the old attachment first, AWS refuses the new
#      one, the deploy fails, and the automatic rollback re-creates the old
#      attachment (issue #6958): Igw is attached to VpcB again, IgwC to VpcC,
#      and state's Att names that attachment.
#   6. Deploy CDKD_TEST_UPDATE=move,cidr,eip,failassoc (RtAssoc -> RtC, a route
#      table of another VPC): the same, for the association: the subnet is
#      associated with RtB again and state's RtAssoc names that association.
#   7. `cdkd diff --fail` of move,cidr,eip reports no changes, and `cdkd drift`
#      reports none of Att, RtAssoc and EipAssoc drifted.
#   8. Destroy: every VPC, every gateway, the Elastic IP and the state file are
#      gone.
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
subnet_association_id() { # $1 = subnet id -> its explicit route table association id
  aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$1" --region "${REGION}" \
    --query "join(' ', RouteTables[].Associations[] | [?SubnetId=='$1'].RouteTableAssociationId)" --output text || return 1
}
default_route_state() { # $1 = subnet id -> the state of its route table's 0.0.0.0/0 route
  aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$1" --region "${REGION}" \
    --query "join(' ', RouteTables[].Routes[] | [?DestinationCidrBlock=='0.0.0.0/0'].State)" --output text || return 1
}
eip_instance() { # $1 = allocation id -> the instance it is associated with
  aws ec2 describe-addresses --allocation-ids "$1" --region "${REGION}" \
    --query 'Addresses[0].InstanceId' --output text || return 1
}
instance_state() { # $1 = instance id
  aws ec2 describe-instances --instance-ids "$1" --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text || return 1
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
VPC_C="$(output VpcCId)"
IGW_C="$(output IgwCId)"
INST_OLD="$(output InstId)"
EIP_ALLOC="$(output EipAllocationId)"
for v in "${INST_OLD}" "${EIP_ALLOC}" "${VPC_C}" "${IGW_C}" "${VPC_A}" "${VPC_B}" "${IGW}" "${SUBNET}" "${RT_A}" "${RT_B}" "${NET_VPC_OLD}" "${NET_IGW}" "${NET_SUBNET_OLD}"; do
  case "${v}" in
    vpc-?* | igw-?* | subnet-?* | rtb-?* | i-?* | eipalloc-?*) ;;
    *) echo "FAIL: an output id is '${v}'" >&2; exit 1 ;;
  esac
done
ATT_ID_1="$(physical_id Att)"
ASSOC_ID_1="$(physical_id RtAssoc)"
EIP_ASSOC_ID_1="$(physical_id EipAssoc)"
expect_eq "the Elastic IP's instance" "$(eip_instance "${EIP_ALLOC}")" "${INST_OLD}"
expect_eq "Igw's attached VPCs" "$(igw_vpcs "${IGW}")" "${VPC_A}"
expect_eq "IgwC's attached VPCs" "$(igw_vpcs "${IGW_C}")" "${VPC_C}"
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

# --- Phase 4b: replace the instance holding the Elastic IP -------------------
echo "==> Phase 4b: cdkd diff + deploy CDKD_TEST_UPDATE=move,cidr,eip (the instance is replaced)"
set +e
diff_out=$(CDKD_TEST_UPDATE=move,cidr,eip node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail-on=destructive </dev/null 2>&1)
diff_rc=$?
set -e
diff_txt=$(printf '%s' "${diff_out}" | sed $'s/\033\[[0-9;]*m//g')
# Sentinel: the replacement line itself, independent of the note.
if ! grep -q "EipAssoc will be replaced" <<<"${diff_txt}"; then
  echo "FAIL: cdkd diff --fail-on=destructive listed no replacement of EipAssoc" >&2
  echo "${diff_txt}" >&2
  exit 1
fi
if ! grep -q "EipAssoc will be replaced — the deploy deletes the old resource before creating its replacement" <<<"${diff_txt}"; then
  echo "FAIL: EipAssoc's replacement line does not say the old one is deleted first (issue #6990)" >&2
  echo "${diff_txt}" >&2
  exit 1
fi
expect_eq "diff --fail-on=destructive exit code for the eip change" "${diff_rc}" "1"
eip_out=$(CDKD_TEST_UPDATE=move,cidr,eip node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes </dev/null 2>&1) || {
  echo "FAIL: the eip deploy failed (issue #6990: a create-first association is refused)" >&2
  echo "${eip_out}" >&2
  exit 1
}
if ! grep -q "allows one link at a time — deleting old EipAssoc" <<<"${eip_out}"; then
  echo "FAIL: the eip deploy did not replace EipAssoc delete-first" >&2
  echo "${eip_out}" >&2
  exit 1
fi
INST_NEW="$(output InstId)"
case "${INST_NEW}" in
  i-?*) ;;
  *) echo "FAIL: the instance id after the eip deploy is '${INST_NEW}'" >&2; exit 1 ;;
esac
if [ "${INST_NEW}" = "${INST_OLD}" ]; then
  echo "FAIL: the instance was not replaced (${INST_OLD})" >&2
  exit 1
fi
expect_eq "the Elastic IP's instance after the replacement" "$(eip_instance "${EIP_ALLOC}")" "${INST_NEW}"
EIP_ASSOC_ID_2="$(physical_id EipAssoc)"
if [ -z "${EIP_ASSOC_ID_2}" ] || [ "${EIP_ASSOC_ID_2}" = "${EIP_ASSOC_ID_1}" ]; then
  echo "FAIL: EipAssoc's record was not replaced ('${EIP_ASSOC_ID_1}' -> '${EIP_ASSOC_ID_2}')" >&2
  exit 1
fi
old_state="$(instance_state "${INST_OLD}")"
case "${old_state}" in
  shutting-down | terminated) ;;
  *) echo "FAIL: the old instance ${INST_OLD} is '${old_state}' after its replacement" >&2; exit 1 ;;
esac
echo "    the instance was replaced (${INST_OLD} -> ${INST_NEW}) and the Elastic IP followed it"

# --- Phase 5: a refused re-attach is rolled back ------------------------------
echo "==> Phase 5: deploy CDKD_TEST_UPDATE=move,cidr,eip,failatt (expected to fail and roll back)"
set +e
fail_out=$(CDKD_TEST_UPDATE=move,cidr,eip,failatt node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes </dev/null 2>&1)
fail_rc=$?
set -e
if [ "${fail_rc}" -eq 0 ]; then
  echo "FAIL: the failatt deploy succeeded; AWS should refuse a second gateway on ${VPC_C}" >&2
  echo "${fail_out}" >&2
  exit 1
fi
# Sentinel: the forward deleted the old attachment first; without that line
# the assertions below would pass on a deploy that never touched it.
if ! grep -q "allows one link at a time — deleting old Att" <<<"${fail_out}"; then
  echo "FAIL: the failatt deploy did not replace Att delete-first" >&2
  echo "${fail_out}" >&2
  exit 1
fi
expect_eq "Igw's attached VPCs after the rolled-back failatt deploy" "$(igw_vpcs "${IGW}")" "${VPC_B}"
expect_eq "IgwC's attached VPCs after the failatt deploy" "$(igw_vpcs "${IGW_C}")" "${VPC_C}"
expect_eq "state's Att record after the rollback" "$(physical_id Att)" "${ATT_ID_2}"
echo "    the refused attach was rolled back: Igw is attached to ${VPC_B} again"

# --- Phase 6: a refused re-association is rolled back -------------------------
echo "==> Phase 6: deploy CDKD_TEST_UPDATE=move,cidr,eip,failassoc (expected to fail and roll back)"
set +e
fail_out=$(CDKD_TEST_UPDATE=move,cidr,eip,failassoc node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes </dev/null 2>&1)
fail_rc=$?
set -e
if [ "${fail_rc}" -eq 0 ]; then
  echo "FAIL: the failassoc deploy succeeded; AWS should refuse a route table of another VPC" >&2
  echo "${fail_out}" >&2
  exit 1
fi
if ! grep -q "allows one link at a time — deleting old RtAssoc" <<<"${fail_out}"; then
  echo "FAIL: the failassoc deploy did not replace RtAssoc delete-first" >&2
  echo "${fail_out}" >&2
  exit 1
fi
expect_eq "the subnet's route table after the rolled-back failassoc deploy" "$(subnet_route_table "${SUBNET}")" "${RT_B}"
ASSOC_ID_3="$(physical_id RtAssoc)"
expect_eq "state's RtAssoc record after the rollback" "${ASSOC_ID_3}" "$(subnet_association_id "${SUBNET}")"
if [ "${ASSOC_ID_3}" = "${ASSOC_ID_2}" ]; then
  echo "FAIL: state's RtAssoc still names the association the deploy deleted (${ASSOC_ID_2})" >&2
  exit 1
fi
echo "    the refused association was rolled back: the subnet is on ${RT_B} again (${ASSOC_ID_3})"

# --- Phase 7: state matches the last good version ------------------------------
echo "==> Phase 7: cdkd diff --fail and cdkd drift after the rollbacks"
set +e
diff_out=$(CDKD_TEST_UPDATE=move,cidr,eip node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail </dev/null 2>&1)
diff_rc=$?
set -e
if [ "${diff_rc}" -ne 0 ] || ! grep -q "No changes detected for stack ${STACK}" <<<"${diff_out}"; then
  echo "FAIL: cdkd diff --fail after the rollbacks exited ${diff_rc}; expected 0 and no changes" >&2
  echo "${diff_out}" >&2
  exit 1
fi
set +e
drift_out=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
set -e
if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' <<<"${drift_out}" 2>/dev/null)" != "yes" ]; then
  echo "FAIL: cdkd drift --json produced no stack report: ${drift_out}" >&2
  exit 1
fi
drifted=$(jq '[.[].drifted[] | select(.logicalId == "Att" or .logicalId == "RtAssoc" or .logicalId == "EipAssoc")] | length' <<<"${drift_out}")
expect_eq "drifted Att / RtAssoc / EipAssoc after the rollbacks" "${drifted}" "0"
echo "    no changes, no drift"

# --- Phase 8: destroy --------------------------------------------------------
echo "==> Phase 8: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for vpc in "${VPC_A}" "${VPC_B}" "${VPC_C}" "${NET_VPC_NEW}"; do
  assert_gone "VPC ${vpc} still exists after destroy" \
    aws ec2 describe-vpcs --vpc-ids "${vpc}" --region "${REGION}"
done
for gw in "${IGW}" "${IGW_C}" "${NET_IGW}"; do
  assert_gone "internet gateway ${gw} still exists after destroy" \
    aws ec2 describe-internet-gateways --internet-gateway-ids "${gw}" --region "${REGION}"
done
assert_gone "Elastic IP ${EIP_ALLOC} still exists after destroy" \
  aws ec2 describe-addresses --allocation-ids "${EIP_ALLOC}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "[verify] PASS — gateway attachment and route table association replaced delete-first (move), Net's VPC replaced on a CIDR change with its gateway re-attached, an instance replaced with its Elastic IP association re-created delete-first, refused re-attach and re-association rolled back to the old links, destroyed clean"
