#!/usr/bin/env bash
# verify.sh — cdkd RDS DBInstance CharacterSetName / NcharCharacterSetName /
# Timezone on the SDK route (go-to-k/cdkd#5640).
#
# Before #5640 any of the three routed the whole instance to Cloud Control;
# the provisionedBy=sdk assertion is what a pre-fix cdkd fails. All three are
# create-only, and CloudFormation's create translation sends each as declared
# (`Translator.createDbInstanceRequest`); its read handler reads each back.
#
# Phases:
#   1. create an Oracle SE2 instance (CharacterSetName WE8ISO8859P1,
#      NcharCharacterSetName UTF8; defaults AL32UTF8 / AL16UTF16) and a SQL
#      Server Express instance (Timezone "Tokyo Standard Time"; default UTC):
#      both route via the SDK provider, RDS reports each declared value, and
#      `cdkd drift` reports both clean.
#   2. a changed Timezone is a create-only change of a stateful resource: the
#      deploy refuses it before any call (no --force-stateful-recreation), and
#      the SQL Server instance keeps its time zone and identity.
#   3. destroy: both instances and the state file are gone.
#
# Budget: the two creates run in parallel (Oracle ~25-40 min, SQL Server
# Express ~20 min), phase 2 makes no AWS change, the deletes ~10 min.
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

STACK="CdkdRdsDbInstanceCharsetTimezoneExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The stack file's ORACLE_INSTANCE_ID / SQLSERVER_INSTANCE_ID.
ORACLE_ID="cdkd-rds-charset-integ"
SQLSERVER_ID="cdkd-rds-timezone-integ"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-5640-charset-drift.$$.json"

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  # The instances by their fixed names FIRST, and waited out: a run aborted
  # before a create returned has no record naming it, and while one lives its
  # subnet group, security group and VPC cannot be deleted by `state destroy`.
  for id in "${ORACLE_ID}" "${SQLSERVER_ID}"; do
    aws rds delete-db-instance \
      --db-instance-identifier "${id}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null 2>&1
  done
  for id in "${ORACLE_ID}" "${SQLSERVER_ID}"; do
    aws rds wait db-instance-deleted --db-instance-identifier "${id}" \
      --region "${REGION}" >/dev/null 2>&1
  done
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

instance_field() { # usage: instance_field <instance id> <JMESPath under DBInstances[0]>
  aws rds describe-db-instances --db-instance-identifier "$1" --region "${REGION}" \
    --query "DBInstances[0].$2" --output text || return 1
}

assert_field() { # usage: assert_field <instance id> <field> <expected> <phase label>
  local got
  got="$(instance_field "$1" "$2")"
  if [ "${got}" != "$3" ]; then
    echo "FAIL ($4): ${1} reports ${2} '${got}', expected '$3' — the declared value never reached CreateDBInstance (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($4): ${1} ${2}=${got}"
}

assert_sdk_route() { # usage: assert_sdk_route <phase label>
  local by
  by="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '[.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .provisionedBy // "sdk"] | if length == 2 and all(. == "sdk") then "sdk" else "records:\(length) \(join(","))" end')" || {
    echo "FAIL ($1): could not read the state record" >&2
    exit 1
  }
  if [ "${by}" != "sdk" ]; then
    echo "FAIL ($1): the DB instances are provisionedBy '${by}', expected two sdk records — CharacterSetName / NcharCharacterSetName / Timezone must not route an instance to Cloud Control (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK ($1): both DB instances provisionedBy sdk"
}

# --- Phase 1: create -----------------------------------------------------------
echo "==> Phase 1: create the Oracle and SQL Server instances"
env -u CDKD_TEST_TIMEZONE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_sdk_route "phase 1"
assert_field "${ORACLE_ID}" 'CharacterSetName' 'WE8ISO8859P1' "phase 1"
assert_field "${ORACLE_ID}" 'NcharCharacterSetName' 'UTF8' "phase 1"
assert_field "${SQLSERVER_ID}" 'Timezone' 'Tokyo Standard Time' "phase 1"
SQLSERVER_RESOURCE_ID="$(instance_field "${SQLSERVER_ID}" 'DbiResourceId')"
case "${SQLSERVER_RESOURCE_ID}" in
  db-?*) echo "    instance ${SQLSERVER_ID} is ${SQLSERVER_RESOURCE_ID}" ;;
  *) echo "FAIL: could not read ${SQLSERVER_ID}'s DbiResourceId ('${SQLSERVER_RESOURCE_ID}')" >&2; exit 1 ;;
