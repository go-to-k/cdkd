#!/usr/bin/env bash
# verify.sh — cdkd GlobalTable replica settings integ (issues #5355, #5365, #5381, #5399).
#
# A two-region `TableV2` renders its KMS key, table class and deletion
# protection PER REPLICA. cdkd read the key and the class under names the CFn
# schema does not have (`Replicas[].KMSMasterKeyId`,
# `Replicas[].TableClassOverride`), so both regions came up under the AWS
# managed key and the STANDARD class, and it never sent a cross-region
# replica's `DeletionProtectionEnabled`. Removing `SSESpecification` or a
# `TableClass` reset nothing, where CloudFormation resets both.
#
# Issue #5365: a replica's point-in-time recovery, Contributor Insights,
# Kinesis stream and the table / stream resource policies were never sent, for
# the deploy region's table or the replica. Both replicas declare the first
# four from Phase 1 (CloudFormation refuses a table resource policy in the
# deploy that creates a replica, so that one arrives in Phase 2b).
#
# Phases:
#   1. Deploy: customer managed keys (one per region), STANDARD_INFREQUENT_ACCESS,
#      replica protected. Assert each region's table holds ITS key and the
#      class, and the second region's table is protected (a pre-fix binary
#      fails every one of these). Assert each region holds point-in-time
#      recovery (10 days), Contributor Insights, streaming to ITS region's
#      Kinesis stream and a stream resource policy (#5365).
#   2. Turn the replica's protection off out of band (a replica deployed by a
#      pre-fix binary), then deploy an ordinary change (`tag`). Assert the
#      unchanged `true` is converged back on, and that the replica's class and
#      key, which already match, drew no corrective replica update. Point-in-
#      time recovery is turned off out of band too, and must come back on
#      (#5365), with no correction for the four settings AWS still holds.
#  2b. `tag,policy`: a table resource policy on both replicas (#5365).
#  2c. `cdkd drift` reports the untouched table clean; then the second
#      region's PITR period (10 -> 20 days), table resource policy (deleted)
#      and deletion protection (off) change out of band, drift reports all
#      three on that replica, and `drift --revert` restores them (#5381).
#   3. `tag,rotated`: a second customer managed key per region. Assert each
#      region holds its new key, sent as one every-region ReplicaUpdates call.
#   4. `tag,managed`: customer managed keys -> the AWS managed key. Assert
#      each region's table is on ITS region's AWS managed key, class kept.
#   5. `tag,removed`: no key, no class, no protection, none of the #5365
#      settings. Assert both regions leave KMS encryption, read STANDARD, the
#      replica is unprotected, cdkd warned that it auto-disabled the replica's
#      protection, and every #5365 setting reset as CloudFormation resets it
#      (measured): PITR and insights off, streaming disabled, both policies gone.
#  5b. `tag,removed,ssetable`: a second two-region table on the AWS owned key
#      (the first has used up its encryption switches). Drift is clean; then
#      both its regions move to the customer managed keys out of band (one
#      every-region ReplicaUpdates call), drift reports SSESpecification
#      leaving the AWS owned key, and `drift --revert` returns both regions to
#      it (SSEDescription absent) and drift is clean again (#5399).
#   6. `tag,removed,protect,ssetable`: protect the replica again (the Phase 5b
#      table is kept, so the destroy removes it).
#   7. `destroy --remove-protection`: assert the table is gone in BOTH regions
#      (the replica's guard is turned off before its drop) and the state file
#      is removed.
#
# Wall-clock (estimate, not yet measured for all 7 phases): a cross-region
# replica create + delete plus four encryption / class / protection updates,
# each waited out across both regions, is roughly 45-90 minutes; the summed
# wait caps allow more, which is why the leftover sweep spares runs younger
# than 4 h.
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

# Per-run STACK name (so the state key, table and key aliases are per run
# too): a concurrent or earlier run of this fixture never shares a name with
# this one, and this run's cleanup never touches another's.
BASE="CdkdDynamoDBGlobalTableReplicaSettingsExample"
RUN_ID="$(date +%s)-$$"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
STACK="${BASE}-${RUN_ID}"
REGION="${AWS_REGION:-us-east-1}"
if [ "${REGION}" = "us-west-2" ]; then SECOND_REGION="us-east-1"; else SECOND_REGION="us-west-2"; fi
export CDKD_INTEG_SECOND_REGION="${SECOND_REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE="${STACK}-table"
# Phase 5b's own table (issue #5399): ${TABLE} has switched encryption four
# times by then, and DynamoDB refused a further switch on it.
TABLE2="${STACK}-table2"
LOCAL_ALIAS="alias/${STACK}-local"
REPLICA_ALIAS="alias/${STACK}-replica"
# Tag on the keys this script creates, so a key whose alias was never
# created can still be found by a later run's sweep.
KEY_TAG="cdkd-integ-fixture"
# Kinesis streams (#5365): the deploy region's is stack-created, the second
# region's is created here.
LOCAL_KINESIS="${STACK}-local"
REPLICA_KINESIS="${STACK}-replica"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

# "<SSE status> <SSE type> <key ARN> <table class> <deletion protection>" for
# the table in region $1; absent members read as None. `GT_TABLE`, when set,
# names the table this and `wait_settled` read instead of `${TABLE}` (Phase 5b).
table_settings() {
  aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "$1" \
    --query '[Table.SSEDescription.Status, Table.SSEDescription.SSEType, Table.SSEDescription.KMSMasterKeyArn, Table.TableClassSummary.TableClass, Table.DeletionProtectionEnabled]' \
    --output text
}

