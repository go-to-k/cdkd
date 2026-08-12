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

# The AWS::DynamoDB::GlobalTable arms (issues #1724 / #1726). `TableName` is
# create-only, so flipping it classifies the table as a REPLACEMENT -- the same
# op class as the route, reaching the same reverse-replacement rollback.
#
# Per-RUN unique names: unlike the route (whose identity is scoped to this
# stack's own route table) a DynamoDB table name is account+region global, so a
# fixed name would collide with a leftover from an earlier failed run and fail
# phase 1 for a reason unrelated to what this tests. They must stay STABLE
# within a run -- the rollback re-acquires the v1 name from the state record.
GT_RUN_ID="$$-$(date +%s)"
GT_NAME_V1="cdkd-rbreplay-gt-${GT_RUN_ID}-v1"
GT_NAME_V2="cdkd-rbreplay-gt-${GT_RUN_ID}-v2"
# The #1724 subject is a SECOND table: the two arms need incompatible state
# (a real GSI carrying capacity vs. a GSI blob replaced by a string).
GTO_NAME_V1="cdkd-rbreplay-gto-${GT_RUN_ID}-v1"
GTO_NAME_V2="cdkd-rbreplay-gto-${GT_RUN_ID}-v2"
# Injected into the v1 state records in phase 2 (see there for why each one).
BAD_BILLING_MODE=""
BAD_GSI_BLOB="not-an-array"
UNSENT_WRITE_CAPACITY=7
# Deliberately NOT stripped -- the substituted PAY_PER_REQUEST mode DOES send
# these, so they fence a blanket "strip anything throughput-shaped".
SENT_MAX_WRITE_UNITS=11
SENT_MAX_READ_UNITS=13

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-replay-effective-props"
CDKD="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# Honor the harness's exported STATE_BUCKET; only fall back to the account
# default. Overwriting it unconditionally would make every read below target a
# different bucket than the CLI writes to the moment the harness points
# somewhere else.
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
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

  ROUTE_DEST="${DEST_V1}" GT_TABLE_NAME="${GT_NAME_V1:-}" GT_OMIT_TABLE_NAME="${GTO_NAME_V1:-}" \
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --force >/dev/null 2>&1

  # The GlobalTable is swept by NAME, not by the fixture tag: the CFn
  # `AWS::DynamoDB::GlobalTable` schema has no top-level `Tags` (they are
  # per-replica), so the stack-level tag never reaches it and a tag filter
  # would return empty -- vacuously "clean" over a real leak. Both names are
  # swept because a failure between the replacement and the rollback can leave
  # either one live.
  local gt
  for gt in "${GT_NAME_V1:-}" "${GT_NAME_V2:-}" "${GTO_NAME_V1:-}" "${GTO_NAME_V2:-}"; do
    [ -n "${gt}" ] || continue
    if aws dynamodb describe-table --table-name "${gt}" >/dev/null 2>&1; then
      echo "[verify] cleanup: deleting leftover table ${gt}"
      aws dynamodb delete-table --table-name "${gt}" >/dev/null 2>&1
    fi
  done

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
ROUTE_DEST="${DEST_V1}" GT_TABLE_NAME="${GT_NAME_V1}" GT_OMIT_TABLE_NAME="${GTO_NAME_V1}" ${CDKD} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --yes

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
# Prove the fixture TAG actually matches a live resource, before phase 6 and
# the cleanup trap rely on it. Both filter on this tag, so if cdkd ever stopped
# propagating the stack-level tag to EC2 resources, phase 6 would report
# "0 orphans" against an empty result set while the trap silently leaked the
# very same resources -- a green run over a real leak.
TAGGED_VPC="$(aws ec2 describe-vpcs \
  --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
  --query 'Vpcs[].VpcId' --output text)"
if [ -z "${TAGGED_VPC}" ] || [ "${TAGGED_VPC}" = "None" ]; then
  echo "FAIL: phase 1: the fixture tag ${FIXTURE_TAG_KEY}=${FIXTURE_TAG_VALUE}" >&2
  echo "      matches no VPC, so phase 6's orphan assertions and the cleanup" >&2
  echo "      trap would both be vacuous. Did stack-level tag propagation break?" >&2
  exit 1
