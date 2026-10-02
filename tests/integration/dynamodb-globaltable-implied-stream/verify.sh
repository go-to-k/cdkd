#!/usr/bin/env bash
# verify.sh — cdkd GlobalTable "needsStream" record integ (issue #1723).
#
# An `AWS::DynamoDB::GlobalTable` with TWO replicas and NO `StreamSpecification`
# gets a NEW_AND_OLD_IMAGES stream from cdkd's create (cross-region replication
# requires one). State used to record no stream, so a template that later
# declared that very stream diffed as a change and the update asked AWS to
# enable a stream the table already had. The fix records the stream (create,
# and update when the live table confirms it) and folds the same stream into
# both diff sides via `canonicalizeDesiredProperties`.
#
# Phases:
#   1. Deploy (no stream declared). Assert the live table has an enabled
#      NEW_AND_OLD_IMAGES stream, the second-region replica is ACTIVE, and the
#      state record carries `StreamSpecification: {StreamViewType:
#      NEW_AND_OLD_IMAGES}` (a pre-fix binary records no key -> RED here).
#   2. `cdkd diff --fail` on the UNCHANGED template exits 0 — the one phase
#      that witnesses the twin folding a RECORDED stream against a silent
#      template — then redeploy it.
#   3. CDKD_TEST_UPDATE=ttl: an ordinary in-place change through `update()`.
#      Assert TTL reached AWS, the table and its stream were not replaced, and
#      the record STILL carries the stream (pre-fix `update()` re-recorded the
#      desired bag).
#   4. CDKD_TEST_UPDATE=ttl,declare-stream: the template declares the stream
#      cdkd enabled. Against a record that already carries it, `cdkd diff
#      --fail` exits 0 and the deploy is a no-op; this pins the record's
#      shape, not the fold.
#   5. Rewrite the record to its pre-#1723 shape (no `StreamSpecification`),
#      then deploy `ttl,declare-stream,tag`: the stream is declared AND a tag
#      changes, so `update()`'s stream arm runs against a previous side with no
#      stream while AWS holds one. Assert the deploy succeeds without
#      re-enabling the stream (AWS refuses stream changes on a multi-replica
#      table), the tag reached AWS, and the record carries the stream again.
#   6. Destroy; assert the table is gone in BOTH regions and the state file is
#      removed.
#
# Wall-clock: a cross-region replica create + delete is roughly 15-25 minutes.
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

STACK="CdkdDynamoDBGlobalTableImpliedStreamExample"
REGION="${AWS_REGION:-us-east-1}"
# The same rule bin/app.ts applies; passed to the app explicitly below.
if [ "${REGION}" = "us-west-2" ]; then SECOND_REGION="us-east-1"; else SECOND_REGION="us-west-2"; fi
export CDKD_INTEG_SECOND_REGION="${SECOND_REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE="${STACK}-table"
LOGICAL_ID="ImpliedStreamTable"
EXPECTED_STREAM='{"StreamViewType":"NEW_AND_OLD_IMAGES"}'

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Phase 5's state.json scratch copy; swept by cleanup().
STATE_EDIT_DIR=""

# The table's StreamSpecification as cdkd RECORDED it, compact JSON, or ABSENT.
recorded_stream() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${state}" | jq -c --arg lid "${LOGICAL_ID}" \
    '.resources[$lid].properties.StreamSpecification // "ABSENT"'
}

# "<StreamEnabled> <StreamViewType> <LatestStreamArn>" as AWS reports them.
live_stream() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query '[Table.StreamSpecification.StreamEnabled, Table.StreamSpecification.StreamViewType, Table.LatestStreamArn]' \
    --output text
}

creation_time() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query 'Table.CreationDateTime' --output text
}

# Table AND every replica ACTIVE: a global table reports ACTIVE at the table
# level while a replica is still UPDATING, and a destroy or the next update
# against a mutating table fails with ResourceInUseException.
wait_settled() {
  local i tbl reps
  for i in $(seq 1 90); do
    tbl="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    reps="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
      --query "join(' ', Table.Replicas[].ReplicaStatus || \`[]\`)" --output text)" || return 1
    if [ "${tbl}" = "ACTIVE" ] && [ "${reps}" = "ACTIVE" ]; then
      echo "    settled (table=${tbl} replicas=${reps})"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: table did not settle (table='${tbl}' replicas='${reps}')" >&2
  exit 1
}

assert_recorded_stream() { # usage: assert_recorded_stream "<phase>"
  local got
  got="$(recorded_stream)"
  if [ "${got}" != "${EXPECTED_STREAM}" ]; then
    echo "FAIL: $1: state records StreamSpecification=${got}, expected ${EXPECTED_STREAM} (issue #1723: the auto-enabled stream must be recorded)" >&2
    exit 1
  fi
  echo "    state records StreamSpecification=${got}"
}