esac

node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null || true
if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}" 2>/dev/null)" != "yes" ]; then
  echo "FAIL (phase 1): cdkd drift --json produced no stack report:" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
DRIFT_CLEAN="$(jq '[.[].clean[] | select(.type == "AWS::RDS::DBInstance")] | length' "${DRIFT_JSON}")"
DRIFT_DRIFTED="$(jq '[.[].drifted[] | select(.type == "AWS::RDS::DBInstance")] | length' "${DRIFT_JSON}")"
if [ "${DRIFT_CLEAN}" != "2" ] || [ "${DRIFT_DRIFTED}" != "0" ]; then
  echo "FAIL (phase 1): cdkd drift reports the DB instances clean=${DRIFT_CLEAN} drifted=${DRIFT_DRIFTED}, expected both clean (go-to-k/cdkd#5640)" >&2
  jq '[.[].drifted[] | select(.type == "AWS::RDS::DBInstance")]' "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK (phase 1): cdkd drift reports both DB instances clean"

# --- Phase 2: a changed Timezone is refused ---------------------------------------
echo "==> Phase 2: a changed Timezone (create-only, stateful) is refused"
P2_RC=0
P2_OUT="$(CDKD_TEST_TIMEZONE=changed node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || P2_RC=$?
if [ "${P2_RC}" = "0" ]; then
  printf '%s\n' "${P2_OUT}" >&2
  echo "FAIL (phase 2): the deploy changing Timezone exited 0; a create-only change of a stateful DB instance must be refused without --force-stateful-recreation" >&2
  exit 1
fi
# ONE line, not the whole output: the logical id and the property name also
# appear in ordinary plan output.
GUARD_LINE="$(printf '%s\n' "${P2_OUT}" \
  | grep -m1 'requires replacement (immutable property changed:' || true)"
if [ -z "${GUARD_LINE}" ]; then
  printf '%s\n' "${P2_OUT}" >&2
  # Sentinel: a stateful refusal in other words means the needle drifted.
  if grep -q 'but it is a stateful resource' <<<"${P2_OUT}"; then
    echo "FAIL (phase 2): a stateful refusal fired, but not in the property-driven wording this fixture parses — update the needle" >&2
  else
    echo "FAIL (phase 2): the deploy failed (rc=${P2_RC}) without the property-driven stateful refusal" >&2
  fi
  exit 1
fi
for NEEDLE in 'SqlServerInstance' 'Timezone' 'force-stateful-recreation'; do
  case "${GUARD_LINE}" in
    *"${NEEDLE}"*) ;;
    *)
      echo "FAIL (phase 2): the refusal line lacks '${NEEDLE}': ${GUARD_LINE}" >&2
      exit 1
      ;;
  esac
done
echo "    OK (phase 2): refused — ${GUARD_LINE}"
assert_field "${SQLSERVER_ID}" 'Timezone' 'Tokyo Standard Time' "phase 2"
if [ "$(instance_field "${SQLSERVER_ID}" 'DbiResourceId')" != "${SQLSERVER_RESOURCE_ID}" ]; then
  echo "FAIL (phase 2): ${SQLSERVER_ID} was replaced despite the refusal" >&2
  exit 1
fi
assert_sdk_route "phase 2"

# --- Phase 3: destroy ---------------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_TIMEZONE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for id in "${ORACLE_ID}" "${SQLSERVER_ID}"; do
  if gone_probe aws rds describe-db-instances --db-instance-identifier "${id}" --region "${REGION}"; then
    STATUS="gone"
  elif ! STATUS="$(aws rds describe-db-instances --db-instance-identifier "${id}" \
      --region "${REGION}" --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1)"; then
    # The instance can vanish between the probe and this requery.
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${STATUS}" \
      && STATUS="gone" \
      || { echo "FAIL: describe-db-instances requery undetermined: ${STATUS}" >&2; exit 1; }
  fi
  if [ "${STATUS}" != "gone" ] && [ "${STATUS}" != "deleting" ]; then
    echo "FAIL: ${id} is '${STATUS}' after destroy" >&2
    exit 1
  fi
  echo "    OK: ${id} is ${STATUS}"
done

cleanup
trap - EXIT INT TERM

echo "[verify] PASS — RDS DBInstance CharacterSetName / NcharCharacterSetName / Timezone on the SDK route (go-to-k/cdkd#5640)"
