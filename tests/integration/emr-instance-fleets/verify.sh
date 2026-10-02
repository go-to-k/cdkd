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
#   2b. Re-deploy with CDKD_TEST_REMOVAL=true (issue #1160): the TASK fleet's
#      ResizeSpecifications is DROPPED from the template while its
#      TargetOnDemandCapacity goes 2 -> 1. Assert the deploy succeeds and warns
#      naming the removed property (with no CloudFormation-reset claim), the
#      live On-Demand resize timeout stays 25 (cdkd sends no reset), and the
#      companion resize landed.
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
# The TASK fleet's templated On-Demand resize timeout (minutes). Phase 1 proves
# it reached AWS; Phase 2b proves it survives its removal from the template.
RESIZE_TIMEOUT="25"
# Phase 2b (issue #1160): the provider's removal warning. The needle names the
# removed property; the sentinel is an independent substring of the same line,
# so a reworded warning fails loudly instead of reading as "not fired".
REMOVAL_NEEDLE="(AWS::EMR::InstanceFleetConfig): property ResizeSpecifications was removed from the template"
REMOVAL_SENTINEL="ModifyInstanceFleet keeps a setting it is not sent"
# The shared caller's line for a removal no provider handles. It claims a
# CloudFormation reset, which is unmeasured for this property, so it must not
# name the fleet.
SHARED_REMOVAL_CLAIM="(CloudFormation would reset it to its default)"
# Deploy logs, streamed through `tee` and read back for the greps; removed by
# cleanup on every exit path.
PHASE2_LOG=""
PHASE2B_LOG=""

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
# the fixture's constant tag — ASSERTION grade: any AWS failure propagates
# instead of masquerading as "no clusters".
#
# `|| return 1` on each capture is load-bearing: errexit is cleared inside
# `$( )`, so without it a throttled `describe-cluster` would classify a live
# leftover as untagged and the post-destroy leak check would report clean.
strict_active_tagged_cluster_ids() {
  local ids id tags
  ids="$(aws emr list-clusters --active --region "${REGION}" \
    --query "Clusters[?Name=='${CLUSTER_NAME}'].Id" --output text)" || return 1
  ids="$(printf '%s' "${ids}" | tr '\t' '\n' | sed '/^$/d')"
  for id in ${ids}; do
    tags="$(aws emr describe-cluster --cluster-id "${id}" --region "${REGION}" \
      --query "Cluster.Tags[?Key=='${CLEANUP_TAG_KEY}' && Value=='${CLEANUP_TAG_VALUE}']" \
      --output text)" || return 1
    if printf '%s' "${tags}" | grep -q .; then
      echo "${id}"
    fi
  done
}

# Best-effort variant for cleanup(), where a transient API failure must not
# abort the teardown — the EXIT trap runs with `set +eu` and any leftover is
# caught by the next run's pre-run cleanup.
active_tagged_cluster_ids() {
  strict_active_tagged_cluster_ids 2>/dev/null || true
}

# Cluster state, assertion grade: prints the state and returns 0, or returns
# non-zero with the AWS error on stderr. There is deliberately NO swallowing
# variant — in assertion position `X="$(probe)"` under `set -e` aborts at the
# ASSIGNMENT, so the FAIL branch never runs and the diagnostic never prints.
# Callers use `&& rc=0 || rc=$?` and report properly; the polling caller passes
# `2>/dev/null` at the call site where it genuinely tolerates "don't know".
strict_cluster_state() {
  aws emr describe-cluster --cluster-id "$1" --region "${REGION}" \
    --query 'Cluster.Status.State' --output text
}

