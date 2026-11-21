#!/usr/bin/env bash
# verify.sh — CreationPolicy + cfn-init through cdkd's signal receiver (issue #6705).
# Phases: deploy (the receiver stack is created, AWS::StackId resolves to it,
# the instance's cfn-init reads its metadata from it and cfn-signal reports
# SUCCESS) -> no-change redeploy (the receiver is reused, untouched) ->
# replacement (a new AMI replaces the instance; the replacement waits for its
# own signal) -> FAILURE (a second instance's init fails, cfn-signal sends
# FAILURE, the deploy fails and rolls that instance back) -> destroy (the
# receiver goes with the stack).

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

STACK="CdkdCreationPolicyCfnInit"
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

# The receiver exists, carries cdkd's tag, and is the one state records.
assert_receiver_recorded() {
  local live recorded tag
  live=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
    --query 'Stacks[0].StackId' --output text) || return 1
  tag=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
    --query "Stacks[0].Tags[?Key=='cdkd:signal-receiver'].Value | [0]" --output text) || return 1
  recorded=$(state_field 's.signalReceiverStackId') || return 1
  [ "${tag}" = "true" ] || { echo "FAIL: the stack named ${STACK} is not cdkd's receiver (tag ${tag})" >&2; exit 1; }
  [ -n "${recorded}" ] && [ "${recorded}" = "${live}" ] \
    || { echo "FAIL: state records receiver '${recorded}', the live one is '${live}'" >&2; exit 1; }
  printf '%s' "${live}"
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

echo "==> Phase 1: Deploy (the receiver is created; cfn-init reads its metadata; cfn-signal SUCCESS)"
DEPLOY_LOG=$(mktemp)
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
grep -q 'Created the CloudFormation signal receiver stack' "${DEPLOY_LOG}" \
  || { echo "FAIL: the deploy did not create a signal receiver" >&2; exit 1; }
grep -q 'Instance[0-9A-F]*: received its CreationPolicy signal' "${DEPLOY_LOG}" \
  || { echo "FAIL: the deploy did not wait for the instance's signal" >&2; exit 1; }
# Sentinel: the fallback warning's other half without "not honored" is a reword.
if grep -q 'cfn-signal success signals' "${DEPLOY_LOG}" && ! grep -q 'CreationPolicy is not honored' "${DEPLOY_LOG}"; then
  echo "FAIL: the fallback warning was reworded; update this check" >&2
  exit 1
fi
if grep -q 'CreationPolicy is not honored' "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy fell back to not waiting" >&2
  exit 1
fi
# Phase 2 asserts the ABSENCE of these two lines; prove here they still read so.
grep -q 'waiting for CreationPolicy signals from' "${DEPLOY_LOG}" \
  || { echo "FAIL: the arming line was reworded; update Phase 2's check" >&2; exit 1; }
rm -f "${DEPLOY_LOG}"
echo "    OK: the instance's cfn-init + cfn-signal reached the receiver"
RECEIVER_ID=$(assert_receiver_recorded)
echo "    OK: the receiver ${RECEIVER_ID} is recorded in state"
# AWS::StackId resolves to the receiver: CDK's instance-role grant names it.
POLICY_ARNS=$(state_field 'JSON.stringify(Object.values(s.resources).filter((r) => r.resourceType === "AWS::IAM::Policy").map((r) => r.properties))')
grep -qF "${RECEIVER_ID}" <<<"${POLICY_ARNS}" \
  || { echo "FAIL: no instance-role policy names the receiver's ARN" >&2; exit 1; }
echo "    OK: the instance-role grant names the receiver's ARN"
INSTANCE_ID=$(state_field 'Object.entries(s.resources).find(([id, x]) => x.resourceType === "AWS::EC2::Instance" && !id.startsWith("FailingInstance"))?.[1].physicalId')
[ -n "${INSTANCE_ID}" ] || { echo "FAIL: no instance in state" >&2; exit 1; }
VPC_ID=$(state_field 'Object.values(s.resources).find((x) => x.resourceType === "AWS::EC2::VPC")?.physicalId')

