#!/usr/bin/env bash
# verify.sh — cdkd destroy of an Auto Scaling group with running instances
# (issue #6466).
#
# AWS refuses DeleteAutoScalingGroup without ForceDelete while the group holds
# instances. CloudFormation scales the group to 0, waits for the instances to
# terminate, then deletes it; before the fix cdkd sent the plain delete and the
# destroy failed unless --remove-protection was passed.
#
# Phases:
#   A. CdkdAsgDestroyRunningExample: deploy (1 instance), wait for it to be
#      InService, plain `cdkd destroy`. Assert: the destroy succeeds, it took
#      the scale-in path (its log line), the group is gone, the instance is
#      terminated, and the launch template, VPC and state file are gone.
#   B. CdkdAsgDestroyScaleInProtectedExample: the same with the instance
#      protected from scale in. Assert: the plain destroy FAILS naming the
#      instance, and nothing was scaled (desired capacity still 1, the instance
#      still InService, the record kept). Then `destroy --remove-protection`
#      force-deletes the group: everything gone, the instance terminated.
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

REGION="${AWS_REGION:-us-east-1}"
RUN_STACK="CdkdAsgDestroyRunningExample"
PROT_STACK="CdkdAsgDestroyScaleInProtectedExample"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="$(mktemp)"

state_key() { echo "cdkd/$1/${REGION}/state.json"; }
# ${LOG} without colour codes, on one line (a long line may wrap).
plain_log() { sed $'s/\x1b\\[[0-9;]*m//g' "${LOG}" | tr '\n' ' ' | tr -s ' '; }
asg_name() { echo "$1-asg"; }

# Instance ids seen by this run, terminated by cleanup on any exit path.
SEEN_INSTANCES=()

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${LOG}"
  local stack
  for stack in "${RUN_STACK}" "${PROT_STACK}"; do
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force --remove-protection >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes --remove-protection >/dev/null 2>&1
    fi
    aws autoscaling delete-auto-scaling-group --region "${REGION}" --auto-scaling-group-name "$(asg_name "${stack}")" --force-delete >/dev/null 2>&1 || true
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/$(state_key "${stack}")" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${REGION}/lock.json" >/dev/null 2>&1 || true
    fi
  done
  if [ "${#SEEN_INSTANCES[@]}" -gt 0 ]; then
    aws ec2 terminate-instances --region "${REGION}" --instance-ids "${SEEN_INSTANCES[@]}" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# The group's one instance, once it is InService (up to 6 minutes). A failed
# read aborts the run (set -e), so an empty answer means "not yet".
wait_in_service() { # usage: wait_in_service <group name>
  local id=""
  for _ in $(seq 1 72); do
    id="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
      --auto-scaling-group-names "$1" \
      --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId | [0]" --output text)" || return 1
    case "${id}" in i-*) echo "${id}"; return 0 ;; esac
    sleep 5
  done
  echo "FAIL: no instance of $1 reached InService within 6 minutes" >&2
  exit 1
}

# DescribeAutoScalingGroups answers an EMPTY list for a missing group, not a
# not-found error, so the count is read strictly.
assert_group_gone() { # usage: assert_group_gone <group name>
  local left=""
  for _ in $(seq 1 36); do
    left="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
      --auto-scaling-group-names "$1" --query 'length(AutoScalingGroups)' --output text)" || return 1
    [ "${left}" = "0" ] && return 0
    sleep 5
  done
  echo "FAIL: ASG $1 still exists after destroy" >&2
  exit 1
}

# EC2 keeps a terminated instance visible for about an hour, so the state is
# read: it must reach `terminated` (it may still be `shutting-down` briefly).
assert_terminated() { # usage: assert_terminated <instance id>
  local state=""
  for _ in $(seq 1 36); do
    state="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "$1" \
      --query 'Reservations[0].Instances[0].State.Name' --output text)" || return 1
    [ "${state}" = "terminated" ] && { echo "    OK: instance $1 is terminated"; return 0; }
    sleep 5
  done
  echo "FAIL: instance $1 is '${state}' after destroy, not terminated (orphaned)" >&2
  exit 1
}

# The VPC and launch template ids from the stack's state, before its destroy.
record_id() { # usage: record_id <stack> <resource type>
  aws s3 cp "s3://${STATE_BUCKET}/$(state_key "$1")" - \
    | jq -r --arg t "$2" '[.resources[] | select(.resourceType == $t) | .physicalId] | if length == 1 then .[0] else error("expected one \($t) record") end'
}

assert_rest_gone() { # usage: assert_rest_gone <stack> <vpc id> <launch template id>
  assert_gone "launch template $3 of $1 still exists after destroy" aws ec2 describe-launch-templates --region "${REGION}" --launch-template-ids "$3"
  assert_gone "VPC $2 of $1 still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "$2"
  assert_gone "state file of $1 still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "$1")"
  echo "    OK: $1's launch template, VPC and state file are gone"
}

