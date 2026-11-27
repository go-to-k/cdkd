#!/usr/bin/env bash
# verify.sh - cdkd ec2-vpc integ + removal of the VPC DNS attributes (#1160).
#
# Deploys the ec2-vpc fixture, then redeploys with CDKD_TEST_REMOVAL=true,
# where both VPCs drop EnableDnsHostnames and EnableDnsSupport. CloudFormation
# resets each removed attribute to the VPC default (measured A/B, us-east-1:
# hostnames true -> false, support false -> true), while ModifyVpcAttribute
# changes only the attribute it is sent. The same deploy changes the NACL
# entry AllowHTTPIn's action and CIDR, asserted to be one in-place
# ReplaceNetworkAclEntry with no DeleteNetworkAclEntry / CreateNetworkAclEntry
# (the SDK call log, issue #5070). It also drops `VPCs` whole from a private
# hosted zone: CloudFormation keeps every association (A/B, us-east-1), so
# cdkd must send no DisassociateVPCFromHostedZone, keep the zone on the VPC,
# and print one warning naming the kept associations (issue #1160). It also
# changes one tag and drops another on the IGW, the public RouteTable and the
# custom NACL, asserted in place on the same physical ids (issue #5448), and
# changes two VPCs' InstanceTenancy: a removal from dedicated is one in-place
# ModifyVpcTenancy, default -> dedicated replaces the VPC (issue #5449). A
# fifth VPC carries VpcEncryptionControl, read back after create on the SDK
# path (issue #5633). Then destroys clean.
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

STACK="Ec2VpcStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Phase 2's SDK call log and deploy log, left behind when a run fails
  # before they are read.
  if [ -n "${DRIFT_JSON:-}" ]; then
    rm -f "${DRIFT_JSON}"
  fi
  if [ -n "${P2_CALLS_DIR:-}" ]; then
    rm -f "${P2_CALLS_DIR}/calls.jsonl" "${P2_CALLS_DIR}/deploy.log"
    rmdir "${P2_CALLS_DIR}" 2>/dev/null
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Prints "<hostnames>/<support>" for a VPC, e.g. "True/False".
dns_attrs() { # usage: dns_attrs <vpc-id>
  local h s
  h=$(aws ec2 describe-vpc-attribute --vpc-id "$1" --attribute enableDnsHostnames \
    --region "${REGION}" --query EnableDnsHostnames.Value --output text) || return 1
  s=$(aws ec2 describe-vpc-attribute --vpc-id "$1" --attribute enableDnsSupport \
    --region "${REGION}" --query EnableDnsSupport.Value --output text) || return 1
  printf '%s/%s' "${h}" "${s}"
}

# Prints a resource's physical id from the cdkd state record.
physical_id() { # usage: physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "$1" '.resources[$l].physicalId // empty'
}

# The physical id of the ingress NACL entry at rule 100 (AllowHTTPIn), from
# the cdkd state record: `<aclId>|100|false`.
nacl_entry_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '[.resources[]
    | select(.resourceType == "AWS::EC2::NetworkAclEntry")
    | select(.physicalId | endswith("|100|false")) | .physicalId] | .[0] // empty'
}
# The live entry as JSON ('null' when absent), and one field of it ('' when absent).
nacl_entry() { # usage: nacl_entry <acl-id>
  aws ec2 describe-network-acls --region "${REGION}" --network-acl-ids "$1" \
    --query "NetworkAcls[0].Entries[?RuleNumber==\`100\` && Egress==\`false\`] | [0]" --output json
}
entry_field() { # usage: entry_field <entry JSON> <field>
  printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.trim()===""?"null":s);const v=r===null?undefined:r[process.argv[1]];process.stdout.write(v===undefined||v===null?"":String(v))})' "$2"
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

MAIN_VPC=$(physical_id Vpc8378EB38)
OFF_VPC=$(physical_id DnsOffVpc)
if [ -z "${MAIN_VPC}" ] || [ -z "${OFF_VPC}" ]; then
  echo "FAIL: VPC physical ids missing from state: Vpc8378EB38='${MAIN_VPC}' DnsOffVpc='${OFF_VPC}'" >&2
  exit 1
