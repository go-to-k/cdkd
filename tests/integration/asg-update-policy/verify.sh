#!/usr/bin/env bash
# verify.sh -- `cdkd deploy --update-policy` on Auto Scaling groups
# (go-to-k/cdkd#6437 PR 2, go-to-k/cdkd#6457).
#
# The stack (lib/asg-update-policy-stack.ts) has two one-instance groups, each
# on its own launch template whose version a phase bumps:
#   RollingAsg    AutoScalingRollingUpdate (MaxBatchSize 1, MinInstancesInService 0, PauseTime PT0S)
#   ReplacingAsg  AutoScalingReplacingUpdate WillReplace: true
# Both also declare AutoScalingScheduledAction IgnoreUnmodifiedGroupSizeProperties.
#
# This test asserts:
#   1. Phase 1 (deploy): both groups have one InService instance.
#   2. Phase 2 (both launch templates change, --update-policy):
#      - RollingAsg is updated in place (same group name), exactly one instance
#        refresh ran and is Successful, the instance was replaced, and the new
#        instance runs the group's new launch template version.
#      - ReplacingAsg was replaced: state names a new group, the old group is
#        gone, and the new group runs the new launch template version.
#   3. Phase 3 (RollingLt changes, a queue depending on RollingAsg fails to
#      create, --update-policy; go-to-k/cdkd#6457): the deploy fails and rolls
#      back. RollingAsg is back on its phase-2 launch template version, its
#      instance runs that version again (the revert ran a second refresh, so
#      three refreshes are Successful), and a MaxSize raised out of band before
#      the deploy is reset to the template's 2: CloudFormation ignores
#      IgnoreUnmodifiedGroupSizeProperties during a rollback.
#   4. Phase 4 (both launch templates change, NO flag): both groups are updated
#      in place with no refresh and no replacement: the refresh count, the
#      instance ids and ReplacingAsg's name are unchanged.
#   5. Phase 5 (RollingLt changes, RollingAsg declares AutoScalingInstanceRefresh
#      instead of the rolling update, --update-policy): one more refresh runs and
#      succeeds, and the instance is replaced onto the new version.
#   6. Destroy: every group the run created (the replaced one included), both
#      launch templates, the VPC, its subnet and route table, and every instance
#      are gone, and so is the state file.
#
# ReplacingAsg's scaling policy reads the group by Ref: after
# phase 2 it is attached to the NEW group (the replacement promoted it).
#
# Instances: t3.micro, one per group (two during a replacement). Budget: about
# 25-30 minutes, mostly the five instance refreshes and the instance boots.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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

STACK="CdkdAsgUpdatePolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TAG_KEY="cdkd-integ"
TAG_VALUE="asg-update-policy"
ROLLING_LT="cdkd-asg-update-policy-rolling"
REPLACING_LT="cdkd-asg-update-policy-replacing"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
PHASE3_LOG=""
PHASE2_LOG=""

# Every group still carrying this run's tag, one name per line.
# A failed read returns 1 and prints nothing, never an empty list.
tagged_groups() {
  local out
  out=$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" \
    --query 'AutoScalingGroups[].AutoScalingGroupName' --output text) || return 1
  tr '\t' '\n' <<<"${out}" | sed '/^$/d;/^None$/d'
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  [ -n "${PHASE3_LOG}" ] && rm -f "${PHASE3_LOG}"
  [ -n "${PHASE2_LOG}" ] && rm -f "${PHASE2_LOG}"
  # Groups first (force delete terminates their instances), then cdkd destroy
  # for the rest of the stack, then the launch templates by name. The tag
  # filter is a literal, so the sweep cannot widen past this fixture's groups.
  if [ -n "${STATE_BUCKET:-}" ] && [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for group in $(tagged_groups 2>/dev/null); do
    aws autoscaling delete-auto-scaling-group --auto-scaling-group-name "${group}" \
      --force-delete --region "${REGION}" >/dev/null 2>&1
  done
  for _ in $(seq 1 60); do
    [ -z "$(tagged_groups 2>/dev/null)" ] && break
    sleep 10
  done
  for lt in "${ROLLING_LT}" "${REPLACING_LT}"; do
    aws ec2 delete-launch-template --launch-template-name "${lt}" --region "${REGION}" >/dev/null 2>&1
  done
  # A VPC a failed run left (tagged by the stack): its subnets and non-main
  # route tables, then the VPC. The tag filter is a literal, as above.
  for vpc in $(aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" \
      --query 'RouteTables[?!(Associations[?Main])].RouteTableId' --output text 2>/dev/null); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
    done
    aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ] && [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- helpers ------------------------------------------------------------------

# The physical id (the group name) state records for a logical id.
state_physical_id() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}") || return 1
  jq -r --arg id "$1" '.resources[$id].physicalId // empty' <<<"${state}"
}

# Every physical id state records for a resource type, space-separated.
state_ids_of_type() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}") || return 1
  jq -r --arg t "$1" '[.resources[] | select(.resourceType == $t) | .physicalId] | join(" ")' <<<"${state}"
}

