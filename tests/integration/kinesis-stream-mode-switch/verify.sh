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
#   3. Destroy + assert the stream is gone and the cdkd state file is removed.
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

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws kinesis delete-stream --stream-name "${STREAM_NAME}" --enforce-consumer-deletion \
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

# `effectiveProperties`: cdkd must RECORD the expanded list, not the literal
# `ALL` the template declared — a state record AWS's readback can never match
# is exactly the permanent phantom drift this mechanism exists to prevent.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
RECORDED_METRICS="$(printf '%s' "${STATE_JSON}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Kinesis::Stream")
            | .properties.DesiredShardLevelMetrics // []] | first | sort | join(" ")')"
echo "    cdkd state DesiredShardLevelMetrics: ${RECORDED_METRICS}"
if printf '%s' "${RECORDED_METRICS}" | grep -qw "ALL"; then
  echo "FAIL: cdkd state recorded the literal 'ALL' — AWS stores the expanded seven, so this is permanent phantom drift (effectiveProperties not applied?)" >&2
  exit 1
fi
assert_eq "state-recorded DesiredShardLevelMetrics (effectiveProperties)" \
  "${ALL_METRICS_SORTED}" "${RECORDED_METRICS}"
echo "    state records the EXPANDED metric list (effectiveProperties applied)"

# `canonicalizeDesiredProperties`: the paired half. With only the recording
# half, the template still says `ALL` while state holds seven names, so the very
# next diff reports a change the user never made. A clean diff here is what
# proves the two halves narrow identically.
echo "==> Phase 2b: cdkd diff must be clean (ALL vs expanded seven is NOT a change)"
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
printf '%s\n' "${DIFF_OUT}" | sed 's/^/    | /'
if printf '%s' "${DIFF_OUT}" | grep -q "DesiredShardLevelMetrics"; then
  echo "FAIL: cdkd diff reports a DesiredShardLevelMetrics change on an untouched stream — canonicalizeDesiredProperties does not agree with the wire-path expansion" >&2
  exit 1
fi
echo "    diff is clean on DesiredShardLevelMetrics (both sides narrowed identically)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Kinesis DeleteStream is ASYNC: the stream enters DELETING and
# describe-stream-summary keeps returning it for a few seconds after a clean
# destroy. Accept DELETING and poll until it is fully gone (ResourceNotFound),
# rather than asserting an immediate disappearance.
stream_gone=""
for attempt in $(seq 1 15); do
  # `|| true`: once the stream is fully gone, describe-stream-summary exits
  # non-zero (ResourceNotFoundException), which would trip `set -e` on the
  # assignment before we can inspect the captured message.
  STATUS="$(aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text 2>&1 || true)"
  if echo "${STATUS}" | grep -q "ResourceNotFoundException"; then
    stream_gone="yes"
    break
  fi
  if [ "${STATUS}" != "DELETING" ]; then
    echo "FAIL: stream ${STREAM_NAME} in unexpected status '${STATUS}' after destroy" >&2
    exit 1
  fi
  echo "    stream still DELETING (attempt ${attempt}/15), waiting..."
  sleep 4
done
if [ -z "${stream_gone}" ]; then
  echo "FAIL: stream ${STREAM_NAME} did not finish deleting within ~60s" >&2
  exit 1
fi
echo "    stream deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Kinesis StreamMode switch (PROVISIONED -> ON_DEMAND) reaches AWS, all 3 phases passed"