fi
# Issue #1160 baseline: each VPC holds a non-default attribute first, so the
# default afterwards is the removal's doing.
MAIN_DNS=$(dns_attrs "${MAIN_VPC}")
OFF_DNS=$(dns_attrs "${OFF_VPC}")
if [ "${MAIN_DNS}" != "True/True" ] || [ "${OFF_DNS}" != "False/False" ]; then
  echo "FAIL: DNS hostnames/support after create: ${MAIN_VPC}='${MAIN_DNS}' (expected True/True), ${OFF_VPC}='${OFF_DNS}' (expected False/False)" >&2
  exit 1
fi
echo "    OK: baseline DNS hostnames/support True/True and False/False"

# Issue #5449 baseline: TenancyDownVpc is dedicated and TenancyUpVpc default
# first, so default / dedicated afterwards are the Phase 2 update's doing.
tenancy() { # usage: tenancy <vpc-id>
  aws ec2 describe-vpcs --vpc-ids "$1" --region "${REGION}" --query 'Vpcs[0].InstanceTenancy' --output text
}
DOWN_VPC=$(physical_id TenancyDownVpc)
UP_VPC=$(physical_id TenancyUpVpc)
if [ -z "${DOWN_VPC}" ] || [ -z "${UP_VPC}" ]; then
  echo "FAIL: tenancy VPC physical ids missing from state: TenancyDownVpc='${DOWN_VPC}' TenancyUpVpc='${UP_VPC}' (issue #5449)" >&2
  exit 1
fi
P1_DOWN_TENANCY=$(tenancy "${DOWN_VPC}") || P1_DOWN_TENANCY="<describe-vpcs failed>"
P1_UP_TENANCY=$(tenancy "${UP_VPC}") || P1_UP_TENANCY="<describe-vpcs failed>"
if [ "${P1_DOWN_TENANCY}" != "dedicated" ] || [ "${P1_UP_TENANCY}" != "default" ]; then
  echo "FAIL: InstanceTenancy after create: ${DOWN_VPC}='${P1_DOWN_TENANCY}' (expected dedicated), ${UP_VPC}='${P1_UP_TENANCY}' (expected default) (issue #5449)" >&2
  exit 1
fi
echo "    OK: baseline InstanceTenancy dedicated on ${DOWN_VPC}, default on ${UP_VPC}"

# Issue #5633: VpcEncryptionControl reached CreateVpc on the SDK path. The
# route guard comes first: Cloud Control applies the control too, so only
# `provisionedBy` tells the SDK wiring from the auto-route it replaced.
ENC_VPC=$(physical_id EncryptedVpc)
if [ -z "${ENC_VPC}" ]; then
  echo "FAIL: EncryptedVpc physical id missing from state (issue #5633)" >&2
  exit 1
fi
ENC_ROUTE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.EncryptedVpc.provisionedBy // "sdk"')
if [ "${ENC_ROUTE}" != "sdk" ]; then
  echo "FAIL: EncryptedVpc was provisioned by '${ENC_ROUTE}', expected the SDK provider (issue #5633)" >&2
  exit 1
fi
ENC_CONTROL=$(aws ec2 describe-vpcs --vpc-ids "${ENC_VPC}" --region "${REGION}" \
  --query 'Vpcs[0].EncryptionControl.[Mode, ResourceExclusions.InternetGateway.State, ResourceExclusions.Lambda.State]' \
  --output text 2>&1) || {
  echo "FAIL: describe-vpcs ${ENC_VPC} failed: ${ENC_CONTROL} (issue #5633)" >&2
  exit 1
}
if [ "${ENC_CONTROL}" != "$(printf 'enforce\tenabled\tdisabled')" ]; then
  echo "FAIL: ${ENC_VPC} encryption control mode/igw-exclusion/lambda-exclusion is '${ENC_CONTROL}', expected enforce/enabled/disabled (issue #5633)" >&2
  exit 1
