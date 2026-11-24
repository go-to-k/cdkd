#!/usr/bin/env bash
# verify.sh — cdkd VPC endpoint integ (SDK provider, go-to-k/cdkd#6939).
#
# An Interface endpoint (STS) and a Gateway endpoint (S3) in an isolated VPC
# go through cdkd's SDK provider; an SSM parameter reads the Interface
# endpoint's NetworkInterfaceIds and DnsEntries through Fn::GetAtt. Each phase
# prints how long it took.
#
# Phases:
#   1. Deploy (default wait mode): both endpoints are recorded `provisionedBy:
#      sdk` and are `available`; the Interface endpoint has one subnet,
#      private DNS off and the tag `base`; the parameter equals the live
#      network interfaces and first DNS entry (`<hosted zone>:<name>`).
#   2. Drift: both endpoints report CLEAN.
#   3. UPDATE under --no-wait (CDKD_TEST_UPDATE=true): a second subnet,
#      private DNS on, a narrower policy and the tag `updated` on the
#      Interface endpoint, a policy on the Gateway endpoint; both ids are
#      unchanged. The parameter's GetAtt waited for the modified endpoint, so
#      it names both network interfaces.
#   4. Destroy: endpoints, VPC, parameter and state file are gone (the
#      destroy waits for each endpoint to be gone before the VPC's subnets
#      and security group, which its interfaces hold).
#   5. Re-deploy under --no-wait: returns while the Interface endpoint is
#      still `pending`, the parameter still equals the live values once it is
#      available. Then destroy again.
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

STACK="CdkdEc2VpcEndpointExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-vpce-drift.$$.json"
PARAM_NAME="/cdkd-integ/${STACK}/endpoint-network"

state_field() { # $1 = jq path under the state document
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1 // empty"
}
endpoint_ids() { # -> "<interface id> <gateway id>" from the state outputs
  local doc
  doc="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r '"\(.outputs.InterfaceEndpointId // "None") \(.outputs.GatewayEndpointId // "None")"' <<<"${doc}"
}
endpoint_field() { # $1 = id, $2 = JMESPath under the endpoint
  aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$1" --region "${REGION}" \
    --query "VpcEndpoints[0].$2" --output text || return 1
}
wait_available() { # $1 = id; bounded at ~5 min
  local state
  for _ in $(seq 1 100); do
    state="$(endpoint_field "$1" State)" || return 1
    [ "${state}" = "available" ] && return 0
    sleep 3
  done
  echo "FAIL: endpoint $1 is still '${state}' after ~5 min" >&2
  exit 1
}
# The parameter the stack derives from the Interface endpoint's GetAtts,
# against what the endpoint reports live.
check_network_param() { # $1 = interface id, $2 = expected interface count
  local enis first want got count
  enis="$(aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$1" --region "${REGION}" --output json \
    | jq -r '.VpcEndpoints[0].NetworkInterfaceIds | sort | join(",")')" || return 1
  first="$(aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$1" --region "${REGION}" --output json \
    | jq -r '.VpcEndpoints[0].DnsEntries[0] | "\(.HostedZoneId):\(.DnsName)"')" || return 1
  got="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query Parameter.Value --output text)" || return 1
  # The parameter keeps EC2's interface order: sort it like the live side.
  got="$(printf '%s' "${got%%|*}" | tr ',' '\n' | sort | paste -sd, -)|${got#*|}"
  want="${enis}|${first}"
  count="$(printf '%s' "${enis}" | tr ',' '\n' | grep -c . || true)"
  if [ "${got}" != "${want}" ] || [ "${count}" != "$2" ]; then
    echo "FAIL: parameter is '${got}', the endpoint reports '${want}' (expected $2 interfaces)" >&2
    exit 1
  fi
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
CLEANED_UP=0

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy (default wait mode)"
T0="$(date +%s)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
DEPLOY_SECS=$(( $(date +%s) - T0 ))

read -r IFACE_ID GW_ID <<<"$(endpoint_ids)"
case "${IFACE_ID}/${GW_ID}" in
  vpce-?*/vpce-?*) ;;
  *) echo "FAIL: endpoint ids from the outputs are '${IFACE_ID}' / '${GW_ID}'" >&2; exit 1 ;;
esac
for id in StsEndpoint S3Endpoint; do
  BY="$(state_field ".resources.${id}.provisionedBy")"
  if [ "${BY}" != "sdk" ]; then
    echo "FAIL: ${id} provisionedBy is '${BY:-<absent>}', expected 'sdk'" >&2
    exit 1
  fi
done
# The default deploy waited for `available`.
SHAPE="$(endpoint_field "${IFACE_ID}" 'join(`/`, [State, to_string(PrivateDnsEnabled), to_string(length(SubnetIds))])')"
if [ "${SHAPE}" != "available/false/1" ]; then
  echo "FAIL: Interface endpoint state/privateDns/subnets is '${SHAPE}', expected available/false/1" >&2
  exit 1
fi
if [ "$(endpoint_field "${GW_ID}" State)" != "available" ]; then
  echo "FAIL: Gateway endpoint is '$(endpoint_field "${GW_ID}" State)', expected available" >&2
  exit 1
