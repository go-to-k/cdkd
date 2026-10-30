#!/usr/bin/env bash
# verify.sh — cdkd AWS::EC2::NatGateway integ test.
#
# Covers the SDK provider's create/wait/delete path (the fixture's original
# purpose) PLUS issue #1411: `MaxDrainDurationSeconds` is declared
# `unhandledByDesign`, so the NAT gateway whose template sets it must
# auto-route via Cloud Control API (#614) instead of being silently dropped by
# the SDK provider.
#
# Why the value itself is not read back: the CloudFormation registry schema
# lists `/properties/MaxDrainDurationSeconds` under `writeOnlyProperties`, and
# no EC2 API returns it (`DescribeNatGateways`'s `NatGateway` shape has no such
# member — the only two SDK inputs carrying the field are
# `DisassociateNatGatewayAddress` / `UnassignPrivateNatGatewayAddress`). A
# "read it back and compare" assertion is therefore structurally impossible.
# What IS observable is the fix's actual effect, asserted below:
#   1. the drain gateway is recorded `provisionedBy == 'cc-api'` (pre-fix it was
#      'sdk' and the value went nowhere),
#   2. the L2 gateway that does NOT set it stays `provisionedBy == 'sdk'`
#      (heterogeneous routing in one stack — the fix is scoped to the property,
#      not to the type),
#   3. both gateways are live and `available` on AWS, and the drain gateway
#      carries the submitted `ConnectivityType` — i.e. the CC route really
#      provisioned it rather than erroring past the un-wired property.
#
# PLUS issue #4447 (Phases 1b / 1c): `cdkd drift` reads every Elastic IP back
# (both compare clean after the deploy), and a standalone EIP released out of
# band reports `deleted` with exit 1 rather than "drift unknown".
#
# PLUS go-to-k/cdkd#2762 (Assertion 4, Phases 1g / 1h / 1i): a REGIONAL NAT
# gateway (`AvailabilityMode: regional`, `VpcId`, `AvailabilityZoneAddresses`)
# is created by the SDK provider (pre-fix it auto-routed to Cloud Control),
# reads back drift-clean, gains a zone and a new `Name` tag IN PLACE, releases
# that zone again in a deploy started while it is still associating, and then
# swaps its only address in one deploy.
#
# PLUS issue #4606 (Phases 1d / 1f): a `--no-rollback` deploy whose NAT gateway
# (then Elastic IP) CREATE fails after AWS made it, then a fix-forward under the
# same logical id: that successful deploy deletes the earlier one and exits 0.
# The EIP arm (1f) deploys as a role denied `ec2:ReleaseAddress`: with release
# allowed, the provider releases the address itself (go-to-k/cdkd#4945), which
# Phase 1e asserts, and nothing is left to journal.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdVpcNatGateway"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
NAT_TYPE="AWS::EC2::NatGateway"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Phase 1f's role: it may allocate, tag and associate an address but never
# release one (go-to-k/cdkd#4606 through go-to-k/cdkd#4945's cleanup).
# IAM names are account-global: the region keeps a run in another region from
# sharing it (and from `cleanup` deleting that run's role). <= 64 chars.
DENY_ROLE="${STACK}-no-release-${REGION}"
DENY_POLICY_NAME="allocate-without-release"
DENY_ROLE_CREATED=""
delete_deny_role() { ( # usage: delete_deny_role  (best-effort)
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON_FILE:-}"
  rm -f "${ASSUME_ERR:-}"
  if [ -n "${DENY_ROLE_CREATED}" ]; then
    delete_deny_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then break; fi
      sleep 5
    done
    if ! ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then
      echo "    WARN: role ${DENY_ROLE} could not be confirmed deleted; delete it by hand" >&2
    else
      DENY_ROLE_CREATED=""
    fi
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Only drop the state file when the destroy actually succeeded. A classic NAT
  # stuck in `deleting` makes the VPC delete fail with DependencyViolation; if
  # the state were wiped anyway, the per-hour-billed NAT + VPC would be orphaned
  # with nothing left to retry from.
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  elif [ -n "${STATE_BUCKET:-}" ]; then
    echo "    NOTE: state destroy exited ${destroy_rc}; keeping cdkd state so the stack stays retryable" >&2
  fi
  rm -f "${FF_LOG:-}"
  rm -f "${NAT_LOG:-}"
  # go-to-k/cdkd#4606: `state destroy` deletes what the rollback journal holds
  # too; this backstop releases a Phase 1e / 1f address neither record reached
  # (an unassociated EIP bills by the hour). Only the allocation ids THIS run
  # captured: a tag filter would also release a concurrent run's address.
  # Only after a clean destroy: a kept state may still record the address.
  if [ "${destroy_rc}" -eq 0 ]; then
    for alloc in ${PENDING_EIP_ALLOCS:-} ${RELEASED_EIP_ALLOC:-} ${FF_EIP_ALLOC:-} ${ORPHAN_EIP_ALLOC:-} ${FF2_EIP_ALLOC:-}; do
      case "${alloc}" in eipalloc-*) ;; *) continue;; esac
      if aws ec2 release-address --allocation-id "${alloc}" --region "${REGION}" >/dev/null 2>&1; then
        echo "    released leftover ${alloc}"
      fi
    done
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

# The single source of truth for the value under test lives in the stack file;
# grep it rather than re-typing so the two cannot drift.
EXPECTED_DRAIN=$(grep -oE 'DRAIN_DURATION_SECONDS = [0-9]+' lib/vpc-nat-gateway-stack.ts | grep -oE '[0-9]+$' || true)
if [ -z "${EXPECTED_DRAIN}" ]; then
  echo "FAIL: could not read DRAIN_DURATION_SECONDS from lib/vpc-nat-gateway-stack.ts" >&2
  exit 1
