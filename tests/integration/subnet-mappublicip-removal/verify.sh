#!/usr/bin/env bash
# Subnet MapPublicIpOnLaunch removal keeps the live value, as CloudFormation
# does (go-to-k/cdkd#6342), with diff and drift consistent afterwards.
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
STACK="CdkdSubnetMapPublicIpRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SUBNET_ID=""
VPC_ID=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    :
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: run vp run build first" >&2; exit 1; }
if [ ! -d node_modules ]; then pnpm install --ignore-workspace --prefer-offline; fi
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" --only-show-errors
}
deploy_phase() { # CDKD_TEST_UPDATE, CDKD_TEST_REMOVAL
  CDKD_TEST_UPDATE="$1" CDKD_TEST_REMOVAL="$2" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
}
# The same SDK-created subnet holds the expected live value and Phase tag.
check_live() { # expected MapPublicIpOnLaunch, expected Phase tag
  local state current route live tag
  state=$(state_json) || return 1
  current=$(printf '%s' "${state}" | jq -r '.outputs.SubnetId') || return 1
  [ "${current}" = "${SUBNET_ID}" ] || { echo "FAIL: subnet was replaced (${current} != ${SUBNET_ID})" >&2; exit 1; }
  route=$(printf '%s' "${state}" | jq -r '.resources.Subnet.provisionedBy') || return 1
  [ "${route}" = sdk ] || { echo "FAIL: Subnet route is ${route}, expected sdk" >&2; exit 1; }
  for _ in 1 2 3 4 5 6; do
    live=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
      --query 'Subnets[0].MapPublicIpOnLaunch' --output text | tr '[:upper:]' '[:lower:]') || return 1
    tag=$(aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}" \
      --query 'Subnets[0].Tags[?Key==`Phase`].Value | [0]' --output text) || return 1
    if [ "${live}" = "$1" ] && [ "${tag}" = "$2" ]; then
      echo "    OK: same SDK subnet, MapPublicIpOnLaunch=${live}, Phase=${tag}"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: MapPublicIpOnLaunch=${live}, Phase=${tag}; expected $1, $2" >&2
  exit 1
}
check_diff_clean() { # CDKD_TEST_UPDATE, CDKD_TEST_REMOVAL, phase label
  CDKD_TEST_UPDATE="$1" CDKD_TEST_REMOVAL="$2" node "${LOCAL_DIST}" diff "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail || {
    echo "FAIL: cdkd diff reports changes (or failed) right after $3" >&2
    exit 1
  }
  echo "    OK: cdkd diff reports no changes after $3"
}
check_drift() {
  local report id
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || {
    echo "FAIL: cdkd drift failed after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  }
  for id in Vpc Subnet; do
    if ! jq -e --arg stack "${STACK}" --arg id "${id}" '
      [.[] | select(.stack == $stack)] as $reports |
      ($reports | length) == 1 and
      ([$reports[0].clean[] | select(.logicalId == $id)] | length) == 1 and
      ([$reports[0].drifted[] | select(.logicalId == $id)] | length) == 0 and
      ([$reports[0].notCompared[] | select(.logicalId == $id)] | length) == 0
    ' <<<"${report}" >/dev/null; then
      echo "FAIL: ${id} was not fully compared and drift-clean after $1" >&2
      printf '%s\n' "${report}" >&2
      exit 1
    fi
  done
  echo "    OK: Vpc and Subnet fully compared and drift-clean after $1"
}

cleanup
CLEANED_UP=0

echo "==> Create: MapPublicIpOnLaunch=true on the SDK route"
deploy_phase create false
STATE=$(state_json)
SUBNET_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.SubnetId')
VPC_ID=$(printf '%s' "${STATE}" | jq -r '.outputs.VpcId')
case "${SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: no subnet ID" >&2; exit 1 ;; esac
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: no VPC ID" >&2; exit 1 ;; esac
check_live true create
check_drift "the create"

echo "==> Remove MapPublicIpOnLaunch (and change the Phase tag): the live true stays (#6342)"
# CloudFormation keeps the live value on this removal (measured A/B,
# us-east-1); before the fix cdkd sent ModifySubnetAttribute false here.
deploy_phase create true
check_live true remove
RECORDED=$(state_json | jq -c '.resources.Subnet.properties.MapPublicIpOnLaunch') || exit 1
[ "${RECORDED}" = null ] || { echo "FAIL: the record still declares MapPublicIpOnLaunch=${RECORDED} after its removal" >&2; exit 1; }
check_diff_clean create true "the removal"
check_drift "the removal"

echo "==> Declare MapPublicIpOnLaunch=false over the record that holds no value"
deploy_phase readd-false false
check_live false readd-false
check_diff_clean readd-false false "declaring false"
check_drift "declaring false"

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "subnet still exists" aws ec2 describe-subnets --region "${REGION}" --subnet-ids "${SUBNET_ID}"
assert_gone "VPC still exists" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
trap - EXIT INT TERM
echo "[verify] PASS: Subnet MapPublicIpOnLaunch removal kept the live true, diff and drift clean, a later false applied, clean destroy (#6342)"
