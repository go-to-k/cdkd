#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB WarmThroughput backfill (#609) + DynamoDB Streams
# StreamSpecification enable-on-UPDATE (#977) integ test.
#
# Phase 1 deploys a PROVISIONED DynamoDB table WITHOUT a stream and asserts:
#   - WarmThroughput (Read/Write UnitsPerSecond) reached AWS (silent-drop #609)
#   - the table has NO enabled stream yet
# The UPDATE phase (CDKD_TEST_UPDATE=true) enables `stream: NEW_AND_OLD_IMAGES`
# on the existing table (plus a Lambda + EventSourceMapping consumer) and
# asserts:
#   - StreamSpecification.StreamEnabled == true (the #977 silent-drop close:
#     StreamSpecification had NO update() branch before, so enabling a stream
#     on UPDATE was dropped — deploy reported green while AWS kept no stream)
#   - LatestStreamArn is non-null (the update-time enable materialized a stream
#     ARN, resolvable via `Fn::GetAtt [Table, StreamArn]`)
#   - the ESM 2-prop backfill (KmsKeyArn / MetricsConfig) reached AWS (#609)
# Also asserts the destroy path cleans up.
#
# A SECOND stack (`DynamodbStreamMembersStack`, issue #3458) covers
# `StreamSpecification.ResourcePolicy` / `StreamSpecification.Tags`, which are
# not members of the SDK's `StreamSpecification` and used to be dropped on the
# wire. Its own table, because the view-type change below replaces the stream
# arn the first stack's EventSourceMapping is wired to:
#   M1. create with both members -> both are on the STREAM arn, the table arn
#       has neither, and `cdkd drift` is clean on BOTH baselines
#   M2. `StreamViewType` change -> a NEW stream arn carrying both, the recorded
#       `StreamArn` attribute updated, drift clean
#   M3. out-of-band `delete-resource-policy` -> reported as drift on the member,
#       restored by `cdkd drift --revert`
#   M4. both members removed -> no policy, no tags, SAME stream arn, drift clean
#   M5. destroy, and a by-name orphan check
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

STACK="DynamodbStreamsStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# AWS enforces minimums of 12000 read units / 4000 write units per second.
EXPECTED_READ=12000
EXPECTED_WRITE=4000

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The fixture's EventsTable has no explicit tableName, so CDK auto-generates
# the physical name; we resolve it from cdkd state after deploy.
TABLE_NAME=""

# The issue #3458 stack. Its table name is FIXED in the stack source, so the
# teardown can sweep it by name before any state record is consulted.
MEMBERS_STACK="DynamodbStreamMembersStack"
MEMBERS_STATE_KEY="cdkd/${MEMBERS_STACK}/${REGION}/state.json"
MEMBERS_TABLE="cdkd-stream-members-test-table"
MEMBERS_TAG_KEY="cdkd-stream-owner"
MEMBERS_TAG_VALUE="integ-3458"
MEMBERS_POLICY_SID="CdkdIntegStreamRead"
# Scratch files, declared HERE so `cleanup` sweeps them on every exit path.
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-3458-drift.$$.json"
MEMBERS_STATE_JSON="${TMPDIR:-/tmp}/cdkd-3458-state.$$.json"

