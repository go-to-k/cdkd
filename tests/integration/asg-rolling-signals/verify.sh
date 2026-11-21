#!/usr/bin/env bash
# verify.sh — ASG rolling update WaitOnResourceSignals through cdkd's signal receiver (issue #6706).
# Phases: deploy (CreationPolicy waits for both instances) -> --update-policy
# rolling update (each replaced instance signals SUCCESS; the update waits for
# both) -> a FAILURE signal stops the refresh and the deploy rolls the group
# back -> destroy (the receiver goes with the stack).

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

STACK="CdkdAsgRollingSignals"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_field() { # usage: state_field <node expression over s>
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  printf '%s' "${json}" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => { const s = JSON.parse(d); process.stdout.write(String(('"$1"') ?? "")); });'
}

asg_name() { state_field 'Object.values(s.resources).find((r) => r.resourceType === "AWS::AutoScaling::AutoScalingGroup")?.physicalId'; }

# The group's InService instance ids, sorted, space-separated.
inservice_ids() {
  local name
  name=$(asg_name) || return 1
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${name}" --region "${REGION}" \
    --query "join(' ', sort(AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId || \`[]\`))" \
    --output text || return 1
}

assert_receiver_gone() {
  local i status
  for i in $(seq 1 60); do
    if gone_probe aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}"; then
      echo "    OK: the signal receiver stack is gone"
      return 0
    fi
    status=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
      --query 'Stacks[0].StackStatus' --output text) || return 1
    [ "${status}" = "DELETE_COMPLETE" ] && { echo "    OK: the signal receiver stack is deleted"; return 0; }
    sleep 5
  done
  echo "FAIL: the signal receiver stack ${STACK} still exists" >&2
  exit 1
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # A receiver an interrupted run left (tagged by cdkd; never a stack it did not make).
  TAG=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
    --query "Stacks[0].Tags[?Key=='cdkd:signal-receiver'].Value | [0]" --output text 2>/dev/null)
  [ "${TAG}" = "true" ] && aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Phase 1: Deploy (the group's CreationPolicy waits for both instances' signals)"
LOG1=$(mktemp)
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG1}"
grep -q 'Created the CloudFormation signal receiver stack' "${LOG1}" \
  || { echo "FAIL: the deploy did not create a signal receiver" >&2; exit 1; }
grep -qE 'AsgASG[0-9A-Fa-f]*: received its CreationPolicy signal' "${LOG1}" \
  || { echo "FAIL: the deploy did not wait for the group's signals" >&2; exit 1; }
rm -f "${LOG1}"
IDS1=$(inservice_ids)
[ "$(wc -w <<<"${IDS1}" | tr -d ' ')" = "2" ] || { echo "FAIL: expected 2 InService instances, got '${IDS1}'" >&2; exit 1; }
echo "    OK: 2 instances signalled at create (${IDS1})"

echo "==> Phase 2: a rolling update waits for both replaced instances' signals"
LOG2=$(mktemp)
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --update-policy --yes 2>&1 | tee "${LOG2}"
grep -qE 'instance refresh [^ ]+ started' "${LOG2}" \
  || { echo "FAIL: no instance refresh ran" >&2; exit 1; }
grep -qE 'AsgASG[0-9A-Fa-f]*: waiting for 2 CreationPolicy signal\(s\)' "${LOG2}" \
  || { echo "FAIL: the rolling update did not wait for 2 signals" >&2; exit 1; }
grep -qE 'AsgASG[0-9A-Fa-f]*: received its CreationPolicy signal' "${LOG2}" \
  || { echo "FAIL: the rolling update's signals were not received" >&2; exit 1; }
# Sentinel for the absence check below: the fallback warning's other half.
if grep -q 'waits PauseTime after each new instance' "${LOG2}" && ! grep -q 'WaitOnResourceSignals is not honored' "${LOG2}"; then
  echo "FAIL: the fallback warning was reworded; update this check" >&2
  exit 1
fi
if grep -q 'WaitOnResourceSignals is not honored' "${LOG2}"; then
  echo "FAIL: the rolling update fell back to the plain pause" >&2
  exit 1
fi
rm -f "${LOG2}"
IDS2=$(inservice_ids)
for id in ${IDS1}; do
  if grep -qw "${id}" <<<"${IDS2}"; then echo "FAIL: ${id} was not replaced (${IDS2})" >&2; exit 1; fi
done
echo "    OK: both instances replaced and signalled (${IDS2})"
LT_VERSION=$(state_field 'JSON.stringify(Object.values(s.resources).find((r) => r.resourceType === "AWS::AutoScaling::AutoScalingGroup")?.properties.LaunchTemplate ?? null)')

echo "==> Phase 3: a FAILURE signal stops the rolling update and the deploy rolls the group back"
LOG3=$(mktemp)
set +e
CDKD_TEST_UPDATE=fail node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --update-policy --yes >"${LOG3}" 2>&1
RC3=$?
set -e
tail -25 "${LOG3}"
[ "${RC3}" -ne 0 ] || { echo "FAIL: the deploy with failing instances succeeded" >&2; exit 1; }
grep -qE 'instance refresh [^ ]+ stopped: Received FAILURE signal with UniqueId' "${LOG3}" \
  || { echo "FAIL: the refresh was not stopped by the FAILURE signal" >&2; exit 1; }
grep -q 'Rolling back' "${LOG3}" || { echo "FAIL: the deploy did not roll back" >&2; exit 1; }
rm -f "${LOG3}"
LT_AFTER=$(state_field 'JSON.stringify(Object.values(s.resources).find((r) => r.resourceType === "AWS::AutoScaling::AutoScalingGroup")?.properties.LaunchTemplate ?? null)')
[ "${LT_AFTER}" = "${LT_VERSION}" ] || { echo "FAIL: the group's launch template was not rolled back (${LT_VERSION} -> ${LT_AFTER})" >&2; exit 1; }
echo "    OK: the FAILURE signal failed the update (rc=${RC3}) and the group was rolled back"

echo "==> Phase 4: Destroy"
VPC_ID=$(state_field 'Object.values(s.resources).find((x) => x.resourceType === "AWS::EC2::VPC")?.physicalId')
ASG_NAME=$(asg_name)
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
LEFT=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "${ASG_NAME}" --region "${REGION}" \
  --query 'length(AutoScalingGroups)' --output text)
[ "${LEFT}" = "0" ] || { echo "FAIL: the group ${ASG_NAME} still exists" >&2; exit 1; }
echo "    OK: group gone"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "    OK: state gone"
assert_receiver_gone

trap - EXIT INT TERM
echo ""
echo "==> asg-rolling-signals test passed"
