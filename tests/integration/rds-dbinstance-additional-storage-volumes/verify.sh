#!/usr/bin/env bash
# verify.sh — cdkd RDS DBInstance AdditionalStorageVolumes on the SDK route
# (go-to-k/cdkd#5640).
#
# Before #5640 the property routed the whole instance to Cloud Control; the
# provisionedBy=sdk assertion is what a pre-fix cdkd fails. cdkd sends what
# CloudFormation's handler was measured to send (CloudTrail A/B, 2026-11-11):
# the list on CreateDBInstance; on update only the changed and new volumes, in
# full, and `{ VolumeName, SetForDelete: true }` for each removed one (every
# previous one when the property goes), then a wait for the instance to settle.
#
# Phases (one SQL Server SE instance, `CDKD_TEST_VOLUMES` picks the list):
#   1. create with rdsdbdata2 and rdsdbdata3 (gp3, 20 GiB each): SDK route,
#      both volumes read back, `cdkd drift` clean.
#   2. `grown`: rdsdbdata2 to 25 GiB, rdsdbdata4 added: an in-place update
#      (same DbiResourceId); all three volumes read back at their sizes; the
#      primary volume keeps its 20 GiB; drift clean.
#   3. `removed`: rdsdbdata3 dropped from the list: it is deleted, the other
#      two are kept; drift clean.
#   4. `none`: the property removed: every volume is deleted; drift clean.
#   5. destroy: the instance and the state file are gone.
#
# Budget: create ~25 min, the grow ~20 min (CloudFormation took ~17.5 min),
# each removal a few minutes, the delete ~10 min.
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

STACK="CdkdRdsDbInstanceAdditionalStorageVolumesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The stack file's INSTANCE_ID.
INSTANCE_ID="cdkd-rds-volumes-integ"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-5640-volumes-drift.$$.json"

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  # The instance by its fixed name FIRST, and waited out: a run aborted
  # before the create returned has no record naming it, and while it lives
  # its subnet group, security group and VPC cannot be deleted by
  # `state destroy`.
  aws rds delete-db-instance \
    --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" \
    --skip-final-snapshot \
    --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" >/dev/null 2>&1
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Not silenced: a VPC still held by a deleting instance must show.
    env -u CDKD_TEST_VOLUMES node "${LOCAL_DIST}" state destroy "${STACK}" \
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

instance_field() { # usage: instance_field <JMESPath under DBInstances[0]>
  aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" --region "${REGION}" \
    --query "DBInstances[0].$1" --output text || return 1
}

assert_volumes() { # usage: assert_volumes "<sorted name:size list, space-separated>" <phase label>
  local got
  # Order-insensitive: RDS lists the volumes in its own order (the A/B read
  # rdsdbdata3 first). The coalesce keeps an instance with none readable.
  local query="join(' ', sort(DBInstances[0].AdditionalStorageVolumes[].join(':', [VolumeName, to_string(AllocatedStorage)]) || \`[]\`))"
  if ! got="$(aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" --region "${REGION}" --query "${query}" --output text)"; then
    echo "FAIL ($2): could not read ${INSTANCE_ID}'s AdditionalStorageVolumes" >&2
    exit 1
  fi
  if [ "${got}" != "$1" ]; then
    echo "FAIL ($2): ${INSTANCE_ID} lists volumes '${got}', expected '$1' (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($2): volumes '${got}'"
}

assert_sdk_route() { # usage: assert_sdk_route <phase label>
  local by
  by="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '[.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .provisionedBy // "sdk"] | if length == 1 and all(. == "sdk") then "sdk" else "records:\(length) \(join(","))" end')" || {
    echo "FAIL ($1): could not read the state record" >&2
    exit 1
  }
  if [ "${by}" != "sdk" ]; then
    echo "FAIL ($1): the DB instance is provisionedBy '${by}', expected one sdk record — AdditionalStorageVolumes must not route the instance to Cloud Control (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($1): the DB instance is provisionedBy sdk"
}

