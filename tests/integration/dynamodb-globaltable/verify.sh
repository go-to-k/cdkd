#!/usr/bin/env bash
#
# End-to-end real-AWS test for cdkd's AWS::DynamoDB::GlobalTable SDK
# Provider (Issue #383 / #389 / #395 / #402). Verifies that a
# `dynamodb.TableV2` deployment produces a `${StackName}-X<hash>` AWS-side
# table name (not a CC-API auto-generated random string), that subsequent
# in-place UPDATE deploys round-trip cleanly through cdkd's serialized
# UpdateTable / TagResource / UpdateTimeToLive pipeline, that the
# `DeletionProtectionEnabled` toggle round-trips on / off (Issue #389),
# that BillingMode flips PROVISIONED <-> PAY_PER_REQUEST (Issue #402 Item C),
# that auto-scaling targets + policies get registered and torn down on
# the write path (Issue #402 Item B + Item A), and that destroy cleans
# up the table.
#
# Steps (default flow):
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDynamoDBGlobalTableExample (baseline)
#   3. read the deployed table name from cdkd state and assert it starts
#      with the cdkd `${StackName}-` prefix
#   4. assert the deployed table exists on AWS via DescribeTable
#   4b. assert per-GSI throughput round-tripped (Issue #1387): the
#       PROVISIONED table's GSI carries ProvisionedThroughput 7/2 and the
#       on-demand table's GSI carries OnDemandThroughput 50/60. Pre-fix the
#       first table could not be created at all and the second silently lost
#       its per-index limits. The write half is `MinCapacity` (2), not
#       `SeedCapacity` (3) — issue #1435.
#   4c. assert the per-INDEX scalable target + target-tracking policy exist
#       (Issue #1419). Runs against the BASELINE deploy, so it pins the
#       create-side half: pre-fix `create()` registered no autoscaling at
#       all and NO code path ever registered a `dynamodb:index:*` dimension.
#  4f. issue #1857: assert the QUOTED-STRING per-GSI WarmThroughput on
#       WarmCoercionTable reached AWS as NUMBERS. The arm's real
#       discriminator is step 2 itself — pre-fix the string is forwarded
#       verbatim into a numeric `Long` field and DynamoDB rejects the whole
#       CreateTable, so a reverted fix never gets here.
#   5. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection
#   8. assert DeletionProtectionEnabled is now true on AWS
#   9. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection,billing-provisioned
#       (Issue #402 Item C — BillingMode round-trip)
#  10. assert BillingMode is now PROVISIONED on AWS
#  11. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection,autoscaling
#       (Issue #402 Item B — table-level write + per-replica read autoscaling)
#  12. assert RegisterScalableTarget + PutScalingPolicy reached AWS via
#       application-autoscaling describe-scaling-policies
#  12a. assert the LOCAL replica's read dimension is registered too (Issue
#       #1419) — update()'s replica loops skip the local region, so only
#       CROSS-REGION replicas ever got a read target before the fix.
#  12b-e: optional cross-region (CDKD_INTEG_MULTI_REGION=1, see below).
#  12f. cdkd deploy with CDKD_TEST_UPDATE=...,ttl,tags (TTL toggle MUST be
#       LAST among structural changes — AWS's "Time to live has been
#       modified multiple times within a fixed interval" rate limit fires
#       when an UpdateTable structural change happens within ~1 hour after
#       a UpdateTimeToLive call. Deferring TTL to the end keeps the only
#       TTL state changes to enable-here → disable-at-step-13.)
#  12g. assert TTL is now ENABLED and the UpdateTest tag is present
#  13. cdkd deploy with CDKD_TEST_UPDATE= (cleared, baseline)
#  13j. issues #1733 / #1738: with BillingMode REMOVED from the state record,
#       a template declaring PAY_PER_REQUEST must resolve its baseline from
#       DescribeTable and APPLY the flip (pre-fix it compared equal to the
#       create-path default and silently lost it)
#  13k. issue #1738: an unusable BillingMode over a PAY_PER_REQUEST table keeps
#       the mode, so the declared provisioned capacity is unsendable and state
#       must retain the PREVIOUS value (the kept-PROVISIONED mirror of this is
#       asserted at step 13g on GsiProvRecoveryTable's on-demand ceiling)
#  14. assert DeletionProtectionEnabled is now false (or absent) on AWS,
#       BillingMode flipped back to PAY_PER_REQUEST, AND the scaling
#       policy is gone (DeleteScalingPolicy + DeregisterScalableTarget)
#  14d. issue #1830 preconditions: GsiDeleteRetryTable's indexes are ACTIVE
#       and its table-level WRITE scalable target is registered (the signal
#       step 15's race driver keys on).
#  15. cdkd destroy --remove-protection --force --verbose (works regardless
#       of the last DeletionProtectionEnabled state), teed to a log, with the
#       issue #1830 race driver running alongside it.
#  15b. issue #1830: assert the destroy ABSORBED an index-busy DeleteTable
#       refusal — the AWS refusal text AND a retry line naming the table must
#       both appear in a destroy that still exited 0.
#  16. assert the AWS-side table is gone, the per-INDEX scalable target was
#       deregistered (Issue #1419 — application-autoscaling is a separate
#       control plane, so DeleteTable alone leaves an orphan target a future
#       same-named table would inherit), and cdkd state is empty
#
# Wall-clock budget: ~7-10 min (each deploy + describe pair is ~30-60s;
# autoscaling apply adds ~5-10s per direction).
#
# Opt-in cross-region scenario (Issue #402 Item D, extended by Issue #1512):
#   Set CDKD_INTEG_MULTI_REGION=1 to enable the cross-region replica
#   round-trips. Replica provisioning is 5-10 min per region and per
#   direction, and there are now five of them:
#     12b-e  main table (PROVISIONED): add a replica carrying its own
#            ReadProvisionedThroughputSettings, assert the resulting
#            ProvisionedThroughputOverride, then remove the replica.
#     12e1-4 OnDemandReplicaTable (PAY_PER_REQUEST): add a replica with an
#            on-demand ceiling, CHANGE it, then DROP it — the last asserting
#            the live value is UNCHANGED and cdkd warned, since AWS offers
#            no way to clear a replica-level override.
#   Budget ~45-75 min total and ~$0.10-0.20 in cross-region replication.
#   The default `bash verify.sh` invocation does NOT run any of this — it
#   stays under 8 min as before. Runs BEFORE the TTL toggle so the
#   cross-region UpdateTable is not blocked by AWS's TTL rate limit.
#
#   Only 12d removes a replica from a live table (pre-existing). The #1512
#   rounds deliberately only ADD: a live replica-delete is what arms
#   DynamoDB's 24h source-region delete lock (issue #1436 / #1442), and
#   `cdkd destroy` tears the whole GlobalTable down as one resource instead.
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
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

# --- issue #1830: the index-busy DeleteTable race driver --------------------
# Deliberately OUTSIDE the canonical gone-probe block above: that block is
# matched verbatim by `check-integ-probe-not-found.ts`, so anything added
# inside it is a lint failure.
#
# WHY A DRIVER AT ALL, and why it keys on a LOG line rather than on the clock.
# `delete()` runs: pre-delete DescribeTable -> auto-scaling teardown ->
# `hasTransitionalIndex(<the PRE-DELETE snapshot>)` gate -> DeleteTable. An
# index that is already transitioning when the destroy STARTS is therefore
# seen by that describe, waited out by the #1521 gate, and the delete then
# succeeds — with the #1830 fix REVERTED as well, which is exactly the
# vacuous arm this driver exists to avoid. The only window that reproduces
# the real defect is BETWEEN the describe and DeleteTable, and the auto-
# scaling teardown is the only thing in it.
#
# `Deregistered auto-scaling target table/<t> (dynamodb:table:WriteCapacityUnits)`
# is the one debug line emitted inside that window whose ordering is
# GUARANTEED: it is logged after the pre-delete describe, and 48 further
# serialized application-auto-scaling calls (12 indexes x 2 dimensions x 2
# calls) follow it before `DeleteTable`. Keying on it means the driver can
# fire too LATE (the arm then fails loudly at step 15b with nothing left
# behind) but never too EARLY (which would arm the #1521 gate and make the
# arm pass with the fix reverted).
delete_retry_race_driver() { # $1=destroy log  $2=table  $3=marker file
  local log="$1" table="$2" marker="$3"
  local signal="Deregistered auto-scaling target table/${table} (dynamodb:table:WriteCapacityUnits)"
  local i
  for i in $(seq 1 12000); do
    if [ -s "${log}" ] && grep -qF "${signal}" "${log}"; then
      # CREATE a new index rather than re-provisioning an existing one.
      # Measured 2026-08-18: a provisioned-capacity `Update` on an empty index
      # settles in well under a second, so it was ACTIVE again before
      # `DeleteTable` arrived and AWS never refused — the arm failed twice in a
      # row reporting "the UpdateTable landed but AWS never refused". Widening
      # the window (more indexes) does not fix that, because the problem is how
      # SHORT the transition is, not how narrow the window is. An index CREATE
      # holds the table in `UPDATING` through the backfill, which is also
      # literally the condition the refusal names ("indexes are being
      # created"). The index is never cleaned up on purpose: the table it hangs
      # off is deleted seconds later by the destroy under test.
      # `2>&1 >/dev/null` (in that order) keeps AWS's own refusal and discards
      # the success payload. The stderr goes INTO the marker because the driver
      # runs in a background subshell whose output is interleaved with the
      # destroy's `tee`: discarding it, as this did, made `update-rejected` the
      # one outcome nobody could diagnose — and it is the outcome whose causes
      # (the table is already DELETING, a throttle, a limit) are the ones worth
      # telling apart.
      local err
      if err="$(aws dynamodb update-table \
        --table-name "${table}" \
        --attribute-definitions AttributeName=raceKey,AttributeType=S \
        --global-secondary-index-updates \
        "[{\"Create\":{\"IndexName\":\"raceIdx\",\"KeySchema\":[{\"AttributeName\":\"raceKey\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"KEYS_ONLY\"},\"ProvisionedThroughput\":{\"ReadCapacityUnits\":1,\"WriteCapacityUnits\":1}}}]" \
        --region "${REGION}" 2>&1 >/dev/null)"; then
        printf 'fired' >"${marker}"
      else
        printf 'update-rejected: %s' "${err}" >"${marker}"
      fi
      return 0
    fi
    sleep 0.05
  done
  printf 'signal-timeout' >"${marker}"
  return 0
}
# ---------------------------------------------------------------------------

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDynamoDBGlobalTableExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/dynamodb-globaltable"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# Set once step 15 starts the issue #1830 race driver; killed on every exit
# path so an aborted run cannot leave a background `aws dynamodb update-table`
# loop running against a table the cleanup destroy is deleting.
DELETE_RETRY_DRIVER_PID=""
# The step 15 destroy log and the driver's outcome marker. Declared here rather
# than only at step 15 so `cleanup()` can sweep them under `set -u` on the exit
# paths that never reach step 15, and so a FAILURE at step 15 / 15b — which
# leaves both behind, since the success path is the only place that removes
# them inline — cannot leak two `mktemp` files per run.
DESTROY_LOG=""
DELETE_RETRY_MARKER=""

cleanup() {
  rc=$?
  if [ -n "${DELETE_RETRY_DRIVER_PID}" ]; then
    kill "${DELETE_RETRY_DRIVER_PID}" 2>/dev/null || true
    wait "${DELETE_RETRY_DRIVER_PID}" 2>/dev/null || true
    DELETE_RETRY_DRIVER_PID=""
  fi
  # Sweep AFTER the driver is dead: it writes the marker, so removing it while
  # the driver still runs would just let it be re-created. `if` rather than
  # `[ ... ] && rm`, because under `set -e` a false test in an `&&` list aborts
  # the function and would skip the destroy below it.
  if [ -n "${DESTROY_LOG}" ]; then
    rm -f "${DESTROY_LOG}"
    DESTROY_LOG=""
  fi
  if [ -n "${DELETE_RETRY_MARKER}" ]; then
    rm -f "${DELETE_RETRY_MARKER}"
    DELETE_RETRY_MARKER=""
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    # Retry once on dependency errors (AWS DynamoDB delete can lag
    # briefly). `--remove-protection` is load-bearing — the
    # deletion-protection step (#7) may have left the table protected
    # mid-run; without the flag, AWS rejects DeleteTable.
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --remove-protection --force || \
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --remove-protection --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy (baseline — no UPDATE flags)"
unset CDKD_TEST_UPDATE
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 3: read deployed table names from cdkd state"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
# The stack deploys THREE AWS::DynamoDB::GlobalTable resources (the original
# HistoryTable plus the two Issue #1387 GSI fixtures), so select by logical-id
# prefix rather than "first GlobalTable in state".
table_name_for() { # $1 = construct id prefix -> physical table name
  echo "${STATE_JSON}" | python3 -c '
import json, sys
prefix = sys.argv[1]
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable" and logical_id.startswith(prefix):
        print(resource["physicalId"])
        break
' "$1"
}
TABLE_NAME="$(table_name_for HistoryTable)"
STREAM_RECOVERY_TABLE="$(table_name_for StreamRecoveryTable)"
GSI_PROV_TABLE="$(table_name_for GsiProvisionedTable)"
GSI_OD_TABLE="$(table_name_for GsiOnDemandTable)"
GSI_FLIP_TABLE="$(table_name_for GsiFlipTable)"
OD_REPLICA_TABLE="$(table_name_for OnDemandReplicaTable)"
WARM_COERCION_TABLE="$(table_name_for WarmCoercionTable)"
GSI_DELETE_RETRY_TABLE="$(table_name_for GsiDeleteRetryTable)"
if [ -z "${WARM_COERCION_TABLE}" ] || [ -z "${GSI_DELETE_RETRY_TABLE}" ]; then
  echo "FAIL: issues #1857 / #1830 — WarmCoercionTable / GsiDeleteRetryTable missing from cdkd state (got '${WARM_COERCION_TABLE}' / '${GSI_DELETE_RETRY_TABLE}')" >&2
  exit 1
fi
# Issue #1512: once step 12e1 has ADDED the on-demand replica, every LATER
# deploy must keep declaring it. A mode-gated resource disappears from the
# template in any step whose mode list omits its token, and cdkd then issues a
# DELETE -- here that would be a replica removal on a still-live table, the
# operation that arms DynamoDB's 24h source-region delete lock (#1442). So the
# gating token is carried forward in this suffix, which is appended to every
# deploy after the on-demand rounds. Empty until step 12e3 sets it, and empty for the
# whole run when CDKD_INTEG_MULTI_REGION is unset -- so the default flow is
# byte-for-byte unchanged.
OD_MODE_SUFFIX=""
if [ -z "${TABLE_NAME}" ]; then
  echo "[verify] FAIL: no HistoryTable AWS::DynamoDB::GlobalTable resource in cdkd state"
  exit 1
fi
if [ -z "${GSI_FLIP_TABLE}" ]; then
  echo "[verify] FAIL: Issue #1421 billing-flip fixture table missing from cdkd state"
  exit 1
fi
if [ -z "${GSI_PROV_TABLE}" ] || [ -z "${GSI_OD_TABLE}" ]; then
  echo "[verify] FAIL: Issue #1387 GSI fixture tables missing from cdkd state (prov='${GSI_PROV_TABLE}' on-demand='${GSI_OD_TABLE}')"
  exit 1
fi
if [ -z "${STREAM_RECOVERY_TABLE}" ]; then
  echo "[verify] FAIL: Issue #1653 StreamRecoveryTable missing from cdkd state"
  exit 1
fi
echo "[verify] step 3 ok: deployed table names = ${TABLE_NAME} / ${GSI_PROV_TABLE} / ${GSI_OD_TABLE}"

# The canonical bug fix assertion: pre-PR the name was an opaque random
# string (`yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV`-style); post-PR it
# MUST start with `${StackName}-`. Allow case-insensitive match because
# `generateResourceName`'s sanitize pipeline may lowercase / dash-replace
# characters.
case "${TABLE_NAME}" in
  "${STACK}-"*)
    echo "[verify] step 3 ok: name has the expected '${STACK}-' prefix"
    ;;
  *)
    echo "[verify] FAIL: deployed table name '${TABLE_NAME}' does not start with '${STACK}-'"
    echo "[verify]   (pre-PR bug: CC API auto-generated random names; the new SDK Provider must apply cdkd's stack-name prefix)"
    exit 1
    ;;