fi
echo "==> MaxDrainDurationSeconds under test: ${EXPECTED_DRAIN}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup
# Never deleted by the pre-run cleanup: a concurrent run may be using it.
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run, or a concurrent run holds it); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
case "${ACCOUNT_ID}" in [0-9]*) ;; *) echo "FAIL: could not read the account id (got '${ACCOUNT_ID}')" >&2; exit 1;; esac
[ -n "${CALLER_USERID}" ] || { echo "FAIL: could not read the caller's user id" >&2; exit 1; }

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# The template really does carry the property — without this, every assertion
# below could pass vacuously against a fixture that silently lost it (e.g. an
# aws-cdk-lib version whose CfnNatGateway drops the prop).
DRAIN_IN_STATE=$(echo "${STATE}" | jq -r "
  [.resources | to_entries[]
   | select(.value.resourceType == \"${NAT_TYPE}\")
   | .value.properties.MaxDrainDurationSeconds // empty] | first // \"\"")
if [ "${DRAIN_IN_STATE}" != "${EXPECTED_DRAIN}" ]; then
  echo "FAIL: no NAT gateway in state carries MaxDrainDurationSeconds=${EXPECTED_DRAIN} (got '${DRAIN_IN_STATE}') — the fixture is not exercising issue #1411" >&2
  echo "${STATE}" | jq '.resources | with_entries(select(.value.resourceType == "AWS::EC2::NatGateway"))'
  exit 1
fi
echo "    OK: template/state carry MaxDrainDurationSeconds=${EXPECTED_DRAIN}"

# --- Assertion 1: the drain NAT auto-routed via Cloud Control ---------------
# Selected by the property rather than by logical id: CDK appends a hash, and
# keying on the property is what makes this assertion about issue #1411.
DRAIN_ROUTE=$(echo "${STATE}" | jq -r "
  [.resources | to_entries[]
   | select(.value.resourceType == \"${NAT_TYPE}\")
   | select(.value.properties.MaxDrainDurationSeconds != null)
   | .value.provisionedBy // \"\"] | first // \"\"")
if [ "${DRAIN_ROUTE}" != "cc-api" ]; then
  echo "FAIL: the MaxDrainDurationSeconds NAT gateway has provisionedBy='${DRAIN_ROUTE}', expected 'cc-api' (issue #1411 auto-route did NOT fire — the property would be silently dropped)" >&2
  exit 1
fi
echo "    OK: MaxDrainDurationSeconds NAT gateway provisionedBy == 'cc-api' (silent drop CLOSED by #614 routing)"

# --- Assertion 2: the plain NAT stayed on the SDK provider -----------------
PLAIN_ROUTE=$(echo "${STATE}" | jq -r "
  [.resources | to_entries[]
   | select(.value.resourceType == \"${NAT_TYPE}\")
   | select(.value.properties.MaxDrainDurationSeconds == null)
   | select(.value.properties.AvailabilityMode == null)
   | .value.provisionedBy // \"\"] | first // \"\"")
if [ "${PLAIN_ROUTE}" != "sdk" ]; then
  echo "FAIL: the plain NAT gateway has provisionedBy='${PLAIN_ROUTE}', expected 'sdk' (the fix must be scoped to the property, not to the whole type)" >&2
  exit 1
fi
echo "    OK: plain NAT gateway provisionedBy == 'sdk' (heterogeneous routing in one stack)"

# --- Assertion 3: both gateways are live on AWS ----------------------------
DRAIN_NAT_ID=$(echo "${STATE}" | jq -r "
  [.resources | to_entries[]
   | select(.value.resourceType == \"${NAT_TYPE}\")
   | select(.value.properties.MaxDrainDurationSeconds != null)
   | .value.physicalId // \"\"] | first // \"\"")
PLAIN_NAT_ID=$(echo "${STATE}" | jq -r "
  [.resources | to_entries[]
   | select(.value.resourceType == \"${NAT_TYPE}\")
   | select(.value.properties.MaxDrainDurationSeconds == null)
   | select(.value.properties.AvailabilityMode == null)
   | .value.physicalId // \"\"] | first // \"\"")
case "${DRAIN_NAT_ID}" in nat-*) ;; *) echo "FAIL: drain NAT physicalId is not a NAT gateway id: '${DRAIN_NAT_ID}'" >&2; exit 1;; esac
case "${PLAIN_NAT_ID}" in nat-*) ;; *) echo "FAIL: plain NAT physicalId is not a NAT gateway id: '${PLAIN_NAT_ID}'" >&2; exit 1;; esac

# Read both back in one call and sort BOTH sides: AWS does not preserve the
# order of `NatGateways[]` across reads, so a positional compare would be flaky.
OBSERVED_IDS=$(aws ec2 describe-nat-gateways \
  --nat-gateway-ids "${DRAIN_NAT_ID}" "${PLAIN_NAT_ID}" \
  --region "${REGION}" \
  --query "join(' ', sort(NatGateways[].NatGatewayId || \`[]\`))" --output text)
EXPECTED_IDS=$(printf '%s\n%s\n' "${DRAIN_NAT_ID}" "${PLAIN_NAT_ID}" | sort | tr '\n' ' ' | sed 's/ $//')
if [ "${OBSERVED_IDS}" != "${EXPECTED_IDS}" ]; then
  echo "FAIL: describe-nat-gateways returned '${OBSERVED_IDS}', expected '${EXPECTED_IDS}'" >&2
  exit 1
fi
echo "    OK: both NAT gateways exist on AWS"

# One call, two fields: `--output text` renders a multi-select list as a
# tab-separated row, so this stays a single API hit.
DRAIN_FACTS=$(aws ec2 describe-nat-gateways --nat-gateway-ids "${DRAIN_NAT_ID}" \
  --region "${REGION}" \
  --query 'NatGateways[0].[State,ConnectivityType]' --output text)
DRAIN_STATE=$(printf '%s' "${DRAIN_FACTS}" | cut -f1)
DRAIN_CONNECTIVITY=$(printf '%s' "${DRAIN_FACTS}" | cut -f2)
if [ "${DRAIN_STATE}" != "available" ]; then
  echo "FAIL: drain NAT gateway ${DRAIN_NAT_ID} is in state '${DRAIN_STATE}', expected 'available' (the CC route did not settle it)" >&2
  exit 1
fi
if [ "${DRAIN_CONNECTIVITY}" != "private" ]; then
  echo "FAIL: drain NAT gateway ${DRAIN_NAT_ID} has ConnectivityType '${DRAIN_CONNECTIVITY}', expected 'private' (the CC route did not forward the full property map)" >&2
  exit 1
fi
echo "    OK: drain NAT gateway is available with ConnectivityType=private (CC route forwarded the property map)"

# --- Assertion 4: the regional NAT gateway is on the SDK route (go-to-k/cdkd#2762) ---
# Pre-fix, AvailabilityMode / AvailabilityZoneAddresses were silent drops, so
# this gateway auto-routed through Cloud Control (provisionedBy 'cc-api').
REGIONAL_ID=$(echo "${STATE}" | jq -r "[.resources | to_entries[] | select(.value.resourceType == \"${NAT_TYPE}\") | select(.key | startswith(\"RegionalNatGateway\")) | .key] | first // \"\"")
[ -n "${REGIONAL_ID}" ] || { echo "FAIL: no RegionalNatGateway in state" >&2; exit 1; }
REGIONAL_ROUTE=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].provisionedBy // ""')
if [ "${REGIONAL_ROUTE}" != "sdk" ]; then
  echo "FAIL: the regional NAT gateway has provisionedBy='${REGIONAL_ROUTE}', expected 'sdk' (go-to-k/cdkd#2762: AvailabilityMode / AvailabilityZoneAddresses must be wired, not auto-routed)" >&2
  exit 1
fi
REGIONAL_NAT_ID=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].physicalId // ""')
case "${REGIONAL_NAT_ID}" in nat-*) ;; *) echo "FAIL: regional NAT physicalId is not a NAT gateway id: '${REGIONAL_NAT_ID}'" >&2; exit 1;; esac
REGIONAL_VPC=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].properties.VpcId // ""')
case "${REGIONAL_VPC}" in vpc-*) ;; *) echo "FAIL: the regional NAT's recorded VpcId is '${REGIONAL_VPC}'" >&2; exit 1;; esac
REGIONAL_ZONE_1=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].properties.AvailabilityZoneAddresses[0].AvailabilityZone // ""')
REGIONAL_ALLOC_1=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].properties.AvailabilityZoneAddresses[0].AllocationIds[0] // ""')
case "${REGIONAL_ALLOC_1}" in eipalloc-*) ;; *) echo "FAIL: the regional NAT's recorded first allocation id is '${REGIONAL_ALLOC_1}'" >&2; exit 1;; esac
[ -n "${REGIONAL_ZONE_1}" ] || { echo "FAIL: the regional NAT records no first AvailabilityZone" >&2; exit 1; }
# One call, tab-separated: State, AvailabilityMode, VpcId, AutoProvisionZones, SubnetId.
REGIONAL_FACTS=$(aws ec2 describe-nat-gateways --nat-gateway-ids "${REGIONAL_NAT_ID}" --region "${REGION}" \
  --query 'NatGateways[0].[State,AvailabilityMode,VpcId,AutoProvisionZones,SubnetId]' --output text)