echo "==> Deploy both stacks"
node "${LOCAL_DIST}" deploy "${RUN_STACK}" "${PROT_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# --- Phase A: a plain destroy scales the group in --------------------------
echo "==> Phase A: plain destroy of ${RUN_STACK} with a running instance"
RUN_INSTANCE="$(wait_in_service "$(asg_name "${RUN_STACK}")")"
SEEN_INSTANCES+=("${RUN_INSTANCE}")
echo "    instance ${RUN_INSTANCE} is InService"
RUN_VPC="$(record_id "${RUN_STACK}" AWS::EC2::VPC)"
RUN_LT="$(record_id "${RUN_STACK}" AWS::EC2::LaunchTemplate)"

node "${LOCAL_DIST}" destroy "${RUN_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${LOG}"
PLAIN="$(plain_log)"
if ! grep -q "Scaling AutoScalingGroup Asg[A-Za-z0-9]* to 0 and waiting for its 1 instance(s) to terminate" <<<"${PLAIN}"; then
  echo "FAIL: the destroy log has no scale-in line: the group was not emptied by the scale-in path" >&2
  exit 1
fi
assert_group_gone "$(asg_name "${RUN_STACK}")"
assert_terminated "${RUN_INSTANCE}"
assert_rest_gone "${RUN_STACK}" "${RUN_VPC}" "${RUN_LT}"

# --- Phase B: a scale-in-protected instance is refused, untouched ----------
echo "==> Phase B: plain destroy of ${PROT_STACK} (instance protected from scale in)"
PROT_GROUP="$(asg_name "${PROT_STACK}")"
PROT_INSTANCE="$(wait_in_service "${PROT_GROUP}")"
SEEN_INSTANCES+=("${PROT_INSTANCE}")
PROTECTED="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" --auto-scaling-group-names "${PROT_GROUP}" \
  --query "AutoScalingGroups[0].Instances[?InstanceId=='${PROT_INSTANCE}'].ProtectedFromScaleIn | [0]" --output text)"
[ "${PROTECTED}" = "True" ] || { echo "FAIL: instance ${PROT_INSTANCE} is not protected from scale in (${PROTECTED}): the arm proves nothing" >&2; exit 1; }
PROT_VPC="$(record_id "${PROT_STACK}" AWS::EC2::VPC)"
PROT_LT="$(record_id "${PROT_STACK}" AWS::EC2::LaunchTemplate)"

set +e
node "${LOCAL_DIST}" destroy "${PROT_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >"${LOG}" 2>&1
RC=$?
set -e
cat "${LOG}"
PLAIN="$(plain_log)"
[ "${RC}" -ne 0 ] || { echo "FAIL: the plain destroy of a group with a scale-in-protected instance exited 0" >&2; exit 1; }
if ! grep -qF "protected from scale in, in Standby or retained: ${PROT_INSTANCE} (InService)" <<<"${PLAIN}"; then
  echo "FAIL: the refusal does not name instance ${PROT_INSTANCE} as protected from scale in" >&2
  exit 1
fi
if ! grep -qF -- "--remove-protection" <<<"${PLAIN}"; then
  echo "FAIL: the refusal does not offer --remove-protection on a destroy" >&2
  exit 1
fi
DESIRED="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" --auto-scaling-group-names "${PROT_GROUP}" \
  --query 'AutoScalingGroups[0].DesiredCapacity' --output text)"
[ "${DESIRED}" = "1" ] || { echo "FAIL: the refused destroy changed the desired capacity to ${DESIRED}" >&2; exit 1; }
STATE_NOW="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${PROT_INSTANCE}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)"
[ "${STATE_NOW}" = "running" ] || { echo "FAIL: instance ${PROT_INSTANCE} is '${STATE_NOW}' after the refused destroy" >&2; exit 1; }
KEPT="$(aws s3 cp "s3://${STATE_BUCKET}/$(state_key "${PROT_STACK}")" - \
  | jq -r '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup")] | length')"
[ "${KEPT}" = "1" ] || { echo "FAIL: the refused destroy dropped the ASG record (${KEPT} left)" >&2; exit 1; }
echo "    OK: refused, nothing scaled, instance running, record kept"

echo "==> Phase B: destroy --remove-protection force-deletes it"
node "${LOCAL_DIST}" destroy "${PROT_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --remove-protection
assert_group_gone "${PROT_GROUP}"
assert_terminated "${PROT_INSTANCE}"
assert_rest_gone "${PROT_STACK}" "${PROT_VPC}" "${PROT_LT}"

echo ""
echo "[verify] PASS — asg-destroy-running-instances: a plain destroy scales a running group to 0 and deletes it; a scale-in-protected one is refused untouched"
