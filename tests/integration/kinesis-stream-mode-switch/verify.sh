#!/usr/bin/env bash
# verify.sh — cdkd Kinesis StreamMode-switch integ.
#
# Regression coverage for the bug where switching a Kinesis stream's StreamMode
# (PROVISIONED <-> ON_DEMAND) on redeploy was silently dropped: cdkd's
# kinesis-provider.update() had no UpdateStreamMode call, so the deploy reported
# success while AWS kept the old mode, and the next diff saw no change (state
# recorded the new mode), so it could never self-heal. CloudFormation / `cdk
# deploy` apply this in place via UpdateStreamMode. The fix wires UpdateStreamMode
# into update() and reconciles the shard count against the live open-shard count
# on the ON_DEMAND -> PROVISIONED direction.
#
# Phases:
#   1. Deploy a PROVISIONED (1 shard) stream. Assert AWS reports PROVISIONED.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (ON_DEMAND). Assert AWS now reports
#      ON_DEMAND (the switch actually reached AWS, not just cdkd state).
#   2c. Re-deploy with CDKD_TEST_REMOVAL=true: the second stream's
#      RecordDistributionStrategy (created AUTO) is removed and must reset to
#      USER_PARTITION_KEY; the first stream keeps AUTO (go-to-k/cdkd#2762).
#      The first stream also drops MaxRecordSizeInKiB (4096) and must reset
#      to 1024 (go-to-k/cdkd#1160).
#   2d. Raise the second stream's retention to 48h under a 2s per-type
#      deadline, with --no-rollback: the deploy fails mid-update and the record must name
#      RetentionPeriodHours unsettled; once ACTIVE at 48h, a redeploy of the
#      24h template must decrease it and clear the name (go-to-k/cdkd#5487).
#   2e. The same cut-short raise WITHOUT --no-rollback (go-to-k/cdkd#5505):
#      the automatic rollback waits for the stream to leave UPDATING and
#      reverts it, so right after the failed deploy returns retention reads 24h
#      and the record names nothing unsettled, with no further deploy.
#   3. Destroy + assert both streams are gone and the cdkd state file is removed.
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

STACK="CdkdKinesisStreamModeSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# AWS rate-limits StreamMode switches per stream NAME (a few per rolling 24h
# window), so each run uses a unique name to stay repeatable. Both phases of a
# single run share this one name (it must be stable WITHIN a run); the stack
# reads it via CDKD_KINESIS_STREAM_NAME.
STREAM_NAME="cdkd-kinesis-mode-switch-$(date +%s)"
export CDKD_KINESIS_STREAM_NAME="${STREAM_NAME}"
# go-to-k/cdkd#2762: the stack's second, always-ON_DEMAND stream.
STRATEGY_STREAM_NAME="${STREAM_NAME}-rds"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Phase 2e's auto-rolled-back deploy (go-to-k/cdkd#5505); removed by cleanup().
P2E_LOG="${TMPDIR:-/tmp}/cdkd-5505-kinesis-rollback.$$.log"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${P2E_LOG}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --enforce-consumer-deletion \
    --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${STRATEGY_STREAM_NAME}" --enforce-consumer-deletion \
    --region "${REGION}" >/dev/null 2>&1 || true
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

stream_mode() {
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamModeDetails.StreamMode' --output text
}

# Issue #609 backfill readbacks. The metric list is SORTED on both sides: AWS
# returns enhanced-monitoring metrics in an arbitrary order (measured: neither
# request order nor alphabetical), so a raw join would be flaky and its failure
# would accuse the fix.
shard_level_metrics() {
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query "join(' ', sort(StreamDescriptionSummary.EnhancedMonitoring[0].ShardLevelMetrics || \`[]\`))" \
    --output text
}
# go-to-k/cdkd#2762: `RecordDistributionStrategy`, reported for ON_DEMAND
# streams only.
distribution_strategy() { # usage: distribution_strategy <stream name>
  aws kinesis describe-stream-summary --stream-name "$1" --region "${REGION}" \
    --query 'StreamDescriptionSummary.RecordDistributionStrategy' --output text
}
max_record_size() {
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.MaxRecordSizeInKiB' --output text
}
assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}

# The seven names AWS expands `ALL` into, space-joined in SORTED order.
ALL_METRICS_SORTED="IncomingBytes IncomingRecords IteratorAgeMilliseconds OutgoingBytes OutgoingRecords ReadProvisionedThroughputExceeded WriteProvisionedThroughputExceeded"

