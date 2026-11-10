#!/usr/bin/env bash
# verify.sh — cdkd RDS DBInstance automated backup replication on the SDK
# route (go-to-k/cdkd#5640).
#
# Before #5640 AutomaticBackupReplicationRegion / -RetentionPeriod routed the
# whole instance to Cloud Control; the provisionedBy=sdk assertion in every
# phase is what a pre-fix cdkd fails.
#
# CloudFormation's handler starts the replication once the instance is
# available, with a call to the DESTINATION region naming the instance's ARN;
# a changed retention stops it and starts it again; a removed region stops it
# (`ResourceModelHelper.shouldStart/StopAutomaticBackupReplication`).
#
# Phases (`CDKD_TEST_BR`; the destination is DEST_REGION, never the stack's):
#   1. create with retention 2: the instance lists a replication to
#      DEST_REGION, whose automated backup there reads retention 2; the
#      instance routes via the SDK provider; `cdkd drift` reports it clean.
#   2. retention: 3: the same instance replicates to DEST_REGION with
#      retention 3; `cdkd drift` reports it clean.
#   3. removed: the instance lists no replication; `cdkd drift` reports it
#      clean.
#   4. destroy: the instance and the state file are gone. The replicated
#      automated backups this instance left in DEST_REGION are then counted
#      (a NOTE: CloudFormation's delete makes no replication call either) and
#      swept, by this instance's identifier only.
#
# Budget: create ~8 min, each replication start or stop a few minutes, the
# delete ~5 min.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdRdsDbInstanceBackupReplicationExample"
REGION="${AWS_REGION:-us-east-1}"
# Any region other than the stack's that takes the replication.
if [ "${REGION}" = "us-west-2" ]; then
  DEST_REGION="us-east-1"
else
  DEST_REGION="us-west-2"
fi
export CDKD_TEST_BR_DEST="${DEST_REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The stack file's INSTANCE_ID.
INSTANCE_ID="cdkd-rds-bkrepl-integ"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-5640-bkrepl-drift.$$.json"

# The replicated automated backups' ARNs `assert_replicating` read off the
# instance this run, space-separated.
SEEN_BACKUP_ARNS=""

# The replicated automated backups of THIS fixture's instance in DEST_REGION,
# one ARN per line; empty when RDS lists none (it answers not-found then).
# Scoped by the fixed DBInstanceIdentifier only, never a broader listing, and
# to backups whose Region is not DEST_REGION: a replicated backup reports its
# source's region, so a same-named instance's own retained backups there (a
# run of this fixture in DEST_REGION) are left alone.
replicated_backups() {
  local out
  if ! out="$(aws rds describe-db-instance-automated-backups \
      --db-instance-identifier "${INSTANCE_ID}" --region "${DEST_REGION}" \
      --query "DBInstanceAutomatedBackups[?Region!='${DEST_REGION}'].DBInstanceAutomatedBackupsArn" \
      --output text 2>&1)"; then
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}" && return 0
    echo "${out}" >&2
    return 1
  fi
  [ "${out}" = "None" ] || printf '%s\n' ${out}
  # Every replicated backup this run SAW listed on the instance, whether or not
  # the identifier listing above reaches it in DEST_REGION.
  local arn
  for arn in ${SEEN_BACKUP_ARNS}; do
    if ! out="$(aws rds describe-db-instance-automated-backups \
        --db-instance-automated-backups-arn "${arn}" --region "${DEST_REGION}" \
        --query 'DBInstanceAutomatedBackups[0].DBInstanceAutomatedBackupsArn' --output text 2>&1)"; then
      grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}" && continue
      echo "${out}" >&2
      return 1
    fi
    [ "${out}" = "None" ] || printf '%s\n' "${out}"
  done
}

