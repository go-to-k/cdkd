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
#       PROVISIONED table's GSI carries ProvisionedThroughput 7/3 and the
#       on-demand table's GSI carries OnDemandThroughput 50/60. Pre-fix the
#       first table could not be created at all and the second silently lost
#       its per-index limits.
#   5. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection
#   8. assert DeletionProtectionEnabled is now true on AWS
#   9. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection,billing-provisioned
#       (Issue #402 Item C — BillingMode round-trip)
#  10. assert BillingMode is now PROVISIONED on AWS
#  11. cdkd deploy with CDKD_TEST_UPDATE=deletion-protection,autoscaling
#       (Issue #402 Item B — table-level write + per-replica read autoscaling)
#  12. assert RegisterScalableTarget + PutScalingPolicy reached AWS via
#       application-autoscaling describe-scaling-policies
#  12b-e: optional cross-region (CDKD_INTEG_MULTI_REGION=1, see below).
#  12f. cdkd deploy with CDKD_TEST_UPDATE=...,ttl,tags (TTL toggle MUST be
#       LAST among structural changes — AWS's "Time to live has been
#       modified multiple times within a fixed interval" rate limit fires
#       when an UpdateTable structural change happens within ~1 hour after
#       a UpdateTimeToLive call. Deferring TTL to the end keeps the only
#       TTL state changes to enable-here → disable-at-step-13.)
#  12g. assert TTL is now ENABLED and the UpdateTest tag is present
#  13. cdkd deploy with CDKD_TEST_UPDATE= (cleared, baseline)
#  14. assert DeletionProtectionEnabled is now false (or absent) on AWS,
#       BillingMode flipped back to PAY_PER_REQUEST, AND the scaling
#       policy is gone (DeleteScalingPolicy + DeregisterScalableTarget)
#  15. cdkd destroy --remove-protection --force (works regardless of
#       the last DeletionProtectionEnabled state)
#  16. assert the AWS-side table is gone and cdkd state is empty
#
# Wall-clock budget: ~7-10 min (each deploy + describe pair is ~30-60s;
# autoscaling apply adds ~5-10s per direction).
#
# Opt-in cross-region scenario (Issue #402 Item D):
#   Set CDKD_INTEG_MULTI_REGION=1 to enable the cross-region replica
#   round-trip. Adds ~15-25 min (replica provisioning is 5-10 min per
#   region and per direction) and ~$0.10-0.20 in cross-region replication.
#   The default `bash verify.sh` invocation does NOT run this — it stays
#   under 8 min as before. Runs BEFORE the TTL toggle so the
#   cross-region UpdateTable is not blocked by AWS's TTL rate limit.
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

cleanup() {
  rc=$?
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
GSI_PROV_TABLE="$(table_name_for GsiProvisionedTable)"
GSI_OD_TABLE="$(table_name_for GsiOnDemandTable)"
if [ -z "${TABLE_NAME}" ]; then
  echo "[verify] FAIL: no HistoryTable AWS::DynamoDB::GlobalTable resource in cdkd state"
  exit 1
fi
if [ -z "${GSI_PROV_TABLE}" ] || [ -z "${GSI_OD_TABLE}" ]; then
  echo "[verify] FAIL: Issue #1387 GSI fixture tables missing from cdkd state (prov='${GSI_PROV_TABLE}' on-demand='${GSI_OD_TABLE}')"
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
#   byStatus.ProvisionedThroughput.WriteCapacityUnits = 3  <- GSI.WriteProvisionedThroughputSettings...SeedCapacity
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
assert_gsi_field "${GSI_PROV_TABLE}" byStatus ProvisionedThroughput.WriteCapacityUnits 3
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
echo "[verify] step 4b ok: table-level throughput preserved on both GSI fixtures"

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
CDKD_TEST_UPDATE=deletion-protection,autoscaling,ttl,tags ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

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
CDKD_TEST_UPDATE=ttl,tags ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

echo "[verify] step 13b: cdkd deploy with drop-gsi-ondemand-limits (issue #1423 — REMOVING a per-GSI on-demand limit must RESET it, not no-op)"
CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

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

CDKD_TEST_UPDATE=ttl,tags,drop-gsi-ondemand-limits,drop-table-ondemand-limit ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# Pre-fix the template removal emitted no UpdateTable at all, so the 200 write
# ceiling stayed live in AWS forever while cdkd reported success. The reset
# surfaces as ABSENCE, never as -1 (live-probed on #1434).
TBL_WRITE_AFTER="$(aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}" \
  --query 'Table.OnDemandThroughput.MaxWriteRequestUnits' --output text)"
if [ "${TBL_WRITE_AFTER}" != "None" ]; then
  echo "FAIL: issue #1434 — expected the table-level write ceiling to reset to absent, got ${TBL_WRITE_AFTER}" >&2
  exit 1
fi
# Deliberately NOT asserted: the table-level READ ceiling. The canonical
# `Billing.onDemand({maxReadRequestUnits})` is never wired by cdkd at all
# (issue #1436), so pinning it here would encode that gap as expected behavior.
echo "    table-level write ceiling reset (absent), issue #1434 closed"

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

echo "[verify] step 15: cdkd destroy --remove-protection --force"
# `--remove-protection` is defense-in-depth: step 14 should have flipped
# the table back to unprotected, but a partial / re-run of the test
# could leave the table protected; the flag ensures cdkd handles the
# residual state without requiring operator intervention.
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --remove-protection --force

echo "[verify] step 16a: assert tables are gone on AWS"
assert_gone "table '${TABLE_NAME}' still exists after destroy" aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"
assert_gone "table '${GSI_PROV_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_PROV_TABLE}" --region "${REGION}"
assert_gone "table '${GSI_OD_TABLE}' still exists after destroy" aws dynamodb describe-table --table-name "${GSI_OD_TABLE}" --region "${REGION}"
echo "[verify] step 16a ok: all three tables deleted"

echo "[verify] step 16b: assert cdkd state is empty"
assert_gone "cdkd state file still exists at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "[verify] step 16b ok: cdkd state cleared"

trap - EXIT INT TERM
echo "[verify] PASS"
