#!/usr/bin/env bash
# verify.sh — cdkd drift on a GlobalTable compared through its template bag
# (issues #5789, #5790).
#
# A record with no `observedProperties` (a rollback's reverse-replacement
# re-create, a pre-v3 record) is compared against its template `properties`.
# The read-back writes every replica's class, deletion protection,
# contributor insights, point-in-time recovery, tags and (SSE on) key ARN, and
# arrays compare whole, so a template that declared none of them reported
# `Replicas` drift on a healthy table. cdkd now completes each at its AWS
# default, and the key only when KMS reports it AWS managed.
#
# Phases:
#   1. Deploy one replica on the AWS managed key, declaring nothing else on it.
#   2. Strip the table's `observedProperties` from the state record (the
#      template-bag baseline), asserting it was there first.
#   3. `cdkd drift --json` reports nothing drifted (pre-fix: `Replicas`).
#   4. Turn deletion protection ON out of band: drift reports `Replicas`
#      (a completed default must not hide a real change), exit 1. Then turn it
#      back off for the destroy.
#   5. Destroy; assert the table and the state file are gone.
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

STACK="CdkdGlobalTableTemplateBaselineDrift"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE="${STACK}-table"
LOGICAL_ID="BaselineTable"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
WORK_DIR=""

# Table ACTIVE and its replica ACTIVE.
wait_settled() {
  local i tbl reps
  for i in $(seq 1 90); do
    tbl="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
      --query 'Table.TableStatus' --output text)" || return 1
    reps="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
      --query "join(' ', Table.Replicas[].ReplicaStatus || \`[]\`)" --output text)" || return 1
    if [ "${tbl}" = "ACTIVE" ] && { [ "${reps}" = "ACTIVE" ] || [ -z "${reps}" ]; }; then
      echo "    settled (table=${tbl} replicas=${reps:-<none listed>})"
      return 0
    fi
    sleep 10
  done
  echo "FAIL: table did not settle (table='${tbl}' replicas='${reps}')" >&2
  exit 1
}

# Every drifted change path, one per line, sorted.
drift_paths() { # usage: drift_paths <json file>
  jq -r '[.[] | .drifted[]? | .changes[]? | .path] | unique | .[]' "$1"
}

# `cdkd drift --json` into a file; echoes the exit code.
run_drift() { # usage: run_drift <json file>
  local rc
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --json >"$1" 2>"$1.err"
  rc=$?
  set -e
  echo "${rc}"
}

# Deletion protection off. DynamoDB refuses a protection change within 15s of
# the last one ("... within the previous 15000 milliseconds") and any change
# while the table is UPDATING (ResourceInUseException), so retry those alone,
# bounded; any other failure is returned to the caller.
protection_off() {
  local out i
  for i in $(seq 1 12); do
    if out="$(aws dynamodb update-table --table-name "${TABLE}" --region "${REGION}" \
      --no-deletion-protection-enabled 2>&1 >/dev/null)"; then
      return 0
    fi
    grep -qE "within the previous|ResourceInUseException" <<<"${out}" || { printf '%s\n' "${out}" >&2; return 1; }
    sleep 5
  done
  printf '%s\n' "${out}" >&2
  return 1
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  protection_off >/dev/null 2>&1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if ! out="$(aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" 2>&1)"; then
    if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
      echo "WARN: cleanup could not delete ${TABLE} in ${REGION}; delete it by hand" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  if [ -n "${WORK_DIR:-}" ]; then rm -rf "${WORK_DIR}"; fi
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
WORK_DIR="$(mktemp -d)"

# --- Phase 1: deploy ----------------------------------------------------------
echo "==> Phase 1: deploy (one replica, AWS managed key, nothing else declared)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_settled
SSE_TYPE="$(aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
  --query 'Table.SSEDescription.SSEType' --output text)"
if [ "${SSE_TYPE}" != "KMS" ]; then
  echo "FAIL: Phase 1 premise: the table's SSE type is '${SSE_TYPE}', expected KMS (the AWS managed key)" >&2
  exit 1
fi
echo "    table on KMS SSE"

# --- Phase 2: strip observedProperties ----------------------------------------
echo "==> Phase 2: strip the table's observedProperties (template-bag baseline)"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/lock.json"; then
  echo "FAIL: Phase 2: a lock is held on ${STACK}; the state rewrite needs none" >&2
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK_DIR}/state.json" >/dev/null
HAS_OBSERVED="$(jq -r --arg lid "${LOGICAL_ID}" '.resources[$lid] | has("observedProperties")' "${WORK_DIR}/state.json")"
if [ "${HAS_OBSERVED}" != "true" ]; then
  echo "FAIL: Phase 2 premise: the ${LOGICAL_ID} record has no observedProperties to strip ('${HAS_OBSERVED}')" >&2
  exit 1
