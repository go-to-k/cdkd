#!/usr/bin/env bash
# verify.sh — cdkd AWS::EMR::InstanceGroupConfig SDK provider integ (issue #1070).
#
# InstanceFleetConfig and InstanceGroupConfig were NON_PROVISIONABLE when their
# providers landed; AWS has since given both Cloud Control handlers. This fixture proves
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
#   1c. Resize the TASK group 1 -> 2 under a 20s per-type deadline: the deploy
#      fails mid-resize and the record must name InstanceCount unsettled; a
#      same-template retry during the resize must be refused, keeping the name;
#      once 2 instances run, a redeploy of the base template must resize back
#      to 1 and clear the name (go-to-k/cdkd#5487).
#   2. Re-deploy with CDKD_TEST_UPDATE=true: resize the TASK group 1 -> 2
#      (ModifyInstanceGroups, polled to RUNNING). Assert the group Id is
#      UNCHANGED (in-place, no replace) and the group has 2 RUNNING instances.
#   2b. Drift (go-to-k/cdkd#6769): the group row is compared and clean; an
#      out-of-band resize to 1 is drift on InstanceCount (exit 1); `drift
#      --revert` resizes it back to 2 with the group id unchanged; clean again.
#   2c. Add a second TASK group with an AutoScalingPolicy (mode scaled-group),
#      assert the policy is ATTACHED with its Application Auto Scaling target
#      and CloudWatch alarm(s), then redeploy without it: cdkd deletes the
#      group with the cluster still up. The delete must remove the policy
#      before the scale to 0, so the alarm(s) and the target are gone
#      (go-to-k/cdkd#6806; before #6802 they outlived the group).
#   3. Destroy + assert the cluster is TERMINATED (it bills per instance-hour,
#      so a leftover is never acceptable) with no ACTIVE cluster carrying the
#      fixture tag, and the cdkd state file is removed. The standalone group is
#      released by the cluster termination (there is no standalone delete API).
#
# NOTE: EMR cluster creation to WAITING takes ~5-15 minutes, adding the group a
# few more, the scaling-policy group of Phase 2c another 5-15, and termination
# a few more — expect a total wall clock of 35-60 minutes.
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

# Disable the AWS CLI output pager everywhere — in a non-interactive shell an
# invoked pager can hang or error (`[Errno 22] Invalid argument`).
export AWS_PAGER=""

cd "$(dirname "$0")"
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

STACK="CdkdEmrInstanceConfigsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-integ-emr-instance-configs"
CLEANUP_TAG_KEY="cdkd-integ"
CLEANUP_TAG_VALUE="emr-instance-configs"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# `aws emr list-instance-groups` is NOT an AWS CLI command: the CLI REMOVES it
# from the `aws emr` command table (awscli/customizations/removals.py) even
# though the EMR API operation exists and every SDK exposes it, so the CLI
# answers `Found invalid choice 'list-instance-groups'`. On a machine with
# `cli_auto_prompt` enabled that error instead surfaces as
# `Warning: Input is not a terminal (fd=0).` + `[Errno 22] Invalid argument`
# (or a hang), because the CLI tries to open its interactive prompter — which is
# how this was first misdiagnosed as an "AWS CLI customization". Read the
# per-group `Configurations` through the SDK instead — the repo root already
# depends on @aws-sdk/client-emr, so no extra install is needed.
REPO_ROOT="${PWD}/../../.."
list_instance_groups_json() { # $1 = cluster id -> JSON array of InstanceGroups
  ( cd "${REPO_ROOT}" && REGION="${REGION}" node --input-type=module -e "
import { EMRClient, ListInstanceGroupsCommand } from '@aws-sdk/client-emr';
const client = new EMRClient({ region: process.env.REGION });
const groups = [];
let marker;
// Follow Marker for parity with the provider's own paginated listInstanceGroups
// — a partial first page would silently satisfy the assertions below.
do {
  const res = await client.send(
    new ListInstanceGroupsCommand({ ClusterId: process.argv[1], Marker: marker })
  );
  groups.push(...(res.InstanceGroups ?? []));
  marker = res.Marker;
} while (marker);
process.stdout.write(JSON.stringify(groups));
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

# Count of RUNNING EC2 instances in the standalone TASK group. NOTE: we use
# `aws emr list-instances` rather than `aws emr list-instance-groups` — the
# latter is on the AWS CLI's removal list and so is not a CLI subcommand at all,
# while `list-instances` is a perfectly ordinary one (being in the same
# `list-instance-*` family means nothing; removal is per-verb).
# cdkd's provider polls the group to RUNNING
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

# go-to-k/cdkd#6806: the cluster (recorded once Phase 1 names it) and the
# scaled group Phase 2c adds, and the alarm names its policy had. A policy that outlived its
# group leaves an Application Auto Scaling target and CloudWatch alarm(s).
SCALED_CID=""
SCALED_GID=""
SCALED_ALARMS=""
scaled_target_ids() { # $1 = cluster id, $2 = group id -> the group's scalable target, or nothing
  aws application-autoscaling describe-scalable-targets --service-namespace elasticmapreduce \
    --resource-ids "instancegroup/$1/$2" --region "${REGION}" \
    --query 'ScalableTargets[].ResourceId' --output text </dev/null
}
# Alarms tied to the group: those its scaling policies name, plus any alarm
# whose action names the group (the policy ARN carries its resource id).
group_alarm_names() { # $1 = cluster id, $2 = group id -> alarm names, one per line
  local aas cw
  aas="$(aws application-autoscaling describe-scaling-policies --service-namespace elasticmapreduce \
    --resource-id "instancegroup/$1/$2" --region "${REGION}" \
    --query 'ScalingPolicies[].Alarms[].AlarmName' --output text </dev/null)" || return 1
  cw="$(aws cloudwatch describe-alarms --region "${REGION}" \
    --query "MetricAlarms[?contains(join(',', AlarmActions || \`[]\`), '$2')].AlarmName" \
    --output text </dev/null)" || return 1
  printf '%s\n%s\n' "${aas}" "${cw}" | tr '\t' '\n' | sed '/^$/d' | sort -u
}
# Which of the named alarms (one per line in $1) CloudWatch still holds.
alarms_remaining() {
  local name out
  while IFS= read -r name || [ -n "${name}" ]; do
    [ -n "${name}" ] || continue
    out="$(aws cloudwatch describe-alarms --alarm-names "${name}" --region "${REGION}" \
      --query 'MetricAlarms[].AlarmName' --output text </dev/null)" || return 1
    if [ -n "${out}" ]; then printf '%s\n' "${name}"; fi
  done <<<"$1"
  return 0
}
# Cluster-scoped, so a Phase 2c deploy that failed after creating the group
# (no group id recorded) is swept too: every elasticmapreduce scalable target
# of the cluster, and every alarm whose action names it. Only the scaled group
# carries a policy in this fixture.
sweep_cluster_scaling_leftovers() { ( # usage: sweep_cluster_scaling_leftovers <cluster id>
  set +eu
  case "$1" in
    j-?*) ;;
    '') exit 0 ;;
    *) echo "    WARN: teardown sweep refused a scaling scope outside j-*: '$1'" >&2
       exit 0 ;;
  esac
  targets="$(aws application-autoscaling describe-scalable-targets --service-namespace elasticmapreduce \
    --region "${REGION}" --query "ScalableTargets[?starts_with(ResourceId, 'instancegroup/$1/')].ResourceId" \
    --output text </dev/null)"
  for rid in ${targets}; do
    echo "    deregistering leftover scalable target ${rid}"
    aws application-autoscaling deregister-scalable-target --service-namespace elasticmapreduce \
      --resource-id "${rid}" --scalable-dimension elasticmapreduce:instancegroup:InstanceCount \
      --region "${REGION}" >/dev/null 2>&1
  done
  names="$(aws cloudwatch describe-alarms --region "${REGION}" \
    --query "MetricAlarms[?contains(join(',', AlarmActions || \`[]\`), '/$1/')].AlarmName" \
    --output text </dev/null)"
  printf '%s\n%s\n' "${names}" "${SCALED_ALARMS}" | tr '\t' '\n' | sed '/^$/d' | sort -u \
    | while IFS= read -r name || [ -n "${name}" ]; do
      echo "    deleting leftover alarm ${name}"
      aws cloudwatch delete-alarms --alarm-names "${name}" --region "${REGION}" >/dev/null 2>&1
    done
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  [ -n "${REVERT_WORK:-}" ] && rm -rf "${REVERT_WORK}"
  [ -n "${DRIFT_JSON:-}" ] && rm -f "${DRIFT_JSON}"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
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
    [ "${cid}" = "${SCALED_CID}" ] || sweep_cluster_scaling_leftovers "${cid}"
  done
  sweep_cluster_scaling_leftovers "${SCALED_CID}"
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
SCALED_CID="${CID_P1}"

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

# --- Assertion: issue #1383 per-group ConfigurationProperties ----------
# CFn spells the property bag `ConfigurationProperties`; the SDK member is
# `Properties`, and the AWS SDK v3 serializer drops unknown members — so before
# the fix AddInstanceGroups silently created the group WITHOUT its application
# configuration while cdkd reported success. Read it back from AWS.
GROUPS_JSON="$(list_instance_groups_json "${CID_P1}")"
GROUP_CFG="$(printf '%s' "${GROUPS_JSON}" | jq -r --arg gid "${GID_P1}" '
  [ .[] | select(.Id == $gid)
        | .Configurations[]? | select(.Classification == "core-site")
        | .Properties["cdkd.integ.marker"] ] | first // empty')"
if [ "${GROUP_CFG}" != "task-group" ]; then
  echo "FAIL: TASK group Configurations 'cdkd.integ.marker' is '${GROUP_CFG}', expected 'task-group' (issue #1383 NOT closed)" >&2
  echo "      raw groups: ${GROUPS_JSON}" >&2
  exit 1
fi
echo "    standalone-group ConfigurationProperties reached AWS (issue #1383 closed)"

# --- Phase 1c: a resize the deadline cut short (go-to-k/cdkd#5487) -------
# ModifyInstanceGroups is accepted at once and the group resizes for minutes,
# so a 20s per-type deadline fails the update after the call. Before the fix
# the record kept InstanceCount 1, so the redeploy of the base template below
# diffed empty and the group stayed at 2. Now the record names InstanceCount
# unsettled, and the redeploy compares it with the group's requested count and
# resizes back to 1. Phase 2 below then resizes 1 -> 2 as before.
group_unsettled() { # the TASK group record's unsettledProperties, comma-joined
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r --arg gid "$1" '[.resources[]
        | select(.resourceType == "AWS::EMR::InstanceGroupConfig" and .physicalId == $gid)
        | (.unsettledProperties // [])[]] | join(",")'
}
wait_group_running_count() { # $1 = cluster id, $2 = group id, $3 = count
  local n=""
  for _ in $(seq 1 90); do
    n="$(task_group_running_count "$1" "$2")"
    [ "${n}" = "$3" ] && return 0
    sleep 10
  done
  echo "FAIL: TASK group ${2} has '${n}' RUNNING instances, expected $3" >&2
  exit 1
}
echo "==> Phase 1c: resize TASK group 1 -> 2 under a 20s deadline (must fail mid-resize)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback \
  --resource-warn-after AWS::EMR::InstanceGroupConfig=10s \
  --resource-timeout AWS::EMR::InstanceGroupConfig=20s
P1C_EXIT=$?
set -e
if [ "${P1C_EXIT}" -eq 0 ]; then
  echo "FAIL: Phase 1c's deploy succeeded; the 20s deadline must cut the resize short (premise of the arm)" >&2
  exit 1
fi
P1C_UNSETTLED="$(group_unsettled "${GID_P1}")"
if [ "${P1C_UNSETTLED}" != "InstanceCount" ]; then
  echo "FAIL: TASK group record's unsettledProperties after the cut-short resize is '${P1C_UNSETTLED}', expected 'InstanceCount' (go-to-k/cdkd#5487)" >&2
  exit 1
fi
# Same-template RETRY at once, while the resize still runs (minutes): a moving
# count is never diffed, so the deploy refuses before any call and the name
# stays (go-to-k/cdkd#5487: the requested count used to read as settled, so
# the retry sent nothing and cleared the name).
#
# The refusal fires only while the group READS in transition, and EMR answers
# RUNNING for a moment after ModifyInstanceGroups (or the 20s deadline can fire
# before the modify is sent): a retry that reads RUNNING legitimately re-sends
# the resize and exits 0 (go-to-k/cdkd#7197). So wait (bounded) until the
# group reads RESIZING first, and fail naming the state if it never does --
# the arm's premise did not hold, which is not the refusal regressing.
# (The SDK helper, not `aws emr list-instance-groups`: some installed CLI
# models lack that verb.)
P1C_STATE=""
for _ in $(seq 1 30); do
  if ! P1C_GROUPS="$(list_instance_groups_json "${CID_P1}")"; then
    echo "FAIL: could not list the instance groups of ${CID_P1} while waiting for the TASK group to read RESIZING" >&2
    exit 1
  fi
  P1C_STATE="$(printf '%s' "${P1C_GROUPS}" | jq -r --arg gid "${GID_P1}" \
    '[.[] | select(.Id == $gid) | .Status.State] | first // "<group not listed>"')" || {
    echo "FAIL: could not read the TASK group state from: ${P1C_GROUPS}" >&2
    exit 1
  }
  [ "${P1C_STATE}" = "RESIZING" ] && break
  sleep 2
done
if [ "${P1C_STATE}" != "RESIZING" ]; then
  echo "FAIL: the TASK group ${GID_P1} read '${P1C_STATE}' (not RESIZING) for 60s after the cut-short resize, so the retry arm's premise (a group in transition) does not hold (go-to-k/cdkd#7197)" >&2
  exit 1
fi
echo "    the TASK group reads RESIZING; retrying the same template"
P1C_RETRY_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P1C_RETRY_LOG}" 2>&1
P1C_RETRY_EXIT=$?
set -e
if [ "${P1C_RETRY_EXIT}" -eq 0 ] || ! grep -q "AWS is still changing it" "${P1C_RETRY_LOG}"; then
  echo "FAIL: the same-template retry during the resize must be refused as in transition (exit ${P1C_RETRY_EXIT}):" >&2
  cat "${P1C_RETRY_LOG}" >&2
  exit 1
fi
if [ "$(group_unsettled "${GID_P1}")" != "InstanceCount" ]; then
  echo "FAIL: the refused retry changed the TASK group record's unsettledProperties ('$(group_unsettled "${GID_P1}")')" >&2
  exit 1
fi
echo "    the same-template retry during the resize was refused and kept the name"
wait_group_running_count "${CID_P1}" "${GID_P1}" 2
echo "==> Phase 1c: redeploy the base template (InstanceCount 1, the record's own value)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P1C_COUNT="$(task_group_running_count "${CID_P1}" "${GID_P1}")"
if [ "${P1C_COUNT}" != "1" ]; then
  echo "FAIL: TASK group has '${P1C_COUNT}' RUNNING instances after redeploying the base template, expected 1 (go-to-k/cdkd#5487: the redeploy diffed empty and left 2)" >&2
  exit 1
fi
if [ -n "$(group_unsettled "${GID_P1}")" ]; then
  echo "FAIL: TASK group record still names unsettled properties after the converging deploy" >&2
  exit 1
fi
echo "    the unsettled InstanceCount converged on redeploy (go-to-k/cdkd#5487)"

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

# --- Phase 2b: drift reads the instance group back (issue #6769) -------
# Cloud Control cannot address the bare group id (its primaryIdentifier is the
# composite `InstanceGroupId` + `JobFlowId`, #5179), so the type was
# deny-listed and drift unknown. The SDK provider now reads it back itself
# through `ListInstanceGroups` on the recorded cluster: the TaskGroup row must
# be CLEAN (not in notSupported, not in notCompared) as deployed (2 instances);
# an out-of-band resize to 1 is drift on `InstanceCount` (exit 1); `drift
# --revert` resizes it back in place (same group id, go-to-k/cdkd#6638), and
# the row is clean again. Only the drifted run's exit is asserted: other rows
# in this stack are not this phase's subject.
echo "==> Phase 2b: drift compares the instance group (clean -> out-of-band resize -> --revert)"
DRIFT_JSON="$(mktemp)"
group_drift_verdict() { # sets VERDICT (OK:clean / OK:drifted:<paths> / the failure shape) and DRIFT_RC
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json > "${DRIFT_JSON}"
  DRIFT_RC=$?
  set -e
  echo "    drift exited ${DRIFT_RC}"
  VERDICT="$(node -e '
const t = process.argv[1];
let r;
try { r = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8")); }
catch (e) { process.stdout.write("UNPARSEABLE"); process.exit(0); }
try {
  const rows = (k) => r.flatMap((s) => s[k] || []).filter((x) => x.type === t);
  const nc = rows("notCompared");
  if (nc.length) { process.stdout.write("NOTCOMPARED:" + nc.map((x) => x.cause).join(",")); process.exit(0); }
  if (rows("notSupported").length) { process.stdout.write("NOTSUPPORTED"); process.exit(0); }
  const drifted = rows("drifted");
  if (drifted.length === 1) {
    process.stdout.write("OK:drifted:" + drifted[0].changes.map((c) => c.path).sort().join(","));
    process.exit(0);
  }
  const counts = ["drifted", "deleted", "clean", "skipped"].map((k) => k + "=" + rows(k).length).join(",");
  process.stdout.write(rows("clean").length === 1 && drifted.length === 0 ? "OK:clean" : counts);
} catch (e) { process.stdout.write("UNEXPECTED_SHAPE"); }
' "AWS::EMR::InstanceGroupConfig" "${DRIFT_JSON}")"
}
requested_count() { # $1 = cluster id, $2 = group id
  list_instance_groups_json "$1" | jq -r --arg gid "$2" '[.[] | select(.Id == $gid) | .RequestedInstanceCount] | first // empty'
}

group_drift_verdict
if [ "${VERDICT}" != "OK:clean" ]; then
  echo "FAIL [phase 2b]: expected the TaskGroup row clean (compared, no drift) as deployed, got '${VERDICT}' (drift rc ${DRIFT_RC}; before go-to-k/cdkd#6769 it was NOTSUPPORTED)" >&2
  exit 1
fi
echo "    instance group compared and clean as deployed"

AWS_CLI_AUTO_PROMPT=off aws emr modify-instance-groups --region "${REGION}" --cluster-id "${CID_P1}" \
  --instance-groups "InstanceGroupId=${GID_P2},InstanceCount=1"
for _ in $(seq 1 20); do
  [ "$(requested_count "${CID_P1}" "${GID_P2}")" = "1" ] && break
  sleep 15
done
[ "$(requested_count "${CID_P1}" "${GID_P2}")" = "1" ] || { echo "FAIL [phase 2b]: premise: the out-of-band resize never read back as requested count 1" >&2; exit 1; }
group_drift_verdict
case "${VERDICT}" in
  OK:drifted:*InstanceCount*) ;;
  *)
    echo "FAIL [phase 2b]: expected TaskGroup drifted on InstanceCount after the out-of-band resize, got '${VERDICT}' (go-to-k/cdkd#6769)" >&2
    exit 1
    ;;
esac
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL [phase 2b]: drift exited ${DRIFT_RC} over a drifted group, expected 1 (go-to-k/cdkd#6769)" >&2
  exit 1
fi
echo "    out-of-band resize reported (${VERDICT#OK:drifted:})"

REVERT_WORK="$(mktemp -d)"
revert_identity_snapshot "${REVERT_WORK}/revert-ids-before" "${STACK}" TaskGroup || exit 1
REVERT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes > "${REVERT_WORK}/revert.log" 2>&1 || REVERT_RC=$?
cat "${REVERT_WORK}/revert.log"
revert_identity_verify "${REVERT_WORK}/revert-ids-before" "${REVERT_WORK}/revert-ids-after" 1 "${REVERT_WORK}/revert.log" || exit 1
rm -rf "${REVERT_WORK}"
[ "${REVERT_RC}" -eq 0 ] || { echo "FAIL [phase 2b]: drift --revert exited ${REVERT_RC} (go-to-k/cdkd#6769)" >&2; exit 1; }
wait_group_running_count "${CID_P1}" "${GID_P2}" 2
echo "    drift --revert resized the group back to 2 in place"
group_drift_verdict
rm -f "${DRIFT_JSON}"
if [ "${VERDICT}" != "OK:clean" ]; then
  echo "FAIL [phase 2b]: expected the TaskGroup row clean after the revert, got '${VERDICT}' (go-to-k/cdkd#6769)" >&2
  exit 1
fi
echo "    instance group clean again after the revert"

# --- Phase 2c: delete a TASK group carrying a scaling policy (go-to-k/cdkd#6806) ----
# Scaling a TASK group to 0 succeeds with its AutoScalingPolicy attached, and
# the policy's CloudWatch alarm and Application Auto Scaling target (min 1)
# then outlive the group (live probe, go-to-k/cdkd#6751). cdkd's delete now
# removes the declared policy first, as CloudFormation's handler does. The
# group is deleted while the cluster stays up: a terminating cluster can end
# the policy on its own, which would hide a delete that left it.
echo "==> Phase 2c: add a TASK group with an AutoScalingPolicy (this takes ~5-10 min)"
CDKD_TEST_UPDATE=true,scaled-group node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
SCALED_GID="$(state_json | jq -r '.state.resources.ScaledTaskGroup.physicalId // empty')"
case "${SCALED_GID}" in
  ig-?*) ;;
  *) echo "FAIL [phase 2c]: no ScaledTaskGroup instance group id in state after its deploy (got '${SCALED_GID}')" >&2
     exit 1 ;;
esac
echo "    scaled group id: ${SCALED_GID}"
scaled_policy_state() {
  list_instance_groups_json "${CID_P1}" \
    | jq -r --arg gid "${SCALED_GID}" '[.[] | select(.Id == $gid) | .AutoScalingPolicy.Status.State // "<none>"] | first // "<no group>"'
}
POLICY_STATE=""
for _ in $(seq 1 30); do
  POLICY_STATE="$(scaled_policy_state)"
  [ "${POLICY_STATE}" = "ATTACHED" ] && break
  case "${POLICY_STATE}" in
    FAILED|DETACHED|DETACHING|"<no group>")
      echo "FAIL [phase 2c]: the scaled group's AutoScalingPolicy is '${POLICY_STATE}', expected it to reach ATTACHED" >&2
      exit 1 ;;
  esac
  sleep 10
done
if [ "${POLICY_STATE}" != "ATTACHED" ]; then
  echo "FAIL [phase 2c]: the scaled group's AutoScalingPolicy is '${POLICY_STATE}' after 5 minutes, expected ATTACHED" >&2
  exit 1
fi
# Baseline: the target and the alarm(s) exist, so their absence below is the
# delete's doing.
SCALED_TARGET=""
for _ in $(seq 1 18); do
  SCALED_TARGET="$(scaled_target_ids "${CID_P1}" "${SCALED_GID}")"
  SCALED_ALARMS="$(group_alarm_names "${CID_P1}" "${SCALED_GID}")"
  [ -n "${SCALED_TARGET}" ] && [ -n "${SCALED_ALARMS}" ] && break
  sleep 10
done
if [ -z "${SCALED_TARGET}" ] || [ -z "${SCALED_ALARMS}" ]; then
  echo "FAIL [phase 2c]: the ATTACHED policy shows no Application Auto Scaling target ('${SCALED_TARGET}') or no CloudWatch alarm ('${SCALED_ALARMS}') after 3 minutes" >&2
  exit 1
fi
echo "    policy ATTACHED: target ${SCALED_TARGET}, alarm(s) $(printf '%s' "${SCALED_ALARMS}" | tr '\n' ' ')"

echo "==> Phase 2c: redeploy without the scaled group (cdkd deletes it, the cluster stays up)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# The delete ran: the group was scaled to 0 (EMR keeps the empty group).
SCALED_REQUESTED=""
for _ in $(seq 1 12); do
  SCALED_REQUESTED="$(list_instance_groups_json "${CID_P1}" \
    | jq -r --arg gid "${SCALED_GID}" '[.[] | select(.Id == $gid) | .RequestedInstanceCount] | first // "<no group>"')"
  [ "${SCALED_REQUESTED}" = "0" ] && break
  sleep 10
done
if [ "${SCALED_REQUESTED}" != "0" ]; then
  echo "FAIL [phase 2c]: the scaled group requests '${SCALED_REQUESTED}' instances 2 minutes after its delete, expected 0 (the delete did not run, or a policy that outlived it scaled the group back out)" >&2
  exit 1
fi
# Policy removal is asynchronous (DETACHING, then DETACHED): poll.
assert_scaling_gone() { # $1 = phase label
  local target="" alarms="" left=""
  for _ in $(seq 1 30); do
    target="$(scaled_target_ids "${CID_P1}" "${SCALED_GID}")"
    alarms="$(group_alarm_names "${CID_P1}" "${SCALED_GID}")"
    left="$(alarms_remaining "${SCALED_ALARMS}")"
    [ -z "${target}" ] && [ -z "${alarms}" ] && [ -z "${left}" ] && break
    sleep 10
  done
  if [ -n "${target}" ] || [ -n "${alarms}" ] || [ -n "${left}" ]; then
    echo "FAIL [$1]: the scaled group's policy outlived its delete: scalable target '${target}', alarm(s) '$(printf '%s %s' "${alarms}" "${left}" | tr '\n' ' ')' still exist after 5 minutes (go-to-k/cdkd#6806)" >&2
    exit 1
  fi
}
assert_scaling_gone "phase 2c"
echo "    the policy's scalable target and alarm(s) are gone with the group (go-to-k/cdkd#6806)"

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

assert_scaling_gone "phase 3"
echo "    no scalable target or alarm of the scaled group remains (go-to-k/cdkd#6806)"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::EMR::InstanceGroupConfig SDK provider: deploy + in-place resize + scaling-policy group delete + destroy (group released with cluster) all passed"