esac

echo "[verify] step 4: assert table exists on AWS"
aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null
echo "[verify] step 4 ok: DescribeTable succeeded"

echo "[verify] step 4b (Issue #1387): assert per-GSI throughput reached AWS"
# The bug: cdkd cast the CFn `GlobalSecondaryIndexes` blob straight to the
# SDK's `GlobalSecondaryIndex[]`, and the SDK serializer drops unknown
# members. So the PROVISIONED table's CreateTable used to fail outright
# ("Neither ProvisionedThroughput nor OnDemandThroughput was specified for
# index: byStatus") and the on-demand table's per-index limits were dropped
# silently. Read every value back off DescribeTable.
#
# Expected values, and where each half comes from in the synthesized template:
#   byStatus.ProvisionedThroughput.ReadCapacityUnits  = 7  <- Replicas[local].GlobalSecondaryIndexes[].ReadProvisionedThroughputSettings
#   byStatus.ProvisionedThroughput.WriteCapacityUnits = 2  <- GSI.WriteProvisionedThroughputSettings...MinCapacity (issue #1435: CFn creates at MinCapacity, not the SeedCapacity=3 cdkd used to send)
#   byOwner.OnDemandThroughput.MaxReadRequestUnits    = 50 <- Replicas[local].GlobalSecondaryIndexes[].ReadOnDemandThroughputSettings
#   byOwner.OnDemandThroughput.MaxWriteRequestUnits   = 60 <- GSI.WriteOnDemandThroughputSettings
gsi_field() { # $1 = table, $2 = index name, $3 = JMESPath under the index object
  local out
  out="$(aws dynamodb describe-table --table-name "$1" --region "${REGION}" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='$2'] | [0].$3" --output text)" || return 1
  printf '%s' "${out}"
}
assert_gsi_field() { # $1 = table, $2 = index, $3 = JMESPath, $4 = expected
  local actual
  actual="$(gsi_field "$1" "$2" "$3")"
  if [ "${actual}" != "$4" ]; then
    echo "[verify] FAIL (issue #1387): ${1} index ${2} ${3} is '${actual}' (expected '$4')" >&2
    echo "[verify]   pre-fix cdkd forwarded the CFn-only spelling and the SDK dropped it" >&2
    exit 1
  fi
  echo "[verify] step 4b ok: ${2}.${3} = ${actual}"
}
assert_gsi_field "${GSI_PROV_TABLE}" byStatus ProvisionedThroughput.ReadCapacityUnits 7
assert_gsi_field "${GSI_PROV_TABLE}" byStatus ProvisionedThroughput.WriteCapacityUnits 2
assert_gsi_field "${GSI_OD_TABLE}" byOwner OnDemandThroughput.MaxReadRequestUnits 50
assert_gsi_field "${GSI_OD_TABLE}" byOwner OnDemandThroughput.MaxWriteRequestUnits 60

# Table-level throughput must survive alongside the per-index values.
PROV_TABLE_READ="$(aws dynamodb describe-table --table-name "${GSI_PROV_TABLE}" --region "${REGION}" \
  --query 'Table.ProvisionedThroughput.ReadCapacityUnits' --output text)"
if [ "${PROV_TABLE_READ}" != "5" ]; then
  echo "[verify] FAIL: ${GSI_PROV_TABLE} table-level ReadCapacityUnits is '${PROV_TABLE_READ}' (expected 5)" >&2
  exit 1
fi
OD_TABLE_MAX_WRITE="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxWriteRequestUnits' --output text)"
if [ "${OD_TABLE_MAX_WRITE}" != "200" ]; then
  echo "[verify] FAIL: ${GSI_OD_TABLE} table-level MaxWriteRequestUnits is '${OD_TABLE_MAX_WRITE}' (expected 200)" >&2
  exit 1
fi
# Issue #1436: the canonical `Billing.onDemand({maxReadRequestUnits})` renders
# onto `Replicas[local].ReadOnDemandThroughputSettings`, a location the provider
# never read — so this member used to be dropped on the way IN and the table
# deployed with NO read ceiling while cdkd reported success (a surprise bill,
# not an error). Asserting it on the BASELINE is what proves the create-side
# wiring; step 13d then proves the reset.
OD_TABLE_MAX_READ="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text)"
if [ "${OD_TABLE_MAX_READ}" != "100" ]; then
  echo "[verify] FAIL (issue #1436): ${GSI_OD_TABLE} table-level MaxReadRequestUnits is '${OD_TABLE_MAX_READ}' (expected 100)" >&2
  echo "[verify]   pre-fix cdkd read only the WRITE half and dropped this one entirely" >&2
  exit 1
fi
echo "[verify] step 4b ok: table-level throughput preserved on both GSI fixtures (incl. the #1436 read ceiling)"