fi
echo "    OK: ${ENC_VPC} created on the SDK path with encryption control enforce, internet-gateway exclusion enabled (issue #5633)"

# Issue #5633: `cdkd drift` reads the control back through the SDK provider's
# readCurrentState; the VPC must be compared and CLEAN right after the deploy.
DRIFT_JSON="$(mktemp -t cdkd-ec2-vpc-drift.XXXXXX)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_JSON}"
DRIFT_RC=$?
set -e
ENC_CLEAN=$(jq '[.[].clean[] | select(.logicalId == "EncryptedVpc")] | length' "${DRIFT_JSON}") || ENC_CLEAN="?"
if [ "${ENC_CLEAN}" != "1" ]; then
  echo "FAIL: EncryptedVpc is not drift-clean right after the deploy (clean=${ENC_CLEAN} rc=${DRIFT_RC}); the VpcEncryptionControl read-back disagrees with the record (issue #5633):" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    OK: EncryptedVpc reads back drift-clean (issue #5633)"

# Issue #1160 baseline: the private zone is associated with the main VPC
# only, so an association still there after the removal is the keep.
zone_vpcs() { # usage: zone_vpcs <zone-id> -> sorted VPC ids, space-separated
  aws route53 get-hosted-zone --id "$1" --query 'VPCs[].VPCId' --output text | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'
}
ZONE_ID=$(physical_id PrivateZone)
ZONE_ID="${ZONE_ID##*/}"
if [ -z "${ZONE_ID}" ]; then
  echo "FAIL: PrivateZone physical id missing from state" >&2
  exit 1
fi
P1_ZONE_VPCS=$(zone_vpcs "${ZONE_ID}")
if [ "${P1_ZONE_VPCS}" != "${MAIN_VPC}" ]; then
  echo "FAIL: private zone ${ZONE_ID} after create is associated with '${P1_ZONE_VPCS}', expected '${MAIN_VPC}'" >&2
  exit 1
fi
echo "    OK: baseline private zone ${ZONE_ID} is associated with ${MAIN_VPC}"

# Issue #5070 baseline: the entry allows 0.0.0.0/0 first, so deny and
# 10.0.0.0/8 afterwards are the Phase 2 update's doing.
ENTRY_ID=$(nacl_entry_id)
NACL_ID="${ENTRY_ID%%|*}"
if [ -z "${ENTRY_ID}" ] || [ "${NACL_ID}" = "${ENTRY_ID}" ]; then
  echo "FAIL: no AWS::EC2::NetworkAclEntry with a '<aclId>|100|false' physical id in state (got '${ENTRY_ID}')" >&2
  exit 1
fi
P1_ENTRY=$(nacl_entry "${NACL_ID}")
if [ "$(entry_field "${P1_ENTRY}" RuleAction)" != "allow" ] || [ "$(entry_field "${P1_ENTRY}" CidrBlock)" != "0.0.0.0/0" ]; then
  echo "FAIL: NACL entry ${ENTRY_ID} after create: expected allow 0.0.0.0/0, got ${P1_ENTRY}" >&2
  exit 1
fi
echo "    OK: baseline NACL entry ${ENTRY_ID} allows 0.0.0.0/0"

# Issue #5448 baseline: the IGW, the public RouteTable and the custom NACL
# carry cdkd-5448=one and cdkd-5448-gone=x first, so 'two' and no
# cdkd-5448-gone afterwards are the Phase 2 update's doing.
TAGGED_LOGICAL_IDS="VpcIGWD7BA715C VpcPublicSubnet1RouteTable6C95E38E CustomNacl7930CF70"
# Prints "<cdkd-5448>/<cdkd-5448-gone>" for a resource, '' for an absent tag.
tag_pair() { # usage: tag_pair <resource-id>
  local v g
  v=$(aws ec2 describe-tags --region "${REGION}" --filters "Name=resource-id,Values=$1" "Name=key,Values=cdkd-5448" \
    --query 'Tags[0].Value' --output text) || return 1
  g=$(aws ec2 describe-tags --region "${REGION}" --filters "Name=resource-id,Values=$1" "Name=key,Values=cdkd-5448-gone" \
    --query 'Tags[0].Value' --output text) || return 1
  [ "${v}" = "None" ] && v=""
  [ "${g}" = "None" ] && g=""
  printf '%s/%s' "${v}" "${g}"
}
P1_TAGGED_IDS=""
for lid in ${TAGGED_LOGICAL_IDS}; do
  pid=$(physical_id "${lid}")
  if [ -z "${pid}" ]; then
    echo "FAIL: ${lid} physical id missing from state (issue #5448)" >&2
    exit 1
  fi
  pair=""
  for _ in 1 2 3 4 5 6; do
    pair=$(tag_pair "${pid}") || pair="<describe-tags failed>"
    [ "${pair}" = "one/x" ] && break
    sleep 5
  done
  if [ "${pair}" != "one/x" ]; then
    echo "FAIL: ${lid} (${pid}) after create: cdkd-5448/cdkd-5448-gone='${pair}', expected 'one/x' (issue #5448)" >&2
    exit 1
  fi
  P1_TAGGED_IDS="${P1_TAGGED_IDS}${P1_TAGGED_IDS:+ }${pid}"
done
echo "    OK: baseline tags one/x on ${P1_TAGGED_IDS}"

# go-to-k/cdkd#7099 baseline: the interface holds its primary 10.0.0.200
# only, so 10.0.0.201 afterwards is the Phase 2 update's doing.
eni_addresses() { # usage: eni_addresses <eni-id> -> "<addr>:<primary>" sorted, space-separated
  aws ec2 describe-network-interfaces --region "${REGION}" --network-interface-ids "$1" \
    --query 'NetworkInterfaces[0].PrivateIpAddresses[].[PrivateIpAddress,Primary]' --output text |
    awk '{print $1 ":" tolower($2)}' | sort | tr '\n' ' ' | sed 's/ $//'
}
ENI_ID=$(physical_id SecondaryIpEni)
case "${ENI_ID}" in eni-?*) ;; *) echo "FAIL: SecondaryIpEni physical id missing from state (got '${ENI_ID}') (issue #7099)" >&2; exit 1 ;; esac
P1_ENI=$(eni_addresses "${ENI_ID}") || P1_ENI="<describe-network-interfaces failed>"
if [ "${P1_ENI}" != "10.0.0.200:true" ]; then
  echo "FAIL: ${ENI_ID} after create holds '${P1_ENI}', expected the primary 10.0.0.200 only (issue #7099)" >&2
  exit 1