assert_same_instance() { # usage: assert_same_instance <phase label>
  local id
  id="$(instance_field 'DbiResourceId')" || {
    echo "FAIL ($1): could not read ${INSTANCE_ID}'s DbiResourceId" >&2
    exit 1
  }
  if [ "${id}" != "${RESOURCE_ID}" ]; then
    echo "FAIL ($1): ${INSTANCE_ID} is ${id}, was ${RESOURCE_ID} — a volume change must update in place" >&2
    exit 1
  fi
  echo "    OK ($1): updated in place (${id})"
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
    echo "FAIL ($1): cdkd drift reports the DB instance clean=${clean} drifted=${drifted}, expected clean (go-to-k/cdkd#5640)" >&2
    jq '[.[].drifted[] | select(.type == "AWS::RDS::DBInstance")]' "${DRIFT_JSON}" >&2
    exit 1
  fi
  echo "    OK ($1): cdkd drift reports the DB instance clean"
}

deploy_phase() { # usage: deploy_phase <CDKD_TEST_VOLUMES value>
  CDKD_TEST_VOLUMES="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  # The deploy waits for a volume change to settle, as CloudFormation does.
  local status
  status="$(instance_field 'DBInstanceStatus')" || {
    echo "FAIL ($1): could not read ${INSTANCE_ID}'s status" >&2
    exit 1
  }
  if [ "${status}" != "available" ]; then
    echo "FAIL ($1): ${INSTANCE_ID} is '${status}' right after the deploy returned, expected available (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($1): ${INSTANCE_ID} is available after the deploy"
}

# --- Phase 1: create -----------------------------------------------------------
echo "==> Phase 1: create the instance with rdsdbdata2 and rdsdbdata3"
deploy_phase initial
assert_sdk_route "phase 1"
assert_volumes "rdsdbdata2:20 rdsdbdata3:20" "phase 1"
RESOURCE_ID="$(instance_field 'DbiResourceId')"
case "${RESOURCE_ID}" in
  db-?*) echo "    instance ${INSTANCE_ID} is ${RESOURCE_ID}" ;;
  *) echo "FAIL: could not read ${INSTANCE_ID}'s DbiResourceId ('${RESOURCE_ID}')" >&2; exit 1 ;;
esac
assert_drift_clean "phase 1"

# --- Phase 2: grow one, add one ---------------------------------------------------
echo "==> Phase 2: grow rdsdbdata2 to 25 GiB and add rdsdbdata4"
deploy_phase grown
assert_sdk_route "phase 2"
assert_same_instance "phase 2"
assert_volumes "rdsdbdata2:25 rdsdbdata3:20 rdsdbdata4:20" "phase 2"
# CloudFormation re-sent the primary's unchanged AllocatedStorage after the
# grow; cdkd does not, and the primary volume must keep its size either way.
PRIMARY="$(instance_field 'AllocatedStorage')"
if [ "${PRIMARY}" != "20" ]; then
  echo "FAIL (phase 2): the primary volume reports AllocatedStorage '${PRIMARY}', expected 20" >&2
  exit 1
fi
echo "    OK (phase 2): the primary volume keeps 20 GiB"
assert_drift_clean "phase 2"

# --- Phase 3: remove one volume ----------------------------------------------------
echo "==> Phase 3: drop rdsdbdata3 from the list"
deploy_phase removed
assert_sdk_route "phase 3"
assert_same_instance "phase 3"
assert_volumes "rdsdbdata2:25 rdsdbdata4:20" "phase 3"
assert_drift_clean "phase 3"

# --- Phase 4: remove the property --------------------------------------------------
echo "==> Phase 4: remove AdditionalStorageVolumes"
deploy_phase none
assert_sdk_route "phase 4"
assert_same_instance "phase 4"
assert_volumes "" "phase 4"
assert_drift_clean "phase 4"

# --- Phase 5: destroy ---------------------------------------------------------
echo "==> Phase 5: destroy"
env -u CDKD_TEST_VOLUMES node "${LOCAL_DIST}" destroy "${STACK}" \
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

cleanup
trap - EXIT INT TERM

echo "[verify] PASS — RDS DBInstance AdditionalStorageVolumes on the SDK route (go-to-k/cdkd#5640)"
