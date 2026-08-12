#!/usr/bin/env bash
#
# End-to-end real-AWS validation for issue #1682 — the reverse-replacement
# replay-CREATE must record the provider's `effectiveProperties`.
#
# WHY THIS FIXTURE EXISTS
#
# `rollback-failure-injection` rolls back CREATEs, which is a DIFFERENT
# classification branch: it deletes the created resources. The arm #1682
# changed is `reverse-replacement` — the op where a resource was REPLACED
# before the failure, so rollback re-creates the OLD one from
# `previousState.properties`. That bag is a cdkd STATE record rather than a
# template, so it can carry a malformed block written by an older binary, and
# the provider is expected to WARN and SUBSTITUTE rather than refuse (the
# #1544 `replayWarn` downgrade). Pre-#1682 the engine typed that call's result
# as `{ physicalId, attributes? }` and rebuilt the record from
# `prev.properties`, so the substitution was announced into a void and the
# phantom drift it exists to close survived the rollback.
#
# WHY `AWS::EC2::Route` AND NOT THE `AWS::S3::Bucket` #1682 NAMES
#
# Both providers substitute on a state replay. But a bucket's
# reverse-replacement re-create must re-acquire a just-deleted GLOBALLY unique
# name, whose release is not immediate — the fixture would be flaky for a
# reason unrelated to what it tests. A route's identity is
# `<RouteTableId>|<Destination>` scoped to this stack's own route table, so the
# re-create is deterministic. `EC2Provider.createRoute`'s multi-destination
# warn arm is reached with exactly the same `CreateContext.replayingState`
# gate (ec2-provider.ts: the callback is passed only when
# `context?.replayingState === true`), so it exercises the identical engine
# path.
#
# WHAT THIS ASSERTS
#   1. Deploy v1 succeeds; state records the route with ONE destination key.
#   2. State is doctored to carry a SECOND destination key
#      (`DestinationIpv6CidrBlock`) — the shape an older binary recorded before
#      the #1591 narrowing, and the malformed block the replay must substitute.
#   3. Deploy v2 flips the create-only `DestinationCidrBlock` (forcing a
#      REPLACEMENT) with the failure injected AFTER the route, so the route's
#      replacement COMPLETES and rollback classifies it reverse-replacement.
#      The deploy exits NON-ZERO.
#   4. THE POINT: the post-rollback state record holds the SUBSTITUTED bag —
#      `DestinationCidrBlock` restored to the v1 value and
#      `DestinationIpv6CidrBlock` GONE. Pre-fix it is still present, because
#      the record was rebuilt from `prev.properties` verbatim.
#   5. Two consecutive `cdkd drift` runs CONVERGE (no phantom drift), which is
#      the user-visible consequence the wiring exists to deliver.
#   6. Destroy is clean and leaves 0 orphans.
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture pattern
# (bash ...; rc=$?) so a piped/teed harness can't mask a failure; the script
# prints an explicit "[verify] PASS" only at the very end.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdRollbackReplayEffProps"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="rollback-replay-effective-props"

# The v1 destination (recorded in state, and what the rollback must restore)
# and the v2 destination (create-only change -> replacement).
DEST_V1="0.0.0.0/0"
DEST_V2="10.100.0.0/16"
# The malformed second destination key injected into state. It is never sent
# to AWS -- `narrowRouteDestinations` keeps the FIRST declared key
# (DestinationCidrBlock) and drops this one, which is precisely the
# substitution whose recording this fixture verifies.
BAD_IPV6_DEST="::/0"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-replay-effective-props"
CDKD="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="cdkd-state-${ACCOUNT_ID}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

WORK_DIR="$(mktemp -d)"

cd "${TEST_DIR}"