# Table and replica ACTIVE in the deploy region, and the second region's copy
# ACTIVE: an SSE / class / protection change leaves one or the other UPDATING
# for a while, and the next deploy or destroy would be refused meanwhile.
wait_settled() {
  local i tbl reps second
  for i in $(seq 1 90); do
    tbl="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    reps="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${REGION}" \
      --query "join(' ', Table.Replicas[].ReplicaStatus || \`[]\`)" --output text)" || return 1
    second="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${SECOND_REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    if [ "${tbl}" = "ACTIVE" ] && [ "${reps}" = "ACTIVE" ] && [ "${second}" = "ACTIVE" ]; then
      echo "    settled (table=${tbl} replicas=${reps} ${SECOND_REGION}=${second})"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: table did not settle (table='${tbl}' replicas='${reps}' ${SECOND_REGION}='${second}')" >&2
  exit 1
}

# Poll until region $1's settings match the extended regex $2 (SSE changes and
# the class reset propagate to the replica asynchronously), then FAIL with $3.
await_settings() { # usage: await_settings <region> <regex> <failure message>
  local i got
  for i in $(seq 1 60); do
    got="$(table_settings "$1")"
    if printf '%s' "${got}" | grep -qE "$2"; then
      echo "    $1: ${got}"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: $3 ($1 reads '${got}')" >&2
  exit 1
}

# "present" / "absent" for the resource policy on ARN $2 in region $1, or
# "error:..." when the read fails for any other reason (never matched).
policy_state() { # usage: policy_state <region> <arn>
  local out
  if out="$(aws dynamodb get-resource-policy --resource-arn "$2" --region "$1" \
    --query 'RevisionId' --output text 2>&1)"; then
    echo present
    return 0
  fi
  case "${out}" in
    *PolicyNotFoundException*) echo absent ;;
    *) echo "error:$(printf '%s' "${out}" | tr '\n\t' '  ')" ;;
  esac
}

# "<PITR status> <period> <insights status> <ACTIVE Kinesis streams | none>
# <table policy> <stream policy>" for the table in region $1 (issue #5365).
replica_settings() {
  local d arn sarn pitr ci ks
  d="$(aws dynamodb describe-table --table-name "${TABLE}" --region "$1" \
    --query '[Table.TableArn, Table.LatestStreamArn]' --output text)" || return 1
  arn="$(printf '%s' "${d}" | cut -f1)"
  sarn="$(printf '%s' "${d}" | cut -f2)"
  pitr="$(aws dynamodb describe-continuous-backups --table-name "${TABLE}" --region "$1" \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.[PointInTimeRecoveryStatus, RecoveryPeriodInDays]' \
    --output text)" || return 1
  ci="$(aws dynamodb describe-contributor-insights --table-name "${TABLE}" --region "$1" \
    --query 'ContributorInsightsStatus' --output text)" || return 1
  ks="$(aws dynamodb describe-kinesis-streaming-destination --table-name "${TABLE}" --region "$1" \
    --query "join(',', KinesisDataStreamDestinations[?DestinationStatus=='ACTIVE'].StreamArn)" \
    --output text)" || return 1
  printf '%s\t%s\t%s\t%s\t%s\n' "${pitr}" "${ci}" "${ks:-none}" \
    "$(policy_state "$1" "${arn}")" "$(policy_state "$1" "${sarn}")"
}

# Poll until region $1's #5365 settings match the extended regex $2 (insights
# and streaming pass through ENABLING / DISABLING), then FAIL with $3.
await_replica() { # usage: await_replica <region> <regex> <failure message>
  local i got
  for i in $(seq 1 60); do
    got="$(replica_settings "$1")" || got="(read failed)"
    if printf '%s' "${got}" | grep -qE "$2"; then
      echo "    $1: ${got}"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: $3 ($1 reads '${got}')" >&2
  exit 1
}

# Delete Kinesis stream $2 in region $1 if it exists.
retire_stream() { # usage: retire_stream <region> <stream name>
  local out
  if ! out="$(aws kinesis delete-stream --stream-name "$2" --enforce-consumer-deletion \
    --region "$1" 2>&1)"; then
    case "${out}" in
      *ResourceNotFoundException*) ;;
      *) echo "WARN: cleanup could not delete Kinesis stream $2 in $1: ${out}" >&2 ;;
    esac
  fi
}

deploy() { # usage: deploy <CDKD_TEST_UPDATE modes> <log file>
  # --verbose: Phase 2 reads the replica convergence's debug lines.
  CDKD_TEST_UPDATE="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose 2>&1 | tee "$2"
}

# Schedule deletion of the key behind alias $2 in region $1, alias first so a
# re-run can create a fresh one under the same name.
retire_key() { # usage: retire_key <region> <alias>
  local key
  key="$(aws kms describe-key --key-id "$2" --region "$1" \
    --query 'KeyMetadata.[KeyId, KeyState]' --output text 2>/dev/null)" || return 0
  aws kms delete-alias --alias-name "$2" --region "$1" >/dev/null 2>&1
  case "${key}" in
    *Enabled)
      aws kms schedule-key-deletion --key-id "$(printf '%s' "${key}" | cut -f1)" \
        --pending-window-in-days 7 --region "$1" >/dev/null 2>&1 ||
        echo "WARN: cleanup could not schedule deletion of $2 in $1" >&2
      ;;
  esac
}

teardown_table() { # usage: teardown_table <table name>
  local tbl="$1" gone out status reps
  # Direct deletes by name, for a run that died before state existed or
  # whose destroy failed. Protection off first in BOTH regions: a
  # protected replica refuses its drop ("Disable deletion protection first").
  for r in "${REGION}" "${SECOND_REGION}"; do
    aws dynamodb update-table --table-name "${tbl}" --region "${r}" \
      --no-deletion-protection-enabled >/dev/null 2>&1
  done
  if aws dynamodb describe-table --table-name "${tbl}" --region "${REGION}" >/dev/null 2>&1; then
    gone=0
    for _ in $(seq 1 90); do
      if ! out="$(aws dynamodb describe-table --table-name "${tbl}" --region "${REGION}" \
        --query "[Table.TableStatus, join(' ', Table.Replicas[].RegionName || \`[]\`)]" --output text 2>&1)"; then
        if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then gone=1; break; fi
        sleep 10
        continue
      fi
      status="$(printf '%s' "${out}" | cut -f1)"
      reps="$(printf '%s' "${out}" | cut -f2-)"
      case " ${reps} " in
        *" ${SECOND_REGION} "*)
          # Refused while anything is UPDATING (the protection flip above
          # included), so re-issued once the table is ACTIVE.
          if [ "${status}" = "ACTIVE" ]; then
            aws dynamodb update-table --table-name "${tbl}" --region "${SECOND_REGION}" \
              --no-deletion-protection-enabled >/dev/null 2>&1
            aws dynamodb update-table --table-name "${tbl}" --region "${REGION}" \
              --replica-updates "Delete={RegionName=${SECOND_REGION}}" >/dev/null 2>&1
          fi
          ;;
        *) [ "${status}" = "ACTIVE" ] && break ;;
      esac
      sleep 10
    done
    if [ "${gone}" = "0" ]; then
      aws dynamodb delete-table --table-name "${tbl}" --region "${REGION}" >/dev/null 2>&1 ||
        echo "WARN: cleanup could not delete ${tbl} in ${REGION}; delete it by hand" >&2
    fi
  fi
  if ! out="$(aws dynamodb delete-table --table-name "${tbl}" --region "${SECOND_REGION}" 2>&1)"; then
    if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
      echo "WARN: cleanup could not delete ${tbl} in ${SECOND_REGION}; delete it by hand" >&2
    fi
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes --remove-protection >/dev/null 2>&1
  fi
  teardown_table "${TABLE}"
  teardown_table "${TABLE2}"
  # The local keys (stack-managed) when the destroy did not schedule them,
  # and the replica keys this fixture creates — by ARN too, in case the
  # alias was never created.
  retire_key "${REGION}" "${LOCAL_ALIAS}"
  retire_key "${REGION}" "${LOCAL_ALIAS}2"
  retire_key "${SECOND_REGION}" "${REPLICA_ALIAS}"
  retire_key "${SECOND_REGION}" "${REPLICA_ALIAS}2"
  # After the table: a streaming destination names the stream.
  retire_stream "${REGION}" "${LOCAL_KINESIS}"
  retire_stream "${SECOND_REGION}" "${REPLICA_KINESIS}"
  for arn in "${REPLICA_KEY_ARN:-}" "${REPLICA_KEY2_ARN:-}"; do
    [ -n "${arn}" ] && aws kms schedule-key-deletion --key-id "${arn}" --pending-window-in-days 7 \
      --region "${SECOND_REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}

# Names are per run, so a run killed before its trap ran leaves tables and
# keys no later cleanup names: sweep earlier runs' by prefix — only those
# older than 4 h (beyond this fixture's longest run), so a concurrent run of
# it is left alone.
run_is_stale() { # usage: run_is_stale <name containing ${BASE}-<epoch>-<pid>>
  local epoch
  epoch="$(printf '%s' "$1" | sed -nE "s/.*${BASE}-([0-9]{9,})-[0-9]+.*/\\1/p")"
  [ -n "${epoch}" ] && [ $(($(date +%s) - epoch)) -gt 14400 ]
}
sweep_previous_runs() {
  set +eu
  local tbl r a k state st swept=" "
  for r in "${REGION}" "${SECOND_REGION}"; do
    for tbl in $(aws dynamodb list-tables --region "${r}" \
      --query "TableNames[?starts_with(@, '${BASE}-')]" --output text 2>/dev/null); do
      run_is_stale "${tbl}" || continue
      # The REGION-side teardown drops the replica too.
      case "${swept}" in *" ${tbl} "*) continue ;; esac
      echo "    sweeping ${tbl} (${r})"
      if [ "${r}" = "${REGION}" ]; then
        teardown_table "${tbl}"
        swept="${swept}${tbl} "
      else
        aws dynamodb update-table --table-name "${tbl}" --region "${r}" \
          --no-deletion-protection-enabled >/dev/null 2>&1
        # The protection change leaves the table UPDATING, and DeleteTable
        # is refused until it is ACTIVE again (bounded: 5 min).
        for _ in $(seq 1 30); do
          [ "$(aws dynamodb describe-table --table-name "${tbl}" --region "${r}" \
            --query 'Table.TableStatus' --output text 2>/dev/null)" = "ACTIVE" ] && break
          sleep 10
        done
        aws dynamodb delete-table --table-name "${tbl}" --region "${r}" >/dev/null 2>&1 ||
          echo "WARN: sweep could not delete ${tbl} in ${r}; delete it by hand" >&2
      fi
    done
    for a in $(aws kms list-aliases --region "${r}" \
      --query "Aliases[?starts_with(AliasName, 'alias/${BASE}-')].AliasName" --output text 2>/dev/null); do
      run_is_stale "${a}" || continue
      echo "    sweeping ${a} (${r})"
      retire_key "${r}" "${a}"
    done
    for k in $(aws kinesis list-streams --region "${r}" \
      --query "StreamNames[?starts_with(@, '${BASE}-')]" --output text 2>/dev/null); do
      run_is_stale "${k}" || continue
      echo "    sweeping stream ${k} (${r})"
      retire_stream "${r}" "${k}"
    done
    # Keys this script created whose alias never was (the run died between
    # create-key and create-alias): found by tag, aged by their description.
    for k in $(aws resourcegroupstaggingapi get-resources --region "${r}" \
      --resource-type-filters kms --tag-filters "Key=${KEY_TAG},Values=${BASE}" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null); do
      state="$(aws kms describe-key --key-id "${k}" --region "${r}" \
        --query 'KeyMetadata.[KeyState, Description]' --output text 2>/dev/null)" || continue
      case "${state}" in Enabled*) ;; *) continue ;; esac
      run_is_stale "${state}" || continue
      echo "    sweeping key ${k} (${r})"
      aws kms schedule-key-deletion --key-id "${k}" --pending-window-in-days 7 --region "${r}" >/dev/null 2>&1
    done
  done
  # State left by a run killed before its destroy.
  if [ -n "${STATE_BUCKET:-}" ]; then
    for st in $(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "cdkd/${BASE}-" \
      --query 'Contents[].Key' --output text 2>/dev/null); do
      [ "${st}" = "None" ] && continue
      run_is_stale "${st}" || continue
      echo "    sweeping state ${st}"
      aws s3 rm "s3://${STATE_BUCKET}/${st}" >/dev/null 2>&1
    done
  fi
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
sweep_previous_runs
cleanup
LOG_DIR="$(mktemp -d)"

echo "==> Creating the ${SECOND_REGION} replica keys"
REPLICA_KEY_ARN="$(aws kms create-key --region "${SECOND_REGION}" \
  --description "cdkd integ ${STACK} replica key (issue 5355)" \
  --tags "TagKey=${KEY_TAG},TagValue=${BASE}" --query 'KeyMetadata.Arn' --output text)"
aws kms create-alias --alias-name "${REPLICA_ALIAS}" --target-key-id "${REPLICA_KEY_ARN}" \
  --region "${SECOND_REGION}"
REPLICA_KEY2_ARN="$(aws kms create-key --region "${SECOND_REGION}" \
  --description "cdkd integ ${STACK} second replica key (issue 5355)" \
  --tags "TagKey=${KEY_TAG},TagValue=${BASE}" --query 'KeyMetadata.Arn' --output text)"
aws kms create-alias --alias-name "${REPLICA_ALIAS}2" --target-key-id "${REPLICA_KEY2_ARN}" \
  --region "${SECOND_REGION}"
export CDKD_INTEG_REPLICA_KEY_ARN="${REPLICA_KEY_ARN}"
export CDKD_INTEG_REPLICA_KEY2_ARN="${REPLICA_KEY2_ARN}"
echo "    ${REPLICA_KEY_ARN} ${REPLICA_KEY2_ARN}"

echo "==> Creating the ${SECOND_REGION} Kinesis stream (issue #5365)"
aws kinesis create-stream --stream-name "${REPLICA_KINESIS}" \
  --stream-mode-details StreamMode=ON_DEMAND --region "${SECOND_REGION}"
aws kinesis wait stream-exists --stream-name "${REPLICA_KINESIS}" --region "${SECOND_REGION}"
REPLICA_KINESIS_ARN="$(aws kinesis describe-stream-summary --stream-name "${REPLICA_KINESIS}" \
  --region "${SECOND_REGION}" --query 'StreamDescriptionSummary.StreamARN' --output text)"
export CDKD_INTEG_REPLICA_STREAM_ARN="${REPLICA_KINESIS_ARN}"
echo "    ${REPLICA_KINESIS_ARN}"

# --- Phase 1: deploy with every replica setting --------------------------
echo "==> Phase 1: deploy (${REGION} + ${SECOND_REGION}): customer managed keys, STANDARD_INFREQUENT_ACCESS, replica protected"
deploy "" "${LOG_DIR}/phase1.log"
wait_settled
LOCAL_KEY_ARN="$(aws kms describe-key --key-id "${LOCAL_ALIAS}" --region "${REGION}" \
  --query 'KeyMetadata.Arn' --output text)"
# Exact matches: a pre-fix binary encrypts both regions under the AWS managed
# key (a different ARN), keeps STANDARD, and leaves the replica unprotected.
await_settings "${REGION}" "^ENABLED	KMS	${LOCAL_KEY_ARN}	STANDARD_INFREQUENT_ACCESS	False$" \
  "Phase 1: the ${REGION} table is not on its customer managed key with STANDARD_INFREQUENT_ACCESS (issue #5355)"
await_settings "${SECOND_REGION}" "^ENABLED	KMS	${REPLICA_KEY_ARN}	STANDARD_INFREQUENT_ACCESS	True$" \
  "Phase 1: the ${SECOND_REGION} replica is not on its customer managed key with STANDARD_INFREQUENT_ACCESS and deletion protection (issue #5355)"
LOCAL_KINESIS_ARN="$(aws kinesis describe-stream-summary --stream-name "${LOCAL_KINESIS}" \
  --region "${REGION}" --query 'StreamDescriptionSummary.StreamARN' --output text)"
# A pre-fix binary sends none of these: PITR and insights read DISABLED, no
# stream is ACTIVE, and the stream has no policy.
await_replica "${REGION}" "^ENABLED	10	ENABLED	${LOCAL_KINESIS_ARN}	absent	present$" \
  "Phase 1: the ${REGION} table lacks its point-in-time recovery, Contributor Insights, Kinesis stream or stream policy (issue #5365)"
await_replica "${SECOND_REGION}" "^ENABLED	10	ENABLED	${REPLICA_KINESIS_ARN}	absent	present$" \
  "Phase 1: the ${SECOND_REGION} replica lacks its point-in-time recovery, Contributor Insights, Kinesis stream or stream policy (issue #5365)"

# --- Phase 2: an unchanged `true` is converged on the next update ---------
echo "==> Phase 2: unprotect the replica out of band, then deploy an ordinary change"
# Phase 1 set this replica's protection moments ago, and DynamoDB throttles a
# second protection change on one table within 15 s: retry that throttle
# (bounded), fail on anything else.
unprotected=0
for _ in 1 2 3 4; do
  if out="$(aws dynamodb update-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
    --no-deletion-protection-enabled 2>&1 >/dev/null)"; then
    unprotected=1
    break
  fi
  case "${out}" in
    *ThrottlingException*) echo "    protection change throttled; retrying in 16 s"; sleep 16 ;;
    *) echo "FAIL: Phase 2 premise: the out-of-band unprotect failed: ${out}" >&2; exit 1 ;;
  esac
done
if [ "${unprotected}" != "1" ]; then
  echo "FAIL: Phase 2 premise: the out-of-band unprotect stayed throttled" >&2
  exit 1
fi
wait_settled
await_settings "${SECOND_REGION}" "	False$" "Phase 2 premise: the out-of-band unprotect did not land"
# A replica deployed by a pre-#5365 binary holds no point-in-time recovery.
aws dynamodb update-continuous-backups --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=false >/dev/null
await_replica "${SECOND_REGION}" "^DISABLED	" "Phase 2 premise: the out-of-band PITR disable did not land"
deploy "tag" "${LOG_DIR}/phase2.log"
wait_settled
TABLE_ARN="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query 'Table.TableArn' --output text)"
TAG_VALUE="$(aws dynamodb list-tags-of-resource --resource-arn "${TABLE_ARN}" --region "${REGION}" \
  --query "Tags[?Key=='Cdkd5355'].Value | [0]" --output text)"
if [ "${TAG_VALUE}" != "tagged" ]; then
  echo "FAIL: Phase 2: the tag did not reach AWS (got '${TAG_VALUE}') — update() never ran, so the phase proves nothing" >&2
  exit 1
fi
await_settings "${SECOND_REGION}" "	True$" \
  "Phase 2: the replica's unchanged DeletionProtectionEnabled=true was not converged back on (issue #5355)"
# The class and the key ARNs every region already holds must read as in sync
# — a mismatch here (e.g. AWS reporting a key in another form) would send a
# corrective UpdateTable, and its wait, on every update.
for line in "The ${SECOND_REGION} replica of ${TABLE} already holds its declared table class" \
  "Every region of ${TABLE} already holds its declared KMS key"; do
  if ! grep -qF "${line}" "${LOG_DIR}/phase2.log"; then
    echo "FAIL: Phase 2: missing the in-sync debug line '${line}' (issue #5355)" >&2
    exit 1
  fi
done
await_replica "${SECOND_REGION}" "^ENABLED	10	ENABLED	${REPLICA_KINESIS_ARN}	absent	present$" \
  "Phase 2: the replica's unchanged point-in-time recovery was not converged back on (issue #5365)"
if ! grep -qF "Bringing the ${SECOND_REGION} replica of ${TABLE} to its declared PointInTimeRecoverySpecification" "${LOG_DIR}/phase2.log"; then
  echo "FAIL: Phase 2: missing the PITR correction debug line (issue #5365)" >&2
  exit 1
fi
for line in "Bringing the ${SECOND_REGION} replica of ${TABLE} to its declared table class" \
  "Setting the KMS key of every region of ${TABLE}" \
  "Bringing the ${SECOND_REGION} replica of ${TABLE} to its declared ContributorInsightsSpecification" \
  "Bringing the ${SECOND_REGION} replica of ${TABLE} to its declared KinesisStreamSpecification" \
  "Bringing the ${SECOND_REGION} replica of ${TABLE} to its declared ReplicaStreamSpecification" \
  "Bringing the ${REGION} replica of ${TABLE} to its declared"; do
  if grep -qF "${line}" "${LOG_DIR}/phase2.log"; then
    echo "FAIL: Phase 2: cdkd issued a corrective update for settings AWS already holds: '${line}' (issue #5355)" >&2
    exit 1
  fi
done
echo "    no corrective replica update"

# --- Phase 2b: a table resource policy on an existing replica (#5365) -----
echo "==> Phase 2b: add a table resource policy to both replicas"
deploy "tag,policy" "${LOG_DIR}/phase2b.log"
wait_settled
await_replica "${REGION}" "^ENABLED	10	ENABLED	${LOCAL_KINESIS_ARN}	present	present$" \
  "Phase 2b: the ${REGION} table has no resource policy (issue #5365)"
await_replica "${SECOND_REGION}" "^ENABLED	10	ENABLED	${REPLICA_KINESIS_ARN}	present	present$" \
  "Phase 2b: the ${SECOND_REGION} replica has no resource policy (issue #5365)"

# --- Phase 2c: drift reads the replica settings back (#5381) ---------------
# The read-back used to drop a replica's PITR period, its table resource policy
# and a cross-region replica's protection, so none of the three out-of-band
# changes below was drift (a pre-fix binary reports the table clean at step 2),
# and `drift --revert` could not restore them.
echo "==> Phase 2c: drift is clean, then sees an out-of-band period, policy and protection change"
DRIFT_OUT="${LOG_DIR}/drift.log"
run_drift() { # usage: run_drift <expected exit code> [phase label]; output in ${DRIFT_OUT}
  local rc
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    > "${DRIFT_OUT}" 2>&1
  rc=$?
  set -e
  cat "${DRIFT_OUT}"
  # 0 = no drift, 1 = drift (docs/cli-drift.md); anything else, or a crash
  # printing no row at all, must not read as "clean".
  if [ "${rc}" != "$1" ]; then
    echo "FAIL: ${2:-Phase 2c (issue #5381)}: drift exited ${rc}, expected $1" >&2
    exit 1
  fi
}
GT_ROW='[~?] [A-Za-z0-9]+ \(AWS::DynamoDB::GlobalTable\)'
# 1. Clean: every member the read-back now carries equals the baseline the
#    Phase 2b deploy captured (no phantom drift from the new members).
run_drift 0
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: Phase 2c: drift reports the untouched GlobalTable (issue #5381)" >&2
  exit 1
fi
echo "    OK: the untouched GlobalTable is not drift"
# 2. Out of band, on the second region's replica: a 20-day period, no table
#    resource policy, no deletion protection.
aws dynamodb update-continuous-backups --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true,RecoveryPeriodInDays=20 >/dev/null
SECOND_TABLE_ARN="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --query 'Table.TableArn' --output text)"
aws dynamodb delete-resource-policy --resource-arn "${SECOND_TABLE_ARN}" --region "${SECOND_REGION}" >/dev/null
unprotected=0
for _ in 1 2 3 4; do
  if out="$(aws dynamodb update-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
    --no-deletion-protection-enabled 2>&1 >/dev/null)"; then
    unprotected=1
    break
  fi
  case "${out}" in
    *ThrottlingException*) echo "    protection change throttled; retrying in 16 s"; sleep 16 ;;
    *) echo "FAIL: Phase 2c premise: the out-of-band unprotect failed: ${out}" >&2; exit 1 ;;
  esac
done
if [ "${unprotected}" != "1" ]; then
  echo "FAIL: Phase 2c premise: the out-of-band unprotect stayed throttled" >&2
  exit 1
fi
wait_settled
await_settings "${SECOND_REGION}" "	False$" "Phase 2c premise: the out-of-band unprotect did not land"
await_replica "${SECOND_REGION}" "^ENABLED	20	ENABLED	${REPLICA_KINESIS_ARN}	absent	present$" \
  "Phase 2c premise: the out-of-band period change or policy delete did not land"
run_drift 1
if ! grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: Phase 2c: drift does not report the out-of-band replica changes (issue #5381)" >&2
  exit 1
fi
# The second region's entry on each side of the `Replicas` change: the
# recorded period / policy / protection against the out-of-band ones.
replica_side() { # usage: replica_side <-|+>; prints "<period> <policy?> <protection>"
  grep -E "^ +\\$1 Replicas: " "${DRIFT_OUT}" | head -1 | sed -E "s/^ +\\$1 Replicas: //" \
    | REGION_NAME="${SECOND_REGION}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(e=>e.Region===process.env.REGION_NAME)||{};const p=r.PointInTimeRecoverySpecification||{};process.stdout.write([p.RecoveryPeriodInDays,"ResourcePolicy" in r?"policy":"nopolicy",r.DeletionProtectionEnabled].join(" "))})'
}
RECORDED="$(replica_side -)" || RECORDED="(unparsed)"
LIVE="$(replica_side +)" || LIVE="(unparsed)"
if [ "${RECORDED}" != "10 policy true" ] || [ "${LIVE}" != "20 nopolicy false" ]; then
  echo "FAIL: Phase 2c: expected the ${SECOND_REGION} replica to drift '10 policy true' -> '20 nopolicy false', got '${RECORDED}' -> '${LIVE}' (issue #5381)" >&2
  exit 1
fi
echo "    OK: drift reports ${SECOND_REGION} '${RECORDED}' -> '${LIVE}'"
# 3. --revert restores all three, and drift is clean again.
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes 2>&1 | tee "${LOG_DIR}/phase2c-revert.log"
wait_settled
await_settings "${SECOND_REGION}" "	True$" "Phase 2c: drift --revert did not protect the replica again (issue #5381)"
await_replica "${SECOND_REGION}" "^ENABLED	10	ENABLED	${REPLICA_KINESIS_ARN}	present	present$" \
  "Phase 2c: drift --revert did not restore the 10-day period and the table resource policy (issue #5381)"
run_drift 0
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: Phase 2c: the GlobalTable still drifts after --revert (issue #5381)" >&2
  exit 1
fi
echo "    OK: clean after --revert"

# --- Phase 3: rotate to a second customer managed key in each region -------
# DynamoDB takes this only as ONE ReplicaUpdates call naming every region's
# key; SSESpecification and a one-replica Update are refused (measured).
echo "==> Phase 3: rotate both regions to their second customer managed key"
deploy "tag,policy,rotated" "${LOG_DIR}/phase3.log"
wait_settled
LOCAL_KEY2_ARN="$(aws kms describe-key --key-id "${LOCAL_ALIAS}2" --region "${REGION}" \
  --query 'KeyMetadata.Arn' --output text)"
await_settings "${REGION}" "^ENABLED	KMS	${LOCAL_KEY2_ARN}	STANDARD_INFREQUENT_ACCESS	False$" \
  "Phase 3: the ${REGION} table is not on its second customer managed key (issue #5355)"
await_settings "${SECOND_REGION}" "^ENABLED	KMS	${REPLICA_KEY2_ARN}	STANDARD_INFREQUENT_ACCESS	True$" \
  "Phase 3: the ${SECOND_REGION} replica is not on its second customer managed key (issue #5355)"
if ! grep -qF "Setting the KMS key of every region of ${TABLE}" "${LOG_DIR}/phase3.log"; then
  echo "FAIL: Phase 3: the key rotation did not go out as one every-region ReplicaUpdates call (issue #5355)" >&2
  exit 1
fi

# --- Phase 4: customer managed keys -> the AWS managed key -----------------
echo "==> Phase 4: move both regions to the AWS managed key"
deploy "tag,policy,managed" "${LOG_DIR}/phase4.log"
wait_settled
LOCAL_MANAGED_ARN="$(aws kms describe-key --key-id alias/aws/dynamodb --region "${REGION}" \
  --query 'KeyMetadata.Arn' --output text)"
SECOND_MANAGED_ARN="$(aws kms describe-key --key-id alias/aws/dynamodb --region "${SECOND_REGION}" \
  --query 'KeyMetadata.Arn' --output text)"
await_settings "${REGION}" "^ENABLED	KMS	${LOCAL_MANAGED_ARN}	STANDARD_INFREQUENT_ACCESS	False$" \
  "Phase 4: the ${REGION} table is not on the AWS managed key (issue #5355)"
await_settings "${SECOND_REGION}" "^ENABLED	KMS	${SECOND_MANAGED_ARN}	STANDARD_INFREQUENT_ACCESS	True$" \
  "Phase 4: the ${SECOND_REGION} replica is not on its region's AWS managed key (issue #5355)"

# --- Phase 5: removals reset, as CloudFormation does ---------------------
echo "==> Phase 5: remove the key, the table class and the replica's protection"
deploy "tag,removed" "${LOG_DIR}/phase5.log"
wait_settled
# An AWS owned key reads back as no SSEDescription (None) — what the CFn A/B
# measured once SSESpecification was removed.
await_settings "${REGION}" "^None	None	None	STANDARD	False$" \
  "Phase 5: the ${REGION} table did not reset to the AWS owned key and STANDARD (issue #5355)"
await_settings "${SECOND_REGION}" "^None	None	None	STANDARD	False$" \
  "Phase 5: the ${SECOND_REGION} replica did not reset to the AWS owned key, STANDARD and no protection (issue #5355)"
if ! grep -qF "Auto-disabling DeletionProtectionEnabled on the ${SECOND_REGION} replica" "${LOG_DIR}/phase5.log"; then
  echo "FAIL: Phase 5: cdkd did not warn that it turned the ${SECOND_REGION} replica's protection off" >&2
  exit 1
fi
echo "    auto-disable warning printed"
# CloudFormation's removal semantics (measured for #5365): everything off.
await_replica "${REGION}" "^DISABLED	None	DISABLED	none	absent	absent$" \
  "Phase 5: the ${REGION} table did not reset its point-in-time recovery, insights, Kinesis stream and policies (issue #5365)"
await_replica "${SECOND_REGION}" "^DISABLED	None	DISABLED	none	absent	absent$" \
  "Phase 5: the ${SECOND_REGION} replica did not reset its point-in-time recovery, insights, Kinesis stream and policies (issue #5365)"

# --- Phase 5b: drift --revert returns the AWS owned key (#5399) ----------
# On its OWN table (`ssetable`): ${TABLE} has switched encryption four times
# by now (keys, rotation, AWS managed, AWS owned), and DynamoDB refused a
# further switch on it with LimitExceededException. The new table is created
# on the AWS owned key, so its baseline has no top-level SSESpecification.
# Moved out of band to the customer managed keys, drift used to report only
# the replicas' keys, and `drift --revert` kept the live SSESpecification, so
# the table stayed on the keys.
echo "==> Phase 5b: a second table on the AWS owned key, moved to customer managed keys out of band, then drift --revert"
PHASE5B="Phase 5b (issue #5399)"
deploy "tag,removed,ssetable" "${LOG_DIR}/phase5b.log"
GT_TABLE="${TABLE2}"
wait_settled
await_settings "${REGION}" "^None	None	None	STANDARD	False$" \
  "${PHASE5B} premise: the ${TABLE2} table is not on the AWS owned key"
await_settings "${SECOND_REGION}" "^None	None	None	STANDARD	False$" \
  "${PHASE5B} premise: the ${TABLE2} replica is not on the AWS owned key"
run_drift 0 "${PHASE5B}"
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: ${PHASE5B}: drift reports a GlobalTable before the out-of-band change" >&2
  exit 1
fi
# DynamoDB takes a customer managed key on a table with replicas only as one
# ReplicaUpdates call naming every region's key (measured, Phase 3).
aws dynamodb update-table --table-name "${TABLE2}" --region "${REGION}" --replica-updates \
  "[{\"Update\":{\"RegionName\":\"${REGION}\",\"KMSMasterKeyId\":\"${LOCAL_KEY_ARN}\"}},{\"Update\":{\"RegionName\":\"${SECOND_REGION}\",\"KMSMasterKeyId\":\"${REPLICA_KEY_ARN}\"}}]" \
  >/dev/null
wait_settled
await_settings "${REGION}" "^ENABLED	KMS	${LOCAL_KEY_ARN}	STANDARD	False$" \
  "${PHASE5B} premise: the out-of-band move to the customer managed key did not land"
await_settings "${SECOND_REGION}" "^ENABLED	KMS	${REPLICA_KEY_ARN}	STANDARD	False$" \
  "${PHASE5B} premise: the out-of-band move did not reach the replica"
run_drift 1 "${PHASE5B}"
if ! grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: ${PHASE5B}: drift does not report the out-of-band key" >&2
  exit 1
fi
# A pre-fix binary fails here: the recorded side has no SSESpecification, and
# the comparator walked only the recorded side's top-level keys.
if ! grep -qE '^ +\+ SSESpecification: \{"SSEEnabled":true,"SSEType":"KMS"\}' "${DRIFT_OUT}"; then
  echo "FAIL: ${PHASE5B}: drift does not report SSESpecification moving off the AWS owned key" >&2
  exit 1
fi
echo "    OK: drift reports the move off the AWS owned key"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes 2>&1 | tee "${LOG_DIR}/phase5b-revert.log"
wait_settled
# An AWS owned key reads back as no SSEDescription (None), as in Phase 5.
await_settings "${REGION}" "^None	None	None	STANDARD	False$" \
  "${PHASE5B}: drift --revert did not return the ${REGION} table to the AWS owned key"
await_settings "${SECOND_REGION}" "^None	None	None	STANDARD	False$" \
  "${PHASE5B}: drift --revert did not return the ${SECOND_REGION} replica to the AWS owned key"
run_drift 0 "${PHASE5B}"
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: ${PHASE5B}: a GlobalTable still drifts after --revert" >&2
  exit 1
fi
unset GT_TABLE
echo "    OK: back on the AWS owned key, and clean after --revert"

# --- Phase 6: protect the replica again ----------------------------------
echo "==> Phase 6: protect the replica again"
# DynamoDB refuses a second protection change on one table within 15 s.
sleep 16
deploy "tag,removed,protect,ssetable" "${LOG_DIR}/phase6.log"
wait_settled
await_settings "${SECOND_REGION}" "	True$" "Phase 6: the replica was not protected again (issue #5355)"

# --- Phase 7: destroy --remove-protection ---------------------------------
echo "==> Phase 7: destroy --remove-protection"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

assert_gone "table ${TABLE} still exists in ${REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
for _ in $(seq 1 30); do
  gone_probe aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}" && break
  sleep 10
done
assert_gone "replica ${TABLE} still exists in ${SECOND_REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}"
echo "    table deleted in both regions"
for r in "${REGION}" "${SECOND_REGION}"; do
  for _ in $(seq 1 30); do
    gone_probe aws dynamodb describe-table --table-name "${TABLE2}" --region "${r}" && break
    sleep 10
  done
  assert_gone "table ${TABLE2} still exists in ${r} after destroy" aws dynamodb describe-table --table-name "${TABLE2}" --region "${r}"
done
echo "    the Phase 5b table deleted in both regions"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"
# The two stack-created keys go with the stack (RemovalPolicy.DESTROY).
for k in "${LOCAL_KEY_ARN}" "${LOCAL_KEY2_ARN}"; do
  got="$(aws kms describe-key --key-id "${k}" --region "${REGION}" --query 'KeyMetadata.KeyState' --output text)"
  if [ "${got}" != "PendingDeletion" ]; then
    echo "FAIL: Phase 7: stack key ${k} is ${got} after destroy, not PendingDeletion" >&2
    exit 1
  fi
done
echo "    both stack keys pending deletion"

echo "[verify] PASS — GlobalTable replica KMS key, table class and deletion protection (issue #5355) and point-in-time recovery, Contributor Insights, Kinesis stream and resource policies (issue #5365) reach AWS and reset on removal, all phases passed"