fi
echo "    OK: baseline ${ENI_ID} holds its primary 10.0.0.200 only"

# --- Phase 2: REMOVAL drops both DNS attributes (issue #1160) ---------
echo "==> Phase 2: removal (drop EnableDnsHostnames, EnableDnsSupport from both VPCs; change the NACL entry; drop the private zone's VPCs)"
# A private directory, so nothing can pre-place the path cdkd appends to; the
# file starts absent, so its existence below proves the log took effect.
P2_CALLS_DIR="$(mktemp -d -t cdkd-ec2-vpc-p2-calls.XXXXXX)"
P2_CALLS="${P2_CALLS_DIR}/calls.jsonl"
# The deploy's own output too, for the issue #1160 warning (pipefail keeps
# the deploy's exit code).
P2_LOG="${P2_CALLS_DIR}/deploy.log"
set +e
CDKD_SDK_CALL_LOG="${P2_CALLS}" CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${P2_LOG}"
P2_RC=${PIPESTATUS[0]}
set -e
if [ "${P2_RC}" -ne 0 ]; then
  # go-to-k/cdkd#7099: Cloud Control left the interface's added secondary
  # address unapplied and cdkd did not apply it through EC2 (#7115 fails the
  # update with this tag).
  if grep -qF '[cc-silent-noop]' "${P2_LOG}"; then
    echo "FAIL: Phase 2 failed with [cc-silent-noop]: Cloud Control left a change unapplied and cdkd did not apply it; CloudFormation adds the SecondaryIpEni secondary address in place (issue #7099)" >&2
    grep -F '[cc-silent-noop]' "${P2_LOG}" >&2
    exit 1
  fi
  # Issue #5448: a tag change on these three was refused as not updatable.
  if grep -qE 'AWS::EC2::(InternetGateway|RouteTable|NetworkAcl) \([^)]*\) cannot be updated in place' "${P2_LOG}"; then
    echo "FAIL: Phase 2 refused an in-place tag change on an InternetGateway / RouteTable / NetworkAcl; CloudFormation applies it in place (issue #5448)" >&2
    exit 1
  fi
  echo "FAIL: Phase 2 deploy exited ${P2_RC}" >&2
  exit 1