# --------------------------------------------------------------------------
# Cleanup: destroy the stack, then sweep by the fixture tag. This fixture
# INTENTIONALLY creates a failed deploy, so the trap must not leak.
# --------------------------------------------------------------------------
cleanup() {
  local rc=$?
  set +e
  echo ""
  echo "[verify] cleanup (rc=${rc})..."

  ROUTE_DEST="${DEST_V1}" ${CDKD} destroy "${STACK}" --force >/dev/null 2>&1

  # Tag sweep AFTER the state-based destroy: a failed phase can leave a
  # resource that state no longer knows about, which the destroy cannot reach.
  local rt_ids igw_ids vpc_ids
  rt_ids="$(aws ec2 describe-route-tables \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'RouteTables[].RouteTableId' --output text 2>/dev/null)"
  for rt in ${rt_ids}; do
    echo "[verify] cleanup: deleting leftover route table ${rt}"
    aws ec2 delete-route-table --route-table-id "${rt}" >/dev/null 2>&1
  done

  igw_ids="$(aws ec2 describe-internet-gateways \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null)"
  for igw in ${igw_ids}; do
    local attached_vpc
    attached_vpc="$(aws ec2 describe-internet-gateways --internet-gateway-ids "${igw}" \
      --query 'InternetGateways[0].Attachments[0].VpcId' --output text 2>/dev/null)"
    if [ -n "${attached_vpc}" ] && [ "${attached_vpc}" != "None" ]; then
      echo "[verify] cleanup: detaching ${igw} from ${attached_vpc}"
      aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${attached_vpc}" >/dev/null 2>&1
    fi
    echo "[verify] cleanup: deleting leftover internet gateway ${igw}"
    aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" >/dev/null 2>&1
  done

  vpc_ids="$(aws ec2 describe-vpcs \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null)"
  for vpc in ${vpc_ids}; do
    echo "[verify] cleanup: deleting leftover VPC ${vpc}"
    aws ec2 delete-vpc --vpc-id "${vpc}" >/dev/null 2>&1
  done

  # The failing queue never reaches ACTIVE, but sweep by name in case a retry
  # of the phase left one behind.
  local q_url
  q_url="$(aws sqs get-queue-url --queue-name "${STACK}-FailQueue" --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    echo "[verify] cleanup: deleting leftover queue ${q_url}"
    aws sqs delete-queue --queue-url "${q_url}" >/dev/null 2>&1
  fi

  # State + the events sidecar this fixture's failed run writes.
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1

  rm -rf "${WORK_DIR}"
  set -e
  echo "[verify] cleanup done"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] region=${REGION} stack=${STACK} account=${ACCOUNT_ID}"
echo "[verify] installing fixture deps..."
npm install --silent >/dev/null 2>&1 || npm install >/dev/null

# --------------------------------------------------------------------------
# Phase 1 — deploy v1 (no failure injected).
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 1: deploy v1 (destination ${DEST_V1})"
ROUTE_DEST="${DEST_V1}" ${CDKD} deploy "${STACK}" --yes

aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state-v1.json" >/dev/null

ROUTE_LOGICAL_ID="$(jq -r '.resources | to_entries[]
  | select(.value.resourceType == "AWS::EC2::Route") | .key' "${WORK_DIR}/state-v1.json" | head -1)"
if [ -z "${ROUTE_LOGICAL_ID}" ]; then
  echo "FAIL: phase 1: no AWS::EC2::Route in state" >&2
  exit 1
fi
echo "[verify] phase 1: route logical id = ${ROUTE_LOGICAL_ID}"

V1_DEST="$(jq -r --arg id "${ROUTE_LOGICAL_ID}" \
  '.resources[$id].properties.DestinationCidrBlock' "${WORK_DIR}/state-v1.json")"
if [ "${V1_DEST}" != "${DEST_V1}" ]; then
  echo "FAIL: phase 1: state DestinationCidrBlock is '${V1_DEST}', expected '${DEST_V1}'" >&2
  exit 1
fi
echo "[verify] phase 1: OK (state records ${V1_DEST})"

# --------------------------------------------------------------------------
# Phase 2 — doctor state so the recorded bag carries a SECOND destination key.
#
# This is the fixture's stand-in for "a state record written by an older
# binary": before #1591 the engine recorded every declared destination key
# even though the provider only ever sent one. It is injected directly rather
# than produced by an old binary because the point under test is the ENGINE's
# handling of the provider's answer on the replay, not how the bag got there.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 2: injecting a second destination key into the state record"
jq --arg id "${ROUTE_LOGICAL_ID}" --arg ipv6 "${BAD_IPV6_DEST}" \
  '.resources[$id].properties.DestinationIpv6CidrBlock = $ipv6' \
  "${WORK_DIR}/state-v1.json" > "${WORK_DIR}/state-doctored.json"

# Fail loudly if the injection did not take -- a silently unchanged state file
# would make every later assertion vacuous (the key would be absent in phase 4
# for the wrong reason, and the test would PASS against the pre-fix binary).
INJECTED="$(jq -r --arg id "${ROUTE_LOGICAL_ID}" \
  '.resources[$id].properties.DestinationIpv6CidrBlock // "MISSING"' "${WORK_DIR}/state-doctored.json")"
if [ "${INJECTED}" != "${BAD_IPV6_DEST}" ]; then
  echo "FAIL: phase 2: injection did not take (got '${INJECTED}')" >&2
  exit 1
fi

aws s3 cp "${WORK_DIR}/state-doctored.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
echo "[verify] phase 2: OK (state now declares both DestinationCidrBlock and DestinationIpv6CidrBlock)"

# --------------------------------------------------------------------------
# Phase 3 — deploy v2: replacement + injected failure -> rollback.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 3: deploy v2 (destination ${DEST_V2}, failure injected) -- expected to FAIL"
set +e
ROUTE_DEST="${DEST_V2}" ROLLBACK_INTEG_FAIL=true ${CDKD} deploy "${STACK}" --yes > "${WORK_DIR}/deploy-v2.log" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: phase 3: deploy was expected to fail but exited 0" >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
echo "[verify] phase 3: deploy failed as expected (rc=${DEPLOY_RC})"

