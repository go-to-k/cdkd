#!/usr/bin/env bash
# verify.sh — ECS Fargate targets on Events Rule + Scheduler Schedule
# (issues #1381 / #1382).
#
# Asserts that the CFn-spelled ECS target sub-shapes reach AWS with the SDK
# spellings after `cdkd deploy`:
#   - Events Rule Targets[0].EcsParameters.NetworkConfiguration.awsvpcConfiguration
#     (from CFn AwsVpcConfiguration) + Tags (from CFn TagList)
#   - Scheduler Target.EcsParameters.NetworkConfiguration.awsvpcConfiguration
#     (from CFn AwsvpcConfiguration)
# Before the fix BOTH creates failed with "Parameter NetworkConfiguration must
# be specified ... when launch type is FARGATE". Then destroys clean.

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
cd "$(dirname "$0")"

STACK="CdkdEcsScheduleTargetsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
RULE="${STACK}-rule"
SCHED="${STACK}-sched"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# --- Assertion 1: Rule target's ECS network config + tags landed ------
TARGET=$(aws events list-targets-by-rule --rule "${RULE}" --region "${REGION}" --output json)
SUBNET_COUNT=$(echo "${TARGET}" \
  | jq -r '.Targets[0].EcsParameters.NetworkConfiguration.awsvpcConfiguration.Subnets | length')
if [ "${SUBNET_COUNT}" != "2" ]; then
  echo "FAIL: rule target awsvpcConfiguration.Subnets count is '${SUBNET_COUNT}', expected 2 (NetworkConfiguration dropped — issue #1381)" >&2
  echo "${TARGET}" | jq . >&2 || true
  exit 1
fi
TAG_VALUE=$(echo "${TARGET}" \
  | jq -r '.Targets[0].EcsParameters.Tags[0] | "\(.Key)=\(.Value)"')
if [ "${TAG_VALUE}" != "cdkd-integ=events-ecs-target" ]; then
  echo "FAIL: rule target ECS Tags is '${TAG_VALUE}', expected 'cdkd-integ=events-ecs-target' (TagList dropped — issue #1381)" >&2
  exit 1
fi
echo "    OK: rule target awsvpcConfiguration (2 subnets) + Tags landed"

# --- Assertion 2: Schedule target's ECS network config landed ---------
SCHED_SUBNETS=$(aws scheduler get-schedule --name "${SCHED}" --region "${REGION}" \
  --query 'Target.EcsParameters.NetworkConfiguration.awsvpcConfiguration.Subnets | length(@)' --output text)
if [ "${SCHED_SUBNETS}" != "2" ]; then
  echo "FAIL: schedule awsvpcConfiguration.Subnets count is '${SCHED_SUBNETS}', expected 2 (NetworkConfiguration dropped — issue #1382)" >&2
  exit 1
fi
echo "    OK: schedule awsvpcConfiguration (2 subnets) landed"

# --- Assertion 3: no phantom drift on the ECS targets ------------------
# The read side maps the SDK spellings back to CFn shape (toCfnTargets /
# toCfnTarget); without the inverse every ECS target would drift on
# AwsVpcConfiguration / TagList / PlacementStrategies right after deploy.
# cdkd drift exits 0 on no drift, 1 on drift, 2 on error.
echo "==> Drift check (expects clean)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    OK: no drift reported"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "rule ${RULE} still exists after destroy" aws events describe-rule --name "${RULE}" --region "${REGION}"
echo "    OK: rule gone"
assert_gone "schedule ${SCHED} still exists after destroy" aws scheduler get-schedule --name "${SCHED}" --region "${REGION}"
echo "    OK: schedule gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> ecs-schedule-targets test passed (Events Rule + Scheduler ECS Fargate targets #1381/#1382 + clean destroy)"
