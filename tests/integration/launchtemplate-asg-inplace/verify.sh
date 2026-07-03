#!/usr/bin/env bash
# verify.sh -- LaunchTemplate + AutoScalingGroup in-place GetAtt propagation
# (issue #985).
#
# The ASG's LaunchTemplate.Version is Fn::GetAtt [Lt, LatestVersionNumber]. An
# in-place edit of the LaunchTemplate's instanceType (t3.micro -> t3.small under
# CDKD_TEST_UPDATE=true) bumps the LaunchTemplate's computed LatestVersionNumber
# 1 -> 2. Before the fix the ASG was classified NO_CHANGE (its raw template did
# not change and diff-time resolution saw the pre-update version "1"), so it
# stayed pinned at version "1" and only caught up on the NEXT deploy. This test
# asserts:
#   1. Phase 1: the LaunchTemplate is at version 1 and the ASG's live
#      LaunchTemplate.Version resolves to "1".
#   2. UPDATE phase (change only instanceType): the LaunchTemplate advances to
#      version 2 AND the ASG's live LaunchTemplate.Version is "2" in the SAME
#      deploy (NOT "1" -- the #985 symptom is a one-deploy-behind "1").
# Then destroys and confirms a clean teardown.
#
# desiredCapacity is 0 so no EC2 instances launch (cheap deploy, fast destroy).
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="LaunchTemplateAsgInplaceStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LT_NAME="cdkd-lt-asg-inplace"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Read the ASG's live LaunchTemplate.Version. CDK auto-names the ASG, so resolve
# it from state by type. The physical id IS the ASG name.
asg_version() {
  local asg_name="$1"
  aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "${asg_name}" --region "${REGION}" \
    --query 'AutoScalingGroups[0].LaunchTemplate.Version' --output text 2>/dev/null
}

lt_latest_version() {
  aws ec2 describe-launch-templates \
    --launch-template-names "${LT_NAME}" --region "${REGION}" \
    --query 'LaunchTemplates[0].LatestVersionNumber' --output text 2>/dev/null
}

# --- Phase 1: deploy (base) -------------------------------------------
echo "==> Phase 1: deploy with the local binary (LT v1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

ASG_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .value.physicalId] | first')
if [ -z "${ASG_NAME}" ] || [ "${ASG_NAME}" = "null" ]; then
  echo "FAIL: could not resolve AutoScalingGroup physical id from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved ASG name: ${ASG_NAME}"

LT_V1=$(lt_latest_version)
if [ "${LT_V1}" != "1" ]; then
  echo "FAIL: LaunchTemplate LatestVersionNumber is '${LT_V1}', expected '1' after Phase 1" >&2
  exit 1
fi
echo "    OK: LaunchTemplate LatestVersionNumber == 1"

ASG_V1=$(asg_version "${ASG_NAME}")
if [ "${ASG_V1}" != "1" ]; then
  echo "FAIL: ASG LaunchTemplate.Version is '${ASG_V1}', expected '1' after Phase 1" >&2
  exit 1
fi
echo "    OK: ASG LaunchTemplate.Version == 1"

# --- Phase 2: UPDATE (change only instanceType -> LT v2) --------------
echo "==> Phase 2: UPDATE (instanceType t3.micro -> t3.small; LT v1 -> v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

LT_V2=$(lt_latest_version)
if [ "${LT_V2}" != "2" ]; then
  echo "FAIL: LaunchTemplate LatestVersionNumber is '${LT_V2}', expected '2' after the instanceType edit" >&2
  exit 1
fi
echo "    OK: LaunchTemplate LatestVersionNumber == 2"

# THE #985 ASSERTION: the ASG must re-point at version 2 in the SAME deploy.
# Pre-fix this read back "1" (one deploy behind).
ASG_V2=$(asg_version "${ASG_NAME}")
if [ "${ASG_V2}" != "2" ]; then
  echo "FAIL: ASG LaunchTemplate.Version is '${ASG_V2}', expected '2' after the in-place LT update." >&2
  echo "      This is the issue #985 symptom -- the ASG is pinned one deploy behind:" >&2
  echo "      the in-place LaunchTemplate update bumped LatestVersionNumber to 2 but the" >&2
  echo "      Fn::GetAtt-consuming ASG was classified NO_CHANGE and never re-pointed." >&2
  exit 1
fi
echo "    OK: ASG LaunchTemplate.Version == 2 in the SAME deploy (issue #985 fixed)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

REMAINING=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "${ASG_NAME}" --region "${REGION}" \
  --query 'length(AutoScalingGroups || `[]`)' --output text 2>/dev/null)
if [ "${REMAINING}" != "0" ]; then
  echo "FAIL: AutoScalingGroup ${ASG_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: AutoScalingGroup is gone"

if aws ec2 describe-launch-templates --launch-template-names "${LT_NAME}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: LaunchTemplate ${LT_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: LaunchTemplate is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> launchtemplate-asg-inplace test passed (issue #985: in-place GetAtt value change propagated to the ASG in the same deploy + clean destroy)"