echo "[verify] step 4d (Issue #1421): assert the billing-flip fixture starts PAY_PER_REQUEST with BOTH indexes"
# Precondition for step 13e. Without it the post-flip checks could pass
# vacuously — "flipDrop is gone" is also true if it never existed.
FLIP_BILLING_BEFORE="$(aws dynamodb describe-table --table-name "${GSI_FLIP_TABLE}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
FLIP_IDX_BEFORE="$(aws dynamodb describe-table --table-name "${GSI_FLIP_TABLE}" --region "${REGION}" \
  --query "join(' ', sort(Table.GlobalSecondaryIndexes[].IndexName || \`[]\`))" --output text)"
if [ "${FLIP_BILLING_BEFORE}" != "PAY_PER_REQUEST" ] || [ "${FLIP_IDX_BEFORE}" != "flipDrop flipKeep" ]; then
  echo "[verify] FAIL (issue #1421 precondition): expected PAY_PER_REQUEST with 'flipDrop flipKeep', got '${FLIP_BILLING_BEFORE}' / '${FLIP_IDX_BEFORE}'" >&2
  exit 1
fi
echo "[verify] step 4d ok: ${GSI_FLIP_TABLE} is PAY_PER_REQUEST with indexes ${FLIP_IDX_BEFORE}"

echo "[verify] step 4e (Issue #1420): assert cdkd drift reports NO drift on the freshly-deployed GSI tables"
# The whole point of the #1420 fix: readCurrentState used to store the raw SDK
# GlobalSecondaryIndexDescription[] into the CFn-shaped state key, so a clean,
# unmodified GlobalTable with a GSI reported PERMANENT phantom drift. This step
# is the end-to-end proof the reverse map round-trips against real AWS — it
# also pins the single-region `DescribeTable` shape (no `Replicas` member) the
# reverse map synthesizes a local entry for.
if ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
  echo "[verify] step 4e ok: zero drift on the freshly-deployed stack (issue #1420 closed)"
else
  echo "[verify] FAIL (issue #1420): cdkd drift reported drift on a freshly-deployed stack — the GSI reverse map does not round-trip" >&2
  exit 1
fi

echo "[verify] step 4f (Issue #1857): assert the QUOTED-STRING WarmThroughput was COERCED onto the wire"
# `WarmCoercionTable` declares warmIdx's WarmThroughput as CloudFormation
# STRINGS ('12000' / '4000') — the shape a quoted template value or an
# `Fn::Sub` result arrives in. Pre-fix the provider forwarded that block
# verbatim into the SDK's numeric `Long` fields and DynamoDB rejected the whole
# CreateTable, so a REVERTED fix fails at step 2 and never reaches this line.
# That, not the readback below, is the arm's discriminator.
#
# What the readback adds is proof the coerced block was SENT and ACCEPTED
# rather than refused and dropped on the way. It deliberately does NOT
# discriminate on the VALUE: AWS reports a warm throughput on every index
# whether or not one was declared (issue #1859), and the declared numbers ARE
# that default — anything above it is a BILLED increase and this fixture runs
# against a real account. So the check is a numeric-shape test plus a monotonic
# floor, never an equality against a pinned literal.
warm_units_ok() { # $1 = readback value, $2 = declared floor
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge "$2" ]
}
WARM_READ="$(gsi_field "${WARM_COERCION_TABLE}" warmIdx WarmThroughput.ReadUnitsPerSecond)"
WARM_WRITE="$(gsi_field "${WARM_COERCION_TABLE}" warmIdx WarmThroughput.WriteUnitsPerSecond)"
if ! warm_units_ok "${WARM_READ}" 12000 || ! warm_units_ok "${WARM_WRITE}" 4000; then
  echo "FAIL: issue #1857 — expected warmIdx on ${WARM_COERCION_TABLE} to carry a NUMERIC WarmThroughput of at least 12000 read / 4000 write after coercion, got read='${WARM_READ}' write='${WARM_WRITE}'" >&2
  exit 1
fi
echo "[verify] step 4f ok: warmIdx WarmThroughput = ${WARM_READ} read / ${WARM_WRITE} write (declared as the strings '12000' / '4000')"

echo "[verify] step 4c (Issue #1419): assert the per-INDEX auto-scaling target + policy exist on AWS"
# The bug: cdkd registered application-autoscaling targets only for
# `dynamodb:table:*`. A per-GSI `writeCapacity: Capacity.autoscaled(...)`
# produced a correct INITIAL capacity (which step 4b asserts and which is why
# this went unnoticed) but no scalable target at all, so the index was pinned
# at that capacity forever — min/max/targetUtilizationPercent silently dropped.
#
# `create()` additionally registered NOTHING, so this assertion runs against
# the BASELINE deploy: no update deploy has happened yet at this point in the
# flow. That is deliberate — it pins the create-side half of the fix.
# Read ONE scalable-target field. Per-value queries rather than a joined
# multi-field `--output text` row: the joined form compares against a literal
# embedded TAB, which is invisible in review and breaks if the AWS CLI ever
# changes its text-output separator. `|| return 1` propagates a probe failure
# to the caller's `set -e` (errexit is cleared inside `$( )`).
scalable_target_field() { # $1 = resource id, $2 = dimension, $3 = field
  local out
  out="$(aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb \
    --resource-ids "$1" \
    --scalable-dimension "$2" \
    --region "${REGION}" \
    --query "ScalableTargets[0].$3" --output text)" || return 1
  printf '%s' "${out}"
}
assert_scalable_target() { # $1 = resource id, $2 = dimension, $3 = min, $4 = max, $5 = label
  # Application Auto Scaling is a SEPARATE, eventually-consistent control
  # plane: `DescribeScalableTargets` can still report the target as absent
  # for a few seconds after `RegisterScalableTarget` returned. This assertion
  # read once, so it raced that window and failed with `Min=None Max=None` on
  # 2026-08-11 while cdkd's own log showed the policy upserted 1s earlier
  # ("Upserted auto-scaling policy ... dynamodb:index:WriteCapacityUnits").
  # An immediately preceding run of the same tree passed, confirming a race
  # rather than a regression.
  #
  # The retry cannot HIDE a real non-registration: if cdkd never registers,
  # every poll reads None and the assertion still fails — it only absorbs the
  # propagation delay. The deregistration side (`assert_target_gone`) is a
  # separate helper and is deliberately left alone.
  local got_min got_max i
  for i in $(seq 1 30); do
    got_min="$(scalable_target_field "$1" "$2" MinCapacity)"
    got_max="$(scalable_target_field "$1" "$2" MaxCapacity)"
    if [ "${got_min}" = "$3" ] && [ "${got_max}" = "$4" ]; then break; fi
    sleep 2
  done
  if [ "${got_min}" != "$3" ] || [ "${got_max}" != "$4" ]; then
    echo "[verify] FAIL (issue #1419): $5 on $1 ($2)" >&2
    echo "[verify]   got Min=${got_min} Max=${got_max}, expected Min=$3 Max=$4" >&2
    echo "[verify]   pre-fix cdkd never registered this scalable dimension" >&2
    exit 1
  fi
  echo "[verify] $5 ok: Min=${got_min} Max=${got_max}"
}

INDEX_RESOURCE_ID="table/${GSI_PROV_TABLE}/index/byStatus"
assert_scalable_target "${INDEX_RESOURCE_ID}" dynamodb:index:WriteCapacityUnits 2 20 \
  "step 4c index write autoscaling"
INDEX_POLICY_TARGET="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb \
  --resource-id "${INDEX_RESOURCE_ID}" \
  --scalable-dimension dynamodb:index:WriteCapacityUnits \
  --region "${REGION}" \
  --query 'ScalingPolicies[?PolicyType==`TargetTrackingScaling`] | [0].TargetTrackingScalingPolicyConfiguration.TargetValue' \
  --output text)"
case "${INDEX_POLICY_TARGET}" in
  60|60.0)
    echo "[verify] step 4c ok: index write autoscaling registered (Min=2 Max=20 TargetValue=${INDEX_POLICY_TARGET})"
    ;;
  *)
    echo "[verify] FAIL (issue #1419): index write autoscaling TargetValue is '${INDEX_POLICY_TARGET}' (expected 60)" >&2
    exit 1
    ;;
esac

# The READ half of the same index. Registered from a DIFFERENT CFn location
# than the write half (`Replicas[local].GlobalSecondaryIndexes[]` rather than
# the top-level GSI), so it is a genuinely separate path, not a mirror.
assert_scalable_target "${INDEX_RESOURCE_ID}" dynamodb:index:ReadCapacityUnits 7 70 \
  "step 4c index read autoscaling"

# Issue #1435 at TABLE level: the fixture declares minCapacity 1 / seedCapacity 8,
# and CloudFormation creates at MinCapacity. Pre-fix cdkd sent the seed (8).
PROV_TABLE_WRITE="$(aws dynamodb describe-table --table-name "${GSI_PROV_TABLE}" --region "${REGION}" \
  --query 'Table.ProvisionedThroughput.WriteCapacityUnits' --output text)"
if [ "${PROV_TABLE_WRITE}" != "1" ]; then
  echo "[verify] FAIL (issue #1435): ${GSI_PROV_TABLE} table-level WriteCapacityUnits is '${PROV_TABLE_WRITE}' (expected 1 = MinCapacity, not 8 = SeedCapacity)" >&2
  exit 1
fi
echo "[verify] step 4c ok: table-level write capacity created at MinCapacity (${PROV_TABLE_WRITE})"

echo "[verify] step 5 (was steps 5/6/7): cdkd deploy with CDKD_TEST_UPDATE=deletion-protection (in-place update — Issue #389)"
# ORDER NOTE (PR follow-up to #403): TTL toggle is intentionally
# deferred to the END of the integ flow. AWS's DynamoDB
# "Time to live has been modified multiple times within a fixed
# interval" rate limit fires when a structural UpdateTable (e.g. an
# UpdateTable adding a replica via ReplicaUpdates: [Create]) is
# issued within ~1 hour after a UpdateTimeToLive call. Putting the
# TTL toggle FIRST trips the limit on the cross-region replica add
# (CDKD_INTEG_MULTI_REGION=1) at step 12b. Reordering to "TTL last"
# avoids the conflict entirely — we never have TTL "recently
# modified" while doing structural changes.
CDKD_TEST_UPDATE=deletion-protection ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 8: assert DeletionProtectionEnabled is now true on AWS"
DP_ENABLED="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.DeletionProtectionEnabled' --output text)"
if [ "${DP_ENABLED}" != "True" ] && [ "${DP_ENABLED}" != "true" ]; then
  echo "[verify] FAIL: DeletionProtectionEnabled is '${DP_ENABLED}' on '${TABLE_NAME}' after the deletion-protection UPDATE deploy (expected true)"
  exit 1
fi
echo "[verify] step 8 ok: DeletionProtectionEnabled = ${DP_ENABLED}"

echo "[verify] step 9: cdkd deploy with CDKD_TEST_UPDATE=billing-provisioned (Issue #402 Item C)"
# Combine with deletion-protection so AWS keeps the table at the same
# protection state — the BillingMode flip is the only diff we care about
# here.
CDKD_TEST_UPDATE=deletion-protection,billing-provisioned ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 10: assert BillingMode is now PROVISIONED on AWS"
BILLING_MODE="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${BILLING_MODE}" != "PROVISIONED" ]; then
  echo "[verify] FAIL: BillingMode is '${BILLING_MODE}' on '${TABLE_NAME}' after the billing-provisioned UPDATE deploy (expected PROVISIONED)"
  exit 1
fi
echo "[verify] step 10 ok: BillingMode = ${BILLING_MODE}"

echo "[verify] step 11: cdkd deploy with CDKD_TEST_UPDATE=autoscaling (Issue #402 Item B — exercises Item A's write-path autoscaling wiring)"
# Build on top of the PROVISIONED state from step 9 so cdkd's update
# path goes via the auto-scaling diff branch (Min/Max + TargetTracking
# upsert) rather than the BillingMode-flip-and-register path.
CDKD_TEST_UPDATE=deletion-protection,autoscaling ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 12: assert auto-scaling target + policy are registered on AWS for the WriteCapacityUnits dimension"
WRITE_POLICY_COUNT="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb \
  --resource-id "table/${TABLE_NAME}" \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --region "${REGION}" \
  --query 'length(ScalingPolicies[?PolicyType==`TargetTrackingScaling`])' \
  --output text)"
if [ "${WRITE_POLICY_COUNT}" != "1" ]; then
  echo "[verify] FAIL: expected 1 TargetTrackingScaling policy on the WriteCapacityUnits dimension, got '${WRITE_POLICY_COUNT}'"
  exit 1
fi
WRITE_TARGET_VALUE="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb \
  --resource-id "table/${TABLE_NAME}" \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --region "${REGION}" \
  --query 'ScalingPolicies[?PolicyType==`TargetTrackingScaling`] | [0].TargetTrackingScalingPolicyConfiguration.TargetValue' \
  --output text)"
case "${WRITE_TARGET_VALUE}" in
  70|70.0)
    echo "[verify] step 12 ok: write autoscaling policy registered, TargetValue=${WRITE_TARGET_VALUE}"
    ;;
  *)
    echo "[verify] FAIL: write autoscaling TargetValue is '${WRITE_TARGET_VALUE}' (expected 70 from Capacity.autoscaled)"
    exit 1
    ;;
esac

echo "[verify] step 12a (Issue #1419): assert the LOCAL replica's read dimension is registered too"
# `readCapacity: Capacity.autoscaled(...)` on the deploy-region replica
# synthesizes to `Replicas[local].ReadProvisionedThroughputSettings`. No code
# path ever registered it: update()'s replica loops all `continue` on the
# local region, so only CROSS-REGION replicas got a read target, and create()
# registered nothing at all. The read half of a single-region autoscaled
# table was therefore silently unscaled.
assert_scalable_target "table/${TABLE_NAME}" dynamodb:table:ReadCapacityUnits 5 50 \
  "step 12a local replica read autoscaling"

# Item D — opt-in cross-region replica round-trip. Guarded behind
# CDKD_INTEG_MULTI_REGION=1 because the wall-clock + cost is large.
if [ "${CDKD_INTEG_MULTI_REGION:-0}" = "1" ]; then
  echo "[verify] step 12b (Item D): cross-region replica round-trip (CDKD_INTEG_MULTI_REGION=1)"
  # Add eu-west-1 as a second replica. Streams already exist (auto-enabled
  # by cdkd on multi-replica).
  CDKD_TEST_UPDATE=deletion-protection,autoscaling,cross-region ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

  echo "[verify] step 12c: assert the eu-west-1 replica reaches ACTIVE"
  EU_STATUS="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region eu-west-1 \
    --query 'Table.TableStatus' --output text 2>&1 || echo MISSING)"
  if [ "${EU_STATUS}" != "ACTIVE" ]; then
    echo "[verify] FAIL: cross-region replica eu-west-1 not ACTIVE (got '${EU_STATUS}')"
    exit 1
  fi
  echo "[verify] step 12c ok: eu-west-1 replica = ${EU_STATUS}"

  # --- step 12c-2 (Issue #1512): the PROVISIONED replica-level override ----
  # PR (#1503) taught `addReplica` to send the replica's TABLE-level
  # `ProvisionedThroughputOverride`, derived from the CFn
  # `Replicas[].ReadProvisionedThroughputSettings` the fixture now declares
  # (autoscaled 7..70 -> the override takes MinCapacity, issue #1435). No
  # real-AWS run had ever asserted it; unit coverage is mocked-SDK only, and
  # a wrong wire assumption agrees with its own mock.
  # 7 is deliberately different from the source table's 5, so a replica that
  # merely INHERITED the source capacity cannot pass this.
  # Strict capture: the source table demonstrably exists here (step 12c just
  # asserted its replica is ACTIVE), so a probe failure is a real error and
  # `set -e` must surface it. A `|| echo MISSING` fallback would turn a
  # throttle into a plain assertion failure blaming the fix (#1120).
  # Polled, not single-shot: this is the same eventually-consistent readback
  # the on-demand twin polls for. A one-shot read here would flake with a FAIL
  # blaming (#1503) when the value simply had not propagated yet.
  EU_PROV_OVERRIDE=""
  for _ in $(seq 1 30); do
    EU_PROV_OVERRIDE="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
      --query "Table.Replicas[?RegionName=='eu-west-1'].ProvisionedThroughputOverride.ReadCapacityUnits | [0]" \
      --output text)"
    [ "${EU_PROV_OVERRIDE}" = "7" ] && break
    sleep 10
  done
  if [ "${EU_PROV_OVERRIDE}" != "7" ]; then
    echo "[verify] FAIL: eu-west-1 ProvisionedThroughputOverride.ReadCapacityUnits is '${EU_PROV_OVERRIDE}', expected 7 (the replica's declared min capacity)"
    exit 1
  fi
  echo "[verify] step 12c-2 ok: eu-west-1 ProvisionedThroughputOverride = 7"

  echo "[verify] step 12d: remove the eu-west-1 replica"
  CDKD_TEST_UPDATE=deletion-protection,autoscaling ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

  echo "[verify] step 12e: assert the eu-west-1 replica is gone (DescribeTable → RNF)"
  # cdkd's `waitForReplicaGone` polls the LOCAL table's `Replicas[]`
  # list and returns when eu-west-1 is no longer there — that's the
  # correct AWS semantic for "replica deleted from the global table's
  # metadata". HOWEVER, the actual eu-west-1 regional DynamoDB copy
  # may stay in DELETING state for several minutes after that. We
  # retry-with-backoff for up to 10 minutes (60 attempts * 10s) so
  # the integ tolerates the async propagation lag without forcing
  # cdkd's wait helper to block on every replica delete.
  # Pattern-match on ResourceNotFoundException specifically so a
  # transient AWS error (throttle / IAM gap / network blip) doesn't
  # false-pass the assertion (PR #410 review minor #3).
  EU_GONE=0
  for i in $(seq 1 60); do
    EU_ERR="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region eu-west-1 2>&1 >/dev/null || true)"
    if [ -z "${EU_ERR}" ]; then
      # DescribeTable succeeded — replica still exists. Keep polling.
      sleep 10
      continue
    fi
    case "${EU_ERR}" in
      *ResourceNotFoundException*|*"Requested resource not found"*)
        EU_GONE=1
        echo "[verify] step 12e: eu-west-1 DescribeTable returned RNF after ~$((i * 10))s"
        break
        ;;
      *)
        echo "[verify] step 12e: transient error from eu-west-1 DescribeTable, retrying: ${EU_ERR}"
        sleep 10
        ;;
    esac
  done
  if [ "${EU_GONE}" != "1" ]; then
    echo "[verify] FAIL: cross-region replica eu-west-1 still exists (or DescribeTable kept erroring transiently) after ~10 min of polling"
    exit 1
  fi
  echo "[verify] step 12e ok: eu-west-1 replica removed (DescribeTable returns RNF)"

  # ─── Issue #1512: the ON-DEMAND replica throughput override ────────────
  #
  # Steps 12b-e above run the main table, which is PROVISIONED under this
  # mode list — so they can only reach the `ProvisionedThroughputOverride`
  # arm of `toSdkReplicaThroughputOverrides`. `OnDemandThroughputOverride`
  # on the Create/Update ReplicationGroupMemberAction is a DIFFERENT wire
  # shape and needs the PAY_PER_REQUEST `OnDemandReplicaTable`.
  #
  # These rounds only ever ADD a replica. Removing one from a still-live
  # table is what arms DynamoDB's 24h source-region delete lock (issue
  # #1436 / #1442); teardown is left to `cdkd destroy`, which drops the
  # GlobalTable as one resource with all replicas together.
  if [ -z "${OD_REPLICA_TABLE}" ]; then
    echo "[verify] FAIL: no OnDemandReplicaTable AWS::DynamoDB::GlobalTable resource in cdkd state"
    exit 1
  fi

  # Read the replica's live ceiling from BOTH directions: the source table's
  # Replicas[] entry (what cdkd wrote) and the replica region's own
  # DescribeTable (what the replica actually serves).
  # Both are TAIL-LESS captures: the probe is the last command of the body,
  # so a failure propagates as the function's own non-zero status instead of
  # being laundered into a sentinel string (#1120). The replica-region probe
  # legitimately fails with RNF until the replica exists, which is precisely
  # why the poll below branches on the STATUS rather than on a sentinel.
  od_override_from_source() {
    aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" --region "${REGION}" \
      --query "Table.Replicas[?RegionName=='eu-west-1'].OnDemandThroughputOverride.MaxReadRequestUnits | [0]" \
      --output text
  }
  od_override_from_replica() {
    aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" --region eu-west-1 \
      --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text
  }
  # The replica flips ACTIVE well before its override is readable; poll. The
  # last-seen values are kept so a timeout can report what it actually saw
  # rather than re-probing (which could itself fail and mask the real value).
  OD_LAST_SRC=""
  OD_LAST_REP=""
  wait_od_override() { # $1 = expected value -> 0 when both sides agree
    for _ in $(seq 1 60); do
      OD_LAST_SRC="$(od_override_from_source 2>/dev/null || true)"
      OD_LAST_REP="$(od_override_from_replica 2>/dev/null || true)"
      if [ "${OD_LAST_SRC}" = "$1" ] && [ "${OD_LAST_REP}" = "$1" ]; then
        return 0
      fi
      sleep 10
    done
    return 1
  }

  echo "[verify] step 12e1 (Issue #1512): add the eu-west-1 replica WITH an on-demand ceiling (20)"
  CDKD_TEST_UPDATE=deletion-protection,autoscaling,cross-region-ondemand ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose
  if ! wait_od_override 20; then
    echo "[verify] FAIL: eu-west-1 OnDemandThroughputOverride is source='${OD_LAST_SRC}' replica='${OD_LAST_REP}', expected 20 on both"
    echo "[verify]       (pre-(#1503) the addReplica call dropped the override entirely and the replica inherited the source default)"
    exit 1
  fi
  echo "[verify] step 12e1 ok: addReplica sent OnDemandThroughputOverride = 20"

  echo "[verify] step 12e2 (Issue #1512): CHANGE the ceiling 20 -> 40 (replica-modify action)"
  CDKD_TEST_UPDATE=deletion-protection,autoscaling,cross-region-ondemand-changed ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose
  if ! wait_od_override 40; then
    echo "[verify] FAIL: eu-west-1 OnDemandThroughputOverride is source='${OD_LAST_SRC}' replica='${OD_LAST_REP}', expected 40 after the change round"
    exit 1
  fi
  echo "[verify] step 12e2 ok: the Update action applied OnDemandThroughputOverride = 40"

  echo "[verify] step 12e3 (Issue #1512): DROP the ceiling — must stay 40 and WARN"
  # AWS offers no way to clear a replica-level override: a -1 sentinel is
  # stored literally and an empty block wedges the table in UPDATING (both
  # live-probed, issue #1436). So cdkd deliberately leaves the old value in
  # effect and says so. Asserting the value is UNCHANGED is what pins that
  # decision; asserting the warning is what pins the user being told.
  OD_DROP_LOG="$(mktemp)"
  CDKD_TEST_UPDATE=deletion-protection,autoscaling,cross-region-ondemand-dropped ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${OD_DROP_LOG}"
  OD_AFTER_DROP="$(od_override_from_source)"
  OD_AFTER_DROP_REP="$(od_override_from_replica)"
  if [ "${OD_AFTER_DROP}" != "40" ] || [ "${OD_AFTER_DROP_REP}" != "40" ]; then
    rm -f "${OD_DROP_LOG}"
    echo "[verify] FAIL: dropping the ceiling changed the live override (source='${OD_AFTER_DROP}' replica='${OD_AFTER_DROP_REP}'), expected both to stay 40 (AWS cannot clear it; cdkd must not try)"
    exit 1
  fi
  if ! grep -q "STILL IN EFFECT" "${OD_DROP_LOG}"; then
    rm -f "${OD_DROP_LOG}"
    echo "[verify] FAIL: dropping the ceiling did not emit the 'STILL IN EFFECT' warning — the user is not told the old override survives"
    exit 1
  fi
  rm -f "${OD_DROP_LOG}"
  echo "[verify] step 12e3 ok: dropped override left at 40 and cdkd warned STILL IN EFFECT"

  # Carry the replica declaration forward through every remaining deploy (see
  # the OD_MODE_SUFFIX comment above). `-dropped` is the right token: it keeps
  # the replica but declares no ceiling, which is exactly the state 12e3 just
  # established, so the remaining deploys produce NO further change to this
  # table rather than churning it.
  OD_MODE_SUFFIX=",cross-region-ondemand-dropped"

  # Let the replica operations settle before the run moves on. Without this the
  # table is still mutating when step 15 runs `cdkd destroy`, and DeleteTable
  # fails with `ResourceInUseException: The resource which you are attempting
  # to change is in use` -- observed 2026-08-11, which left the table AND its
  # eu-west-1 replica behind as orphans that needed a manual retry. A global
  # table reports ACTIVE at the table level while a replica is still UPDATING,
  # so both levels have to be checked.
  echo "[verify] step 12e4 (Issue #1512): wait for the on-demand table + replica to settle"
  OD_SETTLED=0
  for i in $(seq 1 60); do
    OD_TBL_STATUS="$(aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" \
      --region "${REGION}" --query 'Table.TableStatus' --output text)"
    OD_REP_STATUSES="$(aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" \
      --region "${REGION}" --query "join(' ', Table.Replicas[].ReplicaStatus || \`[]\`)" --output text)"
    # ACTIVE:ACTIVE only. An EMPTY replica list must NOT count as settled:
    # by this point the replica is guaranteed present, so "no replicas" can
    # only mean it was deleted — the exact failure OD_MODE_SUFFIX exists to
    # prevent, and accepting it here would mask it.
    case "${OD_TBL_STATUS}:${OD_REP_STATUSES}" in
      ACTIVE:ACTIVE)
        OD_SETTLED=1
        echo "[verify] step 12e4: settled after ~$((i * 10))s (table=${OD_TBL_STATUS} replicas=${OD_REP_STATUSES:-none})"
        break
        ;;
    esac
    sleep 10
  done
  if [ "${OD_SETTLED}" != "1" ]; then
    echo "[verify] FAIL: on-demand table did not settle (table='${OD_TBL_STATUS}' replicas='${OD_REP_STATUSES}') — destroy would hit ResourceInUseException"
    exit 1
  fi
  echo "[verify] step 12e4 ok: on-demand table + replica ACTIVE"