fi
STATE_VPC="$(jq -r '.resources | to_entries[]
  | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId' "${WORK_DIR}/state-v1.json")"
if [ "${TAGGED_VPC}" != "${STATE_VPC}" ]; then
  echo "FAIL: phase 1: the tag matched '${TAGGED_VPC}' but state records" >&2
  echo "      '${STATE_VPC}' -- the sweep would target the wrong resource." >&2
  exit 1
fi
# Select each table by its EXACT recorded physicalId, never by `head -1` over
# the type: both resources are AWS::DynamoDB::GlobalTable, so a positional pick
# resolves to whichever the state file happens to list first and silently swaps
# the two subjects (run 1 of this fixture passed on that ordering by luck; run 2
# did not). A prefix match is no good either -- "cdkd-rbreplay-gt-" is a prefix
# of "cdkd-rbreplay-gto-".
GT_LOGICAL_ID="$(jq -r --arg n "${GT_NAME_V1}" '.resources | to_entries[]
  | select(.value.resourceType == "AWS::DynamoDB::GlobalTable")
  | select(.value.physicalId == $n) | .key' "${WORK_DIR}/state-v1.json" | head -1)"
if [ -z "${GT_LOGICAL_ID}" ]; then
  echo "FAIL: phase 1: no AWS::DynamoDB::GlobalTable in state" >&2
  exit 1
fi
echo "[verify] phase 1: global table logical id = ${GT_LOGICAL_ID}"

# The table must be LIVE and PAY_PER_REQUEST before phase 2 doctors the record.
# Without this the phase 4 assertions are satisfiable by a table that never
# existed -- an absence assertion passes both when the strip worked and when
# nothing was ever created (the #1097 pattern-2 shape, one layer up).
GTO_LOGICAL_ID="$(jq -r --arg n "${GTO_NAME_V1}" '.resources | to_entries[]
  | select(.value.resourceType == "AWS::DynamoDB::GlobalTable")
  | select(.value.physicalId == $n) | .key' "${WORK_DIR}/state-v1.json" | head -1)"
if [ -z "${GTO_LOGICAL_ID}" ] || [ "${GTO_LOGICAL_ID}" = "${GT_LOGICAL_ID}" ]; then
  echo "FAIL: phase 1: could not tell the two GlobalTables apart in state" >&2
  echo "      capacity='${GT_LOGICAL_ID}' omit='${GTO_LOGICAL_ID}'" >&2
  exit 1
fi
echo "[verify] phase 1: gsi-omit table logical id = ${GTO_LOGICAL_ID}"

for t in "${GT_NAME_V1}" "${GTO_NAME_V1}"; do
  st="$(aws dynamodb describe-table --table-name "${t}" --query 'Table.TableStatus' --output text)"
  if [ "${st}" != "ACTIVE" ]; then
    echo "FAIL: phase 1: table ${t} is '${st}', expected ACTIVE" >&2
    exit 1
  fi
done

# The omit table must really HAVE its index before the replay drops it --
# otherwise phase 4's "0 indexes" assertion is unfalsifiable (it would hold for
# any implementation, including one that never omitted anything).
GTO_V1_INDEXES="$(aws dynamodb describe-table --table-name "${GTO_NAME_V1}" \
  --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text)"
if [ "${GTO_V1_INDEXES}" != "1" ]; then
  echo "FAIL: phase 1: ${GTO_NAME_V1} reports ${GTO_V1_INDEXES} index(es), expected 1." >&2
  echo "      Phase 4's post-omit '0 indexes' check would be vacuous." >&2
  exit 1
fi