# How many scaling policies the group has.
group_policy_count() {
  aws autoscaling describe-policies --auto-scaling-group-name "$1" --region "${REGION}" \
    --query 'length(ScalingPolicies)' --output text
}

# The group's live LaunchTemplate.Version.
group_lt_version() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$1" \
    --region "${REGION}" --query 'AutoScalingGroups[0].LaunchTemplate.Version' --output text
}

lt_latest_version() {
  aws ec2 describe-launch-templates --launch-template-names "$1" --region "${REGION}" \
    --query 'LaunchTemplates[0].LatestVersionNumber' --output text
}

group_max_size() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$1" \
    --region "${REGION}" --query 'AutoScalingGroups[0].MaxSize' --output text
}

# How many groups AWS reports under this exact name (0 = gone).
group_count() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$1" \
    --region "${REGION}" --query 'length(AutoScalingGroups)' --output text
}

# "<instance-id> <launch template version>" of the group's ONE InService
# instance, after waiting (up to 10 minutes) for exactly one to be InService
# and Healthy and nothing else in the group.
wait_one_in_service() {
  local group="$1" line count
  for _ in $(seq 1 60); do
    count=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
      --region "${REGION}" --query 'length(AutoScalingGroups[0].Instances)' --output text) || return 1
    line=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${group}" \
      --region "${REGION}" \
      --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService' && HealthStatus=='Healthy'].[InstanceId, LaunchTemplate.Version]" \
      --output text) || return 1
    if [ "${count}" = "1" ] && [ "$(wc -l <<<"${line}" | tr -d ' ')" = "1" ] && [ -n "${line}" ]; then
      tr '\t' ' ' <<<"${line}"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: ${group} did not settle to one InService instance within 10 minutes" >&2
  return 1
}

# Number of the group's instance refreshes, all statuses / Successful only.
refresh_count() {
  aws autoscaling describe-instance-refreshes --auto-scaling-group-name "$1" \
    --region "${REGION}" --query 'length(InstanceRefreshes)' --output text
}
successful_refresh_count() {
  aws autoscaling describe-instance-refreshes --auto-scaling-group-name "$1" \
    --region "${REGION}" --query "length(InstanceRefreshes[?Status=='Successful'])" --output text
}

expect_eq() { # usage: expect_eq "<what>" <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected '$3', got '$2'" >&2
    exit 1
  fi
  echo "    OK: $1 = $3"
}

expect_ne() { # usage: expect_ne "<what>" <actual> <not-expected>
  if [ "$2" = "$3" ]; then
    echo "FAIL: $1: expected a value other than '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 changed ($3 -> $2)"
}

deploy() { # usage: deploy <phase> [extra cdkd flags...]
  local phase="$1"
  shift
  CDKD_ASG_PHASE="${phase}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@"
}

# --- Phase 1: deploy ------------------------------------------------------------
echo "==> Phase 1: deploy"
deploy 1