else
  echo "[verify] (skipping Item D — set CDKD_INTEG_MULTI_REGION=1 to opt into the cross-region scenario)"
fi

echo "[verify] step 12f (was steps 5/6): cdkd deploy with CDKD_TEST_UPDATE=ttl,tags (in-place update)"
# Moved from steps 5/6 to here (post-cross-region) to avoid AWS's
# "Time to live has been modified multiple times within a fixed
# interval" rate limit that fires on cross-region UpdateTable when
# UpdateTimeToLive was called within the same hour. Done LAST so
# the only TTL state changes are: enable here → implicit disable
# at step 13 cleared baseline.
CDKD_TEST_UPDATE=deletion-protection,autoscaling,ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 12g: assert TTL is now ENABLED and UpdateTest tag is present"
TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)"
if [ "${TTL_STATUS}" != "ENABLED" ] && [ "${TTL_STATUS}" != "ENABLING" ]; then
  echo "[verify] FAIL: TimeToLive on '${TABLE_NAME}' is '${TTL_STATUS}' after the UPDATE deploy (expected ENABLED / ENABLING)"
  exit 1
fi
echo "[verify] step 12g ok: TTL = ${TTL_STATUS}"

TABLE_ARN="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.TableArn' --output text)"
TAG_VALUE="$(aws dynamodb list-tags-of-resource --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query "Tags[?Key=='UpdateTest'].Value | [0]" --output text)"
if [ "${TAG_VALUE}" != "true" ]; then
  echo "[verify] FAIL: UpdateTest tag was not applied (got '${TAG_VALUE}')"
  exit 1
fi
echo "[verify] step 12g ok: UpdateTest tag present"

echo "[verify] step 13: cdkd deploy with CDKD_TEST_UPDATE=ttl,tags (structural teardown — flip deletion-protection back to false, flip BillingMode back to PAY_PER_REQUEST, tear down autoscaling)"
# KEEP ttl,tags ON in step 13. AWS's DynamoDB TTL rate limit allows
# a TTL attribute to be updated only once per 4 hours; toggling it
# off here right after step 12f's enable trips
# "Time to live has been modified multiple times within a fixed
# interval". TTL teardown is exercised at the unit-test level; the
# integ's structural teardown for deletion-protection / BillingMode /
# autoscaling is the value-add at this layer. Destroy at step 15
# cleans up the table regardless of TTL state.
CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 13b: cdkd deploy with drop-gsi-ondemand-limits (issue #1423 — REMOVING a per-GSI on-demand limit must RESET it, not no-op)"
CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# The reset reads back as ABSENCE, never as -1 (live-probed on #1423). Pre-fix
# the template removal emitted nothing at all, so the 60 write ceiling stayed
# live in AWS forever while cdkd reported success.
#
# Assert the index still EXISTS first: a `| [0]` query against a MISSING index
# also answers "None", so the absence check alone would pass if `byOwner` had
# vanished entirely.
OD_IDX="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query "length(Table.GlobalSecondaryIndexes[?IndexName=='byOwner'])" --output text)"
if [ "${OD_IDX}" != "1" ]; then
  echo "FAIL: byOwner index missing after the drop-limits update (count=${OD_IDX})" >&2
  exit 1
fi
# The DROPPED member must be gone...
OD_WRITE="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='byOwner'].OnDemandThroughput.MaxWriteRequestUnits | [0]" --output text)"
# ...while the one the template STILL declares must survive untouched.
OD_READ="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='byOwner'].OnDemandThroughput.MaxReadRequestUnits | [0]" --output text)"
if [ "${OD_WRITE}" != "None" ] || [ "${OD_READ}" != "50" ]; then
  echo "FAIL: issue #1423 — expected write=None (reset) / read=50 (kept), got write=${OD_WRITE} / read=${OD_READ}" >&2
  exit 1
fi
echo "    per-GSI write limit reset (absent) and read limit kept at 50, issue #1423 closed"

echo "[verify] step 13c: cdkd deploy with drop-table-ondemand-limit (issue #1434 — the TABLE-level sibling of #1423)"
# BEFORE/AFTER, not just after: step 13b dropped only the per-GSI limit, so the
# TABLE-level ceiling must still be live here. Asserting that first is what
# stops the post-drop absence check from passing vacuously (it would also read
# "None" if the ceiling had never reached AWS in the first place).
TBL_WRITE_BEFORE="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxWriteRequestUnits' --output text)"
if [ "${TBL_WRITE_BEFORE}" != "200" ]; then
  echo "FAIL: issue #1434 precondition — expected table-level write ceiling 200 before the drop, got ${TBL_WRITE_BEFORE}" >&2
  exit 1
fi

CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# Pre-fix the template removal emitted no UpdateTable at all, so the 200 write
# ceiling stayed live in AWS forever while cdkd reported success. The reset
# surfaces as ABSENCE, never as -1 (live-probed on #1434).
TBL_WRITE_AFTER="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxWriteRequestUnits' --output text)"
if [ "${TBL_WRITE_AFTER}" != "None" ]; then
  echo "FAIL: issue #1434 — expected the table-level write ceiling to reset to absent, got ${TBL_WRITE_AFTER}" >&2
  exit 1
fi
# The table-level READ ceiling is NOT touched by this deploy — the template
# still declares it — so it must survive the write-half reset untouched. That
# is the per-member half of #1434: a fix that branched on "the whole block
# disappeared" would have cleared both, and read / write are independent CDK
# props (`maxReadRequestUnits` / `maxWriteRequestUnits`).
TBL_READ_AFTER="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text)"
if [ "${TBL_READ_AFTER}" != "100" ]; then
  echo "FAIL: issue #1434 — the untouched table-level READ ceiling should still be 100, got ${TBL_READ_AFTER}" >&2
  exit 1
fi
echo "    table-level write ceiling reset (absent), read ceiling kept at 100, issue #1434 closed"