echo "[verify] phase 1: OK (state records ${V1_DEST}; fixture tag resolves to ${TAGGED_VPC}; both tables ACTIVE, omit table has 1 index)"

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
#
# The GlobalTable record gets THREE injections, one per arm under test:
#   - `BillingMode: ""`  -> the #1544 replayWarn downgrade substitutes
#     PAY_PER_REQUEST, which is what the record must then show (#1683 arm 1).
#   - `WriteProvisionedThroughputSettings` -> a PROVISIONED-only block the
#     substituted mode makes the create SKIP entirely. Recording it is the
#     #1726 defect; the fix STRIPS it.
#   - `GlobalSecondaryIndexes: "not-an-array"` -> the translator warns and
#     returns the EMPTY list, so CreateTable carries no indexes. Recording the
#     malformed blob is the #1724 defect; the fix DROPS the key.
# All three are injected together on purpose: the create-path arms COMPOSE
# (`?? properties`), and a single-arm fixture cannot tell a composed answer
# from one that overwrote its predecessor.
jq --arg id "${ROUTE_LOGICAL_ID}" --arg ipv6 "${BAD_IPV6_DEST}" \
  --arg gt "${GT_LOGICAL_ID}" --arg gto "${GTO_LOGICAL_ID}" \
  --arg bm "${BAD_BILLING_MODE}" --arg gsi "${BAD_GSI_BLOB}" \
  --argjson wcu "${UNSENT_WRITE_CAPACITY}" \
  --argjson mw "${SENT_MAX_WRITE_UNITS}" --argjson mr "${SENT_MAX_READ_UNITS}" \
  '.resources[$id].properties.DestinationIpv6CidrBlock = $ipv6
   | .resources[$gt].properties.BillingMode = $bm
   | .resources[$gt].properties.WriteProvisionedThroughputSettings = {WriteCapacityUnits: $wcu}
   | .resources[$gt].properties.Replicas[0].ReadProvisionedThroughputSettings = {ReadCapacityUnits: $wcu}
   | .resources[$gt].properties.Replicas[0].ProvisionedThroughputOverride = {ReadCapacityUnits: $wcu}
   | .resources[$gt].properties.Replicas[0].GlobalSecondaryIndexes = [
       {IndexName: "gsi1",
        ReadProvisionedThroughputSettings: {ReadCapacityUnits: $wcu},
        ProvisionedThroughputOverride: {ReadCapacityUnits: $wcu}}
     ]
   | .resources[$gt].properties.WriteOnDemandThroughputSettings = {MaxWriteRequestUnits: $mw}
   | .resources[$gt].properties.Replicas[0].ReadOnDemandThroughputSettings = {MaxReadRequestUnits: $mr}
   | .resources[$gto].properties.GlobalSecondaryIndexes = $gsi' \
  "${WORK_DIR}/state-v1.json" > "${WORK_DIR}/state-doctored.json"

# Fail loudly if any injection did not take -- a silently unchanged record makes
# every phase-4 absence assertion pass for the WRONG reason (the key would be
# absent because it was never there), which is the vacuity this fixture exists
# to avoid.
INJ_MISSING=""
for expr in \
  '.resources[$gt].properties.WriteProvisionedThroughputSettings.WriteCapacityUnits' \
  '.resources[$gt].properties.Replicas[0].ReadProvisionedThroughputSettings.ReadCapacityUnits' \
  '.resources[$gt].properties.Replicas[0].ProvisionedThroughputOverride.ReadCapacityUnits' \
  '.resources[$gt].properties.Replicas[0].GlobalSecondaryIndexes[0].ReadProvisionedThroughputSettings.ReadCapacityUnits' \
  '.resources[$gt].properties.Replicas[0].GlobalSecondaryIndexes[0].ProvisionedThroughputOverride.ReadCapacityUnits' \
  '.resources[$gt].properties.WriteOnDemandThroughputSettings.MaxWriteRequestUnits' \
  '.resources[$gt].properties.Replicas[0].ReadOnDemandThroughputSettings.MaxReadRequestUnits' \
  '.resources[$gto].properties.GlobalSecondaryIndexes'
