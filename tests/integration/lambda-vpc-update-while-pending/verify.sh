#!/usr/bin/env bash
# verify.sh — cdkd update of a VPC Lambda function that is still Pending (#6605).
#
# cdkd's create returns before the function is Active, and a VPC function stays
# Pending for minutes. An update in that window was refused by AWS
# ("...is currently in the following state: 'Pending'"), the retry table missed
# the quoted wording, and the deploy failed and rolled back. cdkd now waits for
# Active once on that refusal and resends the call.
#
# Phases:
#   1. Deploy the function in two isolated subnets; assert it is in the VPC.
#   2. Redeploy AT ONCE with CDKD_TEST_UPDATE=true (VPC removed). Assert exit 0,
#      that cdkd took the Pending wait (otherwise the update missed the window
#      and the run proves nothing), and that the live VpcConfig has no subnets.
#   3. Destroy; assert the function, VPC, security group and state are gone.
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

STACK="CdkdLambdaVpcUpdateWhilePendingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
PHASE2_LOG="$(mktemp -t cdkd-lambda-vpc-pending.XXXXXX)"

# The line cdkd's update writes when AWS refused it for the Pending state.
PENDING_WAIT_LINE="is still Pending; waiting for it to be Active"

fn_config() { # usage: fn_config <JMESPath query>
  aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
    --query "$1" --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${PHASE2_LOG}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: create the function in the VPC ---------------------------
echo "==> Phase 1: deploy the function in two isolated subnets"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
PHASE1_STATE="$(fn_config 'State')"

SUBNETS="$(fn_config 'length(VpcConfig.SubnetIds || `[]`)')"
if [ "${SUBNETS}" != "2" ]; then
  echo "FAIL: expected 2 subnets on ${FN} after Phase 1, got '${SUBNETS}'" >&2; exit 1
fi
VPC_ID="$(fn_config 'VpcConfig.VpcId')"
SG_ID="$(fn_config 'VpcConfig.SecurityGroupIds[0]')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: no VPC id on ${FN} (got '${VPC_ID}')" >&2; exit 1 ;; esac
case "${SG_ID}" in sg-?*) ;; *) echo "FAIL: no security group on ${FN} (got '${SG_ID}')" >&2; exit 1 ;; esac
echo "    function in ${VPC_ID} (2 subnets, ${SG_ID}), State=${PHASE1_STATE}"

# --- Phase 2: remove the VPC while the function is still Pending --------
echo "==> Phase 2: redeploy at once with the VPC removed"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1 | tee "${PHASE2_LOG}"; then
  echo "FAIL: Phase 2 deploy failed (the update of the Pending function, #6605)" >&2; exit 1
fi
if ! grep -qF "${PENDING_WAIT_LINE}" "${PHASE2_LOG}"; then
  echo "FAIL: Phase 2 did not take the Pending wait ('${PENDING_WAIT_LINE}' absent; Phase 1 ended with State=${PHASE1_STATE}) — the update missed the Pending window, so this run proves nothing for #6605" >&2
  exit 1
fi
echo "    cdkd waited for the Pending function to become Active"

SUBNETS="$(fn_config 'length(VpcConfig.SubnetIds || `[]`)')"
if [ "${SUBNETS}" != "0" ]; then
  echo "FAIL: ${FN} still has ${SUBNETS} subnet(s) after Phase 2 — the VPC removal did not reach AWS" >&2; exit 1
fi
echo "    VpcConfig.SubnetIds is empty"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
echo "    function deleted"
assert_gone "security group ${SG_ID} still exists after destroy" aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}"
echo "    security group deleted"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    VPC deleted"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — update of a Pending VPC Lambda function (#6605), all 3 phases passed"