# Poll until the cluster reaches a terminal state. Returns non-zero on timeout
# OR if the state could never be read.
#
# An API failure must NOT read as TERMINATED: a `[ -z "${st}" ]` branch would
# return success on a throttle, so cleanup would walk into the VPC teardown
# with a live cluster still holding ENIs and silently orphan the VPC.
wait_cluster_terminated() {
  local id="$1"
  local deadline=$((SECONDS + 1800))
  local st rc
  while [ ${SECONDS} -lt ${deadline} ]; do
    st="$(strict_cluster_state "${id}" 2>/dev/null)" && rc=0 || rc=$?
    if [ ${rc} -ne 0 ]; then
      # DescribeCluster failing for an id that existed usually means it aged
      # out of the API — treat as gone ONLY after re-confirming it is not in
      # the active list; otherwise keep polling.
      if ! strict_active_tagged_cluster_ids 2>/dev/null | grep -qx "${id}"; then
        return 0
      fi
    elif [ "${st}" = "TERMINATED" ] || [ "${st}" = "TERMINATED_WITH_ERRORS" ]; then
      return 0
    fi
    sleep 15
  done
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${PHASE2_LOG:-}" ] && rm -f "${PHASE2_LOG}"
  [ -n "${PHASE2B_LOG:-}" ] && rm -f "${PHASE2B_LOG}"
  # Drop a stale lock BEFORE `state destroy`: an interrupted run leaves
  # lock.json behind, `state destroy` then refuses to acquire it and exits
  # without deleting anything. The tag sweep below still catches the cluster,
  # but the IAM roles / instance profile would leak silently.
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
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

# On-Demand resize timeout (minutes) of the fleet with the given id; empty when
# the fleet carries no ResizeSpecifications.
fleet_ondemand_resize_timeout() { # $1 = fleets json, $2 = fleet id
  printf '%s' "$1" | jq -r --arg fid "$2" \
    '[ .[] | select(.Id == $fid) | .ResizeSpecifications.OnDemandResizeSpecification.TimeoutDurationMinutes ] | first // empty'
}

# --- Phase 1: deploy baseline ------------------------------------------
echo "==> Phase 1: deploy fleet-based cluster + standalone TASK fleet (this takes ~10-20 min)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
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

STATE_P1="$(strict_cluster_state "${CID_P1}" 2>/dev/null)" && STATE_P1_RC=0 || STATE_P1_RC=$?
if [ ${STATE_P1_RC} -ne 0 ]; then
  echo "FAIL: could not read cluster ${CID_P1} state after Phase 1 (DescribeCluster failed)" >&2
  exit 1
fi
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

# The baseline half of Phase 2b's removal assertion: the templated resize
# timeout must be LIVE before its removal can be shown to leave it in place.
TIMEOUT_P1="$(fleet_ondemand_resize_timeout "${FLEETS_P1}" "${FID_P1}")"
if [ "${TIMEOUT_P1}" != "${RESIZE_TIMEOUT}" ]; then
  echo "FAIL: Phase 1 expected TASK fleet OnDemandResizeSpecification.TimeoutDurationMinutes ${RESIZE_TIMEOUT}, got '${TIMEOUT_P1}'" >&2
  echo "      raw fleets: ${FLEETS_P1}" >&2
  exit 1
fi
echo "    TASK fleet ResizeSpecifications reached AWS (On-Demand timeout ${TIMEOUT_P1} min)"

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
PHASE2_LOG="$(mktemp)"
set +e
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2_LOG}"
PHASE2_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2_RC}" -ne 0 ]; then
  echo "FAIL [phase 2]: deploy exited ${PHASE2_RC}" >&2
  exit 1
fi
PHASE2_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2_LOG}")"
# Negative control for Phase 2b's needle: this deploy resizes the fleet and
# removes nothing, so the removal warning must not appear here.
if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2_PLAIN}"; then
  echo "FAIL [phase 2]: the #1160 removal warning fired on a deploy that removed no property" >&2
  exit 1
fi

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

# --- Phase 2b: removal of ResizeSpecifications (issue #1160) ------------
# ResizeSpecifications leaves the TASK fleet's template while its live
# On-Demand timeout is 25 (asserted in Phase 1). ModifyInstanceFleet keeps a
# field it is not sent and cdkd sends no reset, so: the deploy succeeds, the
# timeout STAYS 25, and the deploy names the removal in a warning (pre-fix it
# was dropped silently). TargetOnDemandCapacity goes 2 -> 1 in the same
# deploy, so ModifyInstanceFleet demonstrably fires beside the removal.
echo "==> Phase 2b: re-deploy with CDKD_TEST_REMOVAL=true (ResizeSpecifications dropped, TASK fleet 2 -> 1)"
PHASE2B_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PHASE2B_LOG}"
PHASE2B_RC=${PIPESTATUS[0]}
set -e
if [ "${PHASE2B_RC}" -ne 0 ]; then
  echo "FAIL [phase 2b]: removing ResizeSpecifications failed the deploy (exit ${PHASE2B_RC}); cdkd must leave it in place and warn" >&2
  exit 1
fi
PHASE2B_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${PHASE2B_LOG}")"
# Needle and sentinel are independent substrings of the SAME warning line: the
# sentinel without the needle means the wording drifted, not that the warning
# did not fire.
if ! grep -qF "${REMOVAL_NEEDLE}" <<<"${PHASE2B_PLAIN}"; then
  if grep -qF "${REMOVAL_SENTINEL}" <<<"${PHASE2B_PLAIN}"; then
    echo "FAIL [phase 2b]: a removal warning fired but no longer reads '${REMOVAL_NEEDLE}' -- the wording drifted; update this fixture" >&2
  else
    echo "FAIL [phase 2b]: removing ResizeSpecifications produced no warning (issue #1160: the removal was dropped silently)" >&2
  fi
  exit 1
