#!/usr/bin/env bash
# verify.sh — cdkd GlobalTable replica settings integ (issues #5355, #5365, #5381, #5399, #5489).
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
#  1a. `gsi` under a 15s per-type deadline (go-to-k/cdkd#5487): the GSI add
#      fails mid backfill and the record must name GlobalSecondaryIndexes
#      unsettled; a same-template retry right after must either be refused
#      (gsi1 still CREATING, name kept) or converge (gsi1 ACTIVE, name cleared,
#      nothing sent). The record also names gsi1 as the index the accepted
#      Create added (`unsettledItems`, go-to-k/cdkd#5498). The base redeploy
#      then clears the name and DELETES gsi1: after (a) because the failed
#      update created it and the template no longer names it; after (b)
#      because the retry recorded it, an ordinary removal.
#  1a2. With `Replicas` marked unsettled on the record and the template
#      unchanged, the converging deploy must send no replica change, keep both
#      replicas and the second replica's protection, and clear the name.
#  1b. `idx` (issue #5489): add a global secondary index whose per-replica
#      Contributor Insights is on, a tag on each replica's stream, and a
#      single-region `ModeTable` declaring GlobalTableSettingsReplicationMode
#      ENABLED. Assert the index's insights are ENABLED and each stream holds
#      its tag in both regions, and the ModeTable reads ENABLED (a pre-fix
#      binary sends none of the three).
#  1c. `idx,lsi` and `idx,replmode` (issue #5489): a local secondary index
#      added to the live ModeTable, and a replication mode on the two-replica
#      table, must each be REFUSED (CloudFormation fails both); a pre-fix
#      binary deployed both green with nothing applied.
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
#      The #5489 index insights read DISABLED and the stream tags are gone.
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
# Issue #5489's single-region ModeTable (`idx`).
TABLE3="${STACK}-table3"
# go-to-k/cdkd#2762's tables (`ts`): vector indexes and warm throughput, and the
# table-level read ceiling.
TABLE4="${STACK}-table4"
TABLE5="${STACK}-table5"
TABLE6="${STACK}-table6"
# go-to-k/cdkd#5604: flat capacity on a single-region table, literal and auto-scaled
# write.
TABLE7="${STACK}-table7"
TABLE8="${STACK}-table8"
# Two regions, each with its own read capacity.
TABLE9="${STACK}-table9"
LOCAL_ALIAS="alias/${STACK}-local"
REPLICA_ALIAS="alias/${STACK}-replica"
# Phase 5b's out-of-band key for ${TABLE2} in ${REGION}: fixture-owned, NOT the
# stack's LocalKey. The template never ties ${TABLE2} to a key, so a stack key
# under it is scheduled for deletion by the stack's destroy while the table is
# still being deleted, and a table deleting on a key pending deletion stays in
# DELETING indefinitely (it happened to a failed run's table2). This key is
# retired only once every table is gone.
OOB_ALIAS="alias/${STACK}-oob"
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
# names the table this and `wait_settled` read instead of `${TABLE}` (Phase 5b,
# whose table declares no table class, so its class reads as None).
table_settings() {
  aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "$1" \
    --query '[Table.SSEDescription.Status, Table.SSEDescription.SSEType, Table.SSEDescription.KMSMasterKeyArn, Table.TableClassSummary.TableClass, Table.DeletionProtectionEnabled]' \
    --output text
}