EXPECTED_FACTS=$(printf 'available\tregional\t%s\tdisabled\tNone' "${REGIONAL_VPC}")
if [ "${REGIONAL_FACTS}" != "${EXPECTED_FACTS}" ]; then
  echo "FAIL: regional NAT ${REGIONAL_NAT_ID} reads '${REGIONAL_FACTS}', expected '${EXPECTED_FACTS}' (state/mode/VPC/manual zones/no subnet)" >&2
  exit 1
fi
REGIONAL_LIVE_ZONE_1=$(aws ec2 describe-nat-gateways --nat-gateway-ids "${REGIONAL_NAT_ID}" --region "${REGION}" \
  --query "NatGateways[0].NatGatewayAddresses[?AllocationId=='${REGIONAL_ALLOC_1}'].AvailabilityZone | [0]" --output text)
if [ "${REGIONAL_LIVE_ZONE_1}" != "${REGIONAL_ZONE_1}" ]; then
  echo "FAIL: regional NAT ${REGIONAL_NAT_ID} holds ${REGIONAL_ALLOC_1} in '${REGIONAL_LIVE_ZONE_1}', expected '${REGIONAL_ZONE_1}' (AvailabilityZoneAddresses not delivered)" >&2
  exit 1
fi
echo "    OK: regional NAT gateway ${REGIONAL_NAT_ID} is SDK-provisioned, regional, in ${REGIONAL_VPC}, holding ${REGIONAL_ALLOC_1} in ${REGIONAL_ZONE_1}"
# Fn::GetAtt RouteTableId resolves to the route table AWS made for the gateway.
REGIONAL_RTB_OUT=$(echo "${STATE}" | jq -r '.outputs.RegionalNatRouteTableId // ""')
REGIONAL_RTB_LIVE=$(aws ec2 describe-nat-gateways --nat-gateway-ids "${REGIONAL_NAT_ID}" --region "${REGION}" \
  --query 'NatGateways[0].RouteTableId' --output text)
case "${REGIONAL_RTB_LIVE}" in rtb-*) ;; *) echo "FAIL: regional NAT ${REGIONAL_NAT_ID} reports RouteTableId '${REGIONAL_RTB_LIVE}'" >&2; exit 1;; esac
if [ "${REGIONAL_RTB_OUT}" != "${REGIONAL_RTB_LIVE}" ]; then
  echo "FAIL: output RegionalNatRouteTableId is '${REGIONAL_RTB_OUT}', expected the live ${REGIONAL_RTB_LIVE} (Fn::GetAtt RouteTableId)" >&2
  exit 1
fi
echo "    OK: Fn::GetAtt RouteTableId resolved to ${REGIONAL_RTB_LIVE}"

# --- Phase 1b: drift reads every Elastic IP back (issue #4447) --------------
# Before #4447 `EC2Provider.readCurrentState` had no EIP arm, so both EIPs (the
# NAT's and the standalone `DriftProbeEip`) landed in `notSupported` ("drift
# unknown"), and one released out of band still read that way with exit 0.
EIP_TYPE="AWS::EC2::EIP"
EIP_IDS=$(echo "${STATE}" | jq -r "[.resources | to_entries[] | select(.value.resourceType == \"${EIP_TYPE}\") | .key] | sort | join(\" \")")
EIP_COUNT=$(echo "${STATE}" | jq "[.resources[] | select(.resourceType == \"${EIP_TYPE}\")] | length")
if [ "${EIP_COUNT}" -ne 4 ]; then
  echo "FAIL: expected 4 ${EIP_TYPE} resources in state (the NAT's, DriftProbeEip and the regional NAT's two), got ${EIP_COUNT}: '${EIP_IDS}'" >&2
  exit 1
fi
PROBE_ID=$(echo "${STATE}" | jq -r "[.resources | to_entries[] | select(.value.resourceType == \"${EIP_TYPE}\") | select(.key | startswith(\"DriftProbeEip\")) | .key] | first // \"\"")
PROBE_PHYSICAL=$(echo "${STATE}" | jq -r --arg id "${PROBE_ID}" '.resources[$id].physicalId // ""')
PROBE_ALLOC="${PROBE_PHYSICAL#*|}"
case "${PROBE_ALLOC}" in eipalloc-*) ;; *) echo "FAIL: DriftProbeEip physicalId '${PROBE_PHYSICAL}' carries no allocation id" >&2; exit 1;; esac

drift_json() { # usage: drift_json <outfile>; echoes the exit code
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"$1" || rc=$?
  echo "${rc}"
}
DRIFT_JSON_FILE=$(mktemp)
echo "==> Phase 1b: cdkd drift --json on the freshly deployed stack"
DRIFT_RC=$(drift_json "${DRIFT_JSON_FILE}")
if ! jq -e 'type == "array" and length == 1' "${DRIFT_JSON_FILE}" >/dev/null; then
  echo "FAIL: drift --json (rc=${DRIFT_RC}) did not print one stack report:" >&2
  cat "${DRIFT_JSON_FILE}" >&2
  exit 1
fi
for id in ${EIP_IDS}; do
  if ! jq -e --arg id "${id}" '[.[0].clean[]?.logicalId] | index($id) != null' "${DRIFT_JSON_FILE}" >/dev/null; then
    echo "FAIL: ${EIP_TYPE} ${id} is not reported clean after a fresh deploy (drift rc=${DRIFT_RC}); report:" >&2
    jq '.[0] | {drifted, deleted, notSupported, notCompared}' "${DRIFT_JSON_FILE}" >&2
    exit 1
  fi
done
echo "    OK: every Elastic IP was read back and compared clean"
# go-to-k/cdkd#2762: the regional gateway's readback (AvailabilityMode, VpcId,
# AvailabilityZoneAddresses) compares clean against what it was created with.
if ! jq -e --arg id "${REGIONAL_ID}" '[.[0].clean[]?.logicalId] | index($id) != null' "${DRIFT_JSON_FILE}" >/dev/null; then
  echo "FAIL: regional NAT ${REGIONAL_ID} is not reported clean after a fresh deploy (drift rc=${DRIFT_RC}); report:" >&2
  jq '.[0] | {drifted, deleted, notSupported, notCompared}' "${DRIFT_JSON_FILE}" >&2
  exit 1
fi
echo "    OK: the regional NAT gateway was read back and compared clean"

echo "==> Phase 1c: release ${PROBE_ID} (${PROBE_ALLOC}) out of band, then drift"
aws ec2 release-address --allocation-id "${PROBE_ALLOC}" --region "${REGION}"
DRIFT_RC=$(drift_json "${DRIFT_JSON_FILE}")
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: drift after releasing ${PROBE_ID} exited ${DRIFT_RC}, expected 1 (a deleted resource is drift)" >&2
  cat "${DRIFT_JSON_FILE}" >&2
  exit 1
fi
if ! jq -e --arg id "${PROBE_ID}" '[.[0].deleted[]?.logicalId] | index($id) != null' "${DRIFT_JSON_FILE}" >/dev/null; then
  echo "FAIL: ${PROBE_ID} released out of band is not in the report's 'deleted' list:" >&2
  jq '.[0] | {drifted, deleted, notSupported, notCompared}' "${DRIFT_JSON_FILE}" >&2
  exit 1