do
  got="$(jq -r --arg gt "${GT_LOGICAL_ID}" --arg gto "${GTO_LOGICAL_ID}" \
    "if (${expr}) == null then \"MISSING\" else \"present\" end" \
    "${WORK_DIR}/state-doctored.json")"
  if [ "${got}" = "MISSING" ]; then
    INJ_MISSING="${INJ_MISSING} ${expr}"
  fi
done
# The blank BillingMode is checked by PRESENCE, not truthiness: it is injected
# as the EMPTY string, which the loop above cannot tell from absent.
BM_PRESENT="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
  '.resources[$gt].properties | has("BillingMode")' "${WORK_DIR}/state-doctored.json")"
BM_VALUE="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
  '.resources[$gt].properties.BillingMode' "${WORK_DIR}/state-doctored.json")"
if [ "${BM_PRESENT}" != "true" ] || [ -n "${BM_VALUE}" ]; then
  INJ_MISSING="${INJ_MISSING} BillingMode(blank)"
fi
if [ -n "${INJ_MISSING}" ]; then
  echo "FAIL: phase 2: injection did not take for:${INJ_MISSING}" >&2
  exit 1
fi

aws s3 cp "${WORK_DIR}/state-doctored.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
echo "[verify] phase 2: OK (route declares both destinations; capacity table carries a blank"
echo "         BillingMode + 5 unsendable capacity members + 2 sendable on-demand ceilings;"
echo "         omit table carries a malformed GSI blob)"

# --------------------------------------------------------------------------
# Phase 3 — deploy v2: replacement + injected failure -> rollback.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 3: deploy v2 (destination ${DEST_V2}, failure injected) -- expected to FAIL"
set +e
# `--force-stateful-recreation` is REQUIRED, and finding that out is worth
# recording: `AWS::DynamoDB::GlobalTable` is in `STATEFUL_TYPES`, so cdkd
# REFUSES an immutable-property replacement without explicit consent to the
# data loss. Without the flag the first run of this fixture never replaced
# either table at all -- both `update()` calls failed with the refusal, the
# rollback had only the ROUTE to reverse, and phase 3 correctly reported that
# the GlobalTable replay substitution never fired. The route needs no such
# consent, so the flag changes nothing about the arm this fixture already had.
ROUTE_DEST="${DEST_V2}" GT_TABLE_NAME="${GT_NAME_V2}" GT_OMIT_TABLE_NAME="${GTO_NAME_V2}" ROLLBACK_INTEG_FAIL=true ${CDKD} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force-stateful-recreation --yes > "${WORK_DIR}/deploy-v2.log" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: phase 3: deploy was expected to fail but exited 0" >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
echo "[verify] phase 3: deploy failed as expected (rc=${DEPLOY_RC})"

# The rollback must have taken the REVERSE-REPLACEMENT arm specifically.
#
# The multi-destination warning alone does NOT prove that: `updateRoute` passes
# the same `onMultipleDestinations` callback, and the rollback's `revert` arm
# calls `provider.update(..., previousState.properties)` with the same
# both-keys bag -- so a future misclassification as `revert` would emit the
# byte-identical message AND still record the substituted bag, via the
# already-shipped update-side `recordAfterRollbackUpdate` (issue #1644). The
# fixture would then pass while never exercising #1682 at all. So assert the
# arm's OWN line, which only the reverse-replacement path emits.
if ! grep -qF 'replacement reversed (old resource re-created as' "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the rollback did not take the REVERSE-REPLACEMENT arm," >&2
  echo "      so this run does not exercise #1682 (a 'revert' UPDATE would pass" >&2
  echo "      phase 4 through the #1644 update-side wiring instead). Log tail:" >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
# ...and that the replay-CREATE actually substituted, which is the input phase 4
# asserts the recording of.
if ! grep -qiE 'more than one destination' "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the replay-CREATE multi-destination substitution never" >&2
  echo "      fired, so the doctored state bag never reached the provider." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