# Deletes each replicated backup `replicated_backups` lists, until it lists
# none (one still settling can refuse the delete for a while); idempotent.
# Returns 1 when some remain after ~5 min or the listing fails.
sweep_replicated_backups() {
  local arns arn
  for _ in $(seq 1 30); do
    arns="$(replicated_backups | sort -u)" || return 1
    [ -z "${arns}" ] && return 0
    for arn in ${arns}; do
      case "${arn}" in
        arn:aws*:rds:"${DEST_REGION}":*:auto-backup:?*) ;;
        *)
          echo "WARN: teardown sweep refused: '${arn}' is not an automated backup ARN in ${DEST_REGION}" >&2
          continue
          ;;
      esac
      # Best effort; the listing above is what decides.
      aws rds delete-db-instance-automated-backup \
        --db-instance-automated-backups-arn "${arn}" --region "${DEST_REGION}" >/dev/null 2>&1 || true
    done
    sleep 10
  done
  return 1
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  # The replication first, by the instance's own ARN, then the instance by its
  # fixed name, waited out: a run aborted before the create returned has no
  # record naming it, and while it lives its subnet group, security group and
  # VPC cannot be deleted by `state destroy` below.
  local arn
  arn="$(aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" --query 'DBInstances[0].DBInstanceArn' --output text 2>/dev/null)"
  case "${arn}" in
    arn:aws*:rds:*:db:"${INSTANCE_ID}")
      # A leftover instance's replicated backup joins the sweep below, whether
      # or not the identifier listing reaches it.
      local leftover
      leftover="$(aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" \
        --region "${REGION}" \
        --query 'DBInstances[0].DBInstanceAutomatedBackupsReplications[0].DBInstanceAutomatedBackupsArn' \
        --output text 2>/dev/null)"
      case "${leftover}" in
        arn:aws*:rds:"${DEST_REGION}":*:auto-backup:?*) SEEN_BACKUP_ARNS="${SEEN_BACKUP_ARNS} ${leftover}" ;;
      esac
      aws rds stop-db-instance-automated-backups-replication \
        --source-db-instance-arn "${arn}" --region "${DEST_REGION}" >/dev/null 2>&1
      ;;
  esac
  aws rds delete-db-instance \
    --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" \
    --skip-final-snapshot \
    --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" >/dev/null 2>&1
  sweep_replicated_backups
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Not silenced: a VPC still held by a deleting instance must show.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --yes
  fi
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
CLEANED_UP=0

deploy_phase() { # usage: deploy_phase <CDKD_TEST_BR value, empty for the create>
  if [ -z "$1" ]; then
    env -u CDKD_TEST_BR node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  else
    CDKD_TEST_BR="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  fi
}

instance_field() { # usage: instance_field <JMESPath under DBInstances[0]>
  aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" --region "${REGION}" \
    --query "DBInstances[0].$1" --output text || return 1
}

# The ARN of the instance's replicated automated backup ("None" when it lists
# no replication).
replication_arn() {
  instance_field 'DBInstanceAutomatedBackupsReplications[0].DBInstanceAutomatedBackupsArn' || return 1
}

assert_sdk_route() { # usage: assert_sdk_route <phase label>
  local by
  by="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '[.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .provisionedBy // "sdk"] | if length == 1 then .[0] else "records:\(length)" end')" || {
    echo "FAIL ($1): could not read the state record" >&2
    exit 1
  }
  if [ "${by}" != "sdk" ]; then
    echo "FAIL ($1): the DB instance is provisionedBy '${by}', expected sdk — AutomaticBackupReplication* must not route it to Cloud Control (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
}

assert_replicating() { # usage: assert_replicating <expected retention> <phase label>
  local arn retention
  arn="$(replication_arn)"
  case "${arn}" in
    arn:aws*:rds:"${DEST_REGION}":*:auto-backup:?*) SEEN_BACKUP_ARNS="${SEEN_BACKUP_ARNS} ${arn}" ;;
    *)
      echo "FAIL ($2): the instance lists replication '${arn}', expected one to ${DEST_REGION} (go-to-k/cdkd#5640)" >&2
      instance_field 'DBInstanceAutomatedBackupsReplications' >&2 || true
      exit 1
      ;;
  esac
  if ! retention="$(aws rds describe-db-instance-automated-backups \
      --db-instance-automated-backups-arn "${arn}" --region "${DEST_REGION}" \
      --query 'DBInstanceAutomatedBackups[0].BackupRetentionPeriod' --output text)"; then
    echo "FAIL ($2): could not read the replicated automated backup ${arn}" >&2
    return 1
  fi
  if [ "${retention}" != "$1" ]; then
    echo "FAIL ($2): the replicated automated backup reads retention '${retention}', expected '$1' (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($2): replicating to ${DEST_REGION}, retention ${retention}"
}