# --- Phase 1: deploy baseline (PROVISIONED) ---------------------------
echo "==> Phase 1: deploy PROVISIONED stream (1 shard)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P1="$(stream_mode)"
echo "    AWS stream mode (Phase 1): ${MODE_P1}"
if [ "${MODE_P1}" != "PROVISIONED" ]; then
  echo "FAIL: expected PROVISIONED after Phase 1, got '${MODE_P1}'" >&2
  exit 1
fi
echo "    stream is PROVISIONED"

# Issue #609: the two backfilled properties must be live on AWS after CREATE.
# Asserting the baseline here is what stops the Phase 2 assertions from passing
# vacuously — a value that never reached AWS at all would otherwise look like a
# successful "change" the moment Phase 2 happens to match.
METRICS_P1="$(shard_level_metrics)"
echo "    AWS shard-level metrics (Phase 1): ${METRICS_P1}"
assert_eq "DesiredShardLevelMetrics after Phase 1 (create path)" \
  "IncomingBytes OutgoingBytes" "${METRICS_P1}"

SIZE_P1="$(max_record_size)"
echo "    AWS MaxRecordSizeInKiB (Phase 1): ${SIZE_P1}"
assert_eq "MaxRecordSizeInKiB after Phase 1 (create path)" "2048" "${SIZE_P1}"
echo "    create-path DesiredShardLevelMetrics + MaxRecordSizeInKiB reached AWS"

# go-to-k/cdkd#2762 create path: AUTO rides on CreateStream. The AWS default is
# USER_PARTITION_KEY, so AUTO cannot be satisfied by cdkd sending nothing.
RDS_CREATE="$(distribution_strategy "${STRATEGY_STREAM_NAME}")"
echo "    AWS RecordDistributionStrategy on ${STRATEGY_STREAM_NAME} (Phase 1): ${RDS_CREATE}"
assert_eq "RecordDistributionStrategy after Phase 1 (create path)" "AUTO" "${RDS_CREATE}"

# --- Phase 2: switch to ON_DEMAND (must actually reach AWS) ------------
echo "==> Phase 2: re-deploy as ON_DEMAND (StreamMode switch via UpdateStreamMode)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P2="$(stream_mode)"
echo "    AWS stream mode (Phase 2): ${MODE_P2}"
if [ "${MODE_P2}" != "ON_DEMAND" ]; then
  echo "FAIL: expected ON_DEMAND after Phase 2 (StreamMode switch silently dropped?), got '${MODE_P2}'" >&2
  exit 1
fi
echo "    stream switched to ON_DEMAND (reached AWS, not just cdkd state)"

# Issue #609 update path. `ALL` is the interesting case: AWS expands it to seven
# names and never stores the literal, so this asserts the EXPANDED set.
METRICS_P2="$(shard_level_metrics)"
echo "    AWS shard-level metrics (Phase 2): ${METRICS_P2}"
assert_eq "DesiredShardLevelMetrics after Phase 2 (ALL must expand to seven)" \
  "${ALL_METRICS_SORTED}" "${METRICS_P2}"

SIZE_P2="$(max_record_size)"
echo "    AWS MaxRecordSizeInKiB (Phase 2): ${SIZE_P2}"
assert_eq "MaxRecordSizeInKiB after Phase 2 (UpdateMaxRecordSize)" "4096" "${SIZE_P2}"
echo "    update-path DesiredShardLevelMetrics + MaxRecordSizeInKiB reached AWS"

# go-to-k/cdkd#2762 update path: AUTO arrives with the switch to ON_DEMAND, so
# UpdateStreamRecordDistributionStrategy must follow UpdateStreamMode.
RDS_UPDATE="$(distribution_strategy "${STREAM_NAME}")"
echo "    AWS RecordDistributionStrategy on ${STREAM_NAME} (Phase 2): ${RDS_UPDATE}"
assert_eq "RecordDistributionStrategy after Phase 2 (update path)" "AUTO" "${RDS_UPDATE}"

# `effectiveProperties`: cdkd must RECORD the expanded list, not the literal
# `ALL` the template declared — a state record AWS's readback can never match
# is exactly the permanent phantom drift this mechanism exists to prevent.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
# Selected by physical id: the stack holds a second stream (go-to-k/cdkd#2762)
# that declares no metrics, and `first` over both read whichever came first.
RECORDED_METRICS="$(printf '%s' "${STATE_JSON}" \
  | jq -r --arg n "${STREAM_NAME}" '[.resources[] | select(.resourceType == "AWS::Kinesis::Stream" and .physicalId == $n)
            | .properties.DesiredShardLevelMetrics // []] | if length == 1 then first | sort | join(" ") else "NO-UNIQUE-RECORD-FOR-\($n)" end')"
