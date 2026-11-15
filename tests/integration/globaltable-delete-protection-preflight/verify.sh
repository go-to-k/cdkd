#!/usr/bin/env bash
# verify.sh — issue #6367: a GlobalTable delete must refuse BEFORE dropping any
# replica when a copy has deletion protection on, and must not strip the other
# regions first. Before the fix, `delete()` dropped every cross-region replica,
# then `DeleteTable` refused for the protected local table, which left the
# table in one region while state still recorded the replica.
#
# Protection is turned on OUT OF BAND (the template declares none), so the
# destroy prompt and the state record know nothing about it.
#   1. deploy: local table in REGION + one replica in REPLICA_REGION
#   2. local protection on  -> destroy refused, replica still there, state kept
#   3. local off, replica protection on -> destroy refused naming REPLICA_REGION
#   4. destroy --remove-protection -> both copies and state gone
#
# Slow: a replica takes minutes to create and to drop.

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
cd "$(dirname "$0")"

STACK="CdkdGlobalTableDeleteProtectionPreflight"
TABLE="CdkdGlobalTableDeleteProtectionPreflight"
REGION="${AWS_REGION:-us-east-1}"
export REPLICA_REGION="${REPLICA_REGION:-us-west-2}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

protection() { # usage: protection <region> <true|false>
  local flag="--no-deletion-protection-enabled"
  [ "$2" = true ] && flag="--deletion-protection-enabled"
  aws dynamodb update-table --table-name "${TABLE}" --region "$1" "${flag}" >/dev/null
  aws dynamodb wait table-exists --table-name "${TABLE}" --region "$1"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  for r in "${REGION}" "${REPLICA_REGION}"; do
    aws dynamodb update-table --table-name "${TABLE}" --region "${r}" --no-deletion-protection-enabled >/dev/null 2>&1
  done
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force --remove-protection >/dev/null 2>&1
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REPLICA_REGION}" >/dev/null 2>&1 || true
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ "${REPLICA_REGION}" = "${REGION}" ] && { echo "FAIL: REPLICA_REGION must differ from ${REGION}" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

replica_listed() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query "length(Table.Replicas[?RegionName=='${REPLICA_REGION}'])" --output text
}

# destroy_refused <log> <expected substring> <phase>
destroy_refused() {
  local log="$1" expected="$2" phase="$3"
  if node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --force >"${log}" 2>&1; then
    cat "${log}" >&2
    echo "FAIL: ${phase}: the destroy succeeded, expected a refusal" >&2
    exit 1
  fi
  if ! grep -qF -- "${expected}" "${log}"; then
    cat "${log}" >&2
    echo "FAIL: ${phase}: the refusal does not say '${expected}'" >&2
    exit 1
  fi
  echo "    OK: ${phase} refused: ${expected}"
  [ "$(replica_listed)" = "1" ] \
    || { echo "FAIL: ${phase}: the ${REPLICA_REGION} replica was dropped by a refused destroy" >&2; exit 1; }
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REPLICA_REGION}" >/dev/null \
    || { echo "FAIL: ${phase}: the ${REPLICA_REGION} copy is gone after a refused destroy" >&2; exit 1; }
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null \
    || { echo "FAIL: ${phase}: the state record is gone after a refused destroy" >&2; exit 1; }
  echo "    OK: both copies and the state record survive"
}

echo "==> Phase 1: deploy (${REGION} + replica in ${REPLICA_REGION})"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(replica_listed)" = "1" ] || { echo "FAIL: Phase 1: no ${REPLICA_REGION} replica after deploy" >&2; exit 1; }

echo "==> Phase 2: local deletion protection on (out of band)"
protection "${REGION}" true
destroy_refused "${LOG_DIR}/phase2.log" "deletion protection enabled in ${REGION}; cdkd changed nothing" "Phase 2"
protection "${REGION}" false

echo "==> Phase 3: replica deletion protection on (out of band)"
protection "${REPLICA_REGION}" true
destroy_refused "${LOG_DIR}/phase3.log" "deletion protection enabled in ${REPLICA_REGION}; cdkd changed nothing" "Phase 3"

echo "==> Phase 4: destroy --remove-protection"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --remove-protection
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REGION}"
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REPLICA_REGION}"
assert_gone "table ${TABLE} remains in ${REGION}" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
assert_gone "table ${TABLE} remains in ${REPLICA_REGION}" aws dynamodb describe-table --table-name "${TABLE}" --region "${REPLICA_REGION}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: both copies and state gone"
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo ""
echo "==> globaltable-delete-protection-preflight test passed"