assert_diff_clean() { # usage: assert_diff_clean "<phase>" "<CDKD_TEST_UPDATE modes, empty for none>"
  local rc
  set +e
  if [ -z "$2" ]; then
    env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" diff "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail
  else
    CDKD_TEST_UPDATE="$2" node "${LOCAL_DIST}" diff "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail
  fi
  rc=$?
  set -e
  # `--fail` exits 1 on a change, 0 on none; anything else is a failed run.
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: $1: cdkd diff --fail exited ${rc} (expected 0, no changes)" >&2
    exit 1
  fi
  echo "    cdkd diff reports no changes"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct deletes by deterministic name, for a run that died before state
  # existed. The replica removal is ASYNC and leaves the table UPDATING, where
  # DeleteTable fails with ResourceInUseException, so wait for the replica to
  # leave before deleting the table, and say so when something survives.
  if aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1; then
    aws dynamodb update-table --table-name "${TABLE}" --region "${REGION}" \
      --replica-updates "Delete={RegionName=${SECOND_REGION}}" >/dev/null 2>&1
    gone=0
    for _ in $(seq 1 60); do
      # Stop waiting once the table is gone (a destroy still in flight
      # finished). Only a NOT-FOUND counts as gone; any other failure keeps
      # waiting, so a throttle cannot silently skip the delete below.
      if ! out="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
        --query "[Table.TableStatus, join(' ', Table.Replicas[].RegionName || \`[]\`)]" --output text 2>&1)"; then
        if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then gone=1; break; fi
        sleep 10
        continue
      fi
      status="$(printf '%s' "${out}" | cut -f1)"
      reps="$(printf '%s' "${out}" | cut -f2-)"
      case " ${reps} " in
        *" ${SECOND_REGION} "*)
          # The first replica delete is refused while the replica is still
          # CREATING (ResourceInUse), so re-issue it once the table is ACTIVE.
          if [ "${status}" = "ACTIVE" ]; then
            aws dynamodb update-table --table-name "${TABLE}" --region "${REGION}" \
              --replica-updates "Delete={RegionName=${SECOND_REGION}}" >/dev/null 2>&1
          fi
          ;;
        *) [ "${status}" = "ACTIVE" ] && break ;;
      esac
      sleep 10
    done
    if [ "${gone}" = "0" ]; then
      aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1 ||
        echo "WARN: cleanup could not delete ${TABLE} in ${REGION}; delete it by hand" >&2
    fi
  fi
  # A run that died with only the second-region copy left: best effort, and
  # loud when a copy is there and will not go.
  if ! out="$(aws dynamodb delete-table --table-name "${TABLE}" --region "${SECOND_REGION}" 2>&1)"; then
    if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
      echo "WARN: cleanup could not delete ${TABLE} in ${SECOND_REGION}; delete it by hand" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_EDIT_DIR:-}" ]; then rm -rf "${STATE_EDIT_DIR}"; fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy, no stream declared --------------------------------
echo "==> Phase 1: deploy two replicas (${REGION}, ${SECOND_REGION}) with no StreamSpecification"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_settled

LIVE="$(live_stream)"
read -r LIVE_ENABLED LIVE_VIEW STREAM_ARN_BEFORE <<<"${LIVE}"
if [ "${LIVE_ENABLED}" != "True" ] || [ "${LIVE_VIEW}" != "NEW_AND_OLD_IMAGES" ] ||
  [ -z "${STREAM_ARN_BEFORE}" ] || [ "${STREAM_ARN_BEFORE}" = "None" ]; then
  echo "FAIL: premise: expected the auto-enabled NEW_AND_OLD_IMAGES stream, AWS reports enabled=${LIVE_ENABLED} view=${LIVE_VIEW}" >&2
  exit 1
fi
SECOND_STATUS="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --query 'Table.TableStatus' --output text)"
if [ "${SECOND_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: premise: the ${SECOND_REGION} replica is '${SECOND_STATUS}', expected ACTIVE" >&2
  exit 1
fi
echo "    live stream enabled (${LIVE_VIEW}), ${SECOND_REGION} replica ACTIVE"
CREATED_AT="$(creation_time)"
assert_recorded_stream "Phase 1"

# --- Phase 2: the unchanged template diffs clean ------------------------
echo "==> Phase 2: unchanged template -> no changes, record survives a redeploy"
assert_diff_clean "Phase 2" ""
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_recorded_stream "Phase 2"

# --- Phase 3: an ordinary in-place update keeps the record --------------
echo "==> Phase 3: add TTL (in-place update through update())"
CDKD_TEST_UPDATE=ttl node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_settled

TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "${TABLE}" --region "${REGION}" \
  --query 'TimeToLiveDescription.[TimeToLiveStatus, AttributeName]' --output text)"