fi
jq --arg lid "${LOGICAL_ID}" 'del(.resources[$lid].observedProperties)' "${WORK_DIR}/state.json" >"${WORK_DIR}/stripped.json"
aws s3 cp "${WORK_DIR}/stripped.json" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
STRIPPED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg lid "${LOGICAL_ID}" '.resources[$lid] | has("observedProperties")')"
if [ "${STRIPPED}" != "false" ]; then
  echo "FAIL: Phase 2: the rewritten record still has observedProperties ('${STRIPPED}')" >&2
  exit 1
fi
echo "    observedProperties stripped"

# --- Phase 3: drift is clean ----------------------------------------------------
echo "==> Phase 3: cdkd drift on the template-bag baseline reports nothing"
RC="$(run_drift "${WORK_DIR}/drift3.json")"
PATHS="$(drift_paths "${WORK_DIR}/drift3.json")" || {
  echo "FAIL: Phase 3: drift --json is not readable (rc ${RC})" >&2
  cat "${WORK_DIR}/drift3.json" "${WORK_DIR}/drift3.json.err" >&2
  exit 1
}
if [ "${RC}" != "0" ] || [ -n "${PATHS}" ]; then
  echo "FAIL: Phase 3: drift exited ${RC} with drifted paths [${PATHS//$'\n'/, }] on an untouched table (issues #5789 / #5790)" >&2
  cat "${WORK_DIR}/drift3.json" "${WORK_DIR}/drift3.json.err" >&2
  exit 1
fi
# Not vacuous: the table must be listed as fully compared and clean (an
# empty or reshaped report, or a skipped table, would also show no paths).
if ! jq -e --arg lid "${LOGICAL_ID}" 'length > 0 and any(.[]; any(.clean[]?; .logicalId == $lid))' \
  "${WORK_DIR}/drift3.json" >/dev/null; then
  echo "FAIL: Phase 3: drift did not report ${LOGICAL_ID} as compared and clean" >&2
  cat "${WORK_DIR}/drift3.json" "${WORK_DIR}/drift3.json.err" >&2
  exit 1
fi
echo "    drift exit 0, ${LOGICAL_ID} compared and clean"

# --- Phase 4: a real change still drifts ---------------------------------------
echo "==> Phase 4: deletion protection ON out of band must still drift"
aws dynamodb update-table --table-name "${TABLE}" --region "${REGION}" \
  --deletion-protection-enabled >/dev/null
wait_settled
RC="$(run_drift "${WORK_DIR}/drift4.json")"
PATHS="$(drift_paths "${WORK_DIR}/drift4.json")" || {
  echo "FAIL: Phase 4: drift --json is not readable (rc ${RC})" >&2
  cat "${WORK_DIR}/drift4.json" "${WORK_DIR}/drift4.json.err" >&2
  exit 1
}
if [ "${RC}" != "1" ] || ! grep -qx 'Replicas' <<<"${PATHS}"; then
  echo "FAIL: Phase 4: drift exited ${RC} with paths [${PATHS//$'\n'/, }]; expected exit 1 naming Replicas (a completed default hid a real change)" >&2
  cat "${WORK_DIR}/drift4.json" "${WORK_DIR}/drift4.json.err" >&2
  exit 1
fi
if ! jq -e --arg lid "${LOGICAL_ID}" \
  'any(.[]; any(.drifted[]?; .logicalId == $lid and any(.changes[]?; .path == "Replicas" and (.awsValue | tostring | test("\"DeletionProtectionEnabled\":true")))))' \
  "${WORK_DIR}/drift4.json" >/dev/null; then
  echo "FAIL: Phase 4: the Replicas drift does not carry the live DeletionProtectionEnabled: true" >&2
  cat "${WORK_DIR}/drift4.json" >&2
  exit 1
fi
echo "    drift exit 1, Replicas reported with the live protection"
protection_off || { echo "FAIL: Phase 4: could not turn deletion protection back off" >&2; exit 1; }
wait_settled

# --- Phase 5: destroy ----------------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "table ${TABLE} still exists in ${REGION} after destroy" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    table and state gone"

trap - EXIT INT TERM
rm -rf "${WORK_DIR}"
echo "[verify] PASS — GlobalTable drift on a template-bag baseline: AWS defaults and the AWS managed key read as no drift, a real change still drifts (issues #5789, #5790), all 5 phases passed"