fi
rm -f "${DRIFT_JSON_FILE}"
echo "    OK: ${PROBE_ID} released out of band reports deleted, exit 1"

# A deleted NAT gateway lingers in `describe-nat-gateways` as State=deleted
# rather than 404-ing, so the gone-probe helper does not apply here: assert on
# the reported state instead, and treat a genuine not-found as gone too.
assert_nat_gone() { # usage: assert_nat_gone <nat-gateway-id> <label>
  local id="$1" label="$2" state
  if gone_probe aws ec2 describe-nat-gateways --nat-gateway-ids "${id}" --region "${REGION}"; then
    echo "    OK: ${label} NAT gateway ${id} is gone (not found)"
    return 0
  fi
  # Still queryable, so re-read the state. The re-read is guarded against the
  # TOCTOU race the gone-probe rule calls out: a canonical not-found HERE still
  # means gone; anything else is undetermined and hard-fails.
  if ! state="$(aws ec2 describe-nat-gateways --nat-gateway-ids "${id}" \
    --region "${REGION}" --query 'NatGateways[0].State' --output text 2>&1)"; then
    if printf '%s' "${state}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
      echo "    OK: ${label} NAT gateway ${id} is gone (not found on re-read)"
      return 0
    fi
    echo "FAIL: ${label} NAT gateway ${id} state re-read undetermined: ${state}" >&2
    exit 1
  fi
  if [ "${state}" != "deleted" ]; then
    echo "FAIL: ${label} NAT gateway ${id} is in state '${state}' after destroy, expected 'deleted'" >&2
    exit 1
  fi
  echo "    OK: ${label} NAT gateway ${id} is ${state}"
}

# --- Phases 1d / 1e: the fix-forward of a failed CREATE (go-to-k/cdkd#4606) ---
# A `--no-rollback` deploy whose CREATE fails after AWS made the resource
# journals it as a proven orphan. The fix-forward redeploy keeps the logical id
# with a valid shape, so the CREATE succeeds and a record under that id holds a
# NEW resource. `EC2Provider.isSameResource` proves the earlier one is another
# resource: the deploy deletes it, keeps the new one, exits 0 and drops the
# journal. Before #4606 it warned, named the earlier one, exited 2 and left it.

# The journal's failed operation for a logical id (compact JSON, empty if none).
journal_op() { # usage: journal_op <logical-id> <when>
  local body
  if ! body="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"; then
    echo "FAIL: no rollback journal $2" >&2
    exit 1
  fi
  printf '%s' "${body}" | jq -c --arg id "$1" \
    '[.segments[]?.failedOperations[]? | select(.logicalId == $id)] | last // empty'
}

# The journaled proven orphan's physical id for a logical id, or a FAIL.
journaled_orphan_id() { # usage: journaled_orphan_id <logical-id> <when>
  local op
  op="$(journal_op "$1" "$2")"
  if [ -z "${op}" ] || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ]; then
    echo "FAIL: the journal does not carry $1 as a proven orphan $2 (op: ${op:-<none>})" >&2
    exit 1
  fi
  printf '%s' "${op}" | jq -r '.physicalId // ""'
}

state_physical_id() { # usage: state_physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "$1" '.resources[$id].physicalId // "<absent>"'
}

# The fix-forward deploy's own verdict: exit 0, the earlier attempt deleted
# (not warned about), the journal gone.
assert_fix_forward_deleted() { # usage: assert_fix_forward_deleted <logical-id> <rc> <log>
  local id="$1" rc="$2" log="$3"
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: the ${id} fix-forward deploy exited ${rc} (expected 0: the earlier attempt is proven another resource and deleted -- output above)" >&2
    echo "      (before go-to-k/cdkd#4606 it exited 2 and left the earlier ${id})" >&2
    exit 1
  fi
  if ! grep -q "deleting partially-created ${id}" "${log}"; then
    echo "FAIL: the fix-forward deploy did not delete the earlier attempt's ${id} (output above)" >&2
    exit 1
  fi
  if grep -q "Skipping failed CREATE of ${id}" "${log}"; then
    echo "FAIL: the fix-forward deploy still warned about the earlier ${id} instead of deleting it (output above)" >&2
    exit 1
  fi
  assert_gone "rollback journal s3://${STATE_BUCKET}/${JOURNAL_KEY} still present after the ${id} fix-forward deploy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
}

FF_LOG=$(mktemp)

echo "==> Phase 1d: --no-rollback deploy whose OrphanNatGateway CREATE fails after CreateNatGateway"
set +e
INJECT_NAT_ORPHAN=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback >"${FF_LOG}" 2>&1
NAT_FAIL_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
if [ "${NAT_FAIL_RC}" -eq 0 ]; then
  echo "FAIL: the OrphanNatGateway injection deploy unexpectedly SUCCEEDED (the gateway should go failed: its EIP is already associated)" >&2
  exit 1
fi
if [ "$(state_physical_id OrphanNatGateway)" != "<absent>" ]; then
  echo "FAIL: state records OrphanNatGateway after a CREATE that threw (expected no record)" >&2
  exit 1
fi
ORPHAN_NAT_ID="$(journaled_orphan_id OrphanNatGateway 'after the --no-rollback deploy of Phase 1d')"
case "${ORPHAN_NAT_ID}" in nat-*) ;; *) echo "FAIL: journaled OrphanNatGateway id is not a NAT gateway id: '${ORPHAN_NAT_ID}'" >&2; exit 1;; esac
# The arm discriminates only while the earlier gateway is still listed short of
# `deleted`: unfixed, it stays `failed`; fixed, the settle deletes it.
ORPHAN_NAT_STATE="$(aws ec2 describe-nat-gateways --nat-gateway-ids "${ORPHAN_NAT_ID}" \
  --region "${REGION}" --query 'NatGateways[0].State' --output text)"
# Pinned to `failed`: the injection's mechanism (Resource.AlreadyAssociated);
# any other state means the wait failed for another reason and the arm would
# not exercise the failed-gateway delete.
if [ "${ORPHAN_NAT_STATE}" != "failed" ]; then
  echo "FAIL: the journaled ${ORPHAN_NAT_ID} is '${ORPHAN_NAT_STATE}' before the fix-forward, expected 'failed' (the EIP-already-associated injection did not fire as designed)" >&2
  exit 1
fi
echo "    OK: OrphanNatGateway ${ORPHAN_NAT_ID} (${ORPHAN_NAT_STATE}) is journaled as a proven orphan, no state record"

echo "==> Phase 1d: the fix-forward deploy (same logical id, a private gateway)"
set +e
INJECT_NAT_ORPHAN=true NAT_FIX_FORWARD=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FF_LOG}" 2>&1
NAT_FF_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
assert_fix_forward_deleted OrphanNatGateway "${NAT_FF_RC}" "${FF_LOG}"
assert_nat_gone "${ORPHAN_NAT_ID}" "the earlier attempt's (go-to-k/cdkd#4606)"
FF_NAT_ID="$(state_physical_id OrphanNatGateway)"
case "${FF_NAT_ID}" in nat-*) ;; *) echo "FAIL: state records OrphanNatGateway as '${FF_NAT_ID}' after the fix-forward (expected a NAT gateway id)" >&2; exit 1;; esac
if [ "${FF_NAT_ID}" = "${ORPHAN_NAT_ID}" ]; then
  echo "FAIL: state records OrphanNatGateway as the earlier attempt's ${ORPHAN_NAT_ID}" >&2
  exit 1
