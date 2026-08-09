#!/usr/bin/env bash
# verify.sh — cdkd AWS::EMR::InstanceFleetConfig SDK provider integ (issue #1400).
#
# The FLEET sibling of `emr-instance-configs` (which covers the instance-GROUP
# half). A cluster's instance-collection type is fixed at create (groups XOR
# fleets), so this needs its own cluster. It is what gives real-AWS coverage to
# every `InstanceTypeConfigs` conversion site:
#
#   - EMRClusterProvider.toInstanceFleetConfig — the INLINE
#     Cluster.Instances.{Master,Core}InstanceFleet path
#   - EMRInstanceFleetConfigProvider.create — the STANDALONE
#     AWS::EMR::InstanceFleetConfig path (AddInstanceFleet)
#   - the same provider's ModifyInstanceFleet update path
#
# Phases:
#   1. Deploy the fleet-based cluster (master + core inline fleets) + the
#      standalone TASK fleet. Assert the cluster is WAITING/RUNNING, the TASK
#      fleet's Ref/Fn::GetAtt Id outputs match the AWS fleet id, state routes the
#      fleet via the SDK provider (provisionedBy=sdk), the TASK fleet's
#      provisioned On-Demand capacity is 1, and — the issue #1383 assertion —
#      that ALL THREE fleets' per-instance-type `Configurations` markers reached
#      AWS (the send-side-looks-fine / AWS-silently-discards class a unit test
#      cannot close).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: resize the TASK fleet's
#      TargetOnDemandCapacity 1 -> 2 (ModifyInstanceFleet, polled until settled).
#      Assert the fleet Id is UNCHANGED (in-place, no replace) and provisioned
#      On-Demand capacity is 2.
#   3. Destroy + assert the cluster is TERMINATED (it bills per instance-hour,
#      so a leftover is never acceptable) with no ACTIVE cluster carrying the
#      fixture tag, and the cdkd state file is removed. The standalone fleet is
#      released by the cluster termination (there is no standalone delete API).
#
# NOTE: EMR cluster creation to WAITING takes ~5-15 minutes, adding the fleet a
# few more, and termination a few more — expect a total wall clock of 25-45
# minutes.
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

# Disable the AWS CLI output pager everywhere — in a non-interactive shell an
# invoked pager can hang or error (`[Errno 22] Invalid argument`).
export AWS_PAGER=""

cd "$(dirname "$0")"

STACK="CdkdEmrInstanceFleetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-integ-emr-instance-fleets"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="emr-instance-fleets"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Read the fleets through the SDK rather than `aws emr list-instance-fleets`.
#
# NOTE the reason is NOT the one the `emr-instance-groups` write-up assumed.
# `aws emr list-instance-fleets` DOES exist and DOES work non-interactively
# (verified 2026-08-09 against aws-cli/2.35.13); it is only its
# `list-instance-groups` sibling that is unusable, because that verb is on the
# AWS CLI's REMOVED-command list (awscli/customizations/removals.py) and so is
# not a CLI subcommand at all. The SDK is used here for two concrete reasons:
# the response is the SDK's own PascalCase shape (so
# `InstanceTypeSpecifications[].Configurations[].Properties` reads back exactly
# as the provider sent it), and the `Marker` loop matches the provider's own
# pagination — a partial first page would be a silent false pass. The repo root
# already depends on @aws-sdk/client-emr, so no extra install is needed.
REPO_ROOT="${PWD}/../../.."
list_instance_fleets_json() { # $1 = cluster id -> JSON array of InstanceFleets
  ( cd "${REPO_ROOT}" && REGION="${REGION}" node --input-type=module -e "
import { EMRClient, ListInstanceFleetsCommand } from '@aws-sdk/client-emr';
const client = new EMRClient({ region: process.env.REGION });
const fleets = [];
let marker;
// Follow Marker for parity with the provider's own paginated listInstanceFleets
// — a partial first page would silently satisfy the assertions below.
do {
  const res = await client.send(
    new ListInstanceFleetsCommand({ ClusterId: process.argv[1], Marker: marker })
  );
  fleets.push(...(res.InstanceFleets ?? []));
  marker = res.Marker;
} while (marker);
process.stdout.write(JSON.stringify(fleets));
" "$1" ) || return 1
}

# Ids of ACTIVE (not terminated) clusters named like the fixture and carrying
# the fixture's constant tag.
active_tagged_cluster_ids() {
  # `|| return 1`: errexit is cleared inside $( ), so a list-clusters error
  # must be propagated explicitly (pipefail carries it through the pipeline)
  # instead of silently reading as "no clusters".
  local ids id
  ids="$(aws emr list-clusters --active --region "${REGION}" \
    --query "Clusters[?Name=='${CLUSTER_NAME}'].Id" --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')" || return 1
  for id in ${ids}; do
    if aws emr describe-cluster --cluster-id "${id}" --region "${REGION}" \
      --query "Cluster.Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']" \
      --output text 2>/dev/null | grep -q .; then
      echo "${id}"
    fi
  done
}

cluster_state() {
  aws emr describe-cluster --cluster-id "$1" --region "${REGION}" \
    --query 'Cluster.Status.State' --output text 2>/dev/null
}

wait_cluster_terminated() {
  local id="$1"
  local deadline=$((SECONDS + 1800))
  local st
  while [ ${SECONDS} -lt ${deadline} ]; do
    st="$(cluster_state "${id}")"
    if [ "${st}" = "TERMINATED" ] || [ "${st}" = "TERMINATED_WITH_ERRORS" ] || [ -z "${st}" ]; then
      return 0
    fi
    sleep 15
  done
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Terminate any leftover active cluster (disable termination protection
  # first, defensively) and wait until it is gone — its ENIs / EC2 instances
  # block the VPC teardown below and it bills per instance-hour.
  for cid in $(active_tagged_cluster_ids); do
    echo "    terminating leftover EMR cluster ${cid}"
    aws emr modify-cluster-attributes --cluster-id "${cid}" --no-termination-protected \
      --region "${REGION}" >/dev/null 2>&1
    aws emr terminate-clusters --cluster-ids "${cid}" --region "${REGION}" >/dev/null 2>&1
    wait_cluster_terminated "${cid}"
  done
  # Best-effort teardown of the fixture VPC (found via the CDK Name tag).
  for vpcid in $(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:Name,Values=${STACK}/Vpc" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    echo "    deleting leftover VPC ${vpcid}"
    # EMR auto-creates ElasticMapReduce-master / -slave security groups in the
    # cluster's VPC (NOT part of the CDK template) that reference EACH OTHER, so
    # a plain delete fails with DependencyViolation. Revoke every rule first.
    sgs="$(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null)"
    for sg in ${sgs}; do
      ingress="$(aws ec2 describe-security-groups --region "${REGION}" --group-ids "${sg}" \
        --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null)"
      [ -n "${ingress}" ] && [ "${ingress}" != "[]" ] && \
        aws ec2 revoke-security-group-ingress --region "${REGION}" --group-id "${sg}" \
          --ip-permissions "${ingress}" >/dev/null 2>&1
      egress="$(aws ec2 describe-security-groups --region "${REGION}" --group-ids "${sg}" \
        --query 'SecurityGroups[0].IpPermissionsEgress' --output json 2>/dev/null)"
      [ -n "${egress}" ] && [ "${egress}" != "[]" ] && \
        aws ec2 revoke-security-group-egress --region "${REGION}" --group-id "${sg}" \
          --ip-permissions "${egress}" >/dev/null 2>&1
    done
    for sg in ${sgs}; do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    for igw in $(aws ec2 describe-internet-gateways --region "${REGION}" \
      --filters "Name=attachment.vpc-id,Values=${vpcid}" \
      --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null); do
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpcid}" \
        --region "${REGION}" >/dev/null 2>&1
      aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --vpc-id "${vpcid}" --region "${REGION}" >/dev/null 2>&1
  done
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

state_json() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json 2>/dev/null
}

output_value() {
  state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.state.outputs&&j.state.outputs[process.argv[1]])||"")})' "$1"
}

# The marker each fleet's per-instance-type Configurations must carry on the AWS
# side. $1 = fleets JSON, $2 = jq filter selecting the fleet, $3 = expected marker.
assert_fleet_marker() { # usage: assert_fleet_marker "<fleets json>" "<jq select expr>" "<marker>" "<label>"
  local fleets="$1" select="$2" expected="$3" label="$4" actual
  actual="$(printf '%s' "${fleets}" | jq -r --arg sel "${select}" '
    [ .[] | select(.InstanceFleetType == $sel)
          | .InstanceTypeSpecifications[]?
          | .Configurations[]? | select(.Classification == "core-site")
          | .Properties["cdkd.integ.marker"] ] | first // empty')"
  if [ "${actual}" != "${expected}" ]; then
    echo "FAIL: ${label} Configurations 'cdkd.integ.marker' is '${actual}', expected '${expected}' (issue #1383 conversion NOT reaching AWS on this path)" >&2
    echo "      raw fleets: ${fleets}" >&2
    exit 1
  fi
  echo "    ${label} per-instance-type Configurations reached AWS"
}