# The GlobalTable's two arms, each asserted by its OWN guard message. Without
# these, phase 4's absence assertions pass whenever the replay never reached the
# provider at all -- the same vacuity the route's substitution check above
# guards against, one resource over.
if ! grep -qF 'AWS::DynamoDB::GlobalTable BillingMode must be a non-empty string' "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the GlobalTable BillingMode replay substitution never fired," >&2
  echo "      so the doctored bag never reached the provider (#1726)." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
if ! grep -qF 'AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array' "${WORK_DIR}/deploy-v2.log"; then
  echo "FAIL: phase 3: the GlobalTable GSI replay downgrade never fired, so the" >&2
  echo "      create did not take the omit arm (#1724)." >&2
  tail -40 "${WORK_DIR}/deploy-v2.log" >&2
  exit 1
fi
echo "[verify] phase 3: OK (reverse-replacement arm + all three replay-CREATE downgrades observed)"

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

# --- the GlobalTable half (issues #1724 / #1726) ---------------------------
#
# `has(...)` rather than `// "ABSENT"` throughout: a present-but-null key is
# exactly what a half-fix produces, and the `//` form reports it as absent.

# #1726 -- every PROVISIONED-only member must be GONE.
STRIPPED_LEFT=""
for pair in \
  '.resources[$gt].properties|WriteProvisionedThroughputSettings' \
  '.resources[$gt].properties.Replicas[0]|ReadProvisionedThroughputSettings' \
  '.resources[$gt].properties.Replicas[0]|ProvisionedThroughputOverride' \
  '.resources[$gt].properties.Replicas[0].GlobalSecondaryIndexes[0]|ReadProvisionedThroughputSettings' \
  '.resources[$gt].properties.Replicas[0].GlobalSecondaryIndexes[0]|ProvisionedThroughputOverride'
do
  path="${pair%%|*}"; key="${pair##*|}"
  present="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
    "(${path} // {}) | has(\"${key}\")" "${WORK_DIR}/state-rolled-back.json")"
  if [ "${present}" = "true" ]; then
    STRIPPED_LEFT="${STRIPPED_LEFT} ${path}.${key}"
  fi
done
if [ -n "${STRIPPED_LEFT}" ]; then
  echo "FAIL: phase 4: issue #1726 -- the substituted PAY_PER_REQUEST mode makes the" >&2
  echo "      create SKIP every PROVISIONED-only capacity member, yet the record still" >&2
  echo "      carries:${STRIPPED_LEFT}" >&2
  echo "      readCurrentState cannot report any of them on an on-demand table, so each" >&2
  echo "      is permanent phantom drift." >&2
  exit 1
fi

# ...while the ON-DEMAND ceilings, which that same mode DOES send, must SURVIVE.
# This is the fence against a blanket "strip anything throughput-shaped": such an
# implementation passes every assertion above and fails here.
KEPT_MW="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
  '.resources[$gt].properties.WriteOnDemandThroughputSettings.MaxWriteRequestUnits // "GONE"' \
  "${WORK_DIR}/state-rolled-back.json")"
KEPT_MR="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
  '.resources[$gt].properties.Replicas[0].ReadOnDemandThroughputSettings.MaxReadRequestUnits // "GONE"' \
  "${WORK_DIR}/state-rolled-back.json")"
if [ "${KEPT_MW}" != "${SENT_MAX_WRITE_UNITS}" ] || [ "${KEPT_MR}" != "${SENT_MAX_READ_UNITS}" ]; then
  echo "FAIL: phase 4: the on-demand ceilings were stripped (write='${KEPT_MW}'," >&2
  echo "      read='${KEPT_MR}'). They ARE sent under the substituted mode, so the" >&2
  echo "      strip is over-broad and now records a loss that did not happen." >&2
  exit 1
fi

GT_POST_BM="$(jq -r --arg gt "${GT_LOGICAL_ID}" \
  '.resources[$gt].properties.BillingMode // "MISSING"' "${WORK_DIR}/state-rolled-back.json")"