echo "[verify] step 13d: cdkd deploy with drop-table-ondemand-read-limit (issue #1436 — the READ half of the same pair)"
# The read ceiling lives on `Replicas[local].ReadOnDemandThroughputSettings`
# rather than at the top level, so it needed its own wiring on BOTH sides:
# step 4b proved it reaches AWS at all, and this proves removing it RESETS the
# live value instead of leaving the old ceiling in place forever.
CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit,drop-table-ondemand-read-limit${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

TBL_READ_DROPPED="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxReadRequestUnits' --output text)"
if [ "${TBL_READ_DROPPED}" != "None" ]; then
  echo "FAIL: issue #1436 — expected the table-level read ceiling to reset to absent, got ${TBL_READ_DROPPED}" >&2
  exit 1
fi
echo "    table-level read ceiling reset (absent), issue #1436 closed"

echo "[verify] step 13e: cdkd deploy with gsi-billing-flip (issue #1421 — PAY_PER_REQUEST -> PROVISIONED on a table WITH GSIs)"
# AWS requires per-index `ProvisionedThroughput` in the SAME `UpdateTable` call
# that changes `BillingMode`. That claim was asserted only against a mocked
# DynamoDB client: the two GSI fixtures above are never mutated, and the table
# the UPDATE flow does flip has no GSI. So if AWS rejected the combination, the
# unit suite stayed green and every such deploy failed in the field.
#
# The mode also DROPS one of the two indexes, covering the second unverified
# sub-path in the same phase: `flipDrop` is still live on AWS at flip time (its
# Delete is issued later), so it too must carry throughput in the flip call.
CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit,drop-table-ondemand-read-limit,gsi-billing-flip${OD_MODE_SUFFIX} ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

FLIP_BILLING_AFTER="$(aws dynamodb describe-table --table-name "${GSI_FLIP_TABLE}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${FLIP_BILLING_AFTER}" != "PROVISIONED" ]; then
  echo "FAIL: issue #1421 — expected PROVISIONED after the flip, got ${FLIP_BILLING_AFTER}" >&2
  exit 1
fi
# Sorted on both sides: AWS does not preserve submitted list order on readback.
# BOUNDED POLL, not a single read: the removed-GSI loop only waits for the
# TABLE to flip ACTIVE, and a table is ACTIVE while an index is still
# DELETING — so an immediate describe can transiently list flipDrop (the
# async-delete gone-probe convention, one level down).
FLIP_IDX_AFTER=""
for _ in $(seq 1 36); do
  FLIP_IDX_AFTER="$(aws dynamodb describe-table --table-name "${GSI_FLIP_TABLE}" --region "${REGION}" \
    --query "join(' ', sort(Table.GlobalSecondaryIndexes[].IndexName || \`[]\`))" --output text)"
  if [ "${FLIP_IDX_AFTER}" = "flipKeep" ]; then
    break
  fi
  sleep 5
done
if [ "${FLIP_IDX_AFTER}" != "flipKeep" ]; then
  echo "FAIL: issue #1421 — expected only 'flipKeep' to survive the flip (waited 180s), got '${FLIP_IDX_AFTER}'" >&2
  exit 1
fi
FLIP_KEEP_READ="$(gsi_field "${GSI_FLIP_TABLE}" flipKeep ProvisionedThroughput.ReadCapacityUnits)"
FLIP_KEEP_WRITE="$(gsi_field "${GSI_FLIP_TABLE}" flipKeep ProvisionedThroughput.WriteCapacityUnits)"
# Issue #1435: the flip is the ONE context AWS documents `SeedCapacity` for, so
# the surviving index must land on its seed (5), not its min (2). A regression
# to `MinCapacity` reads back 2 here.
if [ "${FLIP_KEEP_READ}" != "3" ] || [ "${FLIP_KEEP_WRITE}" != "5" ]; then
  echo "FAIL: issue #1421 — expected flipKeep read=3 / write=5 (SeedCapacity) after the flip, got read=${FLIP_KEEP_READ} / write=${FLIP_KEEP_WRITE}" >&2
  exit 1
fi
FLIP_TABLE_WRITE="$(aws dynamodb describe-table --table-name "${GSI_FLIP_TABLE}" --region "${REGION}" \
  --query 'Table.ProvisionedThroughput.WriteCapacityUnits' --output text)"
if [ "${FLIP_TABLE_WRITE}" != "6" ]; then
  echo "FAIL: issue #1421 — expected table-level write seed 6 after the flip, got ${FLIP_TABLE_WRITE}" >&2
  exit 1
fi
echo "    billing flip with GSIs succeeded, dropped index gone, seed capacities applied, issue #1421 closed"

echo "[verify] step 13f: cdkd deploy with unresolvable-capacity (issue #1511 — a DECLARED capacity that does not resolve must WARN, not silently deploy the 5/5 default)"
# The provider derives a provisioned capacity through `toFiniteNumber`, so a
# present-but-unparseable value (an unresolved intrinsic, `''`, an object)
# yields `undefined` and the translation falls through to cdkd's 5 default —
# a table the template explicitly sized deploys at 5, silently. The provider
# now emits a diagnostic naming the member and the substituted default; this
# step is what proves it against REAL AWS rather than against a mock.
#
# The fixture table declares an unparseable READ capacity (`Fn::Join` over the
# region pseudo-parameter -> `us-east-1-x`) and a VALID write capacity, so the
# assertion is discriminating in both directions: read must land on cdkd's 5,
# write on the template's 1.
UNRESOLVABLE_LOG="$(mktemp)"
CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit,drop-table-ondemand-read-limit,gsi-billing-flip,unresolvable-capacity${OD_MODE_SUFFIX} \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${UNRESOLVABLE_LOG}"

# ONE line-coupled grep, not three independent ones: `did not resolve to a
# number` is also emitted by the on-demand diagnostic and `ReadCapacityUnits`
# appears throughout a --verbose log, so three separate greps can all pass on
# sentences about other things. This ties the member, the block it lives in,
# and the substitution together.
if ! grep -q "Replicas\[local\].ReadProvisionedThroughputSettings.ReadCapacityUnits is declared but did not resolve to a number" "${UNRESOLVABLE_LOG}"; then
  echo "FAIL: issue #1511 — no unresolved-capacity diagnostic naming the table-level read member" >&2
  grep -i "did not resolve to a number" "${UNRESOLVABLE_LOG}" >&2 || echo "  (no such diagnostic at all)" >&2
  exit 1
fi
if ! grep -q "capacity units instead" "${UNRESOLVABLE_LOG}"; then
  echo "FAIL: issue #1511 — the diagnostic did not name the substituted default" >&2
  exit 1
fi
rm -f "${UNRESOLVABLE_LOG}"

# Re-read state: this table is created by THIS deploy, so step 3's name lookup
# ran before it existed.
UNRESOLVABLE_TABLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable" and logical_id.startswith("UnresolvableCapacityTable"):
        print(resource["physicalId"])
        break
')"
if [ -z "${UNRESOLVABLE_TABLE}" ]; then
  echo "FAIL: issue #1511 — no UnresolvableCapacityTable in cdkd state after the deploy" >&2
  exit 1
fi
UNRESOLVABLE_READ="$(aws dynamodb describe-table --table-name "${UNRESOLVABLE_TABLE}" --region "${REGION}" \
  --query 'Table.ProvisionedThroughput.ReadCapacityUnits' --output text)"
UNRESOLVABLE_WRITE="$(aws dynamodb describe-table --table-name "${UNRESOLVABLE_TABLE}" --region "${REGION}" \
  --query 'Table.ProvisionedThroughput.WriteCapacityUnits' --output text)"
if [ "${UNRESOLVABLE_READ}" != "5" ] || [ "${UNRESOLVABLE_WRITE}" != "1" ]; then
  echo "FAIL: issue #1511 — expected read=5 (cdkd default) / write=1 (template), got read=${UNRESOLVABLE_READ} / write=${UNRESOLVABLE_WRITE}" >&2
  exit 1
fi
echo "    unresolvable capacity warned and defaulted to 5 while the valid sibling kept 1, issue #1511 closed"

echo "[verify] step 13f2: cdkd deploy with stream-state-junk (issue #1653 — a SKIPPED StreamSpecification must record the PREVIOUS value, not the malformed one)"
# The warn-and-skip arm (issue #1551) leaves the live stream alone, so the
# deploy SUCCEEDS and the engine records a bag for a call that never ran.
# Pre-#1653 that bag was the DESIRED one, so state held the string
# `us-east-1-x` while AWS held a KEYS_ONLY stream: `readCurrentState` could
# never match it, every later `cdkd drift` re-reported the same difference,
# and `drift --revert` re-issued the same skipped call. None of that is
# reachable from a mocked client — the record has to be WRITTEN by a real
# deploy and READ BACK by a real read-side run, which is what this step and
# the next one do.
STREAM_MODES="ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit,drop-table-ondemand-read-limit,gsi-billing-flip,unresolvable-capacity${OD_MODE_SUFFIX}"

# Capture the live stream BEFORE the junk deploy. The ARN is the discriminating
# half: a re-pointed view type would also mint a NEW stream, so comparing the
# ARN catches a disable/re-enable that a view-type check alone would miss.
STREAM_ARN_BEFORE="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.LatestStreamArn' --output text)"
STREAM_VIEW_BEFORE="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamViewType' --output text)"
if [ "${STREAM_VIEW_BEFORE}" != "KEYS_ONLY" ]; then
  echo "FAIL: issue #1653 precondition — StreamRecoveryTable should start with a KEYS_ONLY stream, got '${STREAM_VIEW_BEFORE}'" >&2
  exit 1
fi

STREAM_JUNK_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${STREAM_MODES},stream-state-junk" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${STREAM_JUNK_LOG}"

# ONE line-coupled grep: the table name, the refused property and the skip
# decision in a single sentence. Three independent greps would each pass on
# sentences about other tables / other properties in a --verbose log.
if ! grep -q "GlobalTable StreamRecoveryTable: .*StreamSpecification must be an object" "${STREAM_JUNK_LOG}"; then
  echo "FAIL: issue #1653 — cdkd did not report the malformed desired StreamSpecification on StreamRecoveryTable" >&2
  grep -i "StreamSpecification" "${STREAM_JUNK_LOG}" >&2 || echo "  (no StreamSpecification diagnostic at all)" >&2
  exit 1
fi
if ! grep -q "stream configuration is left untouched for this update" "${STREAM_JUNK_LOG}"; then
  echo "FAIL: issue #1653 — the warning did not announce that the block was SKIPPED" >&2
  exit 1
fi
rm -f "${STREAM_JUNK_LOG}"

# What was RECORDED. This is the assertion the fix exists for: the PREVIOUS
# value, not the malformed desired string and not the NEW_AND_OLD_IMAGES
# default.
stream_spec_recorded() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("StreamRecoveryTable"):
        props = resource.get("properties", {})
        if "StreamSpecification" not in props:
            print("<absent>")
        else:
            print(json.dumps(props["StreamSpecification"], sort_keys=True))
        break
'
}
STREAM_RECORDED="$(stream_spec_recorded)"
if [ "${STREAM_RECORDED}" != '{"StreamViewType": "KEYS_ONLY"}' ]; then
  echo "FAIL: issue #1653 — state must record the PREVIOUS StreamSpecification, got ${STREAM_RECORDED}" >&2
  exit 1
fi

# The live stream must be UNTOUCHED — same view type AND the same stream.
STREAM_VIEW_AFTER="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamViewType' --output text)"
STREAM_ARN_AFTER="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.LatestStreamArn' --output text)"
if [ "${STREAM_VIEW_AFTER}" != "KEYS_ONLY" ] || [ "${STREAM_ARN_AFTER}" != "${STREAM_ARN_BEFORE}" ]; then
  echo "FAIL: issue #1653 — the skipped update must leave the live stream alone: view=${STREAM_VIEW_AFTER} (expected KEYS_ONLY), arn=${STREAM_ARN_AFTER} (expected ${STREAM_ARN_BEFORE})" >&2
  exit 1
fi
echo "    skipped StreamSpecification recorded as the PREVIOUS value, live stream untouched"

echo "[verify] step 13f2b: issue #1653 — the CORRECTED template is a NO-OP against the recorded value"
# The consequence half, and the one that actually discriminates.
#
# NOT a `cdkd drift` assertion, deliberately: `drift` prefers the
# `observedProperties` baseline (a live `readCurrentState` snapshot taken at the
# end of every successful deploy, auto-refreshed for records that lack one), so
# it compares AWS against AWS and reports this resource clean whether or not the
# recording is fixed. A drift-based check here would be a vacuous pass. The
# field the fix actually writes is `properties`, and `properties` is the
# PREVIOUS side of the next DEPLOY's diff — so that is what to inspect.
#
# Pre-fix, `properties.StreamSpecification` held the string `us-east-1-x`, so
# the corrected template read as a CHANGE on every later deploy and re-issued
# the same skipped call, warning each time. Post-fix the recorded previous IS
# the corrected template's value, so the diff is empty.
#
# `--json` rather than `--fail`: the exit code is stack-wide and this fixture is
# mid-sequence, so it must not be coupled to whatever else the stack is doing.
DIFF_JSON="$(mktemp)"
set +e
CDKD_TEST_UPDATE="${STREAM_MODES}" \
  ${CLI} diff "${STACK}" --state-bucket "${STATE_BUCKET}" --json > "${DIFF_JSON}" 2>/dev/null
DIFF_RC=$?
set -e
# A run that produced no parseable report is UNDETERMINED, not clean — the same
# tri-state rule `gone_probe` follows for destroy probes.
DIFF_VERDICT="$(python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception as exc:  # noqa: BLE001 - any parse failure is undetermined
    print("undetermined: %s" % exc)
    sys.exit(0)
if not isinstance(payload, list) or not payload:
    print("undetermined: empty diff payload")
    sys.exit(0)
for node in payload:
    for change in node.get("changes", []):
        if change.get("logicalId", "").startswith("StreamRecoveryTable"):
            print("changed: %s" % json.dumps(change))
            sys.exit(0)
print("no-change")
' "${DIFF_JSON}")"
rm -f "${DIFF_JSON}"
if [ "${DIFF_VERDICT}" != "no-change" ]; then
  echo "FAIL: issue #1653 — the corrected template must diff clean against the recorded PREVIOUS value: ${DIFF_VERDICT} (cdkd diff exit ${DIFF_RC})" >&2
  exit 1
fi
echo "    corrected template is a no-op against the recorded value, issue #1653 closed"

echo "[verify] step 13f3: issue #1653 review (A2) — a MALFORMED previous side must be DROPPED, not copied into state"
# The other direction of the same bug. `previousProperties` is a cdkd STATE
# record, so a table whose record was written by an older binary can carry junk
# on the PREVIOUS side too — and the first cut of the fix tested only for
# ABSENCE, so it copied that junk straight back into `effectiveProperties`.
# Only a hand-patched record can produce that shape now (which is the point:
# post-fix cdkd never writes one), so patch it directly, exactly the recipe
# issue #1654 spells out for the Lambda URL sibling.
STATE_PATCH="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
patched = False
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("StreamRecoveryTable"):
        resource.setdefault("properties", {})["StreamSpecification"] = ""
        patched = True
        break
if not patched:
    sys.stderr.write("no StreamRecoveryTable in state to patch\n")
    sys.exit(1)
json.dump(state, sys.stdout)
' > "${STATE_PATCH}"
aws s3 cp "${STATE_PATCH}" "s3://${STATE_BUCKET}/${STATE_KEY}"
rm -f "${STATE_PATCH}"

STREAM_JUNK2_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${STREAM_MODES},stream-state-junk" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${STREAM_JUNK2_LOG}"
if ! grep -q "GlobalTable StreamRecoveryTable: .*StreamSpecification must be an object" "${STREAM_JUNK2_LOG}"; then
  echo "FAIL: issue #1653 (A2) — the skip did not fire on the both-sides-malformed deploy" >&2
  exit 1
fi
rm -f "${STREAM_JUNK2_LOG}"

STREAM_RECORDED2="$(stream_spec_recorded)"
if [ "${STREAM_RECORDED2}" != "<absent>" ]; then
  echo "FAIL: issue #1653 (A2) — an unusable PREVIOUS value must be DROPPED, not recorded; state holds ${STREAM_RECORDED2}" >&2
  exit 1
fi
STREAM_VIEW_A2="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamViewType' --output text)"
STREAM_ARN_A2="$(aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}" \
  --query 'Table.LatestStreamArn' --output text)"
if [ "${STREAM_VIEW_A2}" != "KEYS_ONLY" ] || [ "${STREAM_ARN_A2}" != "${STREAM_ARN_BEFORE}" ]; then
  echo "FAIL: issue #1653 (A2) — the live stream must still be untouched: view=${STREAM_VIEW_A2}, arn=${STREAM_ARN_A2}" >&2
  exit 1
fi
echo "    both-sides-malformed dropped the key, live stream still untouched"

# RESTORE the record before continuing. With the key dropped, the next deploy
# whose template declares `{StreamViewType: KEYS_ONLY}` would see
# previous=absent -> desired=present and send an `UpdateTable` that ENABLES a
# stream which is already enabled. Whether DynamoDB accepts that re-enable is
# NOT verified (see the note in the PR); this fixture is here to prove the
# #1653 recording behavior, so it must not also bet the remaining ~10 steps and
# the destroy on an unverified AWS behavior. Restoring by hand keeps the blast
# radius of this sub-step to itself.
STATE_RESTORE="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("StreamRecoveryTable"):
        resource.setdefault("properties", {})["StreamSpecification"] = {"StreamViewType": "KEYS_ONLY"}
        break
json.dump(state, sys.stdout)
' > "${STATE_RESTORE}"
aws s3 cp "${STATE_RESTORE}" "s3://${STATE_BUCKET}/${STATE_KEY}"
rm -f "${STATE_RESTORE}"
STREAM_RESTORED="$(stream_spec_recorded)"
if [ "${STREAM_RESTORED}" != '{"StreamViewType": "KEYS_ONLY"}' ]; then
  echo "FAIL: issue #1653 (A2) — could not restore the StreamRecoveryTable record (got ${STREAM_RESTORED}); later steps would run against a patched record" >&2
  exit 1
fi
echo "    record restored to the pre-patch value"

echo "[verify] step 13g: cdkd deploy with gsi-state-junk (issue #1571 phase 1 — RECORD an unusable GlobalSecondaryIndexes into cdkd state)"
# The provider's warn path (issue #1551) records a malformed desired
# `GlobalSecondaryIndexes` as the new state, and the NEXT update then has no
# usable previous side. Nothing about that sequence is reachable from a mocked
# client: the junk record has to be WRITTEN by a real deploy and READ BACK by
# the next one, which is what these two steps do.
#
# The fixture renders `GlobalSecondaryIndexes` as an unfolded `Fn::Join` over
# the region pseudo-parameter, so cdkd resolves it at deploy time to the STRING
# `us-east-1-x` — present, and not an array.
GSI_RECOVERY_MODES="ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit,drop-table-ondemand-read-limit,gsi-billing-flip,unresolvable-capacity${OD_MODE_SUFFIX}"
JUNK_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${GSI_RECOVERY_MODES},gsi-state-junk" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${JUNK_LOG}"

if ! grep -q "GlobalTable GsiRecoveryTable: .*GlobalSecondaryIndexes must be an array" "${JUNK_LOG}"; then
  echo "FAIL: issue #1571 phase 1 — cdkd did not report the malformed desired GlobalSecondaryIndexes on GsiRecoveryTable" >&2
  exit 1
fi
# Issue #1585: the PROVISIONED sibling table goes through the same junk phase,
# so the autoscaled-exclusion recovery (step 13h) has a junk record to recover
# from. The warning is per-table — assert it fired for this table too.
if ! grep -q "GlobalTable GsiProvRecoveryTable: .*GlobalSecondaryIndexes must be an array" "${JUNK_LOG}"; then
  echo "FAIL: issue #1585 — cdkd did not report the malformed desired GlobalSecondaryIndexes on GsiProvRecoveryTable" >&2
  exit 1
fi
# The same deploy also hands that table a non-string BillingMode (issue #1683
# arm 1, update side). Fence the GUARD as well as its effect: without this, a
# BillingMode override that stopped producing an unusable value would leave the
# two assertions below passing for the wrong reason — state reads PROVISIONED
# and the table IS PROVISIONED because nothing ever tried to change either.
# Anchored on the guard's OWN wording, not on the bare property name: the
# #1552 baseline warning for an unusable RECORDED previous also names
# BillingMode on this table, so a loose pattern could pass on the wrong warning.
if ! grep -q "GlobalTable GsiProvRecoveryTable: .*is kept for this update" "${JUNK_LOG}"; then
  echo "FAIL: issue #1683 — cdkd did not report the malformed desired BillingMode on GsiProvRecoveryTable" >&2
  exit 1
fi
rm -f "${JUNK_LOG}"

GSI_RECOVERY_TABLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable" and logical_id.startswith("GsiRecoveryTable"):
        print(resource["physicalId"])
        break
')"
if [ -z "${GSI_RECOVERY_TABLE}" ]; then
  echo "FAIL: issue #1571 — no GsiRecoveryTable in cdkd state" >&2
  exit 1
fi
# Issue #1683: the provider no longer RECORDS the malformed desired block. The
# `desiredGsiUnusable` arm SKIPS the GSI diff, so AWS keeps the index set it
# already holds, and `effectiveProperties` now retains the PREVIOUS list — a
# record `readCurrentState` can match, instead of the junk one that produced
# permanent phantom drift and that the NEXT update then read as its previous
# side (the #1552 class).
#
# Assert that FIRST, because it is the live proof of the #1683 arm, and the
# phase-1 seeding below would otherwise mask it.
# Asserted per TABLE and by index-name MEMBERSHIP rather than by a glob over the
# serialized JSON: a glob is order-dependent, so a legitimate reorder of the
# retained list would report "must RETAIN the previous list" and accuse the fix.
# The state is staged through a temp FILE rather than piped into `python3 -`:
# with a `<<'PY'` heredoc the program itself arrives on stdin, so the pipe is
# overridden and `json.load(sys.stdin)` reads an already-drained stream (an
# empty-input JSONDecodeError, which is exactly how this assertion first failed).
assert_retained_previous_gsi() { # $1 = logical-id prefix
  local prefix="$1" verdict tmp
  tmp="$(mktemp)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - > "${tmp}" || { rm -f "${tmp}"; return 1; }
  verdict="$(python3 - "${tmp}" "${prefix}" <<'PY'
import json, sys
path, prefix = sys.argv[1], sys.argv[2]
with open(path) as fh:
    state = json.load(fh)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith(prefix):
        value = resource.get("properties", {}).get("GlobalSecondaryIndexes")
        if not isinstance(value, list):
            # A SENTINEL, not sys.exit: the caller runs under `set -e` inside a
            # command substitution, so exiting non-zero here aborts the script
            # before its `case` arm can print the diagnostic naming the issue.
            # This is the PRIMARY regression shape (state records the junk
            # string) and it must reach that message, not a bare abort.
            print(f"NOT-A-LIST {json.dumps(value)}")
        else:
            # FILTER before sorting: an entry without IndexName yields None,
            # and sorting a mixed str/None sequence raises TypeError, which
            # would surface as an empty verdict accusing the fix.
            names = sorted(
                entry["IndexName"]
                for entry in value
                if isinstance(entry, dict) and entry.get("IndexName")
            )
            print(" ".join(names))
        break
else:
    sys.exit(f"no {prefix} in cdkd state")
PY
)" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
  printf '%s' "${verdict}"
}