fi
if [ "$(endpoint_field "${IFACE_ID}" "Tags[?Key=='cdkd-integ'].Value | [0]")" != "base" ]; then
  echo "FAIL: Interface endpoint tag is not 'base'" >&2
  exit 1
fi
check_network_param "${IFACE_ID}" 1
echo "    Interface ${IFACE_ID} + Gateway ${GW_ID} available (deploy took ${DEPLOY_SECS}s)"

# --- Phase 2: drift ----------------------------------------------------------
echo "==> Phase 2: cdkd drift reports both endpoints clean"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
  echo "FAIL: cdkd drift --json produced no stack report:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
vpce_count() { # $1 = bucket (clean|drifted|notSupported)
  jq --arg b "$1" '[.[][$b][] | select(.type == "AWS::EC2::VPCEndpoint")] | length' "${DRIFT_JSON}"
}
if [ "$(vpce_count drifted)" != "0" ] || [ "$(vpce_count notSupported)" != "0" ] || [ "$(vpce_count clean)" != "2" ]; then
  echo "FAIL: expected both endpoints CLEAN; drifted=$(vpce_count drifted) unknown=$(vpce_count notSupported) clean=$(vpce_count clean)" >&2
  jq '[.[] | {drifted, notSupported}]' "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    both endpoints CLEAN"

# --- Phase 3: in-place UPDATE under --no-wait --------------------------------
echo "==> Phase 3: second subnet, private DNS on, new policies + tag (--no-wait)"
T0="$(date +%s)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-wait
UPDATE_SECS=$(( $(date +%s) - T0 ))
if [ "$(endpoint_ids)" != "${IFACE_ID} ${GW_ID}" ]; then
  echo "FAIL: an endpoint was REPLACED (${IFACE_ID} ${GW_ID} -> $(endpoint_ids))" >&2
  exit 1
fi
wait_available "${IFACE_ID}"
SHAPE="$(endpoint_field "${IFACE_ID}" 'join(`/`, [to_string(PrivateDnsEnabled), to_string(length(SubnetIds))])')"
if [ "${SHAPE}" != "true/2" ]; then
  echo "FAIL: Interface endpoint privateDns/subnets is '${SHAPE}' after the update, expected true/2" >&2
  exit 1
fi
if ! endpoint_field "${IFACE_ID}" PolicyDocument | grep -q 'sts:GetCallerIdentity'; then
  echo "FAIL: Interface endpoint policy was not narrowed to sts:GetCallerIdentity" >&2
  exit 1
fi
if ! endpoint_field "${GW_ID}" PolicyDocument | grep -q 's3:GetObject'; then
  echo "FAIL: Gateway endpoint policy was not set to s3:GetObject" >&2
  exit 1
fi
if [ "$(endpoint_field "${IFACE_ID}" "Tags[?Key=='cdkd-integ'].Value | [0]")" != "updated" ]; then
  echo "FAIL: Interface endpoint tag is not 'updated'" >&2
  exit 1
fi
check_network_param "${IFACE_ID}" 2
echo "    updated in place (update took ${UPDATE_SECS}s)"

# --- Phase 4: destroy --------------------------------------------------------
echo "==> Phase 4: destroy"
VPC_ID="$(endpoint_field "${IFACE_ID}" VpcId)"
T0="$(date +%s)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DESTROY_SECS=$(( $(date +%s) - T0 ))
assert_gone "Interface endpoint ${IFACE_ID} still exists after destroy" \
  aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "${IFACE_ID}" --region "${REGION}"
assert_gone "Gateway endpoint ${GW_ID} still exists after destroy" \
  aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "${GW_ID}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    destroyed (destroy took ${DESTROY_SECS}s)"

# --- Phase 5: re-deploy under --no-wait --------------------------------------
echo "==> Phase 5: re-deploy under --no-wait"
T0="$(date +%s)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-wait
NOWAIT_SECS=$(( $(date +%s) - T0 ))
read -r IFACE_ID GW_ID <<<"$(endpoint_ids)"
case "${IFACE_ID}" in
  vpce-?*) ;;
  *) echo "FAIL: no Interface endpoint id after the --no-wait deploy ('${IFACE_ID}')" >&2; exit 1 ;;
esac
NOWAIT_STATE="$(endpoint_field "${IFACE_ID}" State)"
wait_available "${IFACE_ID}"
check_network_param "${IFACE_ID}" 1
echo "    --no-wait deploy returned with the Interface endpoint '${NOWAIT_STATE}' (took ${NOWAIT_SECS}s)"

T0="$(date +%s)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DESTROY2_SECS=$(( $(date +%s) - T0 ))
assert_gone "Interface endpoint ${IFACE_ID} still exists after the second destroy" \
  aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "${IFACE_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after the second destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_JSON}"
echo "[verify] PASS — VPC endpoints deployed (${DEPLOY_SECS}s), drift-clean, updated in place under --no-wait (${UPDATE_SECS}s), destroyed (${DESTROY_SECS}s), re-deployed under --no-wait (${NOWAIT_SECS}s, endpoint ${NOWAIT_STATE} at return), destroyed (${DESTROY2_SECS}s)"