case "${TTL_STATUS}" in
  "ENABLED"*expiresAt | "ENABLING"*expiresAt) echo "    TTL reached AWS (${TTL_STATUS})" ;;
  *) echo "FAIL: Phase 3: TTL did not reach AWS (got '${TTL_STATUS}') — the update phase proves nothing" >&2; exit 1 ;;
esac
if [ "$(creation_time)" != "${CREATED_AT}" ]; then
  echo "FAIL: Phase 3: CreationDateTime changed — the table was replaced, not updated in place" >&2
  exit 1
fi
LIVE="$(live_stream)"
read -r _ _ STREAM_ARN_AFTER_TTL <<<"${LIVE}"
if [ "${STREAM_ARN_AFTER_TTL}" != "${STREAM_ARN_BEFORE}" ]; then
  echo "FAIL: Phase 3: LatestStreamArn changed (${STREAM_ARN_BEFORE} -> ${STREAM_ARN_AFTER_TTL})" >&2
  exit 1
fi
assert_recorded_stream "Phase 3"

# --- Phase 4: declaring the same stream is not a change -----------------
echo "==> Phase 4: template now DECLARES StreamSpecification NEW_AND_OLD_IMAGES"
assert_diff_clean "Phase 4" "ttl,declare-stream"
CDKD_TEST_UPDATE=ttl,declare-stream node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
LIVE="$(live_stream)"
read -r _ _ STREAM_ARN_AFTER_DECLARE <<<"${LIVE}"
if [ "${STREAM_ARN_AFTER_DECLARE}" != "${STREAM_ARN_BEFORE}" ]; then
  echo "FAIL: Phase 4: LatestStreamArn changed (${STREAM_ARN_BEFORE} -> ${STREAM_ARN_AFTER_DECLARE})" >&2
  exit 1
fi
echo "    stream unchanged"
assert_recorded_stream "Phase 4"
wait_settled

# --- Phase 5: a pre-#1723 record meets a declared stream plus a change -------
echo "==> Phase 5: pre-#1723 record (no StreamSpecification) + declared stream + tag change"
STATE_EDIT_DIR="$(mktemp -d)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_EDIT_DIR}/state.json" >/dev/null
jq --arg lid "${LOGICAL_ID}" 'del(.resources[$lid].properties.StreamSpecification)' \
  "${STATE_EDIT_DIR}/state.json" > "${STATE_EDIT_DIR}/state-legacy.json"
aws s3 cp "${STATE_EDIT_DIR}/state-legacy.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
LEGACY="$(recorded_stream)"
if [ "${LEGACY}" != '"ABSENT"' ]; then
  echo "FAIL: Phase 5 premise: the rewritten record still reads StreamSpecification=${LEGACY}" >&2
  exit 1
fi
# The twin folds the stream into the legacy record too, so declaring it alone
# is still no change.
assert_diff_clean "Phase 5 (declare only)" "ttl,declare-stream"
CDKD_TEST_UPDATE=ttl,declare-stream,tag node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_settled
TABLE_ARN="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query 'Table.TableArn' --output text)"
TAG_VALUE="$(aws dynamodb list-tags-of-resource --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query "Tags[?Key=='Cdkd1723'].Value | [0]" --output text)"
if [ "${TAG_VALUE}" != "tagged" ]; then
  echo "FAIL: Phase 5: the tag change did not reach AWS (got '${TAG_VALUE}') — update() never ran, so the stream arm was not exercised" >&2
  exit 1
fi
LIVE="$(live_stream)"
read -r LIVE_ENABLED LIVE_VIEW STREAM_ARN_AFTER_LEGACY <<<"${LIVE}"
if [ "${LIVE_ENABLED}" != "True" ] || [ "${STREAM_ARN_AFTER_LEGACY}" != "${STREAM_ARN_BEFORE}" ]; then
  echo "FAIL: Phase 5: stream is enabled=${LIVE_ENABLED} arn=${STREAM_ARN_AFTER_LEGACY}, expected the original ${STREAM_ARN_BEFORE}" >&2
  exit 1
fi
echo "    tag applied, stream untouched"
assert_recorded_stream "Phase 5"

# --- Phase 6: destroy ---------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "table ${TABLE} still exists in ${REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
assert_gone "replica ${TABLE} still exists in ${SECOND_REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}"
echo "    table deleted in both regions"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — GlobalTable implied stream is recorded, diffs clean and is never re-sent (issue #1723), all 6 phases passed"