fi
# One process, not `grep | grep -q`: under pipefail the second grep exiting
# early on a match SIGPIPEs the first, and the pipeline then reads as "no match".
if awk -v a="(AWS::EMR::InstanceFleetConfig)" -v b="${SHARED_REMOVAL_CLAIM}" 'index($0, a) && index($0, b) { f = 1 } END { exit !f }' <<<"${PHASE2B_PLAIN}"; then
  echo "FAIL [phase 2b]: the shared removal warning claimed a CloudFormation reset for the fleet; the provider must handle the removal itself" >&2
  exit 1
fi
echo "    deploy warned that ResizeSpecifications is left in place"

FID_P2B="$(output_value TaskFleetId)"
if [ "${FID_P2}" != "${FID_P2B}" ]; then
  echo "FAIL: TASK fleet was REPLACED in Phase 2b (${FID_P2} -> ${FID_P2B})" >&2
  exit 1
fi
FLEETS_P2B="$(list_instance_fleets_json "${CID_P1}")"
TIMEOUT_P2B="$(fleet_ondemand_resize_timeout "${FLEETS_P2B}" "${FID_P2B}")"
if [ "${TIMEOUT_P2B}" != "${RESIZE_TIMEOUT}" ]; then
  echo "FAIL [phase 2b]: expected the On-Demand resize timeout to stay ${RESIZE_TIMEOUT} (cdkd sends no reset), got '${TIMEOUT_P2B}'" >&2
  echo "      raw fleets: ${FLEETS_P2B}" >&2
  exit 1
fi
CAP_P2B="$(fleet_provisioned_ondemand "${FLEETS_P2B}" "${FID_P2B}")"
if [ "${CAP_P2B}" != "1" ]; then
  echo "FAIL [phase 2b]: expected the companion resize to ProvisionedOnDemandCapacity 1, got '${CAP_P2B}' (ModifyInstanceFleet did not apply)" >&2
  echo "      raw fleets: ${FLEETS_P2B}" >&2
  exit 1
fi
echo "    removal left in place (timeout ${TIMEOUT_P2B} min) beside an applied resize (capacity 1)"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy (EMR termination takes a few minutes)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

FINAL_STATE="$(strict_cluster_state "${CID_P1}" 2>/dev/null)" && FINAL_RC=0 || FINAL_RC=$?
if [ ${FINAL_RC} -ne 0 ]; then
  echo "FAIL: could not read cluster ${CID_P1} state after destroy (DescribeCluster failed)" >&2
  echo "      refusing to report PASS on an unverified termination check" >&2
  exit 1
fi
if [ "${FINAL_STATE}" != "TERMINATED" ] && [ "${FINAL_STATE}" != "TERMINATED_WITH_ERRORS" ]; then
  echo "FAIL: EMR cluster ${CID_P1} not terminated after destroy (state '${FINAL_STATE}')" >&2
  exit 1
fi
echo "    cluster ${FINAL_STATE} (fleets released with it)"

# Leak assertion — STRICT lookup, so a throttled `emr list-clusters` cannot
# masquerade as "no leftover clusters". Retry a few times, then hard-fail
# rather than pass on an undetermined result.
LEFTOVERS=""
LEAK_CHECK_OK=false
for attempt in 1 2 3; do
  if LEFTOVERS="$(strict_active_tagged_cluster_ids)"; then
    LEAK_CHECK_OK=true
    break
  fi
  echo "    warn: 'aws emr list-clusters --active' failed (attempt ${attempt}/3), retrying" >&2
  sleep 5
done
if [ "${LEAK_CHECK_OK}" != "true" ]; then
  echo "FAIL: could not determine whether ACTIVE EMR clusters remain (AWS API calls failed 3x)" >&2
  echo "      refusing to report PASS on an unverified leak check — check the account manually" >&2
  exit 1
fi
if [ -n "${LEFTOVERS}" ]; then
  echo "FAIL: ACTIVE EMR cluster(s) with tag ${CLEANUP_TAG_KEY}=${CLEANUP_TAG_VALUE} still exist after destroy: ${LEFTOVERS}" >&2
  exit 1
fi
echo "    no active cluster with the fixture tag remains (verified, not inferred from a failed call)"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AWS::EMR::InstanceFleetConfig SDK provider: deploy + in-place resize + ResizeSpecifications removal warning + destroy, with all three InstanceTypeConfigs conversion sites verified against AWS"