fi
# The new gateway is the record's: deleting the earlier one must not touch it.
FF_NAT_STATE="$(aws ec2 describe-nat-gateways --nat-gateway-ids "${FF_NAT_ID}" \
  --region "${REGION}" --query 'NatGateways[0].State' --output text)"
if [ "${FF_NAT_STATE}" != "available" ]; then
  echo "FAIL: the fix-forward gateway ${FF_NAT_ID} is ${FF_NAT_STATE} (expected available -- the settle must not delete the record's gateway)" >&2
  exit 1
fi
echo "    OK: the fix-forward deleted ${ORPHAN_NAT_ID}, kept ${FF_NAT_ID}, exited 0 and dropped the journal"

# The fix-forward gateway is a normal state resource: the next plain deploy
# removes it from the template and deletes it.
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_nat_gone "${FF_NAT_ID}" "the fix-forward"

# --- Phase 1e: a failed EIP CREATE releases its own address (go-to-k/cdkd#4945) ---
# `AllocateAddress` succeeds, then `AssociateAddress` rejects the malformed
# instance id. Since go-to-k/cdkd#4945 the provider releases the address before
# it throws, so the failed CREATE leaves nothing: no state record, no address,
# no journaled orphan -- and the fix-forward has nothing to delete.

# go-to-k/cdkd#4945: the journal holds no address for a logical id whose CREATE
# released its own. An absent journal passes; a present one must carry no
# physical id for it.
assert_no_journaled_orphan() { # usage: assert_no_journaled_orphan <logical-id> <when>
  local op
  if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
    echo "    OK: no rollback journal $2"
    return 0
  fi
  op="$(journal_op "$1" "$2")" || exit 1
  if [ -n "$(printf '%s' "${op}" | jq -r '.physicalId // empty')" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // false')" = "true" ]; then
    echo "FAIL: the journal carries $1 with a physical id $2, though the CREATE released its address (op: ${op})" >&2
    exit 1
  fi
  echo "    OK: the journal carries no $1 physical id $2 (op: ${op:-<none>})"
}

# Backstop only, never an assertion: every allocation id the provider names for
# OrphanEip (`Released` / `Failed to release partially-created EIP OrphanEip
# (<id>)`) in a failing deploy's output, so `cleanup` releases an address an
# assertion below exits before capturing.
note_pending_eip_allocs() {
  PENDING_EIP_ALLOCS="${PENDING_EIP_ALLOCS:-} $(grep -E 'partially-created EIP OrphanEip \(eipalloc-' "${FF_LOG}" \
    | grep -oE 'eipalloc-[0-9a-f]+' | sort -u | tr '\n' ' ' || true)"
}

echo "==> Phase 1e: --no-rollback deploy whose OrphanEip CREATE fails after AllocateAddress"
set +e
INJECT_EIP_ORPHAN=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback --verbose >"${FF_LOG}" 2>&1
EIP_FAIL_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
note_pending_eip_allocs
if [ "${EIP_FAIL_RC}" -eq 0 ]; then
  echo "FAIL: the OrphanEip injection deploy unexpectedly SUCCEEDED (AssociateAddress should reject the malformed instance id)" >&2
  exit 1
fi
if ! grep -q "i-cdkdmalformed" "${FF_LOG}"; then
  echo "FAIL: the OrphanEip injection deploy failed, but not on the malformed instance id (output above)" >&2
  exit 1
fi
if [ "$(state_physical_id OrphanEip)" != "<absent>" ]; then
  echo "FAIL: state records OrphanEip after a CREATE that threw (expected no record)" >&2
  exit 1
fi
# The address the failed CREATE released, from the provider's own --verbose
# line (`Released partially-created EIP <id> (<allocation>)`). Sentinel: an
# OrphanEip line naming an allocation id that the parse missed means the
# wording drifted, not that nothing was released.
RELEASED_EIP_ALLOC="$(grep -oE 'Released partially-created EIP OrphanEip \(eipalloc-[0-9a-f]+\)' "${FF_LOG}" \
  | grep -oE 'eipalloc-[0-9a-f]+' | head -1 || true)"
if [ -z "${RELEASED_EIP_ALLOC}" ]; then
  if grep -q "Failed to release partially-created EIP OrphanEip" "${FF_LOG}"; then
    echo "FAIL: the provider could not release the address its failed CREATE allocated (go-to-k/cdkd#4945; output above)" >&2
  elif grep -E 'OrphanEip' "${FF_LOG}" | grep -qE 'eipalloc-[0-9a-f]+'; then
    echo "FAIL: an OrphanEip line names an allocation id, but not as 'Released partially-created EIP OrphanEip (<id>)' -- the provider's wording drifted; update this parse (output above)" >&2
  else
    echo "FAIL: the failed OrphanEip CREATE printed no release of its address under --verbose (go-to-k/cdkd#4945; output above)" >&2
  fi
  exit 1
fi
# Read twice, 5s apart: a just-allocated address can read NotFound for a moment,
# so one NotFound alone is weak evidence of the release.
for _ in $(seq 1 12); do
  if gone_probe aws ec2 describe-addresses --allocation-ids "${RELEASED_EIP_ALLOC}" --region "${REGION}"; then break; fi
  sleep 5
done
sleep 5
assert_gone "the failed CREATE's ${RELEASED_EIP_ALLOC} still exists (go-to-k/cdkd#4945: the provider must release it)" \
  aws ec2 describe-addresses --allocation-ids "${RELEASED_EIP_ALLOC}" --region "${REGION}"
# No second address either: a retried CREATE would mint one per attempt, and
# each attempt's failure names its own address. Only this run's output is read,
# so a concurrent or crashed run's address cannot fail the check.
E1_NAMED="$(grep -E 'partially-created EIP OrphanEip \(eipalloc-' "${FF_LOG}" \
  | grep -oE 'eipalloc-[0-9a-f]+' | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
if [ "${E1_NAMED}" != "${RELEASED_EIP_ALLOC}" ]; then
  echo "FAIL: the failed OrphanEip CREATE named addresses '${E1_NAMED}', expected only the released ${RELEASED_EIP_ALLOC} (a retry minted another)" >&2
  exit 1
fi
assert_no_journaled_orphan OrphanEip 'after the --no-rollback deploy of Phase 1e'
echo "    OK: the failed OrphanEip CREATE released ${RELEASED_EIP_ALLOC}, left no state record and journaled no orphan"

echo "==> Phase 1e: the fix-forward deploy (same logical id, no instance)"
set +e
INJECT_EIP_ORPHAN=true EIP_FIX_FORWARD=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FF_LOG}" 2>&1
EIP_FF_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
if [ "${EIP_FF_RC}" -ne 0 ]; then
  echo "FAIL: the OrphanEip fix-forward deploy exited ${EIP_FF_RC} (expected 0: nothing was left to settle -- output above)" >&2
  exit 1
fi
# `deleting partially-created` is pinned positively by Phases 1d / 1f, so its
# absence here is not a drifted string. A warned-about earlier attempt exits 2,
# which the rc check above already refuses.
if grep -q "deleting partially-created OrphanEip" "${FF_LOG}"; then
  echo "FAIL: the fix-forward deploy deleted an earlier OrphanEip, but none was journaled (output above)" >&2
  exit 1
