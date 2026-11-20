#!/usr/bin/env bash
# verify.sh — CreationPolicy + cfn-init through cdkd's signal receiver (issue #6705).
# Phases: deploy (the instance's cfn-init reads its metadata from the receiver
# and cfn-signal reports SUCCESS; the receiver stack is gone afterwards) ->
# FAILURE (a second instance's init fails, cfn-signal sends FAILURE, the deploy
# fails and rolls that instance back) -> destroy.

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

# The receiver is deleted at the deploy's end (DeleteStack, not awaited):
# wait for it to be gone.
assert_receiver_gone() {
  local i
  for i in $(seq 1 30); do
    if gone_probe aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}"; then
      echo "    OK: the signal receiver stack is gone"
      return 0
    fi
    local status
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

echo "==> Phase 1: Deploy (cfn-init reads the receiver's metadata; cfn-signal SUCCESS)"
DEPLOY_LOG=$(mktemp)
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
grep -q 'Created the CloudFormation signal receiver stack' "${DEPLOY_LOG}" \
  || { echo "FAIL: the deploy did not create a signal receiver" >&2; exit 1; }
grep -q 'received its CreationPolicy signal' "${DEPLOY_LOG}" \
  || { echo "FAIL: the deploy did not wait for the instance's signal" >&2; exit 1; }
if grep -q 'CreationPolicy is not honored' "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy fell back to not waiting" >&2
  exit 1
fi
rm -f "${DEPLOY_LOG}"
echo "    OK: the instance's cfn-init + cfn-signal reached the receiver"
assert_receiver_gone

STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
INSTANCE_ID=$(printf '%s' "${STATE_JSON}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    const r = Object.entries(s.resources).find(([id, x]) => x.resourceType === "AWS::EC2::Instance" && !id.startsWith("FailingInstance"));
    process.stdout.write(r ? r[1].physicalId : "");
  });')
[ -n "${INSTANCE_ID}" ] || { echo "FAIL: no instance in state" >&2; exit 1; }
VPC_ID=$(printf '%s' "${STATE_JSON}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    const r = Object.values(s.resources).find((x) => x.resourceType === "AWS::EC2::VPC");
    process.stdout.write(r ? r.physicalId : "");
  });')

echo "==> Phase 2: a FAILURE signal fails the deploy and rolls the instance back"
FAIL_LOG=$(mktemp)
set +e
CDKD_TEST_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FAIL_LOG}" 2>&1
FAIL_RC=$?
set -e
tail -20 "${FAIL_LOG}"
[ "${FAIL_RC}" -ne 0 ] || { echo "FAIL: the deploy with a failing init succeeded" >&2; exit 1; }
grep -q 'FailingInstance' "${FAIL_LOG}" \
  || { echo "FAIL: the failure does not name FailingInstance (sentinel)" >&2; exit 1; }
grep -qE 'FailingInstance received a FAILURE signal|FailingInstance did not receive' "${FAIL_LOG}" \
  || { echo "FAIL: the deploy did not fail on the CreationPolicy signal" >&2; exit 1; }
rm -f "${FAIL_LOG}"
echo "    OK: the deploy failed on the FAILURE signal (rc=${FAIL_RC})"
LEFT=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    process.stdout.write(Object.keys(s.resources).some((k) => k.startsWith("FailingInstance")) ? "yes" : "no");
  });')
[ "${LEFT}" = "no" ] || { echo "FAIL: FailingInstance is still recorded after the rollback" >&2; exit 1; }
RUNNING=$(aws ec2 describe-instances --region "${REGION}" \
  --filters "Name=tag:Name,Values=${STACK}/FailingInstance" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'length(Reservations[].Instances[])' --output json)
[ "${RUNNING}" = "0" ] || { echo "FAIL: ${RUNNING} FailingInstance instance(s) survived the rollback" >&2; exit 1; }
echo "    OK: the failing instance was rolled back"
assert_receiver_gone

echo "==> Phase 3: Destroy"
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