GSI_AFTER_JUNK="$(assert_retained_previous_gsi GsiRecoveryTable)"
case "${GSI_AFTER_JUNK}" in
  *recoverIdx*)
    echo "    issue #1683 ok: GsiRecoveryTable retained the PREVIOUS index list (${GSI_AFTER_JUNK})"
    ;;
  *)
    echo "FAIL: issue #1683 — a skipped GlobalSecondaryIndexes update must RETAIN the previous list, got '${GSI_AFTER_JUNK}'" >&2
    exit 1
    ;;
esac
PROV_AFTER_JUNK="$(assert_retained_previous_gsi GsiProvRecoveryTable)"
case "${PROV_AFTER_JUNK}" in
  *autoProvIdx*)
    echo "    issue #1683 ok: GsiProvRecoveryTable retained the PREVIOUS index list (${PROV_AFTER_JUNK})"
    ;;
  *)
    echo "FAIL: issue #1683 — GsiProvRecoveryTable must RETAIN the previous list, got '${PROV_AFTER_JUNK}'" >&2
    exit 1
    ;;
esac

# The SAME deploy also handed GsiProvRecoveryTable a non-string BillingMode
# (issue #1683 arm 1, update side). cdkd suppresses the flip and keeps the
# table PROVISIONED, so state must record PROVISIONED — recording the junk
# object is the phantom drift this closes, and it lands on the resource whose
# GSI answer was just asserted, which is what makes this the LIVE proof that
# the two arms compose.
read_state_billing_mode() { # $1 = logical-id prefix
  local prefix="$1" verdict tmp
  tmp="$(mktemp)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - > "${tmp}" || { rm -f "${tmp}"; return 1; }
  verdict="$(python3 - "${tmp}" "${prefix}" <<'PY'
import json, sys
path, prefix = sys.argv[1], sys.argv[2]
with open(path) as fh:
    state = json.load(fh)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith(prefix):
        print(json.dumps(resource.get("properties", {}).get("BillingMode")))
        break
else:
    sys.exit(f"no {prefix} in cdkd state")
PY
)" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
  printf '%s' "${verdict}"
}
BILLING_AFTER_JUNK="$(read_state_billing_mode GsiProvRecoveryTable)"
if [ "${BILLING_AFTER_JUNK}" != '"PROVISIONED"' ]; then
  echo "FAIL: issue #1683 — a suppressed BillingMode flip must record the PREVIOUS mode, got ${BILLING_AFTER_JUNK}" >&2
  exit 1
fi
echo "    issue #1683 ok: GsiProvRecoveryTable retained the PREVIOUS BillingMode (PROVISIONED)"
# The wire half: the table must still BE provisioned. Recording PROVISIONED
# while AWS was re-priced to on-demand would satisfy the state assertion alone.
# The physical id is read here rather than reusing GSI_PROV_RECOVERY_TABLE,
# which the #1585 phase below only defines later.
PROV_TABLE_FOR_BILLING="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("GsiProvRecoveryTable"):
        print(resource["physicalId"])
        break
')"
if [ -z "${PROV_TABLE_FOR_BILLING}" ]; then
  echo "FAIL: issue #1683 — no GsiProvRecoveryTable in cdkd state" >&2
  exit 1
fi
LIVE_BILLING_AFTER_JUNK="$(aws dynamodb describe-table \
  --table-name "${PROV_TABLE_FOR_BILLING}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${LIVE_BILLING_AFTER_JUNK}" = 'PAY_PER_REQUEST' ]; then
  echo "FAIL: issue #1683 — the unusable BillingMode must NOT flip the live table, got ${LIVE_BILLING_AFTER_JUNK}" >&2
  exit 1
fi
echo "    issue #1683 ok: live billing mode untouched (${LIVE_BILLING_AFTER_JUNK})"

# Issue #1738, kept-mode-PROVISIONED arm: the CAPACITY twin of that suppression.
# The SAME deploy raised this table's declared
# `WriteOnDemandThroughputSettings.MaxWriteRequestUnits` from 100 to 200, but
# the kept mode is PROVISIONED, so cdkd sends no on-demand ceiling at all — and
# state must therefore record the PREVIOUS 100. Recording 200 describes capacity
# AWS never received, which `readCurrentState` can never match and which the
# NEXT update reads as its previous side (the #1552 class).
read_state_table_max_write() { # $1 = logical-id prefix
  local prefix="$1" verdict tmp
  tmp="$(mktemp)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - > "${tmp}" || { rm -f "${tmp}"; return 1; }
  verdict="$(python3 - "${tmp}" "${prefix}" <<'PY'
import json, sys
path, prefix = sys.argv[1], sys.argv[2]
with open(path) as fh:
    state = json.load(fh)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith(prefix):
        block = resource.get("properties", {}).get("WriteOnDemandThroughputSettings")
        print(json.dumps(block.get("MaxWriteRequestUnits") if isinstance(block, dict) else block))
        break
else:
    sys.exit(f"no {prefix} in cdkd state")
PY
)" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
  printf '%s' "${verdict}"
}
PROV_CEILING_AFTER_JUNK="$(read_state_table_max_write GsiProvRecoveryTable)"
if [ "${PROV_CEILING_AFTER_JUNK}" != "100" ]; then
  echo "FAIL: issue #1738 — a suppressed flip must retain the PREVIOUS on-demand ceiling (100), got ${PROV_CEILING_AFTER_JUNK}" >&2
  exit 1
fi
# The WIRE half: a PROVISIONED table must carry no on-demand ceiling at all, so
# the retention is recording what AWS actually holds rather than papering over a
# call that DID go out.
LIVE_CEILING_AFTER_JUNK="$(aws dynamodb describe-table \
  --table-name "${PROV_TABLE_FOR_BILLING}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxWriteRequestUnits' --output text)"
case "${LIVE_CEILING_AFTER_JUNK}" in
  None|'')
    ;;
  *)
    echo "FAIL: issue #1738 — no on-demand ceiling may reach a PROVISIONED table, got ${LIVE_CEILING_AFTER_JUNK}" >&2
    exit 1
    ;;
esac
echo "    issue #1738 ok: kept-PROVISIONED retained the PREVIOUS on-demand ceiling (100), nothing sent"

# ...which means phase 1 can no longer let the provider WRITE the junk record
# that phases 2 (#1571) and 13h (#1585) recover from — today's binary cannot
# produce that shape any more. Seed it by hand instead, exactly as a pre-#1683
# binary wrote it: `properties.GlobalSecondaryIndexes` set to the deploy-time
# resolved STRING, `observedProperties` (the live read-back) left alone. The
# recovery machinery still matters because that population exists in the wild —
# every record an older binary wrote — so it stays covered here rather than
# being deleted along with the path that used to create it.
seed_junk_gsi_state() { # $1 = logical-id prefix
  local prefix="$1" tmp
  tmp="$(mktemp)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - > "${tmp}" || { rm -f "${tmp}"; return 1; }
  python3 - "${tmp}" "${prefix}" "${REGION}-x" <<'PY' || { rm -f "${tmp}"; return 1; }
import json, sys
path, prefix, junk = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    state = json.load(fh)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith(prefix):
        resource.setdefault("properties", {})["GlobalSecondaryIndexes"] = junk
        break
else:
    sys.exit(f"no {prefix} in cdkd state")
with open(path, "w") as fh:
    json.dump(state, fh)
PY
  aws s3 cp "${tmp}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
}
seed_junk_gsi_state GsiRecoveryTable
seed_junk_gsi_state GsiProvRecoveryTable

# The junk block must be RECORDED (that is what phase 2 recovers from) and the
# live index must be UNTOUCHED — the destructive reading of "the template
# declares no indexes" would have deleted it.
JUNK_RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("GsiRecoveryTable"):
        print(json.dumps(resource.get("properties", {}).get("GlobalSecondaryIndexes")))
        break
')"
case "${JUNK_RECORDED}" in
  \[*)
    echo "FAIL: issue #1571 phase 1 — state still records an ARRAY (${JUNK_RECORDED}); phase 2 would not exercise the recovery path" >&2
    exit 1
    ;;
esac
JUNK_READ="$(gsi_field "${GSI_RECOVERY_TABLE}" recoverIdx OnDemandThroughput.MaxReadRequestUnits)"
JUNK_WRITE="$(gsi_field "${GSI_RECOVERY_TABLE}" recoverIdx OnDemandThroughput.MaxWriteRequestUnits)"
if [ "${JUNK_READ}" != "40" ] || [ "${JUNK_WRITE}" != "50" ]; then
  echo "FAIL: issue #1571 phase 1 — the malformed block must leave the live index untouched, got read=${JUNK_READ} / write=${JUNK_WRITE} (expected 40 / 50)" >&2
  exit 1
fi
echo "    junk GlobalSecondaryIndexes recorded (${JUNK_RECORDED}), live index untouched"