fi
assert_gone "rollback journal s3://${STATE_BUCKET}/${JOURNAL_KEY} still present after the OrphanEip fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
FF_EIP_PID="$(state_physical_id OrphanEip)"
FF_EIP_ALLOC="${FF_EIP_PID#*|}"
case "${FF_EIP_ALLOC}" in eipalloc-*) ;; *) echo "FAIL: state records OrphanEip as '${FF_EIP_PID}' after the fix-forward (expected an allocation id)" >&2; exit 1;; esac
if [ "${FF_EIP_ALLOC}" = "${RELEASED_EIP_ALLOC}" ]; then
  echo "FAIL: state records OrphanEip as the released ${RELEASED_EIP_ALLOC}" >&2
  exit 1
fi
if gone_probe aws ec2 describe-addresses --allocation-ids "${FF_EIP_ALLOC}" --region "${REGION}"; then
  echo "FAIL: the fix-forward address ${FF_EIP_ALLOC} is not in AWS" >&2
  exit 1
fi
echo "    OK: the fix-forward created a fresh ${FF_EIP_ALLOC}, exited 0 and left no journal"

node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "the fix-forward ${FF_EIP_ALLOC} still exists after the deploy that removed it" \
  aws ec2 describe-addresses --allocation-ids "${FF_EIP_ALLOC}" --region "${REGION}"

# --- Phase 1f: the fix-forward deletes a journaled EIP orphan (go-to-k/cdkd#4606) ---
# The same injection as Phase 1e, deployed as a role denied ec2:ReleaseAddress:
# the provider's release fails, so the CREATE throws with the address it made
# and the journal holds it as a proven orphan. The fix-forward (as the caller)
# must then delete it, as Phase 1d does for the NAT gateway.
echo "==> Phase 1f: a role that may allocate and associate an address but not release it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls. Every other resource is unchanged, so the
# deploy reads and writes only the state path in the bucket
# (`cdkd/<stack>/*`, plus the bucket-level reads of src/state and
# src/utils/aws-region-resolver.ts), the CDK bootstrap parameters, read-only
# CloudFormation and EC2 verbs, and the EIP CREATE's own calls: AllocateAddress
# and CreateTags on an address, and AssociateAddress of an address carrying
# OrphanEip's Name tag (the provider tags before it associates). EC2 authorizes
# the malformed instance id against `instance/*`, so the instance side is
# open; without it the association fails on IAM instead of on the id.
# ReleaseAddress and DisassociateAddress are explicitly denied, so the
# provider's cleanup cannot remove the address.
# sts:AssumeRole is denied everywhere: nothing this session runs assumes a role
# (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct,region]=process.argv.slice(1);const eip=`arn:aws:ec2:${region}:${acct}:elastic-ip/*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["ec2:AllocateAddress","ec2:CreateTags"],Resource:eip},{Effect:"Allow",Action:"ec2:AssociateAddress",Resource:eip,Condition:{StringEquals:{"aws:ResourceTag/Name":"cdkd-vpc-nat-gateway-orphan"}}},{Effect:"Allow",Action:"ec2:AssociateAddress",Resource:`arn:aws:ec2:${region}:${acct}:instance/*`},{Effect:"Allow",Action:"ec2:Describe*",Resource:"*"},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["ec2:ReleaseAddress","ec2:DisassociateAddress"],Resource:"*"},{Effect:"Deny",Action:"sts:AssumeRole",Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${REGION}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=vpc-nat-gateway >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
ASSUME_ERR="$(mktemp)"
DENY_CREDS=""
assume_err=""
for _ in $(seq 1 24); do
  # stderr (the error text only) goes to a file; stdout (the credentials)
  # stays in the variable.
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-vpc-nat-gateway-no-release \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>"${ASSUME_ERR}")"; then
    break
  fi
  DENY_CREDS=""
  assume_err="$(tail -3 "${ASSUME_ERR}" 2>/dev/null || true)"
  sleep 5
done
rm -f "${ASSUME_ERR}"
if [ -z "${DENY_CREDS}" ]; then
  echo "FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes (last answer: ${assume_err:-<none>})" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_deny_role() {
  (
    # CDKD_ROLE_ARN would make the deploy AssumeRole, which this role denies.
    unset AWS_PROFILE AWS_DEFAULT_PROFILE CDKD_ROLE_ARN
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
# The inline policy propagates on its own clock: wait until the role may read
# EC2 before the deploy relies on its allows.
policy_live=""
for _ in $(seq 1 24); do
  if as_deny_role aws ec2 describe-addresses --region "${REGION}" --query 'length(Addresses)' --output text >/dev/null 2>"${FF_LOG}"; then
    policy_live=1
    break
  fi
  sleep 5
done
if [ -z "${policy_live}" ]; then
  echo "FAIL: precondition -- ${DENY_ROLE}'s policy did not take effect within 2 minutes (last answer: $(tail -3 "${FF_LOG}"))" >&2
  exit 1
fi

echo "==> Phase 1f: --no-rollback deploy as ${DENY_ROLE} whose OrphanEip CREATE fails and cannot release"
set +e
as_deny_role env INJECT_EIP_ORPHAN=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback >"${FF_LOG}" 2>&1
EIP_FAIL_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
note_pending_eip_allocs
# The role is not needed past this deploy: drop it now, and stop `cleanup`
# owning the name as soon as it is confirmed gone -- after that, a role under
# this name is another run's.
delete_deny_role
unset DENY_AK DENY_SK DENY_ST
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${EIP_FAIL_RC}" -eq 0 ]; then
  echo "FAIL: the OrphanEip injection deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (AssociateAddress should reject the malformed instance id)" >&2
  exit 1
fi
# The injection fired as designed: the association failed on the malformed id
# (not on an IAM refusal of the role's own scope), and the release was refused.
# This deploy is not --verbose, so the thrown error names AWS's failure CLASS
# only (go-to-k/cdkd#2319), never the id AWS echoes in its own text.
if ! grep -q "InvalidInstanceID.Malformed" "${FF_LOG}"; then
  echo "FAIL: the OrphanEip deploy as ${DENY_ROLE} failed, but not on the malformed instance id -- the role's policy refused a call the arm needs (output above)" >&2
  exit 1
fi
if ! grep -q "Failed to release partially-created EIP OrphanEip" "${FF_LOG}"; then
  echo "FAIL: the deploy as ${DENY_ROLE} did not report a refused release of OrphanEip's address (the arm needs the release to fail -- output above)" >&2
  exit 1
fi
# go-to-k/cdkd#2319: the refused ReleaseAddress is the deny role's, and AWS
# words it with the role's assumed-role ARN (this account's id). The default-
# level warning names it by its class; AWS's text is debug-only. A FAIL prints
# only the cdkd-authored prefix and the line's length, never the line.
EIP_RELEASE_HEAD="Failed to release partially-created EIP OrphanEip"
EIP_RELEASE_LINE="$(sed $'s/\x1b\\[[0-9;]*m//g' "${FF_LOG}" | grep -F -- "${EIP_RELEASE_HEAD}" | head -1 || true)"
if [ -z "${EIP_RELEASE_LINE}" ]; then
  echo "FAIL: no '${EIP_RELEASE_HEAD}' line after the ANSI strip (the #2319 checks below would pass for free)" >&2
  exit 1
fi
if ! grep -qE -- "${EIP_RELEASE_HEAD} \(eipalloc-[0-9a-f]+\): [A-Za-z0-9.]+\. Re-run with --verbose for AWS's own message\." <<<"${EIP_RELEASE_LINE}"; then
  echo "FAIL: the '${EIP_RELEASE_HEAD}' warning is not '<head> (<allocation>): <ErrorClass>. Re-run with --verbose for AWS's own message.' (#2319); ${#EIP_RELEASE_LINE} chars" >&2
  exit 1
fi
if grep -qF -- "${ACCOUNT_ID}" <<<"${EIP_RELEASE_LINE}"; then
  echo "FAIL: the '${EIP_RELEASE_HEAD}' warning quotes AWS's text, with this account's id (#2319); ${#EIP_RELEASE_LINE} chars" >&2
  exit 1
fi
echo "    ok: the refused release is named by its class, with no account id"
if [ "$(state_physical_id OrphanEip)" != "<absent>" ]; then
  echo "FAIL: state records OrphanEip after a CREATE that threw (expected no record)" >&2
  exit 1
fi
ORPHAN_EIP_PID="$(journaled_orphan_id OrphanEip 'after the --no-rollback deploy of Phase 1f')"
ORPHAN_EIP_ALLOC="${ORPHAN_EIP_PID#*|}"
case "${ORPHAN_EIP_ALLOC}" in eipalloc-*) ;; *) echo "FAIL: journaled OrphanEip id '${ORPHAN_EIP_PID}' carries no allocation id" >&2; exit 1;; esac
if gone_probe aws ec2 describe-addresses --allocation-ids "${ORPHAN_EIP_ALLOC}" --region "${REGION}"; then
  echo "FAIL: the journaled ${ORPHAN_EIP_ALLOC} is not in AWS before the fix-forward (the arm could not tell a delete)" >&2
  exit 1