ROLLING=$(state_physical_id RollingAsg)
REPLACING_1=$(state_physical_id ReplacingAsg)
[ -n "${ROLLING}" ] && [ -n "${REPLACING_1}" ] || { echo "FAIL: state names no group" >&2; exit 1; }
IN_SERVICE=$(wait_one_in_service "${ROLLING}")
read -r ROLLING_I1 _ <<<"${IN_SERVICE}"
IN_SERVICE=$(wait_one_in_service "${REPLACING_1}")
read -r REPLACING_I1 _ <<<"${IN_SERVICE}"
expect_eq "RollingAsg refreshes after phase 1" "$(refresh_count "${ROLLING}")" 0
expect_eq "ReplacingAsg scaling policies after phase 1" "$(group_policy_count "${REPLACING_1}")" 1
ALL_INSTANCES="${ROLLING_I1} ${REPLACING_I1}"
VPC_IDS=$(state_ids_of_type AWS::EC2::VPC)
SUBNET_IDS=$(state_ids_of_type AWS::EC2::Subnet)
ROUTE_TABLE_IDS=$(state_ids_of_type AWS::EC2::RouteTable)
[ -n "${VPC_IDS}" ] && [ -n "${SUBNET_IDS}" ] && [ -n "${ROUTE_TABLE_IDS}" ] ||
  { echo "FAIL: state names no VPC / subnet / route table" >&2; exit 1; }

# --- Phase 2: both launch templates change, --update-policy ----------------------
echo "==> Phase 2: launch template change with --update-policy"
PHASE2_LOG=$(mktemp)
if ! deploy 2 --update-policy >"${PHASE2_LOG}" 2>&1; then
  cat "${PHASE2_LOG}"
  echo "FAIL: phase 2 deploy failed" >&2
  exit 1
fi
cat "${PHASE2_LOG}"
# The replacement waited for the new group's instance before the old group's
# delete: the wait's own line. Sentinel: the replacement line itself, so a
# reworded wait line fails loudly instead of reading as "no wait".
if ! grep -q 'Replacing ReplacingAsg' "${PHASE2_LOG}"; then
  echo "FAIL: phase 2 did not replace ReplacingAsg" >&2
  exit 1
fi
if ! grep -qE 'ReplacingAsg: the new group has [0-9]+ of [0-9]+ instances in service' "${PHASE2_LOG}"; then
  echo "FAIL: phase 2 replaced ReplacingAsg without waiting for the new group's instances" >&2
  exit 1
fi
echo "    OK: the replacement waited for the new group's instances"
rm -f "${PHASE2_LOG}"
PHASE2_LOG=""

expect_eq "RollingAsg group name (in place)" "$(state_physical_id RollingAsg)" "${ROLLING}"
ROLLING_V2=$(lt_latest_version "${ROLLING_LT}")
expect_eq "RollingAsg launch template version" "$(group_lt_version "${ROLLING}")" "${ROLLING_V2}"
expect_eq "RollingAsg refreshes after phase 2" "$(refresh_count "${ROLLING}")" 1
expect_eq "RollingAsg Successful refreshes after phase 2" "$(successful_refresh_count "${ROLLING}")" 1
IN_SERVICE=$(wait_one_in_service "${ROLLING}")
read -r ROLLING_I2 ROLLING_I2_V <<<"${IN_SERVICE}"
expect_ne "RollingAsg instance" "${ROLLING_I2}" "${ROLLING_I1}"
expect_eq "RollingAsg instance launch template version" "${ROLLING_I2_V}" "${ROLLING_V2}"
ALL_INSTANCES="${ALL_INSTANCES} ${ROLLING_I2}"

REPLACING_2=$(state_physical_id ReplacingAsg)
expect_ne "ReplacingAsg group name (replaced)" "${REPLACING_2}" "${REPLACING_1}"
expect_eq "old ReplacingAsg group ${REPLACING_1} remaining" "$(group_count "${REPLACING_1}")" 0
REPLACING_V2=$(lt_latest_version "${REPLACING_LT}")
expect_eq "new ReplacingAsg launch template version" "$(group_lt_version "${REPLACING_2}")" "${REPLACING_V2}"
IN_SERVICE=$(wait_one_in_service "${REPLACING_2}")
read -r REPLACING_I2 _ <<<"${IN_SERVICE}"
ALL_INSTANCES="${ALL_INSTANCES} ${REPLACING_I2}"
# The reader moved with the replacement: the scaling policy is on the new group.
expect_eq "new ReplacingAsg scaling policies" "$(group_policy_count "${REPLACING_2}")" 1

