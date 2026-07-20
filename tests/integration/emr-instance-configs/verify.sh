#!/usr/bin/env bash
# verify.sh — cdkd AWS::EMR::InstanceGroupConfig SDK provider integ (issue #1070).
#
# InstanceGroupConfig / InstanceFleetConfig are ProvisioningType:
# NON_PROVISIONABLE, so there is no Cloud Control fallback. This fixture proves
# the InstanceGroupConfig SDK provider end to end: a group-based cluster
# (1x m5.xlarge master + 1x m5.xlarge core) + a standalone TASK instance group
# (1x m5.xlarge) added via AddInstanceGroups. The core node is required — EMR
# rejects AddInstanceGroups on a master-only job flow. A cluster's collection
# type is
# fixed at create (groups XOR fleets), so ONE cluster can exercise only ONE of
# the two new types; the structurally-identical InstanceFleetConfig provider is
# covered by unit tests.
#
# Phases:
#   1. Deploy the cluster + standalone TASK group. Assert the cluster is
#      WAITING/RUNNING, the group has 1 RUNNING instance (via
#      `aws emr list-instances --instance-group-id` — the customized
#      `list-instance-groups` command fails with [Errno 22] in a
#      non-interactive shell; the provider polls the group to RUNNING before
#      deploy returns), the group's Ref/Fn::GetAtt Id outputs match the AWS
#      group id, and state routes the group via the SDK provider
#      (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: resize the TASK group 1 -> 2
#      (ModifyInstanceGroups, polled to RUNNING). Assert the group Id is
#      UNCHANGED (in-place, no replace) and the group has 2 RUNNING instances.
#   3. Destroy + assert the cluster is TERMINATED (it bills per instance-hour,
#      so a leftover is never acceptable) with no ACTIVE cluster carrying the
#      fixture tag, and the cdkd state file is removed. The standalone group is
#      released by the cluster termination (there is no standalone delete API).
#
# NOTE: EMR cluster creation to WAITING takes ~5-15 minutes, adding the group a
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

STACK="CdkdEmrInstanceConfigsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-integ-emr-instance-configs"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="emr-instance-configs"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

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

# Count of RUNNING EC2 instances in the standalone TASK group. NOTE: we use
# `aws emr list-instances` (a plain command) rather than
# `aws emr list-instance-groups` — the latter is an AWS-CLI-customized command
# that fails with `[Errno 22] Invalid argument` in a non-interactive shell,
# while `list-instances` works. cdkd's provider polls the group to RUNNING
# before `deploy` returns, so once deploy succeeds the RUNNING instance count
# equals the group's requested InstanceCount.
task_group_running_count() {
  # $1 = cluster id, $2 = group id
  aws emr list-instances --cluster-id "$1" --instance-group-id "$2" \
    --instance-states RUNNING --region "${REGION}" \
    --query 'length(Instances)' --output text </dev/null 2>/dev/null
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

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy single-node cluster + standalone TASK group (this takes ~10-20 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P1="$(output_value ClusterId)"
GID_P1="$(output_value TaskGroupId)"
GID_ATTR_P1="$(output_value TaskGroupAttrId)"
if [ -z "${CID_P1}" ] || [ -z "${GID_P1}" ]; then
  echo "FAIL: ClusterId / TaskGroupId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    cluster id: ${CID_P1}, task group id: ${GID_P1}"

# Ref and Fn::GetAtt Id must both equal the AWS instance group id.
if [ "${GID_P1}" != "${GID_ATTR_P1}" ]; then
  echo "FAIL: TaskGroup Ref '${GID_P1}' != Fn::GetAtt Id '${GID_ATTR_P1}'" >&2
  exit 1
fi

STATE_P1="$(cluster_state "${CID_P1}")"
if [ "${STATE_P1}" != "WAITING" ] && [ "${STATE_P1}" != "RUNNING" ]; then
  echo "FAIL: Phase 1 expected cluster state WAITING/RUNNING, got '${STATE_P1}'" >&2
  exit 1
fi
echo "    cluster is ${STATE_P1}"

# cdkd's provider polled the group to RUNNING before deploy returned, so the
# RUNNING-instance count now equals the requested InstanceCount (1).
GCOUNT_P1="$(task_group_running_count "${CID_P1}" "${GID_P1}")"
if [ "${GCOUNT_P1}" != "1" ]; then
  echo "FAIL: Phase 1 expected 1 RUNNING instance in the TASK group, got '${GCOUNT_P1}'" >&2
  exit 1
fi
echo "    TASK group RUNNING with 1 instance"

# The group must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::EMR::InstanceGroupConfig");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected EMR InstanceGroupConfig provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    group routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2: in-place resize ------------------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (resize TASK group 1 -> 2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

GID_P2="$(output_value TaskGroupId)"
if [ "${GID_P1}" != "${GID_P2}" ]; then
  echo "FAIL: TASK group was REPLACED (${GID_P1} -> ${GID_P2})" >&2
  exit 1
fi
echo "    group identity preserved (${GID_P2}) — in-place resize"

# The provider polls the group back to RUNNING after ModifyInstanceGroups, so
# after the resize deploy returns there are 2 RUNNING instances in the group.
GCOUNT_P2="$(task_group_running_count "${CID_P1}" "${GID_P2}")"
if [ "${GCOUNT_P2}" != "2" ]; then
  echo "FAIL: Phase 2 expected 2 RUNNING instances after resize (ModifyInstanceGroups), got '${GCOUNT_P2}'" >&2
  exit 1
fi
echo "    resize reached AWS (2 RUNNING instances)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (EMR termination takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FINAL_STATE="$(cluster_state "${CID_P1}")"
if [ "${FINAL_STATE}" != "TERMINATED" ] && [ "${FINAL_STATE}" != "TERMINATED_WITH_ERRORS" ]; then
  echo "FAIL: EMR cluster ${CID_P1} not terminated after destroy (state '${FINAL_STATE}')" >&2
  exit 1
fi
echo "    cluster ${FINAL_STATE} (group released with it)"

LEFTOVERS="$(active_tagged_cluster_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: ACTIVE EMR cluster(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no active cluster with the fixture tag remains"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::EMR::InstanceGroupConfig SDK provider: deploy + in-place resize + destroy (group released with cluster) all passed"