# Issue #1585 preconditions. Assert liveOnlyIdx is LIVE at this point — the
# step-13h "it survived" assertion is vacuous if the index never existed — and
# that the PROVISIONED sibling's junk record + live autoscaled index are in
# place for the exclusion sequence.
LIVEONLY_STATUS="$(gsi_field "${GSI_RECOVERY_TABLE}" liveOnlyIdx IndexStatus)"
if [ "${LIVEONLY_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: issue #1585 — liveOnlyIdx must be ACTIVE before the recovery phase, got '${LIVEONLY_STATUS}'" >&2
  exit 1
fi
GSI_PROV_RECOVERY_TABLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable" and logical_id.startswith("GsiProvRecoveryTable"):
        print(resource["physicalId"])
        break
')"
if [ -z "${GSI_PROV_RECOVERY_TABLE}" ]; then
  echo "FAIL: issue #1585 — no GsiProvRecoveryTable in cdkd state" >&2
  exit 1
fi
PROV_JUNK_RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("GsiProvRecoveryTable"):
        print(json.dumps(resource.get("properties", {}).get("GlobalSecondaryIndexes")))
        break
')"
case "${PROV_JUNK_RECORDED}" in
  \[*)
    echo "FAIL: issue #1585 — GsiProvRecoveryTable state still records an ARRAY (${PROV_JUNK_RECORDED}); step 13h would not exercise the recovery path" >&2
    exit 1
    ;;
esac
echo "    liveOnlyIdx ACTIVE, GsiProvRecoveryTable junk recorded (${PROV_JUNK_RECORDED})"

echo "[verify] step 13g2: out-of-band capacity raise on the autoscaled index (issue #1585)"
# Raise the autoscaled GSI's capacity ABOVE the template's MinCapacity (1) so
# the recovery deploy has something to destructively scale DOWN if the
# autoscaled exclusion is broken. This is the out-of-band write Application
# Auto Scaling would normally perform; an explicit UpdateTable is deterministic
# where waiting for AAS is not.
aws dynamodb update-table \
  --table-name "${GSI_PROV_RECOVERY_TABLE}" \
  --global-secondary-index-updates \
  '[{"Update":{"IndexName":"autoProvIdx","ProvisionedThroughput":{"ReadCapacityUnits":7,"WriteCapacityUnits":7}}}]' \
  --region "${REGION}" >/dev/null
RAISED=0
for i in $(seq 1 60); do
  RAISED_STATUS="$(gsi_field "${GSI_PROV_RECOVERY_TABLE}" autoProvIdx IndexStatus)"
  RAISED_READ="$(gsi_field "${GSI_PROV_RECOVERY_TABLE}" autoProvIdx ProvisionedThroughput.ReadCapacityUnits)"
  RAISED_WRITE="$(gsi_field "${GSI_PROV_RECOVERY_TABLE}" autoProvIdx ProvisionedThroughput.WriteCapacityUnits)"
  if [ "${RAISED_STATUS}" = "ACTIVE" ] && [ "${RAISED_READ}" = "7" ] && [ "${RAISED_WRITE}" = "7" ]; then
    RAISED=1
    echo "    autoProvIdx raised to 7/7 and ACTIVE after ~$((i * 10))s"
    break
  fi
  sleep 10
done
if [ "${RAISED}" != "1" ]; then
  echo "FAIL: issue #1585 — autoProvIdx did not reach 7/7 ACTIVE after the out-of-band raise (status=${RAISED_STATUS}, read=${RAISED_READ}, write=${RAISED_WRITE})" >&2
  exit 1
fi

echo "[verify] step 13h: cdkd deploy with gsi-state-recovery (issue #1571 phase 2 — the corrected template must apply VALUES, not just ADDs)"
# PR #1562 recovered by taking the live index NAMES only, so every carried
# entry was a byte-copy of its desired counterpart and the diff could produce
# nothing but ADDs. This phase changes one ceiling and DROPS the other, which
# is exactly what that baseline could not express:
#   - MaxReadRequestUnits 40 -> 90 (a value edit)
#   - MaxWriteRequestUnits 50 -> dropped (the #1160 reset, derived from the
#     PREVIOUS side, which a desired-copy baseline never carried)
# Pre-fix both read back unchanged at 40 / 50.
RECOVERY_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${GSI_RECOVERY_MODES},gsi-state-recovery" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${RECOVERY_LOG}"

if ! grep -q "GlobalTable GsiRecoveryTable: .*using the table's LIVE indexes as the comparison baseline" "${RECOVERY_LOG}"; then
  echo "FAIL: issue #1571 phase 2 — the recovery path did not run on GsiRecoveryTable (no LIVE-baseline warning)" >&2
  exit 1
fi
# Issue #1585 (live-only / removes path): the recovery template dropped
# liveOnlyIdx, and the provider must warn — naming the index — rather than
# issue an irreversible Delete while the state record is junk.
if ! grep -q "GlobalTable GsiRecoveryTable: liveOnlyIdx exist(s) on the table but not in the template" "${RECOVERY_LOG}"; then
  echo "FAIL: issue #1585 — the live-only warning did not fire (or did not name liveOnlyIdx)" >&2
  grep "exist(s) on the" "${RECOVERY_LOG}" >&2 || echo "  (no live-only warning at all)" >&2
  exit 1
fi
# Issue #1585 (autoscaled exclusion): the PROVISIONED sibling also went through
# the recovery path this deploy.
if ! grep -q "GlobalTable GsiProvRecoveryTable: .*using the table's LIVE indexes as the comparison baseline" "${RECOVERY_LOG}"; then
  echo "FAIL: issue #1585 — the recovery path did not run on GsiProvRecoveryTable (no LIVE-baseline warning)" >&2
  exit 1
fi
rm -f "${RECOVERY_LOG}"

RECOVERED_READ="$(gsi_field "${GSI_RECOVERY_TABLE}" recoverIdx OnDemandThroughput.MaxReadRequestUnits)"
RECOVERED_WRITE="$(gsi_field "${GSI_RECOVERY_TABLE}" recoverIdx OnDemandThroughput.MaxWriteRequestUnits)"
if [ "${RECOVERED_READ}" != "90" ]; then
  echo "FAIL: issue #1571 phase 2 — expected the read ceiling edit to apply on the recovery deploy (90), got ${RECOVERED_READ}" >&2
  exit 1
fi
# A cleared on-demand ceiling reads back as ABSENCE, never as -1 (issue #1423).
case "${RECOVERED_WRITE}" in
  None|'')
    ;;
  *)
    echo "FAIL: issue #1571 phase 2 — expected the dropped write ceiling to be RESET (absent), got ${RECOVERED_WRITE}" >&2
    exit 1
    ;;
esac
echo "    recovery deploy applied the value edit (read=90) and the removal (write cleared), issue #1571 closed"

echo "[verify] step 13i: issue #1585 — liveOnlyIdx survived, autoscaled capacity untouched"
# The live-only index must SURVIVE the recovery deploy (no Delete issued).
LIVEONLY_AFTER="$(gsi_field "${GSI_RECOVERY_TABLE}" liveOnlyIdx IndexStatus)"
case "${LIVEONLY_AFTER}" in
  ACTIVE|UPDATING)
    ;;
  *)
    echo "FAIL: issue #1585 — liveOnlyIdx did not survive the recovery deploy (status='${LIVEONLY_AFTER}')" >&2
    exit 1
    ;;
esac
# The autoscaled index's out-of-band capacity must be UNCHANGED: the exclusion
# keeps its baseline entry identity-only, so the recovery deploy must not
# scale the live 7/7 down to the desired side's derived 2/1.
EXCL_READ="$(gsi_field "${GSI_PROV_RECOVERY_TABLE}" autoProvIdx ProvisionedThroughput.ReadCapacityUnits)"
EXCL_WRITE="$(gsi_field "${GSI_PROV_RECOVERY_TABLE}" autoProvIdx ProvisionedThroughput.WriteCapacityUnits)"
if [ "${EXCL_READ}" != "7" ] || [ "${EXCL_WRITE}" != "7" ]; then
  echo "FAIL: issue #1585 — the recovery deploy touched the autoscaled index's capacity: read=${EXCL_READ} / write=${EXCL_WRITE} (expected 7/7 — an unrequested scale-down is the destructive failure mode the exclusion exists to prevent)" >&2
  exit 1
fi
echo "    liveOnlyIdx survived (${LIVEONLY_AFTER}), autoProvIdx capacity unchanged at 7/7 — issue #1585 covered"

# ─── Issues #1733 / #1738 on BillingSeedTable ───────────────────────────────
#
# Placed LAST among the deploys on purpose: both steps below drive the table's
# billing mode, and every later template would have to carry their tokens or
# flip it back (the mode-gated-resource rule). Nothing but `destroy` follows.
#
# Both deploys carry the full accumulated mode list plus one new token, so every
# OTHER table's template is byte-identical to step 13h's and these steps cannot
# perturb the sequence above.
BILLING_SEED_TABLE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::DynamoDB::GlobalTable" and logical_id.startswith("BillingSeedTable"):
        print(resource["physicalId"])
        break
')"
if [ -z "${BILLING_SEED_TABLE}" ]; then
  echo "FAIL: issue #1733 — no BillingSeedTable in cdkd state" >&2
  exit 1
fi

# MEASUREMENT for issue #1733's open question (a): what DescribeTable reports
# for a table cdkd created with an EXPLICIT BillingMode. Logged rather than
# asserted — the code is correct under either answer (a missing summary is
# INFERRED as PROVISIONED, which is what such a table is), so failing here would
# constrain the fix beyond what it claims.
SEED_SUMMARY_BEFORE="$(aws dynamodb describe-table --table-name "${BILLING_SEED_TABLE}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
echo "[measure] issue #1733 (a): explicit-PROVISIONED create reports BillingModeSummary='${SEED_SUMMARY_BEFORE}'"

echo "[verify] step 13j: issue #1733 — an ABSENT recorded BillingMode consults AWS"
# The record shape #1733's step 1 names (a `cdkd import` of a PROVISIONED table,
# or this provider's own DROP arm) cannot be produced by a deploy — cdkd's
# `create()` always sends an explicit mode — so the key is removed by hand,
# exactly as the StreamRecoveryTable phase above patches its record.
SEED_PATCH="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith("BillingSeedTable"):
        resource.get("properties", {}).pop("BillingMode", None)
        break
json.dump(state, sys.stdout)
' > "${SEED_PATCH}"
aws s3 cp "${SEED_PATCH}" "s3://${STATE_BUCKET}/${STATE_KEY}"
rm -f "${SEED_PATCH}"
SEED_RECORDED="$(read_state_billing_mode BillingSeedTable)"
if [ "${SEED_RECORDED}" != "null" ]; then
  echo "FAIL: issue #1733 — could not remove BillingMode from the BillingSeedTable record (got ${SEED_RECORDED})" >&2
  exit 1
fi

SEED_FLIP_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${GSI_RECOVERY_MODES},gsi-state-recovery,billing-seed-flip" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${SEED_FLIP_LOG}"

# The announcement, anchored on its OWN wording — the #1552 unusable-previous
# warning also names BillingMode, so a loose pattern could pass on the wrong one.
if ! grep -q "GlobalTable BillingSeedTable: the cdkd state record declares no BillingMode" "${SEED_FLIP_LOG}"; then
  echo "FAIL: issue #1733 — the absent-previous seed did not announce itself" >&2
  exit 1
fi
rm -f "${SEED_FLIP_LOG}"

# The WIRE half, and the whole point: pre-fix the absent record resolved to the
# create-path default PAY_PER_REQUEST, compared EQUAL to this template, issued
# no UpdateTable, and the table stayed PROVISIONED forever.
SEED_LIVE_AFTER_FLIP="$(aws dynamodb describe-table --table-name "${BILLING_SEED_TABLE}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${SEED_LIVE_AFTER_FLIP}" != "PAY_PER_REQUEST" ]; then
  echo "FAIL: issue #1733 — the corrected template's flip was not applied; live mode is ${SEED_LIVE_AFTER_FLIP}" >&2
  exit 1
fi
echo "    issue #1733 ok: an absent recorded mode resolved from AWS and the flip applied"

echo "[verify] step 13k: issue #1738 — kept-PAY_PER_REQUEST retains the previous provisioned capacity"
# The mirror of the kept-PROVISIONED arm asserted at step 13g. The table is now
# PAY_PER_REQUEST, the template hands it an unusable BillingMode (so the mode is
# KEPT) and raises the replica's declared ReadCapacityUnits 3 -> 9. Under
# PAY_PER_REQUEST `toSdkReplicaThroughputOverrides` drops the provisioned branch
# entirely, so nothing is sent and state must record the PREVIOUS 3.
SEED_UNUSABLE_LOG="$(mktemp)"
CDKD_TEST_UPDATE="${GSI_RECOVERY_MODES},gsi-state-recovery,billing-seed-unusable" \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${SEED_UNUSABLE_LOG}"

if ! grep -q "GlobalTable BillingSeedTable: .*is kept for this update" "${SEED_UNUSABLE_LOG}"; then
  echo "FAIL: issue #1738 — the BillingMode guard did not suppress the flip on BillingSeedTable" >&2
  exit 1
fi
rm -f "${SEED_UNUSABLE_LOG}"

read_state_replica_read_capacity() { # $1 = logical-id prefix
  local prefix="$1" verdict tmp
  tmp="$(mktemp)" || return 1
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - > "${tmp}" || { rm -f "${tmp}"; return 1; }
  verdict="$(python3 - "${tmp}" "${prefix}" <<'PY'
import json, sys
path, prefix = sys.argv[1], sys.argv[2]
with open(path) as fh:
    state = json.load(fh)
for logical_id, resource in state.get("resources", {}).items():
    if logical_id.startswith(prefix):
        replicas = resource.get("properties", {}).get("Replicas")
        entry = replicas[0] if isinstance(replicas, list) and replicas else {}
        block = entry.get("ReadProvisionedThroughputSettings") if isinstance(entry, dict) else None
        print(json.dumps(block.get("ReadCapacityUnits") if isinstance(block, dict) else block))
        break
else:
    sys.exit(f"no {prefix} in cdkd state")
PY
)" || { rm -f "${tmp}"; return 1; }
  rm -f "${tmp}"
  printf '%s' "${verdict}"
}
SEED_CAPACITY_AFTER="$(read_state_replica_read_capacity BillingSeedTable)"
if [ "${SEED_CAPACITY_AFTER}" != "3" ]; then
  echo "FAIL: issue #1738 — a suppressed flip must retain the PREVIOUS replica read capacity (3), got ${SEED_CAPACITY_AFTER}" >&2
  exit 1
fi
# The mode itself is retained too (the recorded previous is present and usable).
SEED_BILLING_AFTER="$(read_state_billing_mode BillingSeedTable)"
if [ "${SEED_BILLING_AFTER}" != '"PAY_PER_REQUEST"' ]; then
  echo "FAIL: issue #1738 — the kept mode must be recorded, got ${SEED_BILLING_AFTER}" >&2
  exit 1
fi
# The WIRE half: the table must still be on-demand, and carry no provisioned
# capacity. Recording 3 while AWS was re-provisioned would satisfy the state
# assertion alone.
SEED_LIVE_FINAL="$(aws dynamodb describe-table --table-name "${BILLING_SEED_TABLE}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${SEED_LIVE_FINAL}" != "PAY_PER_REQUEST" ]; then
  echo "FAIL: issue #1738 — the unusable BillingMode must not re-price the live table, got ${SEED_LIVE_FINAL}" >&2
  exit 1
fi
echo "    issue #1738 ok: kept-PAY_PER_REQUEST retained the PREVIOUS provisioned capacity (3), nothing sent"

echo "[verify] step 14a: assert DeletionProtectionEnabled flipped back to false on AWS"
DP_FINAL="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.DeletionProtectionEnabled' --output text)"
# AWS may return "None" / "False" / "false" / "" depending on the
# CLI's text-encoder; accept any non-true response.
case "${DP_FINAL}" in
  True|true)
    echo "[verify] FAIL: DeletionProtectionEnabled is '${DP_FINAL}' on '${TABLE_NAME}' after the cleared UPDATE deploy (expected false / absent)"
    exit 1
    ;;