fi
echo "    OK: OrphanEip ${ORPHAN_EIP_ALLOC} is journaled as a proven orphan, no state record"

echo "==> Phase 1f: the fix-forward deploy as the caller (same logical id, no instance)"
set +e
INJECT_EIP_ORPHAN=true EIP_FIX_FORWARD=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${FF_LOG}" 2>&1
EIP_FF_RC=$?
set -e
sed 's/^/  /' "${FF_LOG}"
assert_fix_forward_deleted OrphanEip "${EIP_FF_RC}" "${FF_LOG}"
assert_gone "the earlier attempt's ${ORPHAN_EIP_ALLOC} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws ec2 describe-addresses --allocation-ids "${ORPHAN_EIP_ALLOC}" --region "${REGION}"
FF2_EIP_PID="$(state_physical_id OrphanEip)"
FF2_EIP_ALLOC="${FF2_EIP_PID#*|}"
case "${FF2_EIP_ALLOC}" in eipalloc-*) ;; *) echo "FAIL: state records OrphanEip as '${FF2_EIP_PID}' after the fix-forward (expected an allocation id)" >&2; exit 1;; esac
if [ "${FF2_EIP_ALLOC}" = "${ORPHAN_EIP_ALLOC}" ]; then
  echo "FAIL: state records OrphanEip as the earlier attempt's ${ORPHAN_EIP_ALLOC}" >&2
  exit 1
fi
if gone_probe aws ec2 describe-addresses --allocation-ids "${FF2_EIP_ALLOC}" --region "${REGION}"; then
  echo "FAIL: the fix-forward address ${FF2_EIP_ALLOC} is gone (the settle must not release the record's address)" >&2
  exit 1
fi
echo "    OK: the fix-forward released ${ORPHAN_EIP_ALLOC}, kept ${FF2_EIP_ALLOC}, exited 0 and dropped the journal"

node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "the fix-forward ${FF2_EIP_ALLOC} still exists after the deploy that removed it" \
  aws ec2 describe-addresses --allocation-ids "${FF2_EIP_ALLOC}" --region "${REGION}"
rm -f "${FF_LOG}"
echo "    OK: Phases 1d / 1e / 1f passed"

# --- Phases 1g / 1h: a regional NAT gateway updates in place (go-to-k/cdkd#2762) ---
regional_addr_status() { # usage: regional_addr_status <allocation-id>; prints the status or None
  aws ec2 describe-nat-gateways --nat-gateway-ids "${REGIONAL_NAT_ID}" --region "${REGION}" \
    --query "NatGateways[0].NatGatewayAddresses[?AllocationId=='$1'].Status | [0]" --output text || return 1
}
echo "==> Phase 1g: add a second zone and change the Name tag (REGIONAL_NAT_SECOND_ZONE=true)"
REGIONAL_NAT_SECOND_ZONE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
G_NAT_ID=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].physicalId // ""')
if [ "${G_NAT_ID}" != "${REGIONAL_NAT_ID}" ]; then
  echo "FAIL: the regional NAT is '${G_NAT_ID}' after Phase 1g, expected ${REGIONAL_NAT_ID} (the update must not replace it)" >&2
  exit 1
fi
REGIONAL_ZONE_2=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].properties.AvailabilityZoneAddresses[1].AvailabilityZone // ""')
REGIONAL_ALLOC_2=$(echo "${STATE}" | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].properties.AvailabilityZoneAddresses[1].AllocationIds[0] // ""')
case "${REGIONAL_ALLOC_2}" in eipalloc-*) ;; *) echo "FAIL: Phase 1g records no second allocation id (got '${REGIONAL_ALLOC_2}')" >&2; exit 1;; esac
G_LIVE=$(aws ec2 describe-nat-gateways --nat-gateway-ids "${REGIONAL_NAT_ID}" --region "${REGION}" \
  --query "NatGateways[0].[NatGatewayAddresses[?AllocationId=='${REGIONAL_ALLOC_2}'].AvailabilityZone | [0], Tags[?Key=='Name'].Value | [0]]" --output text)
if [ "${G_LIVE}" != "$(printf '%s\tcdkd-vpc-nat-gateway-regional-2' "${REGIONAL_ZONE_2}")" ]; then
  echo "FAIL: after Phase 1g regional NAT ${REGIONAL_NAT_ID} reads '${G_LIVE}', expected ${REGIONAL_ALLOC_2} in ${REGIONAL_ZONE_2} and Name=cdkd-vpc-nat-gateway-regional-2" >&2
  exit 1
fi
echo "    OK: ${REGIONAL_ALLOC_2} associated in ${REGIONAL_ZONE_2} and the Name tag updated, in place"

# --- Phase 1h: revert the added zone at ONCE, while it is still associating ---
# (go-to-k/cdkd#2762, PR #5337 review M1). An address being associated has no
# association id, so AWS refuses to release it; CloudFormation's own update
# waited for the association, so its rollback could release at once. cdkd's
# update returns earlier, so this revert (what an automatic rollback of the
# Phase 1g deploy would send) must wait for the association, then release.
# The arm is only meaningful while the address is still associating (about
# five minutes when measured): read it live first, or the arm is vacuous.
H_START=$(regional_addr_status "${REGIONAL_ALLOC_2}")
if [ "${H_START}" != "associating" ]; then
  echo "FAIL: ${REGIONAL_ALLOC_2} is '${H_START}' when the Phase 1h revert starts, expected associating (the arm would not exercise the wait-for-association release)" >&2
  exit 1