echo "    cdkd state DesiredShardLevelMetrics: ${RECORDED_METRICS}"
if printf '%s' "${RECORDED_METRICS}" | grep -qw "ALL"; then
  echo "FAIL: cdkd state recorded the literal 'ALL' — AWS stores the expanded seven, so this is permanent phantom drift (effectiveProperties not applied?)" >&2
  exit 1
fi
assert_eq "state-recorded DesiredShardLevelMetrics (effectiveProperties)" \
  "${ALL_METRICS_SORTED}" "${RECORDED_METRICS}"
echo "    state records the EXPANDED metric list (effectiveProperties applied)"

# Routing guard (issue #609 per-PR rule): the assertions above only prove the
# properties reached AWS, not WHICH layer put them there. A silent flip to the
# Cloud Control route would still satisfy them while leaving the SDK provider's
# wiring — the thing this PR adds — completely unexercised.
PROVISIONED_BY="$(printf '%s' "${STATE_JSON}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Kinesis::Stream")
            | .provisionedBy // "sdk"] | join(" ")')"
# Two streams; both must be on the SDK route (#2762's RecordDistributionStrategy
# used to auto-route a stream declaring it to Cloud Control).
assert_eq "AWS::Kinesis::Stream routing layer (both streams)" "sdk sdk" "${PROVISIONED_BY}"
echo "    both streams were provisioned by the SDK provider (provisionedBy=sdk)"

# `canonicalizeDesiredProperties`: the paired half. With only the recording
# half, the template still says `ALL` while state holds seven names, so the very
# next diff reports a change the user never made. A clean diff here is what
# proves the two halves narrow identically.
echo "==> Phase 2b: cdkd diff must be clean (ALL vs expanded seven is NOT a change)"
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
printf '%s\n' "${DIFF_OUT}" | sed 's/^/    | /'
# POSITIVE control first. A bare `grep -q DesiredShardLevelMetrics` negative is
# satisfied by a diff that printed nothing at all (a crash, a wrong stack name,
# an empty template), so it would pass for entirely the wrong reason. Requiring
# the explicit no-changes line makes the negative below meaningful.
if ! printf '%s' "${DIFF_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: cdkd diff did not report 'No changes detected' for ${STACK} — the cleanliness check below would pass vacuously" >&2
  exit 1
fi
# Only cdkd's own diff body: synth runs first and aws-cdk-lib's template
# validation prints a `WARNING RecordDistributionStrategy: ...` line of its own,
# which names the property without any change behind it.
DIFF_BODY="$(printf '%s\n' "${DIFF_OUT}" | sed -n '/Calculating diff for stack:/,$p')"
if [ -z "${DIFF_BODY}" ]; then
  echo "FAIL: cdkd diff printed no 'Calculating diff for stack:' line — the property checks below would read nothing" >&2
  exit 1
fi
for PROP in DesiredShardLevelMetrics MaxRecordSizeInKiB RecordDistributionStrategy; do
  if printf '%s' "${DIFF_BODY}" | grep -q "${PROP}"; then
    echo "FAIL: cdkd diff reports a ${PROP} change on an untouched stream — the desired and wire-path narrowing disagree" >&2
    exit 1
  fi
done
echo "    diff reports no changes; neither backfilled property appears (both sides narrowed identically)"

# --- Phase 2c: remove RecordDistributionStrategy (go-to-k/cdkd#2762) ----
# The second stream drops its AUTO; CloudFormation resets a removed strategy to
# USER_PARTITION_KEY (CFn A/B), so cdkd must send that reset. The first stream
# keeps declaring AUTO and must keep it (the retained sibling).
echo "==> Phase 2c: re-deploy with CDKD_TEST_REMOVAL=true (strategy removed from ${STRATEGY_STREAM_NAME}, MaxRecordSizeInKiB from ${STREAM_NAME})"
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RDS_REMOVED="$(distribution_strategy "${STRATEGY_STREAM_NAME}")"
echo "    AWS RecordDistributionStrategy on ${STRATEGY_STREAM_NAME} (Phase 2c): ${RDS_REMOVED}"
assert_eq "RecordDistributionStrategy after its removal (reset to the default)" \
  "USER_PARTITION_KEY" "${RDS_REMOVED}"