# --- Phase 3: failing deploy rolls back (go-to-k/cdkd#6457) ------------------------
echo "==> Phase 3: launch template change + a failing resource, --update-policy"
aws autoscaling update-auto-scaling-group --auto-scaling-group-name "${ROLLING}" \
  --max-size 3 --region "${REGION}"
expect_eq "RollingAsg MaxSize raised out of band" "$(group_max_size "${ROLLING}")" 3
PHASE3_LOG=$(mktemp)
if deploy 3 --update-policy >"${PHASE3_LOG}" 2>&1; then
  cat "${PHASE3_LOG}"
  echo "FAIL: phase 3 deploy succeeded; FailingQueue should have failed it" >&2
  exit 1
fi
# SQS's own refusal of the out-of-range value, not just the logical id, which
# any failure line (an unrelated one included) would carry.
if ! grep -qE 'InvalidAttributeValue|MessageRetentionPeriod' "${PHASE3_LOG}"; then
  cat "${PHASE3_LOG}"
  echo "FAIL: phase 3 failed, but not on SQS's MessageRetentionPeriod refusal" >&2
  exit 1
fi
echo "    OK: phase 3 deploy failed on FailingQueue's MessageRetentionPeriod and rolled back"

expect_eq "RollingAsg group name after rollback" "$(state_physical_id RollingAsg)" "${ROLLING}"
expect_eq "RollingAsg launch template version after rollback" "$(group_lt_version "${ROLLING}")" "${ROLLING_V2}"
expect_eq "RollingAsg MaxSize after rollback (sizes re-sent)" "$(group_max_size "${ROLLING}")" 2
expect_eq "RollingAsg refreshes after phase 3" "$(refresh_count "${ROLLING}")" 3
expect_eq "RollingAsg Successful refreshes after phase 3" "$(successful_refresh_count "${ROLLING}")" 3
IN_SERVICE=$(wait_one_in_service "${ROLLING}")
read -r ROLLING_I3 ROLLING_I3_V <<<"${IN_SERVICE}"
expect_ne "RollingAsg instance after rollback" "${ROLLING_I3}" "${ROLLING_I2}"
expect_eq "RollingAsg instance launch template version after rollback" "${ROLLING_I3_V}" "${ROLLING_V2}"
ALL_INSTANCES="${ALL_INSTANCES} ${ROLLING_I3}"
expect_eq "ReplacingAsg group name after rollback" "$(state_physical_id ReplacingAsg)" "${REPLACING_2}"
rm -f "${PHASE3_LOG}"
PHASE3_LOG=""
# The forward refresh's instance (between I2 and I3) is not read; the
# destroy's instance sweep below finds it by tag.

# --- Phase 4: both launch templates change, no flag ----------------------------------
echo "==> Phase 4: launch template change without --update-policy"
deploy 4

expect_eq "RollingAsg group name" "$(state_physical_id RollingAsg)" "${ROLLING}"
expect_ne "RollingAsg launch template version" "$(group_lt_version "${ROLLING}")" "${ROLLING_V2}"
expect_eq "RollingAsg refreshes after phase 4 (none started)" "$(refresh_count "${ROLLING}")" 3
IN_SERVICE=$(wait_one_in_service "${ROLLING}")
read -r ROLLING_I4 _ <<<"${IN_SERVICE}"
expect_eq "RollingAsg instance (not replaced)" "${ROLLING_I4}" "${ROLLING_I3}"
expect_eq "ReplacingAsg group name (in place)" "$(state_physical_id ReplacingAsg)" "${REPLACING_2}"
expect_eq "ReplacingAsg launch template version" "$(group_lt_version "${REPLACING_2}")" "$(lt_latest_version "${REPLACING_LT}")"
IN_SERVICE=$(wait_one_in_service "${REPLACING_2}")
read -r REPLACING_I4 _ <<<"${IN_SERVICE}"
expect_eq "ReplacingAsg instance (not replaced)" "${REPLACING_I4}" "${REPLACING_I2}"