# The rollback must have taken the reverse-replacement arm, not a plain CREATE
# rollback -- otherwise phase 4 would be asserting the wrong branch entirely.
if ! grep -qiE 'more than one destination' "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the replay-CREATE multi-destination warning never fired --" >&2
  echo "      the rollback did not take the reverse-replacement arm, so this run" >&2
  echo "      does not exercise #1682. Deploy log tail:" >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
echo "[verify] phase 3: OK (replay-CREATE substitution warning observed)"

# --------------------------------------------------------------------------
# Phase 4 — THE POINT: the post-rollback record holds the SUBSTITUTED bag.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 4: asserting the post-rollback state record"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state-rolled-back.json" >/dev/null

POST_DEST="$(jq -r --arg id "${ROUTE_LOGICAL_ID}" \
  '.resources[$id].properties.DestinationCidrBlock // "MISSING"' "${WORK_DIR}/state-rolled-back.json")"
POST_IPV6="$(jq -r --arg id "${ROUTE_LOGICAL_ID}" \
  '.resources[$id].properties.DestinationIpv6CidrBlock // "ABSENT"' "${WORK_DIR}/state-rolled-back.json")"

if [ "${POST_DEST}" != "${DEST_V1}" ]; then
  echo "FAIL: phase 4: rollback did not restore the v1 destination" >&2
  echo "      DestinationCidrBlock='${POST_DEST}', expected '${DEST_V1}'" >&2
  exit 1
fi
if [ "${POST_IPV6}" != "ABSENT" ]; then
  echo "FAIL: phase 4: issue #1682 REGRESSION -- the replay-CREATE's" >&2
  echo "      effectiveProperties were discarded. The post-rollback record still" >&2
  echo "      carries DestinationIpv6CidrBlock='${POST_IPV6}', which the provider" >&2
  echo "      warned it was dropping and never sent to AWS. That difference is" >&2
  echo "      permanent phantom drift." >&2
  exit 1
fi
echo "[verify] phase 4: OK (DestinationCidrBlock=${POST_DEST}, DestinationIpv6CidrBlock absent)"

# --------------------------------------------------------------------------
# Phase 5 — the user-visible consequence: drift converges.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 5: two consecutive drift runs must converge"
set +e
ROUTE_DEST="${DEST_V1}" ${CDKD} drift "${STACK}" > "${WORK_DIR}/drift-1.log" 2>&1
DRIFT1_RC=$?
ROUTE_DEST="${DEST_V1}" ${CDKD} drift "${STACK}" > "${WORK_DIR}/drift-2.log" 2>&1
DRIFT2_RC=$?
set -e
if [ "${DRIFT1_RC}" -ne 0 ] || [ "${DRIFT2_RC}" -ne 0 ]; then
  echo "FAIL: phase 5: drift reported a difference (rc=${DRIFT1_RC}/${DRIFT2_RC})." >&2
  echo "      A DestinationIpv6CidrBlock difference here is the #1682 phantom" >&2
  echo "      drift: readRouteCurrentState can only ever return the one" >&2
  echo "      destination AWS holds." >&2
  tail -30 "${WORK_DIR}/drift-1.log" >&2
  exit 1
fi
echo "[verify] phase 5: OK (both drift runs clean)"

# --------------------------------------------------------------------------
# Phase 6 — destroy clean, 0 orphans.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 6: destroy + orphan sweep"
ROUTE_DEST="${DEST_V1}" ${CDKD} destroy "${STACK}" --force

VPC_LEFT="$(aws ec2 describe-vpcs \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
  --query 'Vpcs[].VpcId' --output text)"
if [ -n "${VPC_LEFT}" ] && [ "${VPC_LEFT}" != "None" ]; then
  echo "FAIL: phase 6: VPC orphan(s) survived destroy: ${VPC_LEFT}" >&2
  exit 1
fi

IGW_LEFT="$(aws ec2 describe-internet-gateways \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
  --query 'InternetGateways[].InternetGatewayId' --output text)"
if [ -n "${IGW_LEFT}" ] && [ "${IGW_LEFT}" != "None" ]; then
  echo "FAIL: phase 6: internet gateway orphan(s) survived destroy: ${IGW_LEFT}" >&2
  exit 1
fi

RT_LEFT="$(aws ec2 describe-route-tables \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
  --query 'RouteTables[].RouteTableId' --output text)"
if [ -n "${RT_LEFT}" ] && [ "${RT_LEFT}" != "None" ]; then
  echo "FAIL: phase 6: route table orphan(s) survived destroy: ${RT_LEFT}" >&2
  exit 1
fi

assert_gone "phase 6: state.json survived destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "[verify] phase 6: OK (0 orphans, state gone)"

trap - EXIT INT TERM
cleanup
echo ""
echo "[verify] PASS"