# Provisioned On-Demand capacity of the fleet with the given id.
fleet_provisioned_ondemand() { # $1 = fleets json, $2 = fleet id
  printf '%s' "$1" | jq -r --arg fid "$2" \
    '[ .[] | select(.Id == $fid) | .ProvisionedOnDemandCapacity ] | first // empty'
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy fleet-based cluster + standalone TASK fleet (this takes ~10-20 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P1="$(output_value ClusterId)"
FID_P1="$(output_value TaskFleetId)"
FID_ATTR_P1="$(output_value TaskFleetAttrId)"
if [ -z "${CID_P1}" ] || [ -z "${FID_P1}" ]; then
  echo "FAIL: ClusterId / TaskFleetId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    cluster id: ${CID_P1}, task fleet id: ${FID_P1}"

# Ref and Fn::GetAtt Id must both equal the AWS instance fleet id.
if [ "${FID_P1}" != "${FID_ATTR_P1}" ]; then
  echo "FAIL: TaskFleet Ref '${FID_P1}' != Fn::GetAtt Id '${FID_ATTR_P1}'" >&2
  exit 1
fi

STATE_P1="$(cluster_state "${CID_P1}")"
if [ "${STATE_P1}" != "WAITING" ] && [ "${STATE_P1}" != "RUNNING" ]; then
  echo "FAIL: Phase 1 expected cluster state WAITING/RUNNING, got '${STATE_P1}'" >&2
  exit 1
fi
echo "    cluster is ${STATE_P1}"

# The fleet must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::EMR::InstanceFleetConfig");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected EMR InstanceFleetConfig provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    fleet routed via SDK provider (provisionedBy=sdk)"

FLEETS_P1="$(list_instance_fleets_json "${CID_P1}")"

# cdkd's provider polled the fleet until its provisioned capacity met the
# target before deploy returned, so it is settled at 1 now.
CAP_P1="$(fleet_provisioned_ondemand "${FLEETS_P1}" "${FID_P1}")"
if [ "${CAP_P1}" != "1" ]; then
  echo "FAIL: Phase 1 expected TASK fleet ProvisionedOnDemandCapacity 1, got '${CAP_P1}'" >&2
  echo "      raw fleets: ${FLEETS_P1}" >&2
  exit 1
fi
echo "    TASK fleet provisioned at capacity 1"

# --- Assertion: issue #1383 per-instance-type Configurations ------------
# CFn spells the property bag `ConfigurationProperties`; the SDK member is
# `Properties`, and the AWS SDK v3 serializer drops unknown members — so
# without the conversion the fleets are created WITHOUT their application
# configuration while cdkd reports success. Read all three back from AWS: the
# MASTER/CORE fleets exercise EMRClusterProvider.toInstanceFleetConfig (the
# inline path), the TASK fleet exercises
# EMRInstanceFleetConfigProvider.create (AddInstanceFleet).
assert_fleet_marker "${FLEETS_P1}" MASTER master-fleet "inline MASTER fleet"
assert_fleet_marker "${FLEETS_P1}" CORE core-fleet "inline CORE fleet"
assert_fleet_marker "${FLEETS_P1}" TASK task-fleet "standalone TASK fleet"
echo "    all three InstanceTypeConfigs conversion sites verified against AWS (issue #1383)"

# --- Phase 2: in-place resize ------------------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (resize TASK fleet 1 -> 2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FID_P2="$(output_value TaskFleetId)"
if [ "${FID_P1}" != "${FID_P2}" ]; then
  echo "FAIL: TASK fleet was REPLACED (${FID_P1} -> ${FID_P2})" >&2
  exit 1
fi
echo "    fleet identity preserved (${FID_P2}) — in-place resize"

# The provider polls the fleet until provisioned capacity meets the new target
# after ModifyInstanceFleet, so after the resize deploy returns it is at 2.
FLEETS_P2="$(list_instance_fleets_json "${CID_P1}")"
CAP_P2="$(fleet_provisioned_ondemand "${FLEETS_P2}" "${FID_P2}")"
if [ "${CAP_P2}" != "2" ]; then
  echo "FAIL: Phase 2 expected TASK fleet ProvisionedOnDemandCapacity 2 after resize (ModifyInstanceFleet), got '${CAP_P2}'" >&2
  echo "      raw fleets: ${FLEETS_P2}" >&2
  exit 1
fi
echo "    resize reached AWS (ProvisionedOnDemandCapacity 2)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (EMR termination takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FINAL_STATE="$(cluster_state "${CID_P1}")"
if [ "${FINAL_STATE}" != "TERMINATED" ] && [ "${FINAL_STATE}" != "TERMINATED_WITH_ERRORS" ]; then
  echo "FAIL: EMR cluster ${CID_P1} not terminated after destroy (state '${FINAL_STATE}')" >&2
  exit 1
fi
echo "    cluster ${FINAL_STATE} (fleets released with it)"

LEFTOVERS="$(active_tagged_cluster_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: ACTIVE EMR cluster(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no active cluster with the fixture tag remains"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::EMR::InstanceFleetConfig SDK provider: deploy + in-place resize + destroy, with all three InstanceTypeConfigs conversion sites verified against AWS"
