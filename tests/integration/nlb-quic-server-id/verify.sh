#!/usr/bin/env bash
# verify.sh -- NLB QUIC target group Targets[].QuicServerId (issue #5394)
#
# `Targets[].QuicServerId` was dropped by cdkd's target conversion, so it never
# reached RegisterTargets / DeregisterTargets and a change to it alone was never
# sent. A QUIC target group REQUIRES a server id on every target, so the
# pre-fix binary already fails Phase 1 (RegisterTargets without a server id is
# refused). Phase 2 is the one that exercises the ORDER: AWS cannot modify a
# registered target's server id, so cdkd must DEREGISTER the old tuple and then
# REGISTER the new one. Measured with raw RegisterTargets on a QUIC target
# group: registering a different server id while one is registered is REFUSED
# ("deregister the target first"), not a no-op, so a register-first update
# FAILS the Phase 2 deploy (the target stays registered with A); it cannot
# produce a zero-registration outcome.
#
# Measured with a raw CloudFormation A/B in us-east-1: server id A -> B on the
# same Id is accepted and leaves ONE registration with B; dropping the server
# id is refused ("QUIC server IDs must be specified"), so Phase 3 swaps the
# target Id instead; a QUIC target group cannot set deregistration_delay, so a
# removed target sits in `draining` (filtered out below).
#
# Phases:
#   1. Deploy: 10.0.0.10 with server id A.
#   2. CDKD_TEST_UPDATE=true: the same target with server id B. Assert it is
#      registered exactly once, with B.
#   3. CDKD_TEST_REMOVAL=true: target 10.0.0.11 (server id A) replaces it.
#      Assert only the new target is registered (the old one is gone or draining).
#   4. Destroy, assert the load balancer, target group and state are gone.
#
# Run via: /run-integ nlb-quic-server-id
#         or: bash tests/integration/nlb-quic-server-id/verify.sh

set -euo pipefail

# A pager invoked non-interactively is its own route to a hang.
export AWS_PAGER=""

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="CdkdNlbQuicServerIdExample"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"
LB_NAME="cdkd-5394-quic-nlb"
TG_NAME="cdkd-5394-quic-tg"
QUIC_A="0x0123456789abcdef"
QUIC_B="0xfedcba9876543210"

# The stack's VPC is tagged ${VPC_TAG_KEY}=${VPC_TAG_VALUE} (CDK propagates the
# tag to its subnets, route tables and internet gateway). Sweep ONLY VPCs
# carrying that exact tag, with their dependents. Best effort, `set +eu` caller.
VPC_TAG_KEY="cdkd-integ"
VPC_TAG_VALUE="5394"
sweep_vpcs_by_tag() {
  (
    set +eu
    case "${VPC_TAG_VALUE}" in 5394) ;; *) echo "WARN: teardown sweep refused (VPC_TAG_VALUE='${VPC_TAG_VALUE}')" >&2; return 0 ;; esac
    for vpc in $(aws ec2 describe-vpcs --region "${AWS_REGION}" \
      --filters "Name=tag:${VPC_TAG_KEY},Values=${VPC_TAG_VALUE}" \
      --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
      case "${vpc}" in vpc-?*) ;; *) continue ;; esac
      for igw in $(aws ec2 describe-internet-gateways --region "${AWS_REGION}" \
        --filters "Name=attachment.vpc-id,Values=${vpc}" --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null); do
        aws ec2 detach-internet-gateway --region "${AWS_REGION}" --internet-gateway-id "${igw}" --vpc-id "${vpc}" >/dev/null 2>&1
        aws ec2 delete-internet-gateway --region "${AWS_REGION}" --internet-gateway-id "${igw}" >/dev/null 2>&1
      done
      for sn in $(aws ec2 describe-subnets --region "${AWS_REGION}" \
        --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
        aws ec2 delete-subnet --region "${AWS_REGION}" --subnet-id "${sn}" >/dev/null 2>&1
      done
      for rt in $(aws ec2 describe-route-tables --region "${AWS_REGION}" \
        --filters "Name=vpc-id,Values=${vpc}" \
        --query 'RouteTables[?length(Associations[?Main==`true`])==`0`].RouteTableId' --output text 2>/dev/null); do
        aws ec2 delete-route-table --region "${AWS_REGION}" --route-table-id "${rt}" >/dev/null 2>&1
      done
      aws ec2 delete-vpc --region "${AWS_REGION}" --vpc-id "${vpc}" >/dev/null 2>&1
    done
    # Load balancer ENIs can outlive the wait above and block the VPC delete.
    for left in $(aws ec2 describe-vpcs --region "${AWS_REGION}" \
      --filters "Name=tag:${VPC_TAG_KEY},Values=${VPC_TAG_VALUE}" \
      --query 'Vpcs[].VpcId' --output text 2>/dev/null); do
      echo "WARN: VPC ${left} (tag ${VPC_TAG_KEY}=${VPC_TAG_VALUE}) still exists after the sweep; delete it by hand" >&2
    done
  )
}

