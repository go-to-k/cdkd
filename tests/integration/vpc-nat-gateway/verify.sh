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
NAT_TYPE="AWS::EC2::NatGateway"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
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

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy (SDK delete for one gateway, CC delete for the other)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

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

assert_nat_gone "${DRAIN_NAT_ID}" "drain (cc-api)"
assert_nat_gone "${PLAIN_NAT_ID}" "plain (sdk)"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> vpc-nat-gateway test passed (SDK route + #1411 Cloud Control route, clean destroy)"