fi

RM_MAIN_VPC=$(physical_id Vpc8378EB38)
RM_OFF_VPC=$(physical_id DnsOffVpc)
if [ "${RM_MAIN_VPC}" != "${MAIN_VPC}" ] || [ "${RM_OFF_VPC}" != "${OFF_VPC}" ]; then
  echo "FAIL: a VPC was replaced by the removal (must reset in place): '${MAIN_VPC}' -> '${RM_MAIN_VPC}', '${OFF_VPC}' -> '${RM_OFF_VPC}'" >&2
  exit 1
fi
RM_MAIN_DNS=$(dns_attrs "${MAIN_VPC}")
RM_OFF_DNS=$(dns_attrs "${OFF_VPC}")
if [ "${RM_MAIN_DNS}" != "False/True" ] || [ "${RM_OFF_DNS}" != "False/True" ]; then
  echo "FAIL: a VPC kept a removed DNS attribute (issue #1160): ${MAIN_VPC}='${RM_MAIN_DNS}', ${OFF_VPC}='${RM_OFF_DNS}'; expected False/True for both, as CloudFormation resets them" >&2
  exit 1
fi
echo "    OK: removed DNS hostnames reset to False, removed DNS support reset to True, in place (issue #1160)"

# Issue #5449: dropping InstanceTenancy from a dedicated VPC is an in-place
# ModifyVpcTenancy to default; default -> dedicated creates a new VPC and
# deletes the old one, as CloudFormation does (measured, us-east-1).
P2_DOWN_VPC=$(physical_id TenancyDownVpc)
P2_UP_VPC=$(physical_id TenancyUpVpc)
if [ "${P2_DOWN_VPC}" != "${DOWN_VPC}" ]; then
  echo "FAIL: TenancyDownVpc was replaced by an InstanceTenancy removal (must change in place): '${DOWN_VPC}' -> '${P2_DOWN_VPC}' (issue #5449)" >&2
  exit 1
fi
# Bounded read: EC2's describe APIs are eventually consistent.
P2_DOWN_TENANCY=""
for _ in 1 2 3 4 5 6; do
  P2_DOWN_TENANCY=$(tenancy "${DOWN_VPC}") || P2_DOWN_TENANCY="<describe-vpcs failed>"
  [ "${P2_DOWN_TENANCY}" = "default" ] && break
  sleep 5
done
if [ "${P2_DOWN_TENANCY}" != "default" ]; then
  echo "FAIL: ${DOWN_VPC} kept InstanceTenancy '${P2_DOWN_TENANCY}' after the property was removed; CloudFormation changes it to default in place (issue #5449)" >&2
  exit 1
fi
if [ -z "${P2_UP_VPC}" ] || [ "${P2_UP_VPC}" = "${UP_VPC}" ]; then
  echo "FAIL: TenancyUpVpc '${UP_VPC}' was not replaced by default -> dedicated (state now '${P2_UP_VPC}'); CloudFormation creates a new VPC (issue #5449)" >&2
  exit 1