# Name-scoped sweep of anything the stack leaves behind. Best effort: runs from
# the EXIT trap under `set +eu`, so a miss never aborts the teardown.
sweep_by_name() {
  (
    set +eu
    case "${LB_NAME}" in cdkd-5394-?*) ;; *) echo "WARN: teardown sweep refused (LB_NAME='${LB_NAME}')" >&2; return 0 ;; esac
    case "${TG_NAME}" in cdkd-5394-?*) ;; *) echo "WARN: teardown sweep refused (TG_NAME='${TG_NAME}')" >&2; return 0 ;; esac
    lb_arn=$(aws elbv2 describe-load-balancers --names "${LB_NAME}" --region "${AWS_REGION}" \
      --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null)
    if [ -n "${lb_arn}" ] && [ "${lb_arn}" != "None" ]; then
      for l in $(aws elbv2 describe-listeners --load-balancer-arn "${lb_arn}" --region "${AWS_REGION}" \
        --query 'Listeners[].ListenerArn' --output text 2>/dev/null); do
        aws elbv2 delete-listener --listener-arn "${l}" --region "${AWS_REGION}" >/dev/null 2>&1
      done
      aws elbv2 delete-load-balancer --load-balancer-arn "${lb_arn}" --region "${AWS_REGION}" >/dev/null 2>&1
      sleep 20
    fi
    tg_arn=$(aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${AWS_REGION}" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)
    if [ -n "${tg_arn}" ] && [ "${tg_arn}" != "None" ]; then
      aws elbv2 delete-target-group --target-group-arn "${tg_arn}" --region "${AWS_REGION}" >/dev/null 2>&1
    fi
  )
}

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  sweep_by_name || true
  sweep_vpcs_by_tag || true
  exit ${rc}
}
# Resolve a physical id out of cdkd state by resource type.
physical_id_by_type() { # usage: physical_id_by_type "<state json>" <ResourceType>
  echo "$1" | python3 -c '
import sys, json
t = sys.argv[1]
s = json.load(sys.stdin)
for k, v in s["resources"].items():
    if v["resourceType"] == t:
        print(v["physicalId"]); break
' "$2"
}

# The non-draining registrations of the target group, one "<Id> <QuicServerId>" per line.
registered_targets() { # usage: registered_targets <tg-arn>
  aws elbv2 describe-target-health --target-group-arn "$1" --region "${AWS_REGION}" \
    --query "TargetHealthDescriptions[?TargetHealth.State!='draining'].[Target.Id,Target.QuicServerId]" \
    --output text
}

assert_registered() { # usage: assert_registered "<expected lines>" <what>
  local got
  got="$(registered_targets "${TG_ARN}")"
  if [[ "${got}" != "$1" ]]; then
    echo "FAIL: $2" >&2
    echo "    expected registrations: $1" >&2
    echo "    actual registrations:   ${got:-<none>}" >&2
    exit 1
  fi
}

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight: clean slate"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: state ${STATE_KEY} already exists -- clean up first."
  exit 1
} || true