if [ "${GT_POST_BM}" != "PAY_PER_REQUEST" ]; then
  echo "FAIL: phase 4: the replay-CREATE substituted PAY_PER_REQUEST but the record" >&2
  echo "      says BillingMode='${GT_POST_BM}' -- the #1683 arm regressed, or the" >&2
  echo "      #1726 strip took the arm's own answer with it." >&2
  exit 1
fi

# #1724 -- the malformed GSI blob must be GONE from the omit table's record...
GTO_HAS_GSI="$(jq -r --arg gto "${GTO_LOGICAL_ID}" \
  '.resources[$gto].properties | has("GlobalSecondaryIndexes")' "${WORK_DIR}/state-rolled-back.json")"
if [ "${GTO_HAS_GSI}" != "false" ]; then
  echo "FAIL: phase 4: issue #1724 -- the malformed GlobalSecondaryIndexes blob was" >&2
  echo "      OMITTED from CreateTable, yet the record still carries it. Nothing was" >&2
  echo "      applied, so the key must be DROPPED." >&2
  # A surviving key has TWO very different causes -- the drop regressed, or the
  # replay-CREATE never succeeded at all (so the pre-rollback record was kept).
  # Print enough to tell them apart without re-running against real AWS.
  echo "      --- recorded keys for ${GTO_LOGICAL_ID} ---" >&2
  jq -r --arg gto "${GTO_LOGICAL_ID}" \
    '.resources[$gto].properties | keys | join(", ")' "${WORK_DIR}/state-rolled-back.json" >&2
  echo "      --- rollback / replay lines from the failed deploy ---" >&2
  grep -aE "Rollback|reversed|must be an array|ValidationException|Failed to" \
    "${WORK_DIR}/deploy-v2.log" | tail -15 >&2
  exit 1
fi
# ...along with the LOCAL replica's index block, which is only a capacity SOURCE
# for the omitted translation and so reached AWS just as little.
GTO_REPLICA_HAS_GSI="$(jq -r --arg gto "${GTO_LOGICAL_ID}" \
  '(.resources[$gto].properties.Replicas[0] // {}) | has("GlobalSecondaryIndexes")' \
  "${WORK_DIR}/state-rolled-back.json")"
if [ "${GTO_REPLICA_HAS_GSI}" != "false" ]; then
  echo "FAIL: phase 4: the local replica's GlobalSecondaryIndexes block survived the" >&2
  echo "      omit. readCurrentState attaches it only when the live table HAS indexes," >&2
  echo "      so on a zero-index table it is the same never-matchable record." >&2
  exit 1
fi

# The wire half: the re-created omit table must really carry NO indexes. Phase 1
# proved it had exactly 1 before the replay, so this can genuinely fail.
GTO_LIVE_INDEXES="$(aws dynamodb describe-table --table-name "${GTO_NAME_V1}" \
  --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text)"
if [ "${GTO_LIVE_INDEXES}" != "0" ]; then
  echo "FAIL: phase 4: the re-created omit table reports ${GTO_LIVE_INDEXES} index(es);" >&2
  echo "      the omit arm was supposed to send none, so the dropped key would be" >&2
  echo "      hiding indexes AWS actually holds." >&2
  exit 1
fi

# Sanity, NOT a discriminator: the template's own mode is PAY_PER_REQUEST too, so
# this cannot tell the substitution from the template. It is here to catch a
# record that describes a mode the table is not in.
GT_LIVE_MODE="$(aws dynamodb describe-table --table-name "${GT_NAME_V1}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${GT_LIVE_MODE}" != "PAY_PER_REQUEST" ]; then
  echo "FAIL: phase 4: AWS reports the re-created table as '${GT_LIVE_MODE}', so the" >&2
  echo "      record's PAY_PER_REQUEST describes a mode the table is not in." >&2
  exit 1
fi
echo "[verify] phase 4: OK (5 unsendable capacity members stripped, 2 on-demand ceilings"
echo "         kept, GSI blob + local replica block dropped, omit table has 0 live indexes)"