# Delete the members table BY NAME. A subshell under `set +eu`, so calling it
# from the `set +eu` trap never re-arms strict mode mid-sweep. The loop keys on
# the DELETE's own outcome: only an explicit not-found ends it early.
reap_members_table() { # usage: reap_members_table <table-name>
  (
    set +eu
    # EXACT name, accepting arm first.
    case "${1:-}" in
      cdkd-stream-members-test-table) ;;
      *)
        echo "WARN: teardown sweep refused — '${1:-}' is not this fixture's members table name" >&2
        exit 0
        ;;
    esac
    DELETE_DONE=""
    DELETE_ERR=""
    for _ in $(seq 1 20); do
      DELETE_ERR="$(aws dynamodb delete-table --table-name "$1" --region "${REGION}" 2>&1 >/dev/null)" && { DELETE_DONE=1; break; }
      grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${DELETE_ERR}" && { DELETE_DONE=1; break; }
      sleep 15
    done
    if [ -z "${DELETE_DONE}" ]; then
      echo "WARN: cleanup could not delete $1 after 20 attempts (~5 min) — it may still exist and MUST be checked. Last AWS error: ${DELETE_ERR}" >&2
    fi
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS table"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  rm -f "${DRIFT_JSON}" "${MEMBERS_STATE_JSON}" "${MEMBERS_STATE_JSON}.stripped"
  # The members table is swept BY NAME first and its state record dropped
  # second, so a `state destroy` that dies half way is never the only thing
  # between the table and a leak (`state destroy` treats a gone table as deleted).
  reap_members_table "${MEMBERS_TABLE}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${MEMBERS_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    # Destroy under CDKD_TEST_UPDATE=true so the synthesized template matches
    # whatever phase the state was last written in (the stream-consumer subtree
    # only exists in the UPDATE phase).
    CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${TABLE_NAME}" ]; then
    aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${MEMBERS_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${MEMBERS_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy WITHOUT a stream ---------------------------------
echo "==> Phase 1: deploy with the local binary (stream-less table)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the auto-generated table physical name from cdkd state.
TABLE_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DynamoDB::Table") | .value.physicalId] | first // ""')
if [ -z "${TABLE_NAME}" ] || [ "${TABLE_NAME}" = "null" ]; then
  echo "FAIL: could not resolve DynamoDB table physical name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved table name: ${TABLE_NAME}"

# --- Assertion: WarmThroughput reached AWS ----------------------------
# DescribeTable returns Table.WarmThroughput (ReadUnitsPerSecond /
# WriteUnitsPerSecond plus an AWS-managed status field) only on tables that
# set warm throughput. Seeing the templated read/write values proves the
# silent-drop is closed by the #609 backfill.
WT=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.WarmThroughput' --output json 2>/dev/null)

ACTUAL_READ=$(echo "${WT}" | jq -r '.ReadUnitsPerSecond // "null"')
ACTUAL_WRITE=$(echo "${WT}" | jq -r '.WriteUnitsPerSecond // "null"')

if [ "${ACTUAL_READ}" != "${EXPECTED_READ}" ]; then
  echo "FAIL: Table.WarmThroughput.ReadUnitsPerSecond is '${ACTUAL_READ}', expected '${EXPECTED_READ}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.ReadUnitsPerSecond == ${EXPECTED_READ} on AWS"

if [ "${ACTUAL_WRITE}" != "${EXPECTED_WRITE}" ]; then
  echo "FAIL: Table.WarmThroughput.WriteUnitsPerSecond is '${ACTUAL_WRITE}', expected '${EXPECTED_WRITE}' (silent-drop NOT closed)" >&2
  echo "${WT}" | jq .
  exit 1
fi
echo "    OK: Table.WarmThroughput.WriteUnitsPerSecond == ${EXPECTED_WRITE} on AWS (silent-drop CLOSED by #609)"

# --- Assertion: NO stream yet (Phase 1 baseline) ----------------------
# DescribeTable's StreamSpecification.StreamEnabled is false (or the block is
# absent) on a stream-less table. Wrap length() on the possibly-null
# StreamSpecification so a null field does not abort under `set -e`.
STREAM_ENABLED_P1=$(aws dynamodb describe-table \
  --table-name "${TABLE_NAME}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamEnabled' --output text)
if [ "${STREAM_ENABLED_P1}" = "True" ]; then
  echo "FAIL: table has a stream enabled in Phase 1, expected none" >&2
  exit 1
fi
echo "    OK: no stream enabled in Phase 1 (StreamEnabled == '${STREAM_ENABLED_P1}')"

# --- UPDATE phase: enable the stream on the existing table (#977) ------
echo "==> UPDATE phase: enable DynamoDB Stream on the existing table"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Re-read state (now carries the stream + the Lambda / ESM consumer subtree).
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file after UPDATE-phase deploy" >&2
  exit 1
fi

# --- Assertion: stream is now enabled (#977 silent-drop close) --------
DT_JSON=$(aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" 2>/dev/null)

STREAM_ENABLED=$(echo "${DT_JSON}" | jq -r '.Table.StreamSpecification.StreamEnabled // false')
if [ "${STREAM_ENABLED}" != "true" ]; then
  echo "FAIL: Table.StreamSpecification.StreamEnabled is '${STREAM_ENABLED}', expected 'true' (StreamSpecification enable-on-UPDATE NOT applied — #977)" >&2
  echo "${DT_JSON}" | jq '.Table.StreamSpecification'
  exit 1
fi
echo "    OK: Table.StreamSpecification.StreamEnabled == true after UPDATE (silent-drop CLOSED by #977)"

STREAM_VIEW=$(echo "${DT_JSON}" | jq -r '.Table.StreamSpecification.StreamViewType // "null"')
if [ "${STREAM_VIEW}" != "NEW_AND_OLD_IMAGES" ]; then
  echo "FAIL: Table.StreamSpecification.StreamViewType is '${STREAM_VIEW}', expected 'NEW_AND_OLD_IMAGES'" >&2
  echo "${DT_JSON}" | jq '.Table.StreamSpecification'
  exit 1
fi
echo "    OK: Table.StreamSpecification.StreamViewType == NEW_AND_OLD_IMAGES"

# LatestStreamArn is the ARN the update-time enable materialized. Assert it is
# a non-null, non-empty string (also proves Fn::GetAtt [Table, StreamArn]
# had a real value to resolve to).
LATEST_STREAM_ARN=$(echo "${DT_JSON}" | jq -r '.Table.LatestStreamArn // "null"')
if [ -z "${LATEST_STREAM_ARN}" ] || [ "${LATEST_STREAM_ARN}" = "null" ]; then
  echo "FAIL: Table.LatestStreamArn is null/empty after UPDATE-phase enable (#977)" >&2
  echo "${DT_JSON}" | jq '{StreamSpecification: .Table.StreamSpecification, LatestStreamArn: .Table.LatestStreamArn}'
  exit 1
fi
echo "    OK: Table.LatestStreamArn is non-null (${LATEST_STREAM_ARN})"

# The StreamArn output (Fn::GetAtt [Table, StreamArn]) should equal AWS's
# LatestStreamArn — this proves the update() attribute-enrichment fed the
# freshly-enabled stream ARN back into cdkd state / outputs.
STREAM_ARN_OUTPUT=$(echo "${STATE}" | jq -r '.outputs.StreamArn // ""')
if [ "${STREAM_ARN_OUTPUT}" != "${LATEST_STREAM_ARN}" ]; then
  echo "FAIL: cdkd StreamArn output '${STREAM_ARN_OUTPUT}' != AWS LatestStreamArn '${LATEST_STREAM_ARN}' (attribute enrichment gap — #977)" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi
echo "    OK: cdkd StreamArn output matches AWS LatestStreamArn (attribute enrichment CLOSED by #977)"

# --- Assertion: Lambda::EventSourceMapping 2-props backfill (#609) -----
# The ESM only exists in the UPDATE phase (it needs the stream). Resolve its
# UUID from cdkd state, then GetEventSourceMapping and assert the 2
# universally-applicable props (KmsKeyArn / MetricsConfig) made it to AWS.
ESM_UUID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::EventSourceMapping") | .value.physicalId] | first // ""')
if [ -z "${ESM_UUID}" ] || [ "${ESM_UUID}" = "null" ]; then
  echo "FAIL: could not resolve EventSourceMapping UUID from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved ESM UUID: ${ESM_UUID}"

EXPECTED_KMS_ARN=$(echo "${STATE}" | jq -r '.outputs.EsmFilterKeyArn // ""')
if [ -z "${EXPECTED_KMS_ARN}" ] || [ "${EXPECTED_KMS_ARN}" = "null" ]; then
  echo "FAIL: cdkd state did not emit an EsmFilterKeyArn output" >&2
  echo "${STATE}" | jq .outputs
  exit 1
fi

ESM_JSON=$(aws lambda get-event-source-mapping --uuid "${ESM_UUID}" --region "${REGION}" 2>/dev/null)
if [ -z "${ESM_JSON}" ]; then
  echo "FAIL: GetEventSourceMapping returned empty for UUID ${ESM_UUID}" >&2
  exit 1
fi

# Assert KMSKeyArn (SDK casing is upper-case `MS`; CFn casing is lower-
# case `Ms`). The provider's create() does the flip — a missed flip would
# silently drop KmsKeyArn, exactly what #609 closes.
ACTUAL_KMS=$(echo "${ESM_JSON}" | jq -r '.KMSKeyArn // "null"')
if [ "${ACTUAL_KMS}" != "${EXPECTED_KMS_ARN}" ]; then
  echo "FAIL: ESM KMSKeyArn is '${ACTUAL_KMS}', expected '${EXPECTED_KMS_ARN}' (KmsKeyArn silent-drop NOT closed)" >&2
  echo "${ESM_JSON}" | jq .
  exit 1
fi
echo "    OK: ESM.KMSKeyArn matches the deployed key (KmsKeyArn silent-drop CLOSED by #609)"

# Assert MetricsConfig.Metrics contains 'EventCount'.
ACTUAL_METRICS=$(echo "${ESM_JSON}" | jq -r '.MetricsConfig.Metrics // [] | sort | join(",")')
if [ "${ACTUAL_METRICS}" != "EventCount" ]; then
  echo "FAIL: ESM MetricsConfig.Metrics is '${ACTUAL_METRICS}', expected 'EventCount' (MetricsConfig silent-drop NOT closed)" >&2
  echo "${ESM_JSON}" | jq .
  exit 1
fi
echo "    OK: ESM.MetricsConfig.Metrics == ['EventCount'] (MetricsConfig silent-drop CLOSED by #609)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# DynamoDB DeleteTable is async: the table lingers in DELETING for a few
# seconds before describe-table returns ResourceNotFoundException. Poll
# until it is truly gone rather than racing the async delete.
TABLE_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB table is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"


# ===========================================================================
# Issue #3458: StreamSpecification.ResourcePolicy / StreamSpecification.Tags
# ===========================================================================
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
# What `policy_statement_on` reduces the declared statement to. The principal
# is checked by ACCOUNT rather than by spelling: whether AWS stores the root
# principal as the arn or as the bare account id is the drift assertions'
# subject, not this one's.
EXPECTED_STATEMENT="$(jq -cn --arg sid "${MEMBERS_POLICY_SID}" \
  '{Sid: $sid, Effect: "Allow", Action: "dynamodb:DescribeStream", PrincipalIsThisAccount: true}')"

members_stream_arn() { # -> the members table's CURRENT LatestStreamArn
  aws dynamodb describe-table --table-name "${MEMBERS_TABLE}" --region "${REGION}" \
    --query 'Table.LatestStreamArn' --output text
}

# The declared statement as AWS holds it on <arn>, reduced to the members the
# fixture declares, or the literal `none` when the arn has NO policy. Any other
# failure is reported on stderr and reads as `error`, never as `none`.
policy_statement_on() { # usage: policy_statement_on <arn>
  local out
  if out="$(aws dynamodb get-resource-policy --resource-arn "$1" --region "${REGION}" \
    --query Policy --output text 2>&1)"; then
    jq -c --arg sid "${MEMBERS_POLICY_SID}" --arg account "${ACCOUNT_ID}" \
      '[.Statement[] | select(.Sid == $sid)
        | {Sid, Effect, Action, PrincipalIsThisAccount: ((.Principal.AWS // "") | tostring | contains($account))}]
       | first // "no-such-sid"' <<<"${out}" || echo "error"
    return 0
  fi
  if grep -qE 'PolicyNotFoundException' <<<"${out}"; then
    echo "none"
    return 0
  fi
  echo "    get-resource-policy on $1 failed: ${out}" >&2
  echo "error"
}

# The value of the fixture's tag on <arn>, or `none` when the key is absent.
tag_value_on() { # usage: tag_value_on <arn>
  local out
  if ! out="$(aws dynamodb list-tags-of-resource --resource-arn "$1" --region "${REGION}" --output json 2>&1)"; then
    echo "    list-tags-of-resource on $1 failed: ${out}" >&2
    echo "error"
    return 0
  fi
  jq -r --arg k "${MEMBERS_TAG_KEY}" '[.Tags[]? | select(.Key == $k) | .Value] | first // "none"' <<<"${out}"
}

# Both reads are EVENTUALLY consistent (the command docs say so), so every
# assertion polls for its expected answer instead of probing once.
wait_members_on() { # usage: wait_members_on <arn> <expected statement|none> <expected tag|none> <label>
  local got_policy="" got_tag=""
  for _ in $(seq 1 18); do
    got_policy="$(policy_statement_on "$1")"
    got_tag="$(tag_value_on "$1")"
    if [ "${got_policy}" = "$2" ] && [ "${got_tag}" = "$3" ]; then
      echo "    OK ($4): policy == $2, tag == $3"
      return 0
    fi
    sleep 5
  done
  echo "FAIL (issue #3458, $4): on $1 expected policy '$2' / tag '$3', got policy '${got_policy}' / tag '${got_tag}'" >&2
  exit 1
}

# `cdkd drift` exits non-zero when it DETECTS drift and ZERO for a resource it
# could not read, so the report is parsed and the table required by bucket.
run_drift_json() { # $1 = label -> writes ${DRIFT_JSON}
  node "${LOCAL_DIST}" drift "${MEMBERS_STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
  if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
    echo "FAIL: cdkd drift --json ($1) produced no stack report — the assertions below would be vacuous:" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
}
table_outcome_count() { # $1 = bucket (clean|drifted|notSupported)
  jq --arg b "$1" '[.[][$b][] | select(.type == "AWS::DynamoDB::Table")] | length' "${DRIFT_JSON}"
}
members_drift_paths() {
  jq -r '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table") | .changes[].path] | sort | join(" ")' "${DRIFT_JSON}"
}
assert_members_drift_clean() { # $1 = label
  run_drift_json "$1"
  if [ "$(table_outcome_count notSupported)" != "0" ] || [ "$(table_outcome_count drifted)" != "0" ] \
    || [ "$(table_outcome_count clean)" != "1" ]; then
    echo "FAIL (issue #3458): expected the members table CLEAN ($1); drifted paths: '$(members_drift_paths)'" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
  echo "    OK: cdkd drift reports the members table CLEAN ($1)"
}
members_state() { # -> writes ${MEMBERS_STATE_JSON}
  aws s3 cp "s3://${STATE_BUCKET}/${MEMBERS_STATE_KEY}" "${MEMBERS_STATE_JSON}" --region "${REGION}" >/dev/null
}
recorded_stream_arn() {
  jq -r '[.resources[] | select(.resourceType == "AWS::DynamoDB::Table") | .attributes.StreamArn] | first // ""' "${MEMBERS_STATE_JSON}"
}

echo "==> Phase M1: create a table whose stream block declares ResourcePolicy + Tags (issue #3458)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${MEMBERS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MEMBERS_TABLE_ARN="$(aws dynamodb describe-table --table-name "${MEMBERS_TABLE}" --region "${REGION}" \
  --query 'Table.TableArn' --output text)"
STREAM_ARN_1="$(members_stream_arn)"
case "${STREAM_ARN_1}" in
  arn:*:table/"${MEMBERS_TABLE}"/stream/?*) ;;
  *)
    echo "FAIL (issue #3458): the members table has no LatestStreamArn after create (got '${STREAM_ARN_1}')" >&2
    exit 1
    ;;
esac
wait_members_on "${STREAM_ARN_1}" "${EXPECTED_STATEMENT}" "${MEMBERS_TAG_VALUE}" "create, stream arn"
# The TABLE arn must carry neither: they are the STREAM's.
wait_members_on "${MEMBERS_TABLE_ARN}" "none" "none" "create, table arn"

members_state
if [ "$(recorded_stream_arn)" != "${STREAM_ARN_1}" ]; then
  echo "FAIL (issue #3458): recorded StreamArn '$(recorded_stream_arn)' != AWS LatestStreamArn '${STREAM_ARN_1}'" >&2
  exit 1
fi
# Vacuity guard: with no deploy-time capture of the two members, a clean
# observed-baseline report would prove nothing about the read-back.
OBSERVED_MEMBER_KEYS="$(jq -r '[.resources[] | select(.resourceType == "AWS::DynamoDB::Table")
  | .observedProperties.StreamSpecification // {} | keys[]] | sort | join(",")' "${MEMBERS_STATE_JSON}")"
if [ "${OBSERVED_MEMBER_KEYS}" != "ResourcePolicy,StreamEnabled,StreamViewType,Tags" ]; then
  echo "FAIL (issue #3458): the observed baseline's StreamSpecification carries '${OBSERVED_MEMBER_KEYS}', expected both members to be captured" >&2
  exit 1
fi
assert_members_drift_clean "M1, observed baseline"

# The binding half: against the TEMPLATE baseline the read-back has to
# round-trip to the declared shape. A plain `cdkd drift` is read-only, so the
# stripped record is restored right after.
jq 'del(.resources[].observedProperties)' "${MEMBERS_STATE_JSON}" > "${MEMBERS_STATE_JSON}.stripped"
aws s3 cp "${MEMBERS_STATE_JSON}.stripped" "s3://${STATE_BUCKET}/${MEMBERS_STATE_KEY}" --region "${REGION}" >/dev/null
run_drift_json "M1, properties baseline"
MEMBER_PATHS="$(jq -r '[.[].drifted[] | select(.type == "AWS::DynamoDB::Table") | .changes[].path
  | select(startswith("StreamSpecification"))] | join(" ")' "${DRIFT_JSON}")"
if [ "$(table_outcome_count notSupported)" != "0" ] \
  || [ "$(( $(table_outcome_count clean) + $(table_outcome_count drifted) ))" != "1" ] \
  || [ -n "${MEMBER_PATHS}" ]; then
  echo "FAIL (issue #3458): the TEMPLATE baseline drifts on the stream block (${MEMBER_PATHS}) — the read-back does not round-trip to the declared members" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK: properties baseline shows no StreamSpecification drift"
aws s3 cp "${MEMBERS_STATE_JSON}" "s3://${STATE_BUCKET}/${MEMBERS_STATE_KEY}" --region "${REGION}" >/dev/null

echo "==> Phase M2: StreamViewType change -> a NEW stream arn carrying both members"
CDKD_TEST_UPDATE=viewtype node "${LOCAL_DIST}" deploy "${MEMBERS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STREAM_ARN_2="$(members_stream_arn)"
if [ -z "${STREAM_ARN_2}" ] || [ "${STREAM_ARN_2}" = "None" ] || [ "${STREAM_ARN_2}" = "${STREAM_ARN_1}" ]; then
  echo "FAIL (issue #3458): the view-type change did not mint a new stream arn (before '${STREAM_ARN_1}', after '${STREAM_ARN_2}')" >&2
  exit 1
fi
MEMBERS_VIEW="$(aws dynamodb describe-table --table-name "${MEMBERS_TABLE}" --region "${REGION}" \
  --query 'Table.StreamSpecification.StreamViewType' --output text)"
if [ "${MEMBERS_VIEW}" != "KEYS_ONLY" ]; then
  echo "FAIL (issue #3458): StreamViewType is '${MEMBERS_VIEW}' after the update, expected KEYS_ONLY" >&2
  exit 1
fi
wait_members_on "${STREAM_ARN_2}" "${EXPECTED_STATEMENT}" "${MEMBERS_TAG_VALUE}" "view-type change, NEW stream arn"
members_state
if [ "$(recorded_stream_arn)" != "${STREAM_ARN_2}" ]; then
  echo "FAIL (issue #3458): recorded StreamArn '$(recorded_stream_arn)' was not updated to the new arn '${STREAM_ARN_2}'" >&2
  exit 1
fi
assert_members_drift_clean "M2, after the view-type change"

echo "==> Phase M3: an out-of-band policy delete is drift, and --revert restores it"
aws dynamodb delete-resource-policy --resource-arn "${STREAM_ARN_2}" --region "${REGION}" >/dev/null
wait_members_on "${STREAM_ARN_2}" "none" "${MEMBERS_TAG_VALUE}" "out-of-band delete landed"
run_drift_json "M3, after the out-of-band delete"
case " $(members_drift_paths) " in
  *" StreamSpecification.ResourcePolicy"*) ;;
  *)
    echo "FAIL (issue #3458): the out-of-band stream policy delete was not reported as drift (drifted paths: '$(members_drift_paths)')" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
    ;;
esac
echo "    OK: reported as drift on: $(members_drift_paths)"
node "${LOCAL_DIST}" drift "${MEMBERS_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --revert --yes
wait_members_on "${STREAM_ARN_2}" "${EXPECTED_STATEMENT}" "${MEMBERS_TAG_VALUE}" "restored by drift --revert"
if [ "$(members_stream_arn)" != "${STREAM_ARN_2}" ]; then
  echo "FAIL (issue #3458): drift --revert replaced the stream (arn is now '$(members_stream_arn)')" >&2
  exit 1
fi
assert_members_drift_clean "M3, after --revert"

echo "==> Phase M4: both members removed -> removed on AWS, SAME stream arn"
CDKD_TEST_UPDATE=viewtype,removed node "${LOCAL_DIST}" deploy "${MEMBERS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
if [ "$(members_stream_arn)" != "${STREAM_ARN_2}" ]; then
  echo "FAIL (issue #3458): removing the members replaced the stream (arn is now '$(members_stream_arn)', was '${STREAM_ARN_2}')" >&2
  exit 1
fi
wait_members_on "${STREAM_ARN_2}" "none" "none" "members removed"
assert_members_drift_clean "M4, after the removal"

echo "==> Phase M5: destroy the members stack"
CDKD_TEST_UPDATE=viewtype,removed node "${LOCAL_DIST}" destroy "${MEMBERS_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
MEMBERS_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws dynamodb describe-table --table-name "${MEMBERS_TABLE}" --region "${REGION}"; then
    MEMBERS_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${MEMBERS_GONE}" ]; then
  echo "FAIL (issue #3458): table ${MEMBERS_TABLE} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: the members table is gone"
assert_gone "state file s3://${STATE_BUCKET}/${MEMBERS_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MEMBERS_STATE_KEY}"
echo "    OK: the members state file is gone"

echo ""
echo "==> dynamodb-streams test passed (WarmThroughput + ESM backfills #609 + StreamSpecification enable-on-UPDATE #977 + stream ResourcePolicy / Tags #3458 + clean destroy)"