# Armed only AFTER the pre-flight: a "state already exists" FAIL above is another
# run's stack, which this script must not destroy on its way out.
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
sweep_by_name || true

echo ""
echo "==> Phase 1: deploy (10.0.0.10 with server id A)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
TG_ARN=$(physical_id_by_type "${STATE_BODY}" "AWS::ElasticLoadBalancingV2::TargetGroup")
LB_ARN=$(physical_id_by_type "${STATE_BODY}" "AWS::ElasticLoadBalancingV2::LoadBalancer")
if [[ -z "${TG_ARN}" || -z "${LB_ARN}" ]]; then
  echo "FAIL: could not resolve the target group / load balancer from cdkd state"
  exit 1
fi
assert_registered "10.0.0.10	${QUIC_A}" "Phase 1: the target is not registered with server id A"
echo "    10.0.0.10 registered with server id A (ok)"

echo ""
echo "==> Phase 2: change ONLY the server id (A -> B) on the same target"
env -u CDKD_TEST_REMOVAL CDKD_TEST_UPDATE=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
assert_registered "10.0.0.10	${QUIC_B}" \
  "Phase 2: the target is not registered exactly once with server id B (deregister-then-register did not land)"
echo "    10.0.0.10 registered once, with server id B (ok)"

echo ""
echo "==> Phase 2: cdkd drift must report the target group CLEAN"
# `cdkd drift` exits non-zero on drift, but a resource reported as "drift
# unknown" exits zero: parse the report and require the target group in the
# `clean` bucket by name.
DRIFT_JSON="$(mktemp -t nlb-quic-drift.XXXXXX)"
node ../../../dist/cli.js drift ${STACK} --state-bucket "${STATE_BUCKET}" --region "${AWS_REGION}" \
  --json >"${DRIFT_JSON}" 2>/dev/null || true
if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
  echo "FAIL: cdkd drift --json produced no stack report:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
for bucket in drifted notSupported; do
  n=$(jq --arg b "${bucket}" '[.[][$b][] | select(.type == "AWS::ElasticLoadBalancingV2::TargetGroup")] | length' "${DRIFT_JSON}")
  if [ "${n}" != "0" ]; then
    echo "FAIL: the QUIC target group is in the '${bucket}' drift bucket after the server id change:" >&2
    jq '[.[][$b][] | select(.type == "AWS::ElasticLoadBalancingV2::TargetGroup")]' --arg b "${bucket}" "${DRIFT_JSON}" >&2
    exit 1
  fi
done
if [ "$(jq '[.[].clean[] | select(.type == "AWS::ElasticLoadBalancingV2::TargetGroup")] | length' "${DRIFT_JSON}")" != "1" ]; then
  echo "FAIL: the target group is in no drift bucket -- the assertion checked nothing" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    target group reported clean (ok)"

echo ""
echo "==> Phase 3: replace the target (10.0.0.11 with server id A)"
env -u CDKD_TEST_UPDATE CDKD_TEST_REMOVAL=true ${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
assert_registered "10.0.0.11	${QUIC_A}" \
  "Phase 3: the old target is still registered, or the new one is missing"
echo "    only 10.0.0.11 is registered; 10.0.0.10 is gone or draining (ok)"

echo ""
echo "==> Destroy"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Verify clean"
assert_gone "load balancer ${LB_NAME} still exists after destroy" \
  aws elbv2 describe-load-balancers --names "${LB_NAME}" --region "${AWS_REGION}"
assert_gone "target group ${TG_NAME} still exists after destroy" \
  aws elbv2 describe-target-groups --names "${TG_NAME}" --region "${AWS_REGION}"
assert_gone "state ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    load balancer, target group and state removed (ok)"

echo ""
echo "[verify] PASS -- nlb-quic-server-id (#5394: QuicServerId reaches RegisterTargets; a server-id-only change deregisters then registers)"