# --------------------------------------------------------------------------
# Phase 5 — the user-visible consequence: drift converges.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 5: two consecutive drift runs must converge"
set +e
ROUTE_DEST="${DEST_V1}" GT_TABLE_NAME="${GT_NAME_V1}" GT_OMIT_TABLE_NAME="${GTO_NAME_V1}" ${CDKD} drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${WORK_DIR}/drift-1.log" 2>&1
DRIFT1_RC=$?
ROUTE_DEST="${DEST_V1}" GT_TABLE_NAME="${GT_NAME_V1}" GT_OMIT_TABLE_NAME="${GTO_NAME_V1}" ${CDKD} drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${WORK_DIR}/drift-2.log" 2>&1
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
# Exit 0 alone is NOT convergence. A resource whose readCurrentState returns
# undefined is reported as "drift unknown" and does NOT affect the exit code
# (src/cli/commands/drift.ts) -- which is exactly the failure mode measured for
# a composite-key mismatch in issue #1643. Without this the whole phase would
# pass while comparing nothing at all.
if grep -qF 'drift unknown' "${WORK_DIR}/drift-1.log"; then
  echo "FAIL: phase 5: drift reported 'drift unknown' -- the route's current" >&2
  echo "      state could not be read back, so the clean exit proves nothing" >&2
  echo "      about convergence." >&2
  tail -30 "${WORK_DIR}/drift-1.log" >&2
  exit 1
fi
# The drift-unknown check above is per-RUN, not per-RESOURCE: it greps the whole
# log, so it already fails if EITHER resource was unreadable. Assert the table
# by name too, because that is the resource whose record this change rewrote --
# a clean run that silently skipped it would prove nothing about #1724 / #1726.
# A CLEAN drift run prints only a SUMMARY -- it names no resource, so grepping
# for a logical id here reports "never compared" on a perfectly clean run (that
# is what the first version of this check did). Assert the COUNT instead: the
# stack has exactly 7 resources, so "7 resources checked, 0 unsupported" is what
# proves every rewritten record was actually compared rather than skipped.
if ! grep -qE '7 resources checked, 0 unsupported' "${WORK_DIR}/drift-1.log"; then
  echo "FAIL: phase 5: drift did not report all 7 resources checked with 0" >&2
  echo "      unsupported, so a rewritten record was skipped and the clean exit" >&2
  echo "      proves nothing about convergence." >&2
  tail -30 "${WORK_DIR}/drift-1.log" >&2
  exit 1
fi
echo "[verify] phase 5: OK (both drift runs clean; route AND global table both compared)"

# --------------------------------------------------------------------------
# Phase 6 — destroy clean, 0 orphans.
# --------------------------------------------------------------------------
echo ""
echo "[verify] phase 6: destroy + orphan sweep"
ROUTE_DEST="${DEST_V1}" GT_TABLE_NAME="${GT_NAME_V1}" GT_OMIT_TABLE_NAME="${GTO_NAME_V1}" \
  ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

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

# BOTH table names: v1 is what destroy must remove, and v2 is the replacement
# the rollback was supposed to delete -- a surviving v2 is a billing orphan the
# state-driven destroy can no longer reach.
assert_gone "phase 6: the v1 capacity table ${GT_NAME_V1} survived destroy" \
  aws dynamodb describe-table --table-name "${GT_NAME_V1}"
assert_gone "phase 6: the v2 capacity table ${GT_NAME_V2} survived the rollback" \
  aws dynamodb describe-table --table-name "${GT_NAME_V2}"
assert_gone "phase 6: the v1 omit table ${GTO_NAME_V1} survived destroy" \
  aws dynamodb describe-table --table-name "${GTO_NAME_V1}"
assert_gone "phase 6: the v2 omit table ${GTO_NAME_V2} survived the rollback" \
  aws dynamodb describe-table --table-name "${GTO_NAME_V2}"

assert_gone "phase 6: state.json survived destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "[verify] phase 6: OK (0 orphans, state gone)"

trap - EXIT INT TERM
cleanup
echo ""
echo "[verify] PASS"