fi
# The provider's wait announces itself on a --verbose debug line; the needles
# below are copied from its source, and the sentinel fails the run when that
# source wording drifts, so a missing line cannot read as "no wait happened".
NAT_SRC="${PWD}/../../../src/provisioning/providers/ec2-provider.ts"
for needle in 'Waiting for NatGateway ${physicalId}: ${what}...' \
  'before releasing it`' 'the release of ${plan.awaitingRelease' \
  'an address the template keeps to associate before releasing the last associated one' \
  'plans to release ${d.allocationId} (live status ${status})' \
  'plans to associate ${id}, which AWS is still releasing'; do
  if ! grep -qF -- "${needle}" "${NAT_SRC}"; then
    echo "FAIL: ${NAT_SRC} no longer contains '${needle}': update the Phase 1h / 1i wait needles" >&2
    exit 1
  fi
done
NAT_LOG=$(mktemp)
echo "==> Phase 1h: drop the second zone again while ${REGIONAL_ALLOC_2} is still associating (default template)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"${NAT_LOG}" 2>&1 \
  || { sed 's/^/  /' "${NAT_LOG}" | tail -40; echo "FAIL: the Phase 1h revert deploy failed" >&2; exit 1; }
# Judge by what the deploy's own plan SAW, not by H_START: the association
# can finish while the deploy synthesizes. The plan line names the live status.
if grep -qF "plans to release ${REGIONAL_ALLOC_2} (live status associating)" "${NAT_LOG}"; then
  if ! grep -qF "the association of ${REGIONAL_ALLOC_2} before releasing it" "${NAT_LOG}"; then
    echo "FAIL: the Phase 1h deploy saw ${REGIONAL_ALLOC_2} still associating but did not wait for it before releasing it (no wait line in its --verbose log)" >&2
    exit 1
  fi
  echo "    OK: the revert saw ${REGIONAL_ALLOC_2} still associating, waited for it, then released it"
elif grep -qF "plans to release ${REGIONAL_ALLOC_2} (live status " "${NAT_LOG}"; then
  echo "    NOTE: NOT EXERCISED THIS RUN -- ${REGIONAL_ALLOC_2} finished associating before the revert deploy read it, so the wait-for-association release did not run (the unit suite pins it)"
else
  echo "FAIL: the Phase 1h deploy logged no plan to release ${REGIONAL_ALLOC_2} (no plan line in its --verbose log)" >&2
  exit 1
fi
H_STATUS=$(regional_addr_status "${REGIONAL_ALLOC_2}")
case "${H_STATUS}" in
  disassociating|None) echo "    OK: ${REGIONAL_ALLOC_2} is ${H_STATUS} after the zone was removed" ;;
  *) echo "FAIL: ${REGIONAL_ALLOC_2} is '${H_STATUS}' after the deploy that removed its zone, expected disassociating or released" >&2; exit 1 ;;
esac
H_KEPT=$(regional_addr_status "${REGIONAL_ALLOC_1}")
if [ "${H_KEPT}" != "succeeded" ]; then
  echo "FAIL: ${REGIONAL_ALLOC_1} is '${H_KEPT}' after Phase 1h, expected succeeded (only the removed zone may be released)" >&2
  exit 1
fi
H_NAT_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].physicalId // ""')
if [ "${H_NAT_ID}" != "${REGIONAL_NAT_ID}" ]; then
  echo "FAIL: the regional NAT is '${H_NAT_ID}' after Phase 1h, expected ${REGIONAL_NAT_ID} (the update must not replace it)" >&2
  exit 1
fi
echo "    OK: Phases 1g / 1h passed"

# --- Phase 1i: swap the gateway's ONLY address in one deploy (go-to-k/cdkd#2762) ---
# AWS refuses a release that leaves no ASSOCIATED address, and one still being
# associated does not count, so the provider must wait for the added address
# before releasing the old one. It starts right after Phase 1h released
# ${REGIONAL_ALLOC_2}: AWS refuses to associate an address still being
# released, so the provider must also wait for that release first (review n3).
# How long a release takes is not ours to choose, so a release already
# finished only NOTEs that the n3 wait was not exercised this run.
I_START=$(regional_addr_status "${REGIONAL_ALLOC_2}")
case "${I_START}" in
  disassociating) echo "    ${REGIONAL_ALLOC_2} is still being released: Phase 1i exercises the wait-for-release" ;;
  None) echo "    NOTE: ${REGIONAL_ALLOC_2} was already released; the wait-for-release is not exercised this run" ;;
  *) echo "FAIL: ${REGIONAL_ALLOC_2} is '${I_START}' when Phase 1i starts, expected disassociating or released" >&2; exit 1 ;;
esac
echo "==> Phase 1i: declare only ${REGIONAL_ZONE_2} (REGIONAL_NAT_SWAP=true)"
REGIONAL_NAT_SWAP=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose >"${NAT_LOG}" 2>&1 \
  || { sed 's/^/  /' "${NAT_LOG}" | tail -40; echo "FAIL: the Phase 1i swap deploy failed" >&2; exit 1; }
if ! grep -qF 'an address the template keeps to associate before releasing the last associated one' "${NAT_LOG}"; then
  echo "FAIL: the Phase 1i swap did not wait for ${REGIONAL_ALLOC_2} to associate before releasing the last address (no wait line in its --verbose log)" >&2
  exit 1
fi
# Judge the wait-for-release by what the deploy's plan SAW: the release can
# finish between I_START and the plan read.
if grep -qF "plans to associate ${REGIONAL_ALLOC_2}, which AWS is still releasing" "${NAT_LOG}"; then
  if ! grep -qF "the release of ${REGIONAL_ALLOC_2}" "${NAT_LOG}"; then
    echo "FAIL: the Phase 1i swap saw ${REGIONAL_ALLOC_2} still being released but did not wait for that release (no wait line in its --verbose log)" >&2
    exit 1
  fi
  echo "    OK: the swap saw ${REGIONAL_ALLOC_2} still being released and waited for it"
else
  echo "    NOTE: NOT EXERCISED THIS RUN -- ${REGIONAL_ALLOC_2} was already released when the swap deploy read it, so the wait-for-release did not run (the unit suite pins it)"
fi
I_NAT_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg id "${REGIONAL_ID}" '.resources[$id].physicalId // ""')
if [ "${I_NAT_ID}" != "${REGIONAL_NAT_ID}" ]; then
  echo "FAIL: the regional NAT is '${I_NAT_ID}' after Phase 1i, expected ${REGIONAL_NAT_ID} (the swap must not replace it)" >&2
  exit 1
fi
I_ADDED=$(regional_addr_status "${REGIONAL_ALLOC_2}")
I_OLD=$(regional_addr_status "${REGIONAL_ALLOC_1}")
if [ "${I_ADDED}" != "succeeded" ]; then
  echo "FAIL: after the swap ${REGIONAL_ALLOC_2} is '${I_ADDED}', expected succeeded (the release must wait for it)" >&2
  exit 1
fi
case "${I_OLD}" in
  disassociating|None) echo "    OK: Phase 1i swapped ${REGIONAL_ALLOC_1} (${I_OLD}) for ${REGIONAL_ALLOC_2} (succeeded) in place" ;;
  *) echo "FAIL: after the swap ${REGIONAL_ALLOC_1} is '${I_OLD}', expected disassociating or released" >&2; exit 1 ;;
esac

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy (SDK delete for one gateway, CC delete for the other)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_nat_gone "${DRAIN_NAT_ID}" "drain (cc-api)"
assert_nat_gone "${PLAIN_NAT_ID}" "plain (sdk)"
assert_nat_gone "${REGIONAL_NAT_ID}" "regional (sdk)"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> vpc-nat-gateway test passed (SDK route + #1411 Cloud Control route + #2762 regional gateway, clean destroy)"