assert_drift_clean() { # usage: assert_drift_clean <phase label>
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
  if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
    echo "FAIL ($1): cdkd drift --json produced no stack report:" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
  local clean drifted
  clean="$(jq '[.[].clean[] | select(.type == "AWS::RDS::DBInstance")] | length' "${DRIFT_JSON}")"
  drifted="$(jq '[.[].drifted[] | select(.type == "AWS::RDS::DBInstance")] | length' "${DRIFT_JSON}")"
  if [ "${clean}" != "1" ] || [ "${drifted}" != "0" ]; then
    echo "FAIL ($1): cdkd drift reports the DB instance clean=${clean} drifted=${drifted}, expected it clean (go-to-k/cdkd#5640)" >&2
    jq '[.[].drifted[] | select(.type == "AWS::RDS::DBInstance")]' "${DRIFT_JSON}" >&2
    exit 1
  fi
  echo "    OK ($1): cdkd drift reports the DB instance clean"
}

# --- Phase 1: create with a replication ---------------------------------------
echo "==> Phase 1: create the instance replicating to ${DEST_REGION}, retention 2"
deploy_phase ""
assert_sdk_route "phase 1"
assert_replicating 2 "phase 1: the replication started after the create"
RESOURCE_ID="$(instance_field 'DbiResourceId')"
case "${RESOURCE_ID}" in
  db-?*) echo "    instance ${INSTANCE_ID} is ${RESOURCE_ID}" ;;
  *) echo "FAIL: could not read the instance's DbiResourceId ('${RESOURCE_ID}')" >&2; exit 1 ;;
esac
assert_drift_clean "phase 1"

assert_same_instance() { # usage: assert_same_instance <phase label>
  local now
  now="$(instance_field 'DbiResourceId')"
  if [ "${now}" != "${RESOURCE_ID}" ]; then
    echo "FAIL ($1): the instance was REPLACED (DbiResourceId ${RESOURCE_ID} -> ${now}); the replication properties are mutable" >&2
    exit 1
  fi
}

# --- Phase 2: a changed retention restarts it ---------------------------------
echo "==> Phase 2: retention 3"
deploy_phase retention
assert_sdk_route "phase 2"
assert_same_instance "phase 2"
assert_replicating 3 "phase 2: the replication restarted with the new retention"
assert_drift_clean "phase 2"

# --- Phase 3: removal stops it --------------------------------------------------
echo "==> Phase 3: drop the replication"
deploy_phase removed
assert_sdk_route "phase 3"
assert_same_instance "phase 3"
P3_ARN="$(replication_arn)"
if [ "${P3_ARN}" != "None" ]; then
  echo "FAIL (phase 3): the instance still lists replication '${P3_ARN}' after the template dropped it (go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK (phase 3): the instance lists no replication"
assert_drift_clean "phase 3"

# --- Phase 4: destroy ---------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
if gone_probe aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" --region "${REGION}"; then
  STATUS="gone"
elif ! STATUS="$(aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1)"; then
  # The instance can vanish between the probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${STATUS}" \
    && STATUS="gone" \
    || { echo "FAIL: describe-db-instances requery undetermined: ${STATUS}" >&2; exit 1; }
fi
if [ "${STATUS}" != "gone" ] && [ "${STATUS}" != "deleting" ]; then
  echo "FAIL: ${INSTANCE_ID} is '${STATUS}' after destroy" >&2
  exit 1
fi
echo "    OK: ${INSTANCE_ID} is ${STATUS}"

LEFT="$(replicated_backups | sort -u)"
echo "NOTE: replicated automated backups of ${INSTANCE_ID} left in ${DEST_REGION} after destroy: $(printf '%s' "${LEFT}" | grep -c . || true)"
if ! sweep_replicated_backups; then
  echo "FAIL: the sweep left replicated automated backups of ${INSTANCE_ID} in ${DEST_REGION}" >&2
  replicated_backups >&2 || true
  exit 1
fi

cleanup
trap - EXIT INT TERM

echo "[verify] PASS — RDS DBInstance automated backup replication on the SDK route (go-to-k/cdkd#5640)"
