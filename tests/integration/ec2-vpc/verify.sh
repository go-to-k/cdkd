#!/usr/bin/env bash
# verify.sh - cdkd ec2-vpc integ + removal of the VPC DNS attributes (#1160).
#
# Deploys the ec2-vpc fixture, then redeploys with CDKD_TEST_REMOVAL=true,
# where both VPCs drop EnableDnsHostnames and EnableDnsSupport. CloudFormation
# resets each removed attribute to the VPC default (measured A/B, us-east-1:
# hostnames true -> false, support false -> true), while ModifyVpcAttribute
# changes only the attribute it is sent. Then destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="Ec2VpcStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
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

# Prints "<hostnames>/<support>" for a VPC, e.g. "True/False".
dns_attrs() { # usage: dns_attrs <vpc-id>
  local h s
  h=$(aws ec2 describe-vpc-attribute --vpc-id "$1" --attribute enableDnsHostnames \
    --region "${REGION}" --query EnableDnsHostnames.Value --output text) || return 1
  s=$(aws ec2 describe-vpc-attribute --vpc-id "$1" --attribute enableDnsSupport \
    --region "${REGION}" --query EnableDnsSupport.Value --output text) || return 1
  printf '%s/%s' "${h}" "${s}"
}

# Prints a resource's physical id from the cdkd state record.
physical_id() { # usage: physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "$1" '.resources[$l].physicalId // empty'
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

MAIN_VPC=$(physical_id Vpc8378EB38)
OFF_VPC=$(physical_id DnsOffVpc)
if [ -z "${MAIN_VPC}" ] || [ -z "${OFF_VPC}" ]; then
  echo "FAIL: VPC physical ids missing from state: Vpc8378EB38='${MAIN_VPC}' DnsOffVpc='${OFF_VPC}'" >&2
  exit 1
fi
# Issue #1160 baseline: each VPC holds a non-default attribute first, so the
# default afterwards is the removal's doing.
MAIN_DNS=$(dns_attrs "${MAIN_VPC}")
OFF_DNS=$(dns_attrs "${OFF_VPC}")
if [ "${MAIN_DNS}" != "True/True" ] || [ "${OFF_DNS}" != "False/False" ]; then
  echo "FAIL: DNS hostnames/support after create: ${MAIN_VPC}='${MAIN_DNS}' (expected True/True), ${OFF_VPC}='${OFF_DNS}' (expected False/False)" >&2
  exit 1
fi
echo "    OK: baseline DNS hostnames/support True/True and False/False"

# --- Phase 2: REMOVAL drops both DNS attributes (issue #1160) ---------
echo "==> Phase 2: removal (drop EnableDnsHostnames, EnableDnsSupport from both VPCs)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RM_MAIN_VPC=$(physical_id Vpc8378EB38)
RM_OFF_VPC=$(physical_id DnsOffVpc)
if [ "${RM_MAIN_VPC}" != "${MAIN_VPC}" ] || [ "${RM_OFF_VPC}" != "${OFF_VPC}" ]; then
  echo "FAIL: a VPC was replaced by the removal (must reset in place): '${MAIN_VPC}' -> '${RM_MAIN_VPC}', '${OFF_VPC}' -> '${RM_OFF_VPC}'" >&2
  exit 1
fi
RM_MAIN_DNS=$(dns_attrs "${MAIN_VPC}")
RM_OFF_DNS=$(dns_attrs "${OFF_VPC}")
if [ "${RM_MAIN_DNS}" != "False/True" ] || [ "${RM_OFF_DNS}" != "False/True" ]; then
  echo "FAIL: a VPC kept a removed DNS attribute (issue #1160): ${MAIN_VPC}='${RM_MAIN_DNS}', ${OFF_VPC}='${RM_OFF_DNS}'; expected False/True for both, as CloudFormation resets them" >&2
  exit 1
fi
echo "    OK: removed DNS hostnames reset to False, removed DNS support reset to True, in place (issue #1160)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "VPC '${MAIN_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${MAIN_VPC}" --region "${REGION}"
assert_gone "VPC '${OFF_VPC}' still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${OFF_VPC}" --region "${REGION}"
echo "    OK: both VPCs are gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> ec2-vpc test passed (removed VPC DNS attributes reset + clean destroy)"