# --- Phase 5: AutoScalingInstanceRefresh, --update-policy ----------------------------
echo "==> Phase 5: RollingAsg on AutoScalingInstanceRefresh, launch template change, --update-policy"
deploy 5 --update-policy

expect_eq "RollingAsg group name" "$(state_physical_id RollingAsg)" "${ROLLING}"
ROLLING_V5=$(lt_latest_version "${ROLLING_LT}")
expect_eq "RollingAsg launch template version" "$(group_lt_version "${ROLLING}")" "${ROLLING_V5}"
expect_eq "RollingAsg refreshes after phase 5" "$(refresh_count "${ROLLING}")" 4
expect_eq "RollingAsg Successful refreshes after phase 5" "$(successful_refresh_count "${ROLLING}")" 4
IN_SERVICE=$(wait_one_in_service "${ROLLING}")
read -r ROLLING_I5 ROLLING_I5_V <<<"${IN_SERVICE}"
expect_ne "RollingAsg instance" "${ROLLING_I5}" "${ROLLING_I4}"
expect_eq "RollingAsg instance launch template version" "${ROLLING_I5_V}" "${ROLLING_V5}"
ALL_INSTANCES="${ALL_INSTANCES} ${ROLLING_I5}"
expect_eq "ReplacingAsg group name (unchanged)" "$(state_physical_id ReplacingAsg)" "${REPLACING_2}"

# --- Phase 6: destroy -----------------------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

for group in "${ROLLING}" "${REPLACING_1}" "${REPLACING_2}"; do
  expect_eq "groups named ${group} after destroy" "$(group_count "${group}")" 0
done
TAGGED=$(tagged_groups)
expect_eq "groups tagged ${TAG_KEY}=${TAG_VALUE} after destroy" "${TAGGED}" ""
assert_gone "launch template ${ROLLING_LT} still exists after destroy" \
  aws ec2 describe-launch-templates --launch-template-names "${ROLLING_LT}" --region "${REGION}"
assert_gone "launch template ${REPLACING_LT} still exists after destroy" \
  aws ec2 describe-launch-templates --launch-template-names "${REPLACING_LT}" --region "${REGION}"
# Every instance the run launched, by tag (the refreshes' in-between ones
# included), is terminated or on its way there.
LIVE=$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=tag:${TAG_KEY},Values=${TAG_VALUE}" \
  "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
expect_eq "live instances tagged ${TAG_KEY}=${TAG_VALUE} after destroy" "${LIVE}" ""
for instance in ${ALL_INSTANCES}; do
  # A terminated instance's record expires after about an hour: gone is fine.
  if gone_probe aws ec2 describe-instances --instance-ids "${instance}" --region "${REGION}"; then
    continue
  fi
  state=$(aws ec2 describe-instances --instance-ids "${instance}" --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
  case "${state}" in
    shutting-down | terminated) ;;
    *)
      echo "FAIL: instance ${instance} is ${state} after destroy" >&2
      exit 1
      ;;
  esac
done
echo "    OK: every instance is terminated or shutting down"
for vpc in ${VPC_IDS}; do
  assert_gone "VPC ${vpc} still exists after destroy" \
    aws ec2 describe-vpcs --vpc-ids "${vpc}" --region "${REGION}"
done
for subnet in ${SUBNET_IDS}; do
  assert_gone "subnet ${subnet} still exists after destroy" \
    aws ec2 describe-subnets --subnet-ids "${subnet}" --region "${REGION}"
done
for rt in ${ROUTE_TABLE_IDS}; do
  assert_gone "route table ${rt} still exists after destroy" \
    aws ec2 describe-route-tables --route-table-ids "${rt}" --region "${REGION}"
done
echo "    OK: the VPC, its subnet and its route table are gone"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

trap - EXIT INT TERM
echo ""
echo "[verify] PASS — asg-update-policy: rolling update ran an instance refresh, replacing update replaced the group and moved its scaling policy, the rollback reverted the refresh and re-sent the sizes, no flag updated both in place, AutoScalingInstanceRefresh ran its refresh, clean destroy"
