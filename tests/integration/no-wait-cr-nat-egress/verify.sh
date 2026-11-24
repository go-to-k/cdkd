#!/usr/bin/env bash
# verify.sh — cdkd --no-wait and a custom resource whose VPC handler calls out
# through a NAT gateway (go-to-k/cdkd#6940, rule 2).
#
# Phase 1 deploys with --no-wait. The NAT gateway's create returns while it is
# `pending`; the custom resource `Probe` is upstream-linked to it only through
# its handler function's DependsOn on the private subnet's default route. The
# handler fetches https://checkip.amazonaws.com on Create and answers FAILED
# when it cannot, so the deploy passes only if cdkd waited for the gateway to
# be `available` before the invoke. Asserted: the deploy succeeds, prints the
# readiness wait naming the gateway and the custom resource, the gateway is on
# the SDK provider and `available`, and the handler's IP is the gateway's
# public IP (its call really left through that gateway).
# Before #6940 the deploy failed: "egress through the NAT gateway failed".
#
# The handler's only path to the gateway is its function's DependsOn on the
# private subnet's default route. --aggressive-vpc-parallel (on by default)
# relaxes that edge for other functions, but keeps it for one upstream of a
# custom resource.
#
# Phase 2 destroys and asserts every resource and the state file are gone.
# Phase 3 deploys again in the DEFAULT mode: the deploy's own event log must
# show the handler function's create starting only after the default route
# finished (the kept edge), and the handler's IP must again be the gateway's.
# Then it destroys and asserts everything gone again.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Runtime: ~12 min (NAT gateway create + delete, VPC Lambda ENI release).

set -euo pipefail

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

STACK="CdkdNoWaitCrNatEgressExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FUNCTION_NAME="${STACK}-probe"
ROLE_NAME="${STACK}-probe"
VPC_NAME="${STACK}-vpc"
LOG_GROUP_PREFIX="/aws/lambda/${STACK}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG=""

state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

output_of() { # usage: output_of <output name>
  state_json | jq -r --arg k "$1" '.outputs[$k] // empty'
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Only drop the state when the destroy succeeded: a NAT gateway still
  # `deleting` makes the VPC delete fail, and the per-hour-billed gateway must
  # stay retryable from state.
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  elif [ -n "${STATE_BUCKET:-}" ]; then
    echo "    NOTE: state destroy exited ${destroy_rc}; keeping cdkd state so the stack stays retryable" >&2
  fi
  # A VPC left with no state is named by its tag; report it rather than tear a
  # NAT gateway, its address and the VPC apart by hand.
  leftover_vpc="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${VPC_NAME}" \
    --query 'Vpcs[0].VpcId' --output text)"
  if [[ "${leftover_vpc}" == vpc-* ]]; then
    echo "    WARN: VPC ${leftover_vpc} (${VPC_NAME}) is still present; delete its NAT gateway, Elastic IP and the VPC by hand" >&2
  fi
  # The function's log group: Lambda creates it on invoke, and nothing deletes
  # it. Scope guard first: an empty STACK would match every Lambda log group.
  case "${STACK}" in
    CdkdNoWaitCrNatEgress?*)
      for group in $(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "${LOG_GROUP_PREFIX}" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
        aws logs delete-log-group --region "${REGION}" --log-group-name "${group}" >/dev/null 2>&1
      done
      ;;
    *)
      echo "    WARN: teardown sweep refused: STACK '${STACK}' is outside this fixture's scope" >&2
      ;;
  esac
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with --no-wait ----------------------------------------
echo "==> Phase 1: deploy --no-wait"
DEPLOY_LOG="$(mktemp)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes --no-wait 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: the --no-wait deploy failed (before #6940: the handler's call left through a pending NAT gateway)" >&2
  exit 1
fi
DEPLOY_OUT="$(cat "${DEPLOY_LOG}")"

# The readiness wait the custom resource asked for, naming the gateway.
if ! grep -qE 'NATGateway[0-9A-F]+ \(AWS::EC2::NatGateway\), whose readiness wait --no-wait skipped: custom resource Probe is invoked after it' <<<"${DEPLOY_OUT}"; then
  echo "FAIL: the deploy printed no readiness wait for the NAT gateway before Probe" >&2
  exit 1
fi
echo "    OK: Probe waited for the NAT gateway --no-wait had not waited for"

STATE="$(state_json)"
NAT_ROUTE="$(jq -r '[.resources[] | select(.resourceType == "AWS::EC2::NatGateway") | .provisionedBy // "<absent>"] | first // "<no record>"' <<<"${STATE}")"
if [ "${NAT_ROUTE}" != "sdk" ]; then
  echo "FAIL: the NAT gateway was provisioned by '${NAT_ROUTE}', not the SDK provider (Cloud Control waits itself)" >&2
  exit 1
fi
echo "    OK: NAT gateway provisioned by the SDK provider"

VPC_ID="$(output_of VpcId)"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output '${VPC_ID}'" >&2; exit 1 ;; esac
NAT_JSON="$(aws ec2 describe-nat-gateways --region "${REGION}" --filter "Name=vpc-id,Values=${VPC_ID}" \
  --query 'NatGateways[?State!=`deleted`] | [0]' --output json)"
