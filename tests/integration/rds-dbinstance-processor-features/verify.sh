#!/usr/bin/env bash
# verify.sh — cdkd RDS DBInstance ProcessorFeatures / UseDefaultProcessorFeatures
# on the SDK route (go-to-k/cdkd#5640).
#
# Before #5640 either property routed the whole instance to Cloud Control; the
# provisionedBy=sdk assertion in every phase is what a pre-fix cdkd fails.
#
# CloudFormation's handler (`Translator.modifyDbInstanceRequest`,
# `shouldSetProcessorFeatures`) sends the desired values of both only when
# either changed, so a REMOVED list sends nothing and the instance keeps its
# features; `UseDefaultProcessorFeatures: true` is what restores the class
# defaults.
#
# Phases (SQL Server Web, db.m7i.large: threadsPerCore 1 or 2, default 2):
#   1. create with threadsPerCore 1: AWS runs 1 (never its own pick); the
#      instance routes via the SDK provider; `cdkd drift` reports it clean.
#   2. removed: the list dropped, beside a CopyTagsToSnapshot change: the
#      ModifyDBInstance went out (CopyTagsToSnapshot reads true) and the
#      instance KEEPS threadsPerCore 1; `cdkd drift` reports it clean.
#   3. use-default: UseDefaultProcessorFeatures: true: back to the default 2.
#   4. reapply: the list with UseDefaultProcessorFeatures: false: back to 1,
#      the same instance (DbiResourceId unchanged) in every phase; `cdkd
#      drift` reports it clean.
#   5. destroy: the instance and the state file are gone.
#
# Budget: the SQL Server create ~20-30 min, each of the three processor
# changes restarts the instance (~10 min each), the delete ~10 min.
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

STACK="CdkdRdsDbInstanceProcessorFeaturesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The stack file's INSTANCE_ID.
INSTANCE_ID="cdkd-rds-procfeat-integ"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DRIFT_JSON="${TMPDIR:-/tmp}/cdkd-5640-procfeat-drift.$$.json"

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_JSON}"
  # The instance by its fixed name FIRST, and waited out: a run aborted before
  # the create returned has no record naming it, and while it lives its subnet
  # group, security group and VPC cannot be deleted by `state destroy` below.
  aws rds delete-db-instance \
    --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" \
    --skip-final-snapshot \
    --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted --db-instance-identifier "${INSTANCE_ID}" \
    --region "${REGION}" >/dev/null 2>&1
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

deploy_phase() { # usage: deploy_phase <CDKD_TEST_PROCESSOR value, empty for the create>
  if [ -z "$1" ]; then
    env -u CDKD_TEST_PROCESSOR node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  else
    CDKD_TEST_PROCESSOR="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  fi
}

instance_field() { # usage: instance_field <JMESPath under DBInstances[0]>
  aws rds describe-db-instances --db-instance-identifier "${INSTANCE_ID}" --region "${REGION}" \
    --query "DBInstances[0].$1" --output text || return 1
}

threads_per_core() { # the live threadsPerCore ("None" when RDS lists no features)
  instance_field "ProcessorFeatures[?Name=='threadsPerCore'].Value | [0]" || return 1
}

assert_sdk_route() { # usage: assert_sdk_route <phase label>
  local by
  by="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | jq -r '[.resources[] | select(.resourceType == "AWS::RDS::DBInstance") | .provisionedBy // "sdk"] | if length == 1 then .[0] else "records:\(length)" end')" || {
    echo "FAIL ($1): could not read the state record" >&2
    exit 1
  }
  if [ "${by}" != "sdk" ]; then
    echo "FAIL ($1): the DB instance is provisionedBy '${by}', expected sdk — ProcessorFeatures / UseDefaultProcessorFeatures must not route it to Cloud Control (go-to-k/cdkd#5640)" >&2
    exit 1
  fi
}

assert_threads() { # usage: assert_threads <expected> <phase label>
  local got
  got="$(threads_per_core)"
  if [ "${got}" != "$1" ]; then
    echo "FAIL ($2): threadsPerCore reads '${got}', expected '$1' (go-to-k/cdkd#5640)" >&2
    instance_field 'ProcessorFeatures' >&2 || true
    instance_field 'PendingModifiedValues' >&2 || true
    exit 1
  fi
  echo "    OK ($2): threadsPerCore=${got}"
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

# --- Phase 1: create with threadsPerCore 1 -----------------------------------
echo "==> Phase 1: create the instance with threadsPerCore 1"
deploy_phase ""
assert_sdk_route "phase 1"
assert_threads 1 "phase 1: the declared list reached CreateDBInstance"
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
    echo "FAIL ($1): the instance was REPLACED (DbiResourceId ${RESOURCE_ID} -> ${now}); both properties are mutable" >&2
    exit 1
  fi
}

# --- Phase 2: removal keeps the features --------------------------------------
echo "==> Phase 2: drop ProcessorFeatures beside a CopyTagsToSnapshot change"
if [ "$(instance_field 'CopyTagsToSnapshot')" != "False" ]; then
  echo "FAIL (phase 2 premise): CopyTagsToSnapshot must read False before the companion change" >&2
  exit 1
fi
deploy_phase removed
assert_sdk_route "phase 2"
assert_same_instance "phase 2"
if [ "$(instance_field 'CopyTagsToSnapshot')" != "True" ]; then
  echo "FAIL (phase 2): CopyTagsToSnapshot still reads False — the ModifyDBInstance never went out, so the kept features prove nothing" >&2
  exit 1
fi
assert_threads 1 "phase 2: a removed list leaves the features, as CloudFormation does"
assert_drift_clean "phase 2"

# --- Phase 3: UseDefaultProcessorFeatures: true -------------------------------
echo "==> Phase 3: UseDefaultProcessorFeatures: true"
deploy_phase use-default
assert_sdk_route "phase 3"
assert_same_instance "phase 3"
# The class default is 2; RDS may also list no features at all once the
# instance runs its class defaults.
THREADS_P3="$(threads_per_core)"
case "${THREADS_P3}" in
  2 | None) echo "    OK (phase 3): threadsPerCore=${THREADS_P3} (the class default)" ;;
  *)
    echo "FAIL (phase 3): threadsPerCore reads '${THREADS_P3}', expected the class default (2, or no features listed) — UseDefaultProcessorFeatures: true never reached ModifyDBInstance (go-to-k/cdkd#5640)" >&2
    instance_field 'PendingModifiedValues' >&2 || true
    exit 1
    ;;
esac

# --- Phase 4: the list again --------------------------------------------------
echo "==> Phase 4: the list again, with UseDefaultProcessorFeatures: false"
deploy_phase reapply
assert_sdk_route "phase 4"
assert_same_instance "phase 4"
assert_threads 1 "phase 4: the changed list reached ModifyDBInstance"
assert_drift_clean "phase 4"

# --- Phase 5: destroy ---------------------------------------------------------
echo "==> Phase 5: destroy"
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

cleanup
trap - EXIT INT TERM

echo "[verify] PASS — RDS DBInstance ProcessorFeatures / UseDefaultProcessorFeatures on the SDK route (go-to-k/cdkd#5640)"