esac
echo "[verify] step 14a ok: DeletionProtectionEnabled = ${DP_FINAL} (flipped back)"

echo "[verify] step 14b: assert BillingMode flipped back to PAY_PER_REQUEST"
BILLING_FINAL="$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.BillingModeSummary.BillingMode' --output text)"
if [ "${BILLING_FINAL}" != "PAY_PER_REQUEST" ]; then
  echo "[verify] FAIL: BillingMode is '${BILLING_FINAL}' after the cleared UPDATE deploy (expected PAY_PER_REQUEST)"
  exit 1
fi
echo "[verify] step 14b ok: BillingMode = ${BILLING_FINAL}"

echo "[verify] step 14c: assert auto-scaling policy is gone after the cleared deploy"
WRITE_POLICY_AFTER="$(aws application-autoscaling describe-scaling-policies \
  --service-namespace dynamodb \
  --resource-id "table/${TABLE_NAME}" \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --region "${REGION}" \
  --query 'length(ScalingPolicies[?PolicyType==`TargetTrackingScaling`])' \
  --output text)"
if [ "${WRITE_POLICY_AFTER}" != "0" ]; then
  echo "[verify] FAIL: write autoscaling policy still present after cleared deploy (count=${WRITE_POLICY_AFTER}, expected 0)"
  exit 1
fi
echo "[verify] step 14c ok: write autoscaling policy torn down"

echo "[verify] step 14d (Issue #1830): assert the delete-retry preconditions hold"
# Both halves have to be true for step 15's driver to reproduce the race, and
# a silent miss on either would make step 15b's failure look like a broken fix.
#
# (a) Every index on the table is ACTIVE right now. If one were already
#     transitioning, `delete()`'s PRE-DELETE describe would see it and the
#     #1521 gate would wait it out — which is the arm that passes with the
#     #1830 fix REVERTED, i.e. exactly the vacuous shape to avoid.
# (b) The table-level WRITE scalable target exists, because its deregistration
#     debug line is the driver's signal. Without it the driver never fires and
#     the arm is inert.
DELETE_RETRY_BUSY="$(aws dynamodb describe-table --table-name "${GSI_DELETE_RETRY_TABLE}" --region "${REGION}" \
  --query "length(Table.GlobalSecondaryIndexes[?IndexStatus!='ACTIVE'] || \`[]\`)" --output text)"
if [ "${DELETE_RETRY_BUSY}" != "0" ]; then
  echo "FAIL: issue #1830 precondition — ${GSI_DELETE_RETRY_TABLE} has ${DELETE_RETRY_BUSY} non-ACTIVE index(es) before destroy; the #1521 gate would absorb the race and the arm would not discriminate" >&2
  exit 1
fi
DELETE_RETRY_SIGNAL_TARGETS="$(aws application-autoscaling describe-scalable-targets \
  --service-namespace dynamodb \
  --resource-ids "table/${GSI_DELETE_RETRY_TABLE}" \
  --scalable-dimension dynamodb:table:WriteCapacityUnits \
  --region "${REGION}" \
  --query 'length(ScalableTargets)' --output text)"
if [ "${DELETE_RETRY_SIGNAL_TARGETS}" != "1" ]; then
  echo "FAIL: issue #1830 precondition — expected exactly 1 table-level write scalable target on ${GSI_DELETE_RETRY_TABLE} (the driver's signal), got ${DELETE_RETRY_SIGNAL_TARGETS}" >&2
  exit 1
fi
echo "[verify] step 14d ok: all indexes ACTIVE and the signal target is registered"

echo "[verify] step 15: cdkd destroy --remove-protection --force --verbose (with the issue #1830 race driver)"
# `--remove-protection` is defense-in-depth: step 14 should have flipped
# the table back to unprotected, but a partial / re-run of the test
# could leave the table protected; the flag ensures cdkd handles the
# residual state without requiring operator intervention.
#
# `--verbose` and the tee are what step 15b reads: the auto-scaling
# deregistration line the driver keys on, AWS's own index-busy refusal, and
# the retry line that proves cdkd ABSORBED it are all debug-level.
DESTROY_LOG="$(mktemp)"
DELETE_RETRY_MARKER="$(mktemp)"
delete_retry_race_driver "${DESTROY_LOG}" "${GSI_DELETE_RETRY_TABLE}" "${DELETE_RETRY_MARKER}" &
DELETE_RETRY_DRIVER_PID=$!
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --remove-protection --force --verbose 2>&1 | tee "${DESTROY_LOG}"
# Kill rather than plain-wait: a driver still looping here is one whose signal
# never appeared, and waiting out its full timeout would only delay the step
# 15b failure that already reports exactly that.
kill "${DELETE_RETRY_DRIVER_PID}" 2>/dev/null || true
wait "${DELETE_RETRY_DRIVER_PID}" 2>/dev/null || true
DELETE_RETRY_DRIVER_PID=""

echo "[verify] step 15b (Issue #1830): assert the destroy ABSORBED an index-busy DeleteTable refusal"
# Discrimination, spelled out because it is the whole point of the arm:
#   - with the fix REVERTED the refusal below is a hard `ProvisioningError`,
#     `cdkd destroy` exits non-zero with `PartialFailureError`, and `set -o
#     pipefail` aborts this script at step 15 — the run cannot reach here;
#   - with the fix present the destroy exits 0 AND both strings below are in
#     the log. Requiring the refusal text is what stops the arm passing
#     vacuously on a run where the driver never landed in the window.
DELETE_RETRY_OUTCOME="$(cat "${DELETE_RETRY_MARKER}" 2>/dev/null || true)"
rm -f "${DELETE_RETRY_MARKER}"
# Each outcome has a DIFFERENT cause and therefore a different remedy; one
# shared sentence sent every one of them to "widen the teardown window", which
# only addresses the last.
case "${DELETE_RETRY_OUTCOME}" in
  fired) ;;
  update-rejected*)
    echo "FAIL: issue #1830 — the race driver fired inside the window but AWS REFUSED its own out-of-band UpdateTable, so no index ever entered a transitional state and the retry path was never reached. AWS said: ${DELETE_RETRY_OUTCOME#update-rejected: }" >&2
    echo "       If that text says the table is already being deleted or does not exist, the driver fired too LATE in the auto-scaling teardown window: GsiDeleteRetryTable needs more indexes to widen it. Anything else (throttle, index/attribute limit, permissions) is a refusal of the driver's own call and is what to fix." >&2
    exit 1
    ;;
  signal-timeout)
    echo "FAIL: issue #1830 — the race driver polled the destroy log for its full budget and never saw the deregistration line it keys on, so it never fired. Check that the destroy still logs 'Deregistered auto-scaling target table/${GSI_DELETE_RETRY_TABLE} (dynamodb:table:WriteCapacityUnits)' at debug level and that step 15 still passes --verbose; a renamed or re-ordered log line silences this driver." >&2
    exit 1
    ;;
  '')
    echo "FAIL: issue #1830 — the race driver recorded no outcome at all, i.e. the destroy finished (and the driver was killed) before its signal line appeared. Same diagnosis as signal-timeout: the log line the driver keys on, or --verbose, is what to check first." >&2
    exit 1
    ;;
  *)
    echo "FAIL: issue #1830 — the race driver wrote an outcome this step does not know: '${DELETE_RETRY_OUTCOME}'. Add a branch for it here rather than widening the 'fired' test." >&2
    exit 1
    ;;
esac
if ! grep -qF "Cannot delete table while indexes are being" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1830 — the out-of-band UpdateTable landed but AWS never refused the DeleteTable, so the retry path was not exercised. Re-run; if it repeats, the driver is firing too late in the auto-scaling teardown window." >&2
  exit 1
fi
if ! grep -qF "Retrying GsiDeleteRetryTable" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1830 — AWS refused the DeleteTable but cdkd logged no retry for GsiDeleteRetryTable; the delete did not go through withRetry" >&2
  exit 1
fi
if grep -qF "Failed to delete GsiDeleteRetryTable" "${DESTROY_LOG}"; then
  echo "FAIL: issue #1830 — the retry did not recover: destroy reported a failure for GsiDeleteRetryTable" >&2
  exit 1
fi
rm -f "${DESTROY_LOG}"
echo "[verify] step 15b ok: AWS refused the DeleteTable mid-teardown and cdkd retried it to success"

echo "[verify] step 16a: assert tables are gone on AWS"
assert_gone "table '${TABLE_NAME}' still exists after destroy" aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"
assert_gone "table '${GSI_PROV_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_PROV_TABLE}" --region "${REGION}"
assert_gone "table '${GSI_OD_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}"
assert_gone "table '${OD_REPLICA_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" --region "${REGION}"
assert_gone "table '${GSI_RECOVERY_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_RECOVERY_TABLE}" --region "${REGION}"
assert_gone "table '${GSI_PROV_RECOVERY_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_PROV_RECOVERY_TABLE}" --region "${REGION}"
assert_gone "table '${STREAM_RECOVERY_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${STREAM_RECOVERY_TABLE}" --region "${REGION}"
assert_gone "table '${WARM_COERCION_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${WARM_COERCION_TABLE}" --region "${REGION}"
assert_gone "table '${GSI_DELETE_RETRY_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_DELETE_RETRY_TABLE}" --region "${REGION}"
echo "[verify] step 16a ok: all nine tables deleted"

# Issue #1512: the on-demand replica table is the one whose eu-west-1 replica
# is never removed by an update — teardown relies entirely on `cdkd destroy`
# deleting the GlobalTable as ONE resource, all replicas together. If that
# claim is wrong the replica survives in eu-west-1 as a silent cross-region
# orphan that a same-region-only sweep would never see, so assert it here.
# The replica's regional copy can linger in DELETING for a few minutes after
# the source is gone, so poll rather than probe once.
if [ "${CDKD_INTEG_MULTI_REGION:-0}" = "1" ]; then
  echo "[verify] step 16a3 (Issue #1512): assert the eu-west-1 replica of the on-demand table is gone"
  OD_EU_GONE=0
  for i in $(seq 1 60); do
    OD_EU_ERR="$(aws dynamodb describe-table --table-name "${OD_REPLICA_TABLE}" --region eu-west-1 2>&1 >/dev/null || true)"
    if [ -z "${OD_EU_ERR}" ]; then
      sleep 10
      continue
    fi
    case "${OD_EU_ERR}" in
      *ResourceNotFoundException*|*"Requested resource not found"*)
        OD_EU_GONE=1
        echo "[verify] step 16a3: eu-west-1 copy gone after ~$((i * 10))s"
        break
        ;;
      *)
        echo "[verify] step 16a3: transient error from eu-west-1 DescribeTable, retrying: ${OD_EU_ERR}"
        sleep 10
        ;;
    esac
  done
  if [ "${OD_EU_GONE}" != "1" ]; then
    echo "[verify] FAIL: eu-west-1 copy of '${OD_REPLICA_TABLE}' still exists after destroy — cross-region orphan"
    exit 1
  fi
  echo "[verify] step 16a3 ok: no cross-region orphan left behind"
fi

echo "[verify] step 16a2 (Issue #1419): assert the per-INDEX scalable target did not survive destroy"
# application-autoscaling is a SEPARATE control plane: DeleteTable does not
# remove a registered target. An orphan `table/<t>/index/<i>` target is
# silently inherited by a future table of the same name, so delete() has to
# deregister the index dimensions the way it already did the table ones.
assert_target_gone() { # $1 = resource id, $2 = scalable dimension
  local remaining
  remaining="$(aws application-autoscaling describe-scalable-targets \
    --service-namespace dynamodb \
    --resource-ids "$1" \
    --scalable-dimension "$2" \
    --region "${REGION}" \
    --query 'length(ScalableTargets)' --output text)" || return 1
  if [ "${remaining}" != "0" ]; then
    echo "[verify] FAIL (issue #1419): scalable target $1 ($2) survived destroy (count=${remaining}, expected 0)" >&2
    exit 1
  fi
  echo "[verify] step 16a2 ok: $2 on $1 deregistered"
}
# BOTH index dimensions, and the local table read dimension this change is
# what first registers. A teardown that covers only the write half leaks the
# other three onto whatever table next takes this name.
assert_target_gone "table/${GSI_PROV_TABLE}/index/byStatus" dynamodb:index:WriteCapacityUnits
assert_target_gone "table/${GSI_PROV_TABLE}/index/byStatus" dynamodb:index:ReadCapacityUnits
assert_target_gone "table/${TABLE_NAME}" dynamodb:table:ReadCapacityUnits
assert_target_gone "table/${TABLE_NAME}" dynamodb:table:WriteCapacityUnits
# Issue #1585: the autoscaled-exclusion table registers write dimensions at
# both the table and index level (read sides are fixed, never registered).
assert_target_gone "table/${GSI_PROV_RECOVERY_TABLE}" dynamodb:table:WriteCapacityUnits
assert_target_gone "table/${GSI_PROV_RECOVERY_TABLE}/index/autoProvIdx" dynamodb:index:WriteCapacityUnits
# Issue #1830: the delete-retry table registers a table-level write target (the
# driver's signal) plus one per index. Both the FIRST and the LAST index are
# asserted because the driver's out-of-band `UpdateTable` lands in the MIDDLE
# of the teardown loop: the table-level write deregistration it keys on is
# emitted first, and all 48 per-index calls (12 indexes x 2 dimensions x 2
# calls) follow it. Asserting only the first index would pass on a run where
# the concurrent `UpdateTable` aborted the tail of the loop.
#
# Note this is NOT about the retry re-running the teardown — the loop sits
# outside `withRetry`, whose closure re-runs only the index-settle wait and the
# `DeleteTable`, so a retry never re-enters it. The loop runs exactly once,
# ahead of every delete attempt.
assert_target_gone "table/${GSI_DELETE_RETRY_TABLE}" dynamodb:table:WriteCapacityUnits
assert_target_gone "table/${GSI_DELETE_RETRY_TABLE}/index/busyIdx0" dynamodb:index:WriteCapacityUnits
assert_target_gone "table/${GSI_DELETE_RETRY_TABLE}/index/busyIdx11" dynamodb:index:WriteCapacityUnits

echo "[verify] step 16b: assert cdkd state is empty"
assert_gone "cdkd state file still exists at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "[verify] step 16b ok: cdkd state cleared"

trap - EXIT INT TERM
echo "[verify] PASS"