RDS_KEPT="$(distribution_strategy "${STREAM_NAME}")"
echo "    AWS RecordDistributionStrategy on ${STREAM_NAME} (Phase 2c): ${RDS_KEPT}"
assert_eq "RecordDistributionStrategy on the retained sibling" "AUTO" "${RDS_KEPT}"
echo "    removal reset the strategy; the sibling kept AUTO"

# go-to-k/cdkd#1160: the first stream dropped MaxRecordSizeInKiB (4096 in
# Phase 2, asserted above), and CloudFormation resets a removed size to 1024
# (CFn A/B), so cdkd must send UpdateMaxRecordSize(1024).
SIZE_REMOVED="$(max_record_size)"
echo "    AWS MaxRecordSizeInKiB on ${STREAM_NAME} (Phase 2c): ${SIZE_REMOVED}"
assert_eq "MaxRecordSizeInKiB after its removal (reset to the default, go-to-k/cdkd#1160)" \
  "1024" "${SIZE_REMOVED}"
echo "    removal reset MaxRecordSizeInKiB to 1024"

# --- Phase 2d: a retention change the deadline cut short (go-to-k/cdkd#5487)
# IncreaseStreamRetentionPeriod puts the stream in UPDATING; a 2s per-type
# deadline fails the update after that call. Before the fix the record kept 24,
# so the redeploy of the 24h template below diffed empty and the stream stayed
# at 48. Now the record names RetentionPeriodHours unsettled, and the redeploy
# compares it with the live period and decreases it.
retention_of() { # usage: retention_of <stream name>
  aws kinesis describe-stream-summary --stream-name "$1" --region "${REGION}" \
    --query 'StreamDescriptionSummary.RetentionPeriodHours' --output text
}
status_of() { # usage: status_of <stream name>
  aws kinesis describe-stream-summary --stream-name "$1" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text
}
unsettled_of() { # usage: unsettled_of <stream name> -- the record's unsettledProperties, comma-joined
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r --arg name "$1" '[.resources[]
        | select(.resourceType == "AWS::Kinesis::Stream" and .physicalId == $name)
        | (.unsettledProperties // [])[]] | join(",")'
}
assert_eq "retention on ${STRATEGY_STREAM_NAME} before Phase 2d" "24" "$(retention_of "${STRATEGY_STREAM_NAME}")"
echo "==> Phase 2d: raise retention on ${STRATEGY_STREAM_NAME} to 48h under a 2s Kinesis deadline (must fail mid-update)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_RETENTION=48 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback \
  --resource-warn-after AWS::Kinesis::Stream=1s \
  --resource-timeout AWS::Kinesis::Stream=2s
P2D_EXIT=$?
set -e
if [ "${P2D_EXIT}" -eq 0 ]; then
  echo "FAIL: Phase 2d's deploy succeeded; the 2s deadline must cut the UPDATING transition short (premise of the arm)" >&2
  exit 1
fi
assert_eq "${STRATEGY_STREAM_NAME} record's unsettledProperties after the cut-short deploy (go-to-k/cdkd#5487)" \
  "RetentionPeriodHours" "$(unsettled_of "${STRATEGY_STREAM_NAME}")"
P2D_STATUS=""
for _ in $(seq 1 60); do
  P2D_STATUS="$(status_of "${STRATEGY_STREAM_NAME}")"
  [ "${P2D_STATUS}" = "ACTIVE" ] && break
  sleep 2
done
assert_eq "${STRATEGY_STREAM_NAME} status once the cut-short increase finished" "ACTIVE" "${P2D_STATUS}"
assert_eq "retention on ${STRATEGY_STREAM_NAME} once the increase finished" "48" "$(retention_of "${STRATEGY_STREAM_NAME}")"
echo "==> Phase 2d: redeploy the 24h template (the record's own value)"
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_eq "retention on ${STRATEGY_STREAM_NAME} after redeploying the recorded template (go-to-k/cdkd#5487: the redeploy diffed empty and left 48h)" \
  "24" "$(retention_of "${STRATEGY_STREAM_NAME}")"
assert_eq "${STRATEGY_STREAM_NAME} record's unsettledProperties after the converging deploy" \
  "" "$(unsettled_of "${STRATEGY_STREAM_NAME}")"
echo "    the unsettled retention converged on redeploy (go-to-k/cdkd#5487)"

# --- Phase 2e: the automatic rollback reverts the cut-short raise (go-to-k/cdkd#5505)
# Phase 2d's raise again, WITHOUT --no-rollback. The rollback waits for the
# deadline-abandoned call and for the stream to leave UPDATING, then puts the
# retention back to 24h, as CloudFormation rolls a failed update back. Before
# the fix the stream stayed at 48h and the record kept the name (Phase 2d's
# --no-rollback run still asserts that path). CDKD_NO_WAIT / CDKD_FULL_WAIT
# are dropped: a no-wait revert would return mid-UPDATING.
assert_eq "retention on ${STRATEGY_STREAM_NAME} before Phase 2e" "24" "$(retention_of "${STRATEGY_STREAM_NAME}")"
echo "==> Phase 2e: raise retention on ${STRATEGY_STREAM_NAME} to 48h under a 2s Kinesis deadline, with the automatic rollback"
set +e
env -u CDKD_NO_WAIT -u CDKD_FULL_WAIT \
  CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true CDKD_TEST_RETENTION=48 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --resource-warn-after AWS::Kinesis::Stream=1s \
  --resource-timeout AWS::Kinesis::Stream=2s >"${P2E_LOG}" 2>&1
P2E_EXIT=$?
set -e
cat "${P2E_LOG}"
if [ "${P2E_EXIT}" -eq 0 ]; then
  echo "FAIL: Phase 2e's deploy succeeded; the 2s deadline must cut the UPDATING transition short (premise of the arm)" >&2
  exit 1
fi
# AWS first, the moment the deploy returned: the subject of the arm.
assert_eq "retention on ${STRATEGY_STREAM_NAME} right after the auto-rolled-back deploy (go-to-k/cdkd#5505: the rollback must revert the cut-short raise)" \
  "24" "$(retention_of "${STRATEGY_STREAM_NAME}")"
# The record checks read "nothing unsettled" off an empty result, so first
# prove the state file was read and holds exactly one record for the stream.
P2E_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
P2E_RECORDS="$(jq -r --arg name "${STRATEGY_STREAM_NAME}" '[.resources[]
    | select(.resourceType == "AWS::Kinesis::Stream" and .physicalId == $name)] | length' <<<"${P2E_STATE}")"