fi
P2_UP_TENANCY=""
for _ in 1 2 3 4 5 6; do
  P2_UP_TENANCY=$(tenancy "${P2_UP_VPC}") || P2_UP_TENANCY="<describe-vpcs failed>"
  [ "${P2_UP_TENANCY}" = "dedicated" ] && break
  sleep 5
done
if [ "${P2_UP_TENANCY}" != "dedicated" ]; then
  echo "FAIL: replacement VPC ${P2_UP_VPC} has InstanceTenancy '${P2_UP_TENANCY}', expected dedicated (issue #5449)" >&2
  exit 1
fi
assert_gone "the replaced TenancyUpVpc '${UP_VPC}' still exists after Phase 2 (issue #5449)" aws ec2 describe-vpcs --vpc-ids "${UP_VPC}" --region "${REGION}"
echo "    OK: ${DOWN_VPC} changed to default in place, ${UP_VPC} replaced by dedicated ${P2_UP_VPC} (issue #5449)"

# Issue #5070: a NACL entry rule change is "Update requires: No interruption"
# in CloudFormation, served by one atomic ReplaceNetworkAclEntry. A delete +
# create leaves rule 100 absent between the two calls, so the SDK call log
# pins which calls the update sent even when the timing does not bite.
if [ ! -s "${P2_CALLS}" ]; then
  echo "FAIL: the SDK call log ${P2_CALLS} was not written - CDKD_SDK_CALL_LOG did not take effect" >&2
  exit 1
fi
# Summed over every line (one per cdkd process); 0 when the command is absent.
p2_calls() { # <command name> [client name, default EC2Client]
  node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(l.trim()==="")continue;n+=JSON.parse(l).counts[process.argv[3]+"."+process.argv[2]]??0}process.stdout.write(String(n))' "${P2_CALLS}" "$1" "${2:-EC2Client}"
}
P2_TENANCY="$(p2_calls ModifyVpcTenancyCommand)"
if [ "${P2_TENANCY}" != "1" ]; then
  echo "FAIL: expected exactly one ModifyVpcTenancy in Phase 2 (the TenancyDownVpc removal), found ${P2_TENANCY} (issue #5449)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
P2_REPLACE="$(p2_calls ReplaceNetworkAclEntryCommand)"
P2_DELETE="$(p2_calls DeleteNetworkAclEntryCommand)"
P2_CREATE="$(p2_calls CreateNetworkAclEntryCommand)"
echo "    Phase 2 NACL entry calls: ReplaceNetworkAclEntry=${P2_REPLACE} DeleteNetworkAclEntry=${P2_DELETE} CreateNetworkAclEntry=${P2_CREATE}"
if [ "${P2_REPLACE}" != "1" ] || [ "${P2_DELETE}" != "0" ] || [ "${P2_CREATE}" != "0" ]; then
  echo "FAIL: the NACL entry change must be exactly one ReplaceNetworkAclEntry and no DeleteNetworkAclEntry / CreateNetworkAclEntry (issue #5070)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi

# Issue #1160: `VPCs` dropped whole from the private zone. CloudFormation
# keeps every association, so cdkd sends no DisassociateVPCFromHostedZone and
# names the kept associations in one warning. The UpdateHostedZoneComment
# count is the positive control: the zone update ran and was logged.
P2_R53_COMMENT="$(p2_calls UpdateHostedZoneCommentCommand Route53Client)"
P2_R53_DISASSOC="$(p2_calls DisassociateVPCFromHostedZoneCommand Route53Client)"
echo "    Phase 2 Route 53 calls: UpdateHostedZoneComment=${P2_R53_COMMENT} DisassociateVPCFromHostedZone=${P2_R53_DISASSOC}"
if [ "${P2_R53_COMMENT}" = "0" ]; then
  echo "FAIL: the private zone update was not logged (UpdateHostedZoneComment=0), so the Disassociate count below proves nothing" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
if [ "${P2_R53_DISASSOC}" != "0" ]; then
  echo "FAIL: a VPCs removal sent DisassociateVPCFromHostedZone; CloudFormation keeps every association (issue #1160)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