NAT_ID="$(jq -r '.NatGatewayId // empty' <<<"${NAT_JSON}")"
NAT_STATE="$(jq -r '.State // empty' <<<"${NAT_JSON}")"
NAT_IP="$(jq -r '.NatGatewayAddresses[0].PublicIp // empty' <<<"${NAT_JSON}")"
case "${NAT_ID}" in nat-?*) ;; *) echo "FAIL: no NAT gateway in ${VPC_ID}: ${NAT_JSON}" >&2; exit 1 ;; esac
[ "${NAT_STATE}" = "available" ] || { echo "FAIL: NAT gateway ${NAT_ID} is '${NAT_STATE}', not available" >&2; exit 1; }

PROBE_IP="$(output_of ProbeIp)"
if [ -z "${NAT_IP}" ] || [ "${PROBE_IP}" != "${NAT_IP}" ]; then
  echo "FAIL: the handler saw IP '${PROBE_IP}', the NAT gateway's public IP is '${NAT_IP}'" >&2
  exit 1
fi
echo "    OK: the handler's call left through NAT gateway ${NAT_ID} (${NAT_IP})"

# --- Phase 2: destroy -------------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --region "${REGION}" --function-name "${FUNCTION_NAME}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
# A deleted NAT gateway stays listed for a while as `deleted`.
NAT_AFTER="$(aws ec2 describe-nat-gateways --region "${REGION}" --nat-gateway-ids "${NAT_ID}" \
  --query 'NatGateways[0].State' --output text 2>&1 || true)"
case "${NAT_AFTER}" in
  deleted | *NotFound*) ;;
  *) echo "FAIL: NAT gateway ${NAT_ID} is '${NAT_AFTER}' after destroy" >&2; exit 1 ;;
esac
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: function, role, NAT gateway, VPC and state gone"

# --- Phase 3: default mode (the handler keeps CDK's route ordering) --------
echo "==> Phase 3: deploy (default mode)"
DEPLOY_LOG="$(mktemp)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: the default-mode deploy failed" >&2
  exit 1
fi
# The ordering, from the run's recorded events (every run records them).
RUNS="$(node "${LOCAL_DIST}" events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json)"
RUN_ID="$(jq -r '[.runs[] | select(.command == "deploy")] | sort_by(.startedAt) | last | .runId // empty' <<<"${RUNS}")"
[ -n "${RUN_ID}" ] || { echo "FAIL: no deploy run in cdkd events: ${RUNS}" >&2; exit 1; }
EVENTS="$(node "${LOCAL_DIST}" events "${STACK}" --run "${RUN_ID}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json)"
ROUTE_DONE="$(jq -r '[.[] | select(.eventType == "RESOURCE_SUCCEEDED" and (.logicalId | startswith("VpcPrivateSubnet1DefaultRoute")))] | first | .timestamp // empty' <<<"${EVENTS}")"
HANDLER_START="$(jq -r '[.[] | select(.eventType == "RESOURCE_STARTED" and (.logicalId | startswith("ProbeHandler")))] | first | .timestamp // empty' <<<"${EVENTS}")"
if [ -z "${ROUTE_DONE}" ] || [ -z "${HANDLER_START}" ]; then
  echo "FAIL: the run's events lack the route's RESOURCE_SUCCEEDED ('${ROUTE_DONE}') or the handler's RESOURCE_STARTED ('${HANDLER_START}')" >&2
  exit 1
fi
if [[ "${HANDLER_START}" < "${ROUTE_DONE}" ]]; then
  echo "FAIL: the handler function started at ${HANDLER_START}, before the default route finished at ${ROUTE_DONE}" >&2
  exit 1
fi
echo "    OK: the handler function started (${HANDLER_START}) after the default route finished (${ROUTE_DONE})"
VPC_ID="$(output_of VpcId)"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output '${VPC_ID}'" >&2; exit 1 ;; esac
NAT_JSON="$(aws ec2 describe-nat-gateways --region "${REGION}" --filter "Name=vpc-id,Values=${VPC_ID}" \
  --query 'NatGateways[?State!=`deleted`] | [0]' --output json)"
NAT_ID="$(jq -r '.NatGatewayId // empty' <<<"${NAT_JSON}")"
NAT_IP="$(jq -r '.NatGatewayAddresses[0].PublicIp // empty' <<<"${NAT_JSON}")"
PROBE_IP="$(output_of ProbeIp)"
if [ -z "${NAT_IP}" ] || [ "${PROBE_IP}" != "${NAT_IP}" ]; then
  echo "FAIL: (default mode) the handler saw IP '${PROBE_IP}', the NAT gateway's public IP is '${NAT_IP}'" >&2
  exit 1
fi
echo "    OK: (default mode) the handler's call left through NAT gateway ${NAT_ID} (${NAT_IP})"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "function ${FUNCTION_NAME} still exists after the Phase 3 destroy" aws lambda get-function --region "${REGION}" --function-name "${FUNCTION_NAME}"
assert_gone "VPC ${VPC_ID} still exists after the Phase 3 destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "state file ${STATE_KEY} still exists after the Phase 3 destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: Phase 3 function, VPC and state gone"

echo ""
echo "[verify] PASS — no-wait-cr-nat-egress: under --no-wait the custom resource waited for the NAT gateway its VPC handler calls out through"