# Table and replica ACTIVE in the deploy region, and the second region's copy
# ACTIVE: an SSE / class / protection change leaves one or the other UPDATING
# for a while, and the next deploy or destroy would be refused meanwhile.
wait_settled() {
  local i tbl reps second sse sse2
  for i in $(seq 1 90); do
    tbl="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    reps="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${REGION}" \
      --query "join(' ', Table.Replicas[].ReplicaStatus || \`[]\`)" --output text)" || return 1
    second="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${SECOND_REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    # An encryption change (a key move) leaves SSEDescription UPDATING while
    # the table already reads ACTIVE, and DynamoDB refuses the next change
    # (or a delete) meanwhile.
    sse="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${REGION}" \
      --query 'Table.SSEDescription.Status' --output text)" || return 1
    sse2="$(aws dynamodb describe-table --table-name "${GT_TABLE:-${TABLE}}" --region "${SECOND_REGION}" \
      --query 'Table.SSEDescription.Status' --output text)" || return 1
    if [ "${tbl}" = "ACTIVE" ] && [ "${reps}" = "ACTIVE" ] && [ "${second}" = "ACTIVE" ] &&
      [ "${sse}" != "UPDATING" ] && [ "${sse2}" != "UPDATING" ]; then
      echo "    settled (table=${tbl} replicas=${reps} ${SECOND_REGION}=${second} sse=${sse}/${sse2})"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: table did not settle (table='${tbl}' replicas='${reps}' ${SECOND_REGION}='${second}' sse='${sse}/${sse2}')" >&2
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

# "<gsi1 insights status> <the stream's Cdkd5489 tag | none>" for ${TABLE} in
# region $1 (issue #5489).
index_settings() {
  local sarn ci tag
  sarn="$(aws dynamodb describe-table --table-name "${TABLE}" --region "$1" \
    --query 'Table.LatestStreamArn' --output text)" || return 1
  ci="$(aws dynamodb describe-contributor-insights --table-name "${TABLE}" --index-name gsi1 \
    --region "$1" --query 'ContributorInsightsStatus' --output text)" || return 1
  tag="$(aws dynamodb list-tags-of-resource --resource-arn "${sarn}" --region "$1" \
    --query "Tags[?Key=='Cdkd5489'].Value | [0]" --output text)" || return 1
  [ "${tag}" = "None" ] && tag=none
  printf '%s\t%s\n' "${ci}" "${tag}"
}

# Poll until region $1's #5489 settings match the extended regex $2 (insights
# pass through ENABLING / DISABLING), then FAIL with $3.
await_index() { # usage: await_index <region> <regex> <failure message>
  local i got
  for i in $(seq 1 60); do
    got="$(index_settings "$1")" || got="(read failed)"
    if printf '%s' "${got}" | grep -qE "$2"; then
      echo "    $1: ${got}"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: $3 ($1 reads '${got}')" >&2
  exit 1
}

# A deploy that must be REFUSED with a message matching the fixed string $3
# (issue #5489). `deploy` pipes through tee, so its status is the pipeline's.
deploy_refused() { # usage: deploy_refused <modes> <log file> <expected message> <phase label>
  if deploy "$1" "$2"; then
    echo "FAIL: $4: the deploy succeeded, but must be refused (issue #5489)" >&2
    exit 1
  fi
  if ! grep -qF "$3" "$2"; then
    echo "FAIL: $4: the deploy failed without the refusal '$3' (issue #5489)" >&2
    exit 1
  fi
  echo "    refused: $3"
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

# Region $2's copy of table $1 ACTIVE with no encryption change in flight, or
# gone. Bounded: 15 min, or the epoch second $3 when given (a caller's own
# deadline). Returns 1 at the bound.
await_table_idle() { # usage: await_table_idle <table name> <region> [deadline epoch]
  local out deadline="${3:-$(($(date +%s) + 900))}"
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    if ! out="$(aws dynamodb describe-table --table-name "$1" --region "$2" \
      --query '[Table.TableStatus, Table.SSEDescription.Status]' --output text 2>&1)"; then
      printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' && return 0
    else
      case "${out}" in ACTIVE*UPDATING*) ;; ACTIVE*) return 0 ;; esac
    fi
    sleep 10
  done
  return 1
}

# DeleteTable for table $1 in region $2, keeping AWS's answer. Not found is the
# goal. A ResourceInUseException (the table, a replica or its encryption still
# changing) waits the table out and retries; a deletion-protection refusal
# turns protection off there first. Anything else, or ONE deadline for the
# whole call (15 min from its start, waits included), is recorded WITH AWS's
# last message and returns 1.
delete_table_logged() { # usage: delete_table_logged <table name> <region>
  local out="(no attempt)" why="refused" deadline=$(($(date +%s) + 900))
  while :; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      why="not deleted within 15 min"
      break
    fi
    if out="$(aws dynamodb delete-table --table-name "$1" --region "$2" 2>&1)"; then
      return 0
    fi
    if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
      return 0
    fi
    if printf '%s' "${out}" | grep -qiE 'deletion protection'; then
      echo "    ${1} (${2}): deletion protection is on; turning it off before the delete"
      local flip
      flip="$(aws dynamodb update-table --table-name "$1" --region "$2" \
        --no-deletion-protection-enabled 2>&1 >/dev/null)" ||
        echo "    ${1} (${2}): turning deletion protection off was refused; retrying: $(printf '%s' "${flip}" | tr '\n' ' ')" >&2
      await_table_idle "$1" "$2" "${deadline}"
      sleep 10
      continue
    fi
    if printf '%s' "${out}" | grep -qiE 'ResourceInUseException|LimitExceededException'; then
      echo "    ${1} (${2}): delete refused while it is changing; waiting: $(printf '%s' "${out}" | tr '\n' ' ')"
      await_table_idle "$1" "$2" "${deadline}"
      sleep 10
      continue
    fi
    break
  done
  echo "ERROR: cleanup could not delete ${1} in ${2} (${why}): $(printf '%s' "${out}" | tr '\n' ' ')" >&2
  CLEANUP_STRANDED=1
  return 1
}

teardown_table() { # usage: teardown_table <table name>
  local tbl="$1" gone out status reps prot rc=0
  # Direct deletes by name, for a run that died before state existed or
  # whose destroy failed. Protection off first in each region that has it on
  # (only there: the flip leaves the table UPDATING): a protected replica
  # refuses its drop ("Disable deletion protection first").
  for r in "${REGION}" "${SECOND_REGION}"; do
    # A failed read (gone, or a throttle) flips nothing here: a protection
    # refusal is still handled by delete_table_logged below.
    prot="$(aws dynamodb describe-table --table-name "${tbl}" --region "${r}" \
      --query 'Table.DeletionProtectionEnabled' --output text 2>/dev/null)" || prot="read-failed:$?"
    if [ "${prot}" = "True" ]; then
      await_table_idle "${tbl}" "${r}"
      if ! out="$(aws dynamodb update-table --table-name "${tbl}" --region "${r}" \
        --no-deletion-protection-enabled 2>&1)"; then
        echo "    ${tbl} (${r}): turning deletion protection off failed: $(printf '%s' "${out}" | tr '\n' ' ')" >&2
      fi
    fi
  done
  if aws dynamodb describe-table --table-name "${tbl}" --region "${REGION}" >/dev/null 2>&1; then
    gone=0
    for _ in $(seq 1 90); do
      if ! out="$(aws dynamodb describe-table --table-name "${tbl}" --region "${REGION}" \
        --query "[Table.TableStatus, join(' ', Table.Replicas[].RegionName || \`[]\`), Table.SSEDescription.Status]" --output text 2>&1)"; then
        if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then gone=1; break; fi
        sleep 10
        continue
      fi
      status="$(printf '%s' "${out}" | cut -f1)"
      reps="$(printf '%s' "${out}" | cut -f2)"
      # An encryption change still in flight refuses every change below.
      if [ "$(printf '%s' "${out}" | cut -f3)" = "UPDATING" ]; then
        sleep 10
        continue
      fi
      case " ${reps} " in
        *" ${SECOND_REGION} "*)
          # Refused while anything is UPDATING (the protection flip above
          # included), so re-issued once the table is ACTIVE.
          if [ "${status}" = "ACTIVE" ]; then
            if [ "$(aws dynamodb describe-table --table-name "${tbl}" --region "${SECOND_REGION}" \
              --query 'Table.DeletionProtectionEnabled' --output text 2>/dev/null)" = "True" ]; then
              if ! out="$(aws dynamodb update-table --table-name "${tbl}" --region "${SECOND_REGION}" \
                --no-deletion-protection-enabled 2>&1)"; then
                echo "    ${tbl} (${SECOND_REGION}): turning deletion protection off failed: $(printf '%s' "${out}" | tr '\n' ' ')" >&2
              fi
            fi
            if ! out="$(aws dynamodb update-table --table-name "${tbl}" --region "${REGION}" \
              --replica-updates "Delete={RegionName=${SECOND_REGION}}" 2>&1)" &&
              ! printf '%s' "${out}" | grep -qiE 'ResourceInUseException|LimitExceededException'; then
              echo "    ${tbl}: dropping the ${SECOND_REGION} replica was refused: $(printf '%s' "${out}" | tr '\n' ' ')" >&2
            fi
          fi
          ;;
        *) [ "${status}" = "ACTIVE" ] && break ;;
      esac
      sleep 10
    done
    if [ "${gone}" = "0" ]; then
      delete_table_logged "${tbl}" "${REGION}" || rc=1
    fi
  fi
  delete_table_logged "${tbl}" "${SECOND_REGION}" || rc=1
  return "${rc}"
}

# Wait until table $1 is gone in both regions (only a not-found answer is
# "gone"; any other failure retries). Bounded: 15 min per region. Returns 1
# when it is still there in some region at the bound: the caller then must NOT
# retire a key, since a table deleting on a key pending deletion stays in
# DELETING indefinitely.
await_table_gone() { # usage: await_table_gone <table name>
  local r out gone
  for r in "${REGION}" "${SECOND_REGION}"; do
    gone=0
    for _ in $(seq 1 90); do
      if ! out="$(aws dynamodb describe-table --table-name "$1" --region "${r}" 2>&1)" &&
        printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
        gone=1
        break
      fi
      sleep 10
    done
    [ "${gone}" = "1" ] || return 1
  done
  return 0
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # ${TABLE2} FIRST, and waited out, before the stack's destroy: Phase 5b moves
  # it onto customer managed keys out of band, which the template does not
  # reference, so nothing orders its delete before a key's deletion. It is
  # moved onto fixture-owned keys (retired below, after every table), but a
  # run of an older script, or a revert that lands on the stack's key, must
  # not leave it deleting on a key the destroy is scheduling.
  # When it is still there at the bound, the stack's destroy (which
  # schedules the stack's keys) is skipped, and so is every key retirement
  # below.
  local stuck=""
  teardown_table "${TABLE2}"
  await_table_gone "${TABLE2}" || stuck="${TABLE2}"
  if [ -z "${stuck}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes --remove-protection >/dev/null 2>&1
  fi
  teardown_table "${TABLE}"
  teardown_table "${TABLE2}"
  teardown_table "${TABLE3}"
  teardown_table "${TABLE4}"
  teardown_table "${TABLE5}"
  teardown_table "${TABLE6}"
  teardown_table "${TABLE7}"
  teardown_table "${TABLE8}"
  teardown_table "${TABLE9}"
  # Keys LAST, once every table is gone: a table still DELETING on a customer
  # managed key whose deletion is scheduled stays stuck until the key is
  # enabled again (bounded: 15 min per table and region).
  # Every fixture table, before ANY fixture key: the stack's local keys, the
  # replica keys and Phase 5b's out-of-band key below.
  local t
  for t in "${TABLE}" "${TABLE2}" "${TABLE3}" "${TABLE4}" "${TABLE5}" "${TABLE6}" "${TABLE7}" "${TABLE8}" "${TABLE9}"; do
    case " ${stuck} " in *" ${t} "*) continue ;; esac
    await_table_gone "${t}" || stuck="${stuck:+${stuck} }${t}"
  done
  # After the table: a streaming destination names the stream.
  retire_stream "${REGION}" "${LOCAL_KINESIS}"
  retire_stream "${SECOND_REGION}" "${REPLICA_KINESIS}"
  if [ -n "${stuck}" ]; then
    # Read by the EXIT trap: a run that strands resources must not pass.
    CLEANUP_STRANDED=1
    echo "WARN: cleanup: ${stuck} still exists after the 15 min bound, so NO key was retired (a table deleting on a key pending deletion stays in DELETING indefinitely). Left enabled: ${LOCAL_ALIAS}, ${LOCAL_ALIAS}2, ${OOB_ALIAS} (${OOB_KEY_ARN:-no ARN}) in ${REGION}; ${REPLICA_ALIAS} (${REPLICA_KEY_ARN:-no ARN}), ${REPLICA_ALIAS}2 (${REPLICA_KEY2_ARN:-no ARN}) in ${SECOND_REGION}. Schedule their deletion once the table is gone; a later run's sweep also does." >&2
  else
    # The local keys (stack-managed) when the destroy did not schedule them,
    # and the replica keys this fixture creates — by ARN too, in case the
    # alias was never created.
    retire_key "${REGION}" "${LOCAL_ALIAS}"
    retire_key "${REGION}" "${LOCAL_ALIAS}2"
    retire_key "${SECOND_REGION}" "${REPLICA_ALIAS}"
    retire_key "${SECOND_REGION}" "${REPLICA_ALIAS}2"
    retire_key "${REGION}" "${OOB_ALIAS}"
    for arn in "${REPLICA_KEY_ARN:-}" "${REPLICA_KEY2_ARN:-}"; do
      [ -n "${arn}" ] && aws kms schedule-key-deletion --key-id "${arn}" --pending-window-in-days 7 \
        --region "${SECOND_REGION}" >/dev/null 2>&1
    done
    [ -n "${OOB_KEY_ARN:-}" ] && aws kms schedule-key-deletion --key-id "${OOB_KEY_ARN}" \
      --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1
  fi
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
  local tbl r a k state st swept=" " stuck=""
  # Stage 1: every stale table, in both regions, deleted and WAITED OUT before
  # any key goes (stage 2) — a table deleting on a key pending deletion stays
  # in DELETING indefinitely.
  for r in "${REGION}" "${SECOND_REGION}"; do
    for tbl in $(aws dynamodb list-tables --region "${r}" \
      --query "TableNames[?starts_with(@, '${BASE}-')]" --output text 2>/dev/null); do
      run_is_stale "${tbl}" || continue
      # The REGION-side teardown drops the replica too.
      case "${swept}" in *" ${tbl} "*) continue ;; esac
      echo "    sweeping ${tbl} (${r})"
      if [ "${r}" = "${REGION}" ]; then
        teardown_table "${tbl}"
      else
        # Protection, an in-flight change and any other refusal are handled
        # (and AWS's answer kept) there.
        delete_table_logged "${tbl}" "${r}"
      fi
      swept="${swept}${tbl} "
    done
  done
  for tbl in ${swept}; do
    await_table_gone "${tbl}" || stuck="${stuck:+${stuck} }${tbl}"
  done
  # Stage 2: streams always; keys only once every swept table is gone.
  for r in "${REGION}" "${SECOND_REGION}"; do
    for k in $(aws kinesis list-streams --region "${r}" \
      --query "StreamNames[?starts_with(@, '${BASE}-')]" --output text 2>/dev/null); do
      run_is_stale "${k}" || continue
      echo "    sweeping stream ${k} (${r})"
      retire_stream "${r}" "${k}"
    done
  done
  if [ -n "${stuck}" ]; then
    echo "WARN: sweep: ${stuck} still exists after the 15 min bound, so no stale run's key was retired (a table deleting on a key pending deletion stays in DELETING indefinitely). The stale '${BASE}-' aliases and keys tagged ${KEY_TAG}=${BASE} stay enabled; a later run's sweep retires them once the table is gone." >&2
  else
    for r in "${REGION}" "${SECOND_REGION}"; do
      for a in $(aws kms list-aliases --region "${r}" \
        --query "Aliases[?starts_with(AliasName, 'alias/${BASE}-')].AliasName" --output text 2>/dev/null); do
        run_is_stale "${a}" || continue
        echo "    sweeping ${a} (${r})"
        retire_key "${r}" "${a}"
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
  fi
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

# EXIT: a run whose cleanup stranded a table (and so kept its keys) exits 1
# even when every phase passed; a non-zero status (INT/TERM's 130/143, a FAIL)
# is kept as it is.
trap 'rc=$?; cleanup; if [ "${rc}" = 0 ] && [ "${CLEANUP_STRANDED:-0}" = 1 ]; then exit 1; fi' EXIT
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
# What an EARLIER run left (reported above with AWS's message) does not fail
# this one: only this run's own cleanup decides its exit status.
CLEANUP_STRANDED=0
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
echo "==> Creating Phase 5b's out-of-band key in ${REGION} (fixture-owned, not a stack key)"
OOB_KEY_ARN="$(aws kms create-key --region "${REGION}" \
  --description "cdkd integ ${STACK} out-of-band key (Phase 5b)" \
  --tags "TagKey=${KEY_TAG},TagValue=${BASE}" --query 'KeyMetadata.Arn' --output text)"
aws kms create-alias --alias-name "${OOB_ALIAS}" --target-key-id "${OOB_KEY_ARN}" \
  --region "${REGION}"
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

# --- Phase 1a: a GSI add the deadline cut short (go-to-k/cdkd#5487) ------
# UpdateTable's GSI Create is accepted at once and the index backfills in both
# regions for minutes, so a 15s per-type deadline fails the update after the
# call. Before the fix the record kept "no GSI" and nothing named gsi1
# unsettled. Now the record names GlobalSecondaryIndexes unsettled; a
# same-template retry right after is refused while gsi1 moves, or converges;
# the base redeploy clears the name and deletes gsi1, which the record names
# as the index the failed update's accepted Create added (go-to-k/cdkd#5498).
gt_unsettled() { # the GlobalTable record's unsettledProperties, comma-joined
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r --arg name "${TABLE}" '[.resources[]
        | select(.resourceType == "AWS::DynamoDB::GlobalTable" and .physicalId == $name)
        | (.unsettledProperties // [])[]] | join(",")'
}
gsi1_status() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='gsi1'].IndexStatus | [0]" --output text
}
echo "==> Phase 1a: add gsi1 under a 15s GlobalTable deadline (must fail while the index backfills)"
# UpdateTable calls summed over a CDKD_SDK_CALL_LOG file (every region's client
# is a DynamoDBClient; one line per cdkd process; 0 when absent).
update_table_calls() { # usage: update_table_calls <call log>
  node -e 'const fs=require("fs");let n=0;for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(l.trim()==="")continue;n+=JSON.parse(l).counts["DynamoDBClient.UpdateTableCommand"]??0}process.stdout.write(String(n))' "$1"
}
P1A_CALLS="${LOG_DIR}/phase1a-calls.jsonl"
rm -f "${P1A_CALLS}"
set +e
CDKD_SDK_CALL_LOG="${P1A_CALLS}" CDKD_TEST_UPDATE="gsi" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback \
  --resource-warn-after AWS::DynamoDB::GlobalTable=5s \
  --resource-timeout AWS::DynamoDB::GlobalTable=15s >"${LOG_DIR}/phase1a.log" 2>&1
P1A_EXIT=$?
set -e
if [ "${P1A_EXIT}" -eq 0 ]; then
  echo "FAIL: Phase 1a's deploy succeeded; the 15s deadline must cut the gsi1 backfill short (premise of the arm)" >&2
  exit 1
fi
# Positive control for Phase 1a2's zero-UpdateTable check: the same counter
# must see the GSI Create this deploy sent.
if [ ! -s "${P1A_CALLS}" ] || [ "$(update_table_calls "${P1A_CALLS}")" -lt 1 ]; then
  echo "FAIL: the SDK call log did not record the cut-short deploy's UpdateTable (the Phase 1a2 zero check would be vacuous)" >&2
  exit 1
fi
case ",$(gt_unsettled)," in
  *,GlobalSecondaryIndexes,*) : ;;
  *) echo "FAIL: GlobalTable record's unsettledProperties after the cut-short add is '$(gt_unsettled)', expected it to name GlobalSecondaryIndexes (go-to-k/cdkd#5487)" >&2; exit 1 ;;
esac
P1A_ATTEMPTED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | jq -r --arg name "${TABLE}" '[.resources[]
      | select(.resourceType == "AWS::DynamoDB::GlobalTable" and .physicalId == $name)
      | (.unsettledItems.GlobalSecondaryIndexes // [])[]] | join(",")')"
if [ "${P1A_ATTEMPTED}" != "gsi1" ]; then
  echo "FAIL: GlobalTable record's attempted indexes after the cut-short add are '${P1A_ATTEMPTED}', expected exactly gsi1 (go-to-k/cdkd#5498)" >&2
  exit 1
fi
# Same-template RETRY at once, with no wait in between. Exactly one of two
# outcomes must hold, and which one is printed:
#   (a) gsi1 still CREATING: the retry is refused as in transition and the
#       record keeps the name;
#   (b) gsi1 already ACTIVE: the retry converges (nothing to send — gsi1 is
#       what the template declares) and clears the name.
set +e
CDKD_TEST_UPDATE="gsi" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG_DIR}/phase1a-retry.log" 2>&1
P1A_RETRY_EXIT=$?
set -e
P1A_CONVERGED_BY_RETRY=false
if [ "${P1A_RETRY_EXIT}" -ne 0 ]; then
  echo "    Phase 1a retry outcome: (a) refused while gsi1 was moving"
  if ! grep -q "AWS is still changing it" "${LOG_DIR}/phase1a-retry.log"; then
    echo "FAIL: the same-template retry failed, but not with the in-transition refusal:" >&2
    cat "${LOG_DIR}/phase1a-retry.log" >&2
    exit 1
  fi
  case ",$(gt_unsettled)," in
    *,GlobalSecondaryIndexes,*) : ;;
    *) echo "FAIL: the refused retry dropped the unsettled name ('$(gt_unsettled)')" >&2; exit 1 ;;
  esac
else
  echo "    Phase 1a retry outcome: (b) gsi1 had settled; the retry converged"
  P1A_CONVERGED_BY_RETRY=true
  if [ -n "$(gt_unsettled)" ]; then
    echo "FAIL: the converging retry left '$(gt_unsettled)' unsettled" >&2
    exit 1
  fi
  P1A_RETRY_GSIS="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query '[length(Table.GlobalSecondaryIndexes || `[]`), Table.GlobalSecondaryIndexes[0].IndexName, Table.GlobalSecondaryIndexes[0].IndexStatus]' --output text)"
  if [ "${P1A_RETRY_GSIS}" != "$(printf '1\tgsi1\tACTIVE')" ]; then
    echo "FAIL: after the converging retry the table's indexes are '${P1A_RETRY_GSIS}', expected exactly gsi1 ACTIVE (a spurious index send?)" >&2
    exit 1
  fi
  if grep -qE "GlobalSecondaryIndexUpdates|already exists" "${LOG_DIR}/phase1a-retry.log"; then
    echo "FAIL: the converging retry sent an index change for an index AWS already holds:" >&2
    grep -nE "GlobalSecondaryIndexUpdates|already exists" "${LOG_DIR}/phase1a-retry.log" >&2
    exit 1
  fi
fi
P1A_STATUS=""
for _ in $(seq 1 180); do
  P1A_STATUS="$(gsi1_status)"
  [ "${P1A_STATUS}" = "ACTIVE" ] && break
  sleep 5
done
if [ "${P1A_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: gsi1 is '${P1A_STATUS}' after the cut-short add, expected it to reach ACTIVE" >&2
  exit 1
fi
wait_settled
echo "==> Phase 1a: redeploy the base template (no GSI, the record's own value)"
deploy "" "${LOG_DIR}/phase1a-converge.log"
gsi_count() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text
}
if [ -n "$(gt_unsettled)" ]; then
  echo "FAIL: GlobalTable record still names unsettled properties after the converging deploy: $(gt_unsettled)" >&2
  exit 1
fi
if [ "${P1A_CONVERGED_BY_RETRY}" = "true" ]; then
  # (b): the retry recorded gsi1, so the base template's omission is an
  # ordinary removal and the deploy deletes it.
  if [ "$(gsi_count)" != "0" ]; then
    echo "FAIL: $(gsi_count) GSI(s) after the base redeploy, expected 0 (the retry had recorded gsi1, so its removal is an ordinary update)" >&2
    exit 1
  fi
  echo "    base redeploy removed gsi1 as an ordinary update (the retry had already settled the name)"
else
  # (a): the record names gsi1 as the index the failed update's accepted
  # Create added, so the convergence puts it on the previous side and the base
  # template's omission deletes it, as CloudFormation would (go-to-k/cdkd#5498).
  P1A_LEFT=""
  for _ in $(seq 1 180); do
    P1A_LEFT="$(gsi_count)"
    [ "${P1A_LEFT}" = "0" ] && break
    [ "$(gsi1_status)" = "DELETING" ] || break
    sleep 5
  done
  if [ "${P1A_LEFT}" != "0" ]; then
    echo "FAIL: ${P1A_LEFT} GSI(s) after the base redeploy (gsi1 '$(gsi1_status)'), expected gsi1 deleted: the record names it attempted (go-to-k/cdkd#5498)" >&2
    exit 1
  fi
  if grep -q "IndexName gsi1, which neither" "${LOG_DIR}/phase1a-converge.log"; then
    echo "FAIL: the converging deploy warned gsi1 is undeclared, though the record names it attempted (go-to-k/cdkd#5498)" >&2
    exit 1
  fi
  echo "    the base redeploy deleted gsi1, the index the failed update created (go-to-k/cdkd#5498)"
  wait_settled
fi

# --- Phase 1a2: converging an unsettled `Replicas` changes nothing (go-to-k/cdkd#5487)
# A record whose `Replicas` a failed update left unsettled, while AWS already
# holds the template: the converging deploy must send no replica change (no
# ReplicaUpdates, no dropped-override warning), keep both replicas and the
# second replica's deletion protection, and clear the name. The mark is put on
# the record directly: no replica-level call waits long enough to cut it short
# reliably.
echo "==> Phase 1a2: converge an unsettled Replicas on an unchanged template"
P1A2_STATE="${LOG_DIR}/phase1a2-state.json"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${P1A2_STATE}" --region "${REGION}" >/dev/null
jq --arg name "${TABLE}" '(.resources[] | select(.resourceType == "AWS::DynamoDB::GlobalTable" and .physicalId == $name)) |= (.unsettledProperties = ["Replicas"])' \
  "${P1A2_STATE}" > "${P1A2_STATE}.new"
aws s3 cp "${P1A2_STATE}.new" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
[ "$(gt_unsettled)" = "Replicas" ] || { echo "FAIL: Phase 1a2 could not mark Replicas unsettled on the record ('$(gt_unsettled)')" >&2; exit 1; }
P1A2_BEFORE="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query '[sort_by(Table.Replicas,&RegionName)[].RegionName, Table.TableClassSummary.TableClass]' --output json)"
P1A2_PROT_BEFORE="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --query 'Table.DeletionProtectionEnabled' --output text)"
P1A2_CALLS="${LOG_DIR}/phase1a2-calls.jsonl"
rm -f "${P1A2_CALLS}"
CDKD_SDK_CALL_LOG="${P1A2_CALLS}" deploy "" "${LOG_DIR}/phase1a2.log"
if [ ! -s "${P1A2_CALLS}" ]; then
  echo "FAIL: the SDK call log ${P1A2_CALLS} was not written — CDKD_SDK_CALL_LOG did not take effect" >&2
  exit 1
fi
# Zero UpdateTable in ANY region (the counter is proven to see one in Phase 1a):
# a same-value replica re-send is invisible to describe-table, not to this.
P1A2_UPDATES="$(update_table_calls "${P1A2_CALLS}")"
if [ "${P1A2_UPDATES}" != "0" ]; then
  echo "FAIL: the converging deploy sent ${P1A2_UPDATES} UpdateTable call(s) for a template AWS already holds (go-to-k/cdkd#5487)" >&2
  exit 1
fi
if grep -qE "no longer declares .* but DynamoDB offers no way" "${LOG_DIR}/phase1a2.log"; then
  echo "FAIL: the converging deploy warned of a dropped override (go-to-k/cdkd#5487):" >&2
  grep -nE "no longer declares" "${LOG_DIR}/phase1a2.log" >&2
  exit 1
fi
P1A2_AFTER="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query '[sort_by(Table.Replicas,&RegionName)[].RegionName, Table.TableClassSummary.TableClass]' --output json)"
[ "${P1A2_AFTER}" = "${P1A2_BEFORE}" ] || { echo "FAIL: the converging deploy changed the replicas or table class: ${P1A2_BEFORE} -> ${P1A2_AFTER}" >&2; exit 1; }
P1A2_PROT_AFTER="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${SECOND_REGION}" \
  --query 'Table.DeletionProtectionEnabled' --output text)"
[ "${P1A2_PROT_AFTER}" = "${P1A2_PROT_BEFORE}" ] || { echo "FAIL: the converging deploy changed the ${SECOND_REGION} replica's deletion protection (${P1A2_PROT_BEFORE} -> ${P1A2_PROT_AFTER})" >&2; exit 1; }
[ -z "$(gt_unsettled)" ] || { echo "FAIL: the GlobalTable record still names unsettled properties after converging: $(gt_unsettled)" >&2; exit 1; }
echo "    the unsettled Replicas converged with no replica change (go-to-k/cdkd#5487)"

# --- Phase 1b: per-index insights, stream tags, replication mode (#5489) ---
echo "==> Phase 1b: add gsi1 with per-replica insights, stream tags, and a one-replica ModeTable"
deploy "idx" "${LOG_DIR}/phase1b.log"
wait_settled
# CDK renders the second region's replica first (stream-0) and the deploy
# region's last (stream-1). A pre-fix binary sends neither the insights nor
# the tags: DISABLED, none.
await_index "${REGION}" "^ENABLED	stream-1$" \
  "Phase 1b: the ${REGION} table's gsi1 insights or stream tag did not reach AWS (issue #5489)"
await_index "${SECOND_REGION}" "^ENABLED	stream-0$" \
  "Phase 1b: the ${SECOND_REGION} replica's gsi1 insights or stream tag did not reach AWS (issue #5489)"
MODE="$(aws dynamodb describe-table --table-name "${TABLE3}" --region "${REGION}" \
  --query 'Table.GlobalTableSettingsReplicationMode' --output text)"
if [ "${MODE}" != "ENABLED" ]; then
  echo "FAIL: Phase 1b: ${TABLE3} reads GlobalTableSettingsReplicationMode '${MODE}', not ENABLED (issue #5489)" >&2
  exit 1
fi
echo "    ${TABLE3}: GlobalTableSettingsReplicationMode ENABLED"

# --- Phase 1c: the two refusals (#5489) ------------------------------------
echo "==> Phase 1c: an LSI added to a live table, and a replication mode on two replicas, are refused"
deploy_refused "idx,lsi" "${LOG_DIR}/phase1c-lsi.log" \
  "LocalSecondaryIndexes is immutable on AWS::DynamoDB::GlobalTable" "Phase 1c (lsi)"
LSI="$(aws dynamodb describe-table --table-name "${TABLE3}" --region "${REGION}" \
  --query 'length(Table.LocalSecondaryIndexes || `[]`)' --output text)"
if [ "${LSI}" != "0" ]; then
  echo "FAIL: Phase 1c (lsi): ${TABLE3} holds ${LSI} local secondary index(es) after the refusal" >&2
  exit 1
fi
deploy_refused "idx,replmode" "${LOG_DIR}/phase1c-mode.log" \
  "can be declared only on a table with exactly one replica" "Phase 1c (replmode)"
MODE="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query 'Table.GlobalTableSettingsReplicationMode' --output text)"
if [ "${MODE}" = "ENABLED" ]; then
  echo "FAIL: Phase 1c (replmode): ${TABLE} reads GlobalTableSettingsReplicationMode ENABLED after the refusal" >&2
  exit 1
fi
wait_settled

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
deploy "tag,idx" "${LOG_DIR}/phase2.log"
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
deploy "tag,policy,idx" "${LOG_DIR}/phase2b.log"
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
deploy "tag,policy,rotated,idx" "${LOG_DIR}/phase3.log"
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
deploy "tag,policy,managed,idx" "${LOG_DIR}/phase4.log"
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
deploy "tag,removed,idx" "${LOG_DIR}/phase5.log"
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
# CloudFormation disables a removed index block and untags a removed stream
# tag (measured for #5489).
await_index "${REGION}" "^DISABLED	none$" \
  "Phase 5: the ${REGION} table's gsi1 insights or stream tag did not reset (issue #5489)"
await_index "${SECOND_REGION}" "^DISABLED	none$" \
  "Phase 5: the ${SECOND_REGION} replica's gsi1 insights or stream tag did not reset (issue #5489)"

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
deploy "tag,removed,ssetable,idx" "${LOG_DIR}/phase5b.log"
GT_TABLE="${TABLE2}"
wait_settled
await_settings "${REGION}" "^None	None	None	None	False$" \
  "${PHASE5B} premise: the ${TABLE2} table is not on the AWS owned key"
await_settings "${SECOND_REGION}" "^None	None	None	None	False$" \
  "${PHASE5B} premise: the ${TABLE2} replica is not on the AWS owned key"
run_drift 0 "${PHASE5B}"
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: ${PHASE5B}: drift reports a GlobalTable before the out-of-band change" >&2
  exit 1
fi
# DynamoDB takes a customer managed key on a table with replicas only as one
# ReplicaUpdates call naming every region's key (measured, Phase 3).
aws dynamodb update-table --table-name "${TABLE2}" --region "${REGION}" --replica-updates \
  "[{\"Update\":{\"RegionName\":\"${REGION}\",\"KMSMasterKeyId\":\"${OOB_KEY_ARN}\"}},{\"Update\":{\"RegionName\":\"${SECOND_REGION}\",\"KMSMasterKeyId\":\"${REPLICA_KEY_ARN}\"}}]" \
  >/dev/null
wait_settled
await_settings "${REGION}" "^ENABLED	KMS	${OOB_KEY_ARN}	None	False$" \
  "${PHASE5B} premise: the out-of-band move to the customer managed key did not land"
await_settings "${SECOND_REGION}" "^ENABLED	KMS	${REPLICA_KEY_ARN}	None	False$" \
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
await_settings "${REGION}" "^None	None	None	None	False$" \
  "${PHASE5B}: drift --revert did not return the ${REGION} table to the AWS owned key"
await_settings "${SECOND_REGION}" "^None	None	None	None	False$" \
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
deploy "tag,removed,protect,ssetable,idx" "${LOG_DIR}/phase6.log"
wait_settled
await_settings "${SECOND_REGION}" "	True$" "Phase 6: the replica was not protected again (issue #5355)"

# --- Phase 6b: the table-level settings (go-to-k/cdkd#2762) ----------------
# A pre-fix binary routes both tables to Cloud Control: the record's
# `provisionedBy` is the assertion that can pass only with the fix. Each value
# is then read from AWS in both regions, and an update adds to what the create
# sent.
TS_BASE="tag,removed,protect,ssetable,idx,ts"
record_of() { # usage: record_of <logical id prefix> -- prints the state record's provisionedBy
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" |
    node -e '
      const state = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const hit = Object.entries(state.resources).find(([id]) => id.startsWith(process.argv[1]));
      if (!hit) { console.error(`no record for ${process.argv[1]}`); process.exit(1); }
      console.log(hit[1].provisionedBy);
    ' "$1"
}
# The sorted ACTIVE names; a failed read (a throttle) polls again.
await_vector_indexes() { # usage: await_vector_indexes <region> <names> <message>
  local got=""
  for _ in $(seq 1 90); do
    if got="$(aws dynamodb describe-table --table-name "${TABLE4}" --region "$1" \
      --query 'sort(Table.VectorIndexes[?IndexStatus==`ACTIVE`].IndexName || `[]`)' \
      --output text)" && [ "${got}" = "$2" ]; then
      return 0
    fi
    sleep 10
  done
  echo "FAIL: $3: ${TABLE4} in $1 holds '${got}', not '$2'" >&2
  exit 1
}
write_targets() { # usage: write_targets <table> [region]; prints the count of its write scalable targets
  aws application-autoscaling describe-scalable-targets --service-namespace dynamodb \
    --resource-ids "table/$1" --scalable-dimension dynamodb:table:WriteCapacityUnits \
    --region "${2:-${REGION}}" --query 'length(ScalableTargets)' --output text
}
await_write_target() { # usage: await_write_target <table> <count> <message> [region]
  local got=""
  for _ in $(seq 1 30); do
    if got="$(write_targets "$1" "${4:-${REGION}}")" && [ "${got}" = "$2" ]; then
      return 0
    fi
    sleep 2
  done
  echo "FAIL: $3 (read '${got}', not '$2')" >&2
  exit 1
}
expect_table_field() { # usage: expect_table_field <table> <JMESPath> <value> <message>
  local got
  got="$(aws dynamodb describe-table --table-name "$1" --region "${REGION}" --query "$2" --output text)" || return 1
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $4: ${1} reads '${got}' at $2, not '$3'" >&2
    exit 1
  fi
}

expect_capacity() { # usage: expect_capacity <table> <read> <write> <message>
  expect_table_field "$1" 'Table.ProvisionedThroughput.ReadCapacityUnits' "$2" "$4"
  expect_table_field "$1" 'Table.ProvisionedThroughput.WriteCapacityUnits' "$3" "$4"
}
expect_replica_read() { # usage: expect_replica_read <table> <local read> <second region read> <message>
  local got
  expect_table_field "$1" 'Table.ProvisionedThroughput.ReadCapacityUnits' "$2" "$4"
  got="$(aws dynamodb describe-table --table-name "$1" --region "${SECOND_REGION}" \
    --query 'Table.ProvisionedThroughput.ReadCapacityUnits' --output text)" || return 1
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $4: $1 reads '${got}' in ${SECOND_REGION}, not '$3'" >&2
    exit 1
  fi
}

echo "==> Phase 6b: vector indexes, warm throughput, TableType and the table-level read ceiling"
deploy "${TS_BASE}" "${LOG_DIR}/phase6b.log"
for logical in VectorTable TableLevelReadTable TableLevelCapacityTable LocalCapacityTable AutoScaledWriteTable ReplicaOverrideTable; do
  by="$(record_of "${logical}")"
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: Phase 6b: ${logical} records provisionedBy '${by}', not sdk (go-to-k/cdkd#2762)" >&2
    exit 1
  fi
done
await_vector_indexes "${REGION}" "vec1" "Phase 6b"
await_vector_indexes "${SECOND_REGION}" "vec1" "Phase 6b"
expect_table_field "${TABLE4}" 'Table.WarmThroughput.ReadUnitsPerSecond' 13000 "Phase 6b"
expect_table_field "${TABLE5}" 'Table.OnDemandThroughput.MaxReadRequestUnits' 50 "Phase 6b"
expect_table_field "${TABLE6}" 'Table.ProvisionedThroughput.ReadCapacityUnits' 7 "Phase 6b"
expect_capacity "${TABLE7}" 3 3 "Phase 6b"
expect_capacity "${TABLE8}" 3 1 "Phase 6b"
expect_table_field "${TABLE9}" 'Table.ProvisionedThroughput.ReadCapacityUnits' 3 "Phase 6b"
# Application Auto Scaling is eventually consistent, so the read polls.
await_write_target "${TABLE6}" 1 "Phase 6b: ${TABLE6} has no write scalable target"
await_write_target "${TABLE8}" 1 "Phase 6b: ${TABLE8} has no write scalable target"
echo "    OK: the SDK route sent every setting (vec1 in both regions)"

echo "==> Phase 6c: an update adds a vector index and raises both values"
deploy "${TS_BASE},ts2" "${LOG_DIR}/phase6c.log"
await_vector_indexes "${REGION}" "vec1	vec2" "Phase 6c"
await_vector_indexes "${SECOND_REGION}" "vec1	vec2" "Phase 6c"
expect_table_field "${TABLE4}" 'Table.WarmThroughput.ReadUnitsPerSecond' 14000 "Phase 6c"
expect_table_field "${TABLE5}" 'Table.OnDemandThroughput.MaxReadRequestUnits' 55 "Phase 6c"
expect_table_field "${TABLE6}" 'Table.ProvisionedThroughput.ReadCapacityUnits' 8 "Phase 6c"
# go-to-k/cdkd#5604: a read and a write change in one deploy, with no billing flip.
expect_capacity "${TABLE7}" 4 4 "Phase 6c (go-to-k/cdkd#5604)"
# A flat read change on the local replica; the auto-scaled write side keeps its
# capacity and its scalable target.
expect_capacity "${TABLE8}" 4 1 "Phase 6c (go-to-k/cdkd#5604)"
await_write_target "${TABLE8}" 1 "Phase 6c: ${TABLE8} lost its write scalable target"
expect_replica_read "${TABLE9}" 3 2 "Phase 6c"
run_drift 0 "Phase 6c"
if grep -qE "${GT_ROW}" "${DRIFT_OUT}"; then
  echo "FAIL: Phase 6c: drift reports a table just deployed (go-to-k/cdkd#2762)" >&2
  exit 1
fi
echo "    OK: vec2 in both regions, both values raised, no drift"

echo "==> Phase 6d: the refusals (go-to-k/cdkd#2762)"
deploy_refused "${TS_BASE},ts2,tsshape" "${LOG_DIR}/phase6d-shape.log" \
  "VectorIndexes vec1 changed definition, which DynamoDB cannot modify in place" \
  "Phase 6d (tsshape)"
deploy_refused "${TS_BASE},ts2,tsregional" "${LOG_DIR}/phase6d-regional.log" \
  "TableType Regional cannot be declared with more than one replica" \
  "Phase 6d (tsregional)"
await_vector_indexes "${REGION}" "vec1	vec2" "Phase 6d"

echo "==> Phase 6e: a vector index removed"
deploy "${TS_BASE},ts3" "${LOG_DIR}/phase6e.log"
await_vector_indexes "${REGION}" "vec1" "Phase 6e"
await_vector_indexes "${SECOND_REGION}" "vec1" "Phase 6e"
# A warm throughput below the live value is warned about and not sent; the
# ceiling and the capacity move back.
expect_table_field "${TABLE4}" 'Table.WarmThroughput.ReadUnitsPerSecond' 14000 "Phase 6e"
expect_table_field "${TABLE5}" 'Table.OnDemandThroughput.MaxReadRequestUnits' 50 "Phase 6e"
expect_table_field "${TABLE6}" 'Table.ProvisionedThroughput.ReadCapacityUnits' 7 "Phase 6e"
# go-to-k/cdkd#5604: the write literal alone moves; the read side stays.
expect_capacity "${TABLE7}" 4 3 "Phase 6e (go-to-k/cdkd#5604)"
expect_capacity "${TABLE8}" 3 1 "Phase 6e (go-to-k/cdkd#5604)"
# The local read moves; the second region keeps the capacity it declares, which
# a `ProvisionedThroughput` send would have cleared.
expect_replica_read "${TABLE9}" 4 2 "Phase 6e (go-to-k/cdkd#5604)"
echo "    OK: vec2 removed in both regions, warm throughput kept, ceiling and capacity back"

echo "==> Phase 6f: both regions of ${TABLE9} move in one deploy (go-to-k/cdkd#5604)"
deploy "${TS_BASE},ts3,ts4" "${LOG_DIR}/phase6f.log"
expect_replica_read "${TABLE9}" 5 5 "Phase 6f"
echo "    OK: both regions read 5 after one deploy"

echo "==> Phase 6g: the second region of ${TABLE9} takes its own read again"
deploy "${TS_BASE},ts3,ts5" "${LOG_DIR}/phase6g.log"
expect_replica_read "${TABLE9}" 5 2 "Phase 6g"

# Last for this table: DynamoDB refuses replica updates once its write target is gone.
echo "==> Phase 6h: a write capacity send puts the second region's read back (go-to-k/cdkd#5604)"
deploy "${TS_BASE},ts3,ts5,ts6" "${LOG_DIR}/phase6h.log"
expect_table_field "${TABLE9}" 'Table.ProvisionedThroughput.WriteCapacityUnits' 3 "Phase 6h"
expect_replica_read "${TABLE9}" 5 2 "Phase 6h (go-to-k/cdkd#5604)"
echo "    OK: the write side moved and the second region reads 2"

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
assert_gone "table ${TABLE3} still exists in ${REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE3}" --region "${REGION}"
echo "    the Phase 1b ModeTable deleted"
for t in "${TABLE4}" "${TABLE5}" "${TABLE6}" "${TABLE7}" "${TABLE8}" "${TABLE9}"; do
  for r in "${REGION}" "${SECOND_REGION}"; do
    for _ in $(seq 1 30); do
      gone_probe aws dynamodb describe-table --table-name "${t}" --region "${r}" && break
      sleep 10
    done
    assert_gone "table ${t} still exists in ${r} after destroy" aws dynamodb describe-table --table-name "${t}" --region "${r}"
  done
done
await_write_target "${TABLE6}" 0 "Phase 7: ${TABLE6}'s write scalable target outlived the table"
await_write_target "${TABLE8}" 0 "Phase 7: ${TABLE8}'s write scalable target outlived the table"
await_write_target "${TABLE9}" 0 "Phase 7: ${TABLE9}'s write scalable target outlived the table"
await_write_target "${TABLE9}" 0 "Phase 7: ${TABLE9}'s write scalable target outlived its replica" "${SECOND_REGION}"
echo "    the Phase 6b tables deleted, and ${TABLE6}'s scalable target with them"

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

echo "[verify] PASS — GlobalTable replica KMS key, table class and deletion protection (issue #5355) point-in-time recovery, Contributor Insights, Kinesis stream and resource policies (issue #5365), and per-index insights, stream tags and the replication mode (issue #5489) reach AWS and reset on removal, all phases passed"