P2_ZONE_VPCS=$(zone_vpcs "${ZONE_ID}")
if [ "${P2_ZONE_VPCS}" != "${MAIN_VPC}" ]; then
  echo "FAIL: private zone ${ZONE_ID} is associated with '${P2_ZONE_VPCS}' after the VPCs removal, expected '${MAIN_VPC}' kept, as CloudFormation keeps it (issue #1160)" >&2
  exit 1
fi
P2_KEPT_WARN=$(grep -cF 'PrivateZone (AWS::Route53::HostedZone): VPCs was removed from the template, and the zone keeps its current VPC associations' "${P2_LOG}" || true)
if [ "${P2_KEPT_WARN}" != "1" ]; then
  echo "FAIL: expected exactly one warning naming the kept VPC associations of PrivateZone (issue #1160), found ${P2_KEPT_WARN}" >&2
  exit 1
fi
echo "    OK: VPCs removal kept ${MAIN_VPC} on the private zone, sent no Disassociate, and warned once (issue #1160)"

# go-to-k/cdkd#7099: Cloud Control reports the added secondary address
# SUCCESS without applying it. CloudFormation applies it in place (measured),
# and cdkd applies it through one EC2 AssignPrivateIpAddresses on the same
# interface. Before the fix the deploy reported success with the address
# absent (the AssignPrivateIpAddresses count below fails), or, over #7115,
# failed with the [cc-silent-noop] tag (the failed-deploy branch above). This
# grep catches the tag at WARN level, where the deploy still succeeds.
if grep -qF '[cc-silent-noop]' "${P2_LOG}"; then
  echo "FAIL: Phase 2 warned [cc-silent-noop]: Cloud Control left a change unapplied on some resource (issue #7099)" >&2
  grep -F '[cc-silent-noop]' "${P2_LOG}" >&2
  exit 1
fi
P2_ENI_ID=$(physical_id SecondaryIpEni)
if [ "${P2_ENI_ID}" != "${ENI_ID}" ]; then
  echo "FAIL: SecondaryIpEni was replaced by the secondary-address change (must update in place, as CloudFormation does): '${ENI_ID}' -> '${P2_ENI_ID}' (issue #7099)" >&2
  exit 1
fi
P2_ASSIGN="$(p2_calls AssignPrivateIpAddressesCommand)"
if [ "${P2_ASSIGN}" != "1" ]; then
  echo "FAIL: expected exactly one EC2 AssignPrivateIpAddresses in Phase 2 (the SecondaryIpEni secondary address), found ${P2_ASSIGN} (issue #7099)" >&2
  cat "${P2_CALLS}" >&2
  exit 1
fi
P2_ENI=""
for _ in 1 2 3 4 5 6; do
  P2_ENI=$(eni_addresses "${ENI_ID}") || P2_ENI="<describe-network-interfaces failed>"
  [ "${P2_ENI}" = "10.0.0.200:true 10.0.0.201:false" ] && break
  sleep 5
done
if [ "${P2_ENI}" != "10.0.0.200:true 10.0.0.201:false" ]; then
  echo "FAIL: ${ENI_ID} after the update holds '${P2_ENI}', expected the primary 10.0.0.200 and the secondary 10.0.0.201 (issue #7099)" >&2
  exit 1
fi
P2_ENI_RECORD=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '[.resources.SecondaryIpEni.properties.PrivateIpAddresses[]?.PrivateIpAddress] | sort | join(" ")')
if [ "${P2_ENI_RECORD}" != "10.0.0.200 10.0.0.201" ]; then
  echo "FAIL: the SecondaryIpEni record holds addresses '${P2_ENI_RECORD}', expected '10.0.0.200 10.0.0.201' (issue #7099)" >&2
  exit 1
fi
echo "    OK: ${ENI_ID} gained the secondary 10.0.0.201 in place with one AssignPrivateIpAddresses, recorded (issue #7099)"

