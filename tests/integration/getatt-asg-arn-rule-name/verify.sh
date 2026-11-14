#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt AutoScalingGroup AutoScalingGroupARN and Events
# Rule RuleName (issue #6242).
#
# Measured against CloudFormation: AutoScalingGroupARN resolved to the group
# NAME and RuleName to the whole rule ARN. Asserts each output equals the
# value AWS / CloudFormation reports (the plain rule name, on a custom bus
# too), then destroys clean. No UPDATE phase: neither attribute changes on an
# in-place update. The ASG has capacity 0, so no instance runs.

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

STACK="CdkdGetattAsgArnRuleNameExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ASG_NAME="${STACK}-asg"
BUS_NAME="${STACK}-bus"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  rm -f "${DEPLOY_LOG}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws autoscaling delete-auto-scaling-group --region "${REGION}" --auto-scaling-group-name "${ASG_NAME}" --force-delete >/dev/null 2>&1 || true
  aws events delete-rule --region "${REGION}" --name "${STACK}-custom" --event-bus-name "${BUS_NAME}" >/dev/null 2>&1 || true
  aws events delete-rule --region "${REGION}" --name "${STACK}-default" >/dev/null 2>&1 || true
  aws events delete-event-bus --region "${REGION}" --name "${BUS_NAME}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

expect_eq() { # usage: expect_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3' (physical-id fallback?)" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
if grep -E 'Unknown attribute (AutoScalingGroupARN|RuleName)' "${DEPLOY_LOG}"; then
  echo "FAIL: a physical-id fallback warning was printed (see above)" >&2
  exit 1
fi

LIVE_ASG_ARN="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text)"
case "${LIVE_ASG_ARN}" in arn:*) ;; *) echo "FAIL: live ASG ARN '${LIVE_ASG_ARN}'" >&2; exit 1 ;; esac
expect_eq "AsgArn output" "$(output_of AsgArn)" "${LIVE_ASG_ARN}"

# CloudFormation's RuleName is the plain name, on a custom bus too.
expect_eq "RuleCustomName output" "$(output_of RuleCustomName)" "${STACK}-custom"
expect_eq "RuleDefaultName output" "$(output_of RuleDefaultName)" "${STACK}-default"
aws events describe-rule --region "${REGION}" --name "${STACK}-custom" --event-bus-name "${BUS_NAME}" >/dev/null
echo "    OK: the custom-bus rule exists under that name"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DescribeAutoScalingGroups answers an EMPTY list for a missing group, not a
# not-found error, so the count is read strictly (a failed read aborts).
ASG_LEFT=""
for _ in $(seq 1 36); do
  ASG_LEFT="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --auto-scaling-group-names "${ASG_NAME}" --query 'length(AutoScalingGroups)' --output text)"
  [ "${ASG_LEFT}" = "0" ] && break
  sleep 5
done
[ "${ASG_LEFT}" = "0" ] || { echo "FAIL: ASG ${ASG_NAME} still exists after destroy" >&2; exit 1; }
assert_gone "rule ${STACK}-default still exists after destroy" aws events describe-rule --region "${REGION}" --name "${STACK}-default"
assert_gone "bus ${BUS_NAME} still exists after destroy" aws events describe-event-bus --region "${REGION}" --name "${BUS_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: ASG, rules, bus and state gone"

echo ""
echo "[verify] PASS — getatt-asg-arn-rule-name: AutoScalingGroupARN and RuleName match CloudFormation's values"