echo "==> Phase 2: a no-change redeploy reuses the receiver and waits for nothing"
NOCHANGE_LOG=$(mktemp)
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${NOCHANGE_LOG}"
grep -q 'No changes' "${NOCHANGE_LOG}" || { echo "FAIL: the redeploy was not a no-change deploy" >&2; exit 1; }
if grep -qE 'Created the CloudFormation signal receiver|waiting for CreationPolicy signals from' "${NOCHANGE_LOG}"; then
  echo "FAIL: the no-change redeploy touched the receiver" >&2
  exit 1
fi
rm -f "${NOCHANGE_LOG}"
[ "$(assert_receiver_recorded)" = "${RECEIVER_ID}" ] || { echo "FAIL: the receiver changed" >&2; exit 1; }
echo "    OK: same receiver, no wait"

echo "==> Phase 3: a replaced instance waits for its own signal"
REPLACE_LOG=$(mktemp)
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${REPLACE_LOG}"
grep -q 'Instance[0-9A-F]*: received its CreationPolicy signal' "${REPLACE_LOG}" \
  || { echo "FAIL: the replacement did not wait for its signal" >&2; exit 1; }
rm -f "${REPLACE_LOG}"
NEW_INSTANCE_ID=$(state_field 'Object.entries(s.resources).find(([id, x]) => x.resourceType === "AWS::EC2::Instance" && !id.startsWith("FailingInstance"))?.[1].physicalId')
[ -n "${NEW_INSTANCE_ID}" ] && [ "${NEW_INSTANCE_ID}" != "${INSTANCE_ID}" ] \
  || { echo "FAIL: the instance was not replaced (${INSTANCE_ID} -> ${NEW_INSTANCE_ID})" >&2; exit 1; }
[ "$(assert_receiver_recorded)" = "${RECEIVER_ID}" ] || { echo "FAIL: the receiver changed" >&2; exit 1; }
echo "    OK: ${INSTANCE_ID} -> ${NEW_INSTANCE_ID}, signalled through the same receiver"
INSTANCE_ID="${NEW_INSTANCE_ID}"

echo "==> Phase 4: a FAILURE signal fails the deploy and rolls the instance back"
FAIL_LOG=$(mktemp)
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FAIL_LOG}" 2>&1
FAIL_RC=$?
set -e
tail -20 "${FAIL_LOG}"
[ "${FAIL_RC}" -ne 0 ] || { echo "FAIL: the deploy with a failing init succeeded" >&2; exit 1; }
grep -qE 'FailingInstance[0-9A-F]* received a FAILURE signal' "${FAIL_LOG}" \
  || { echo "FAIL: the deploy did not fail on FailingInstance's FAILURE signal" >&2; exit 1; }
rm -f "${FAIL_LOG}"
echo "    OK: the deploy failed on the FAILURE signal (rc=${FAIL_RC})"
LEFT=$(state_field 'Object.keys(s.resources).some((k) => k.startsWith("FailingInstance")) ? "yes" : "no"')
[ "${LEFT}" = "no" ] || { echo "FAIL: FailingInstance is still recorded after the rollback" >&2; exit 1; }
RUNNING=$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=tag:Name,Values=${STACK}/FailingInstance" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'length(Reservations[].Instances[])' --output json)
[ "${RUNNING}" = "0" ] || { echo "FAIL: ${RUNNING} FailingInstance instance(s) survived the rollback" >&2; exit 1; }
echo "    OK: the failing instance was rolled back"
[ "$(assert_receiver_recorded)" = "${RECEIVER_ID}" ] || { echo "FAIL: the receiver changed" >&2; exit 1; }

echo "==> Phase 5: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
STATE_OUT=$(aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
case "${STATE_OUT}" in
  terminated | shutting-down) echo "    OK: instance ${INSTANCE_ID} ${STATE_OUT}" ;;
  *) echo "FAIL: instance ${INSTANCE_ID} is ${STATE_OUT} after destroy" >&2; exit 1 ;;
esac
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: VPC gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "    OK: state gone"
assert_receiver_gone

trap - EXIT INT TERM
echo ""
echo "==> creation-policy-cfn-init test passed"
