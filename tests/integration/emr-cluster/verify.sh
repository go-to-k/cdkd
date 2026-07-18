#!/usr/bin/env bash
# verify.sh — cdkd AWS::EMR::Cluster SDK provider integ (issue #1043).
#
# The type is ProvisioningType: NON_PROVISIONABLE, so there is no Cloud
# Control fallback — this fixture proves the new SDK provider end to end with
# the smallest / cheapest legal shape: a single master node (1x m5.xlarge, no
# core/task), emr-7.9.0, in a public subnet.
#
# Phases:
#   1. Deploy the cluster (+ minimal VPC + EMR default roles). Assert via
#      `aws emr describe-cluster` that it is WAITING/RUNNING, that the
#      MasterPublicDNS output (Fn::GetAtt) matches AWS, that the baseline
#      tags/StepConcurrencyLevel/VisibleToAllUsers reached AWS, and that
#      state routes it via the SDK provider (provisionedBy=sdk).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: StepConcurrencyLevel 1 -> 5
#      (ModifyCluster) + VisibleToAllUsers true -> false
#      (SetVisibleToAllUsers) + tag value change AND tag removal (AddTags /
#      RemoveTags). Assert the ClusterId is UNCHANGED (in-place, no replace).
#   3. Destroy + assert the cluster is TERMINATED (an EMR cluster bills per
#      instance-hour, so a leftover is never acceptable) with no ACTIVE
#      cluster carrying the fixture tag, and the cdkd state file is removed.
#
# NOTE: EMR cluster creation to WAITING takes ~5-15 minutes and termination a
# few more — expect a total wall clock of 20-40 minutes.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdEmrClusterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-integ-emr"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="emr-cluster"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Ids of ACTIVE (not terminated) clusters named like the fixture and carrying
# the fixture's constant tag.
active_tagged_cluster_ids() {
  local ids id
  ids="$(aws emr list-clusters --active --region "${REGION}" \
    --query "Clusters[?Name=='${CLUSTER_NAME}'].Id" --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')"
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
    for sg in $(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpcid}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
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
echo "==> Phase 1: deploy single-node EMR cluster (this takes ~5-15 min)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P1="$(output_value ClusterId)"
DNS_OUT="$(output_value MasterPublicDns)"
if [ -z "${CID_P1}" ]; then
  echo "FAIL: ClusterId output missing from cdkd state after Phase 1" >&2
  exit 1
fi
echo "    cluster id: ${CID_P1}"

read -r STATE_P1 STEP_P1 VISIBLE_P1 DNS_AWS <<EOF
$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query 'Cluster.[Status.State,StepConcurrencyLevel,VisibleToAllUsers,MasterPublicDnsName]' \
  --output text)
EOF

if [ "${STATE_P1}" != "WAITING" ] && [ "${STATE_P1}" != "RUNNING" ]; then
  echo "FAIL: Phase 1 expected cluster state WAITING/RUNNING, got '${STATE_P1}'" >&2
  exit 1
fi
echo "    cluster is ${STATE_P1}"

if [ "${STEP_P1}" != "1" ]; then
  echo "FAIL: Phase 1 expected StepConcurrencyLevel 1, got '${STEP_P1}'" >&2
  exit 1
fi
if [ "${VISIBLE_P1}" != "True" ] && [ "${VISIBLE_P1}" != "true" ]; then
  echo "FAIL: Phase 1 expected VisibleToAllUsers true, got '${VISIBLE_P1}'" >&2
  exit 1
fi
echo "    baseline StepConcurrencyLevel=1, VisibleToAllUsers=true"

# Fn::GetAtt MasterPublicDNS output must match the AWS-side value.
if [ -z "${DNS_OUT}" ] || [ "${DNS_OUT}" != "${DNS_AWS}" ]; then
  echo "FAIL: MasterPublicDns output '${DNS_OUT}' does not match AWS MasterPublicDnsName '${DNS_AWS}'" >&2
  exit 1
fi
echo "    Fn::GetAtt MasterPublicDNS matches AWS (${DNS_OUT})"

# Baseline tags reached AWS.
ENV_TAG_P1="$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P1="$(aws emr describe-cluster --cluster-id "${CID_P1}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='dropme'].Value | [0]" --output text)"
if [ "${ENV_TAG_P1}" != "test" ] || [ "${DROPME_P1}" != "yes" ]; then
  echo "FAIL: Phase 1 expected tags env=test dropme=yes, got env='${ENV_TAG_P1}' dropme='${DROPME_P1}'" >&2
  exit 1
fi
echo "    baseline tags reached AWS (env=test, dropme=yes)"

# The cluster must route via the SDK provider (catch a routing flip).
PROVISIONED_BY="$(state_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::EMR::Cluster");process.stdout.write((r[k]&&r[k].provisionedBy)||"sdk")})')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: expected EMR cluster provisionedBy=sdk, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    cluster routed via SDK provider (provisionedBy=sdk)"

# --- Phase 2: in-place update ------------------------------------------
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (step concurrency, visibility, tags)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CID_P2="$(output_value ClusterId)"
if [ "${CID_P1}" != "${CID_P2}" ]; then
  echo "FAIL: cluster was REPLACED (${CID_P1} -> ${CID_P2})" >&2
  exit 1
fi
echo "    cluster identity preserved (${CID_P2}) — in-place update"

read -r STEP_P2 VISIBLE_P2 <<EOF
$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query 'Cluster.[StepConcurrencyLevel,VisibleToAllUsers]' --output text)
EOF
if [ "${STEP_P2}" != "5" ]; then
  echo "FAIL: Phase 2 expected StepConcurrencyLevel 5, got '${STEP_P2}'" >&2
  exit 1
fi
if [ "${VISIBLE_P2}" != "False" ] && [ "${VISIBLE_P2}" != "false" ]; then
  echo "FAIL: Phase 2 expected VisibleToAllUsers false, got '${VISIBLE_P2}'" >&2
  exit 1
fi
ENV_TAG_P2="$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='env'].Value | [0]" --output text)"
DROPME_P2="$(aws emr describe-cluster --cluster-id "${CID_P2}" --region "${REGION}" \
  --query "Cluster.Tags[?Key=='dropme'].Value | [0]" --output text)"
if [ "${ENV_TAG_P2}" != "changed" ]; then
  echo "FAIL: Phase 2 expected tag env=changed, got '${ENV_TAG_P2}'" >&2
  exit 1
fi
if [ "${DROPME_P2}" != "None" ] && [ -n "${DROPME_P2}" ]; then
  echo "FAIL: Phase 2 expected tag 'dropme' to be REMOVED (RemoveTags), still '${DROPME_P2}'" >&2
  exit 1
fi
echo "    update reached AWS (StepConcurrencyLevel 5, VisibleToAllUsers false, env=changed, dropme removed)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (EMR termination takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FINAL_STATE="$(cluster_state "${CID_P2}")"
if [ "${FINAL_STATE}" != "TERMINATED" ] && [ "${FINAL_STATE}" != "TERMINATED_WITH_ERRORS" ]; then
  echo "FAIL: EMR cluster ${CID_P2} not terminated after destroy (state '${FINAL_STATE}')" >&2
  exit 1
fi
echo "    cluster ${FINAL_STATE} (by id)"

LEFTOVERS="$(active_tagged_cluster_ids)"
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: ACTIVE EMR cluster(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no active cluster with the fixture tag remains"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — AWS::EMR::Cluster SDK provider: deploy + in-place update (incl. tag removal) + destroy (TERMINATED) all passed"