assert_eq "${STRATEGY_STREAM_NAME} records in the state after the automatic rollback" "1" "${P2E_RECORDS}"
P2E_UNSETTLED="$(jq -r --arg name "${STRATEGY_STREAM_NAME}" '[.resources[]
    | select(.resourceType == "AWS::Kinesis::Stream" and .physicalId == $name)
    | (.unsettledProperties // [])[]] | join(",")' <<<"${P2E_STATE}")"
assert_eq "${STRATEGY_STREAM_NAME} record's unsettledProperties after the automatic rollback reverted them (go-to-k/cdkd#5505)" "" "${P2E_UNSETTLED}"
P2E_ITEMS="$(jq -r --arg name "${STRATEGY_STREAM_NAME}" '[.resources[]
    | select(.resourceType == "AWS::Kinesis::Stream" and .physicalId == $name)
    | has("unsettledItems")] | any' <<<"${P2E_STATE}")"
assert_eq "${STRATEGY_STREAM_NAME} record carries unsettledItems after the automatic rollback" "false" "${P2E_ITEMS}"
# Premise: the revert is cdkd's. Either line of the arm: the call the
# deadline abandoned may complete once ACTIVE ("... whose call completed after
# the deploy gave up on it, to its pre-deploy properties"), else the line
# names what it left unsettled. The shared tail is the sentinel.
if ! grep -qE 'Rollback: reverting (what )?the failed UPDATE of .*to its pre-deploy properties' "${P2E_LOG}"; then
  if grep -q 'to its pre-deploy properties' "${P2E_LOG}"; then
    echo "FAIL: the rollback's revert line changed wording; update this arm's needle (go-to-k/cdkd#5505)" >&2
  else
    echo "FAIL: the automatic rollback logged no revert of the cut-short retention raise (go-to-k/cdkd#5505)" >&2
  fi
  exit 1
fi
echo "    the automatic rollback reverted the cut-short raise: 24h and the name cleared right after the failed deploy (go-to-k/cdkd#5505)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# No polling: DeleteStream is async (the stream sits in DELETING for a few
# seconds), but cdkd's delete() returns only once the stream is gone (issue
# #3872), so it must already be gone when destroy returns.
assert_gone "stream ${STREAM_NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}"
assert_gone "stream ${STRATEGY_STREAM_NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${STRATEGY_STREAM_NAME}" --region "${REGION}"
echo "    streams deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Kinesis StreamMode switch (PROVISIONED -> ON_DEMAND) reaches AWS, all 3 phases passed"