rm -f "${P2_CALLS}" "${P2_LOG}"
rmdir "${P2_CALLS_DIR}"

P2_ENTRY_ID=$(nacl_entry_id)
if [ "${P2_ENTRY_ID}" != "${ENTRY_ID}" ]; then
  echo "FAIL: the NACL entry physical id changed (must update in place): '${ENTRY_ID}' -> '${P2_ENTRY_ID}'" >&2
  exit 1
fi
# Bounded read: EC2's describe APIs are eventually consistent.
P2_ENTRY=""
for _ in 1 2 3 4 5 6; do
  P2_ENTRY=$(nacl_entry "${NACL_ID}")
  [ "$(entry_field "${P2_ENTRY}" RuleAction)" = "deny" ] && [ "$(entry_field "${P2_ENTRY}" CidrBlock)" = "10.0.0.0/8" ] && break
  sleep 5
done
if [ "$(entry_field "${P2_ENTRY}" RuleAction)" != "deny" ] || [ "$(entry_field "${P2_ENTRY}" CidrBlock)" != "10.0.0.0/8" ]; then
  echo "FAIL: NACL entry ${ENTRY_ID} after update: expected deny 10.0.0.0/8, got ${P2_ENTRY}" >&2
  exit 1
fi
echo "    OK: NACL entry ${ENTRY_ID} changed to deny 10.0.0.0/8 with one ReplaceNetworkAclEntry (issue #5070)"

# Issue #5448: the same physical ids, cdkd-5448 changed to 'two' and
# cdkd-5448-gone removed. Bounded read: EC2's describe APIs are eventually
# consistent.
P2_TAGGED_IDS=""
for lid in ${TAGGED_LOGICAL_IDS}; do
  P2_TAGGED_IDS="${P2_TAGGED_IDS}${P2_TAGGED_IDS:+ }$(physical_id "${lid}")"
done
if [ "${P2_TAGGED_IDS}" != "${P1_TAGGED_IDS}" ]; then
  echo "FAIL: a tag change replaced a resource (must update in place, issue #5448): '${P1_TAGGED_IDS}' -> '${P2_TAGGED_IDS}'" >&2
  exit 1
fi
for pid in ${P2_TAGGED_IDS}; do
  pair=""
  for _ in 1 2 3 4 5 6; do
    pair=$(tag_pair "${pid}") || pair="<describe-tags failed>"
    [ "${pair}" = "two/" ] && break
    sleep 5
  done
  if [ "${pair}" != "two/" ]; then
    echo "FAIL: ${pid} after the tag update: cdkd-5448/cdkd-5448-gone='${pair}', expected 'two/' (changed, removed; issue #5448)" >&2
    exit 1
  fi
done
echo "    OK: cdkd-5448 changed to two and cdkd-5448-gone removed in place on ${P2_TAGGED_IDS} (issue #5448)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "VPC '${MAIN_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${MAIN_VPC}" --region "${REGION}"
assert_gone "VPC '${OFF_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${OFF_VPC}" --region "${REGION}"
assert_gone "VPC '${DOWN_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${DOWN_VPC}" --region "${REGION}"
assert_gone "VPC '${P2_UP_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${P2_UP_VPC}" --region "${REGION}"
assert_gone "VPC '${ENC_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${ENC_VPC}" --region "${REGION}"
echo "    OK: all five VPCs are gone"
assert_gone "network interface '${ENI_ID}' still exists after destroy (issue #7099)" aws ec2 describe-network-interfaces --network-interface-ids "${ENI_ID}" --region "${REGION}"
echo "    OK: the network interface is gone"
assert_gone "private hosted zone '${ZONE_ID}' still exists after destroy" aws route53 get-hosted-zone --id "${ZONE_ID}"
echo "    OK: the private hosted zone is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> ec2-vpc test passed (removed VPC DNS attributes reset + in-place NACL entry change + kept private zone VPCs + in-place IGW / RouteTable / NACL tags + VPC InstanceTenancy + VPC encryption control + ENI secondary address in place + clean destroy)"
