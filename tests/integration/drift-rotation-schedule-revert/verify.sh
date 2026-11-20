#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6497 and #6498.
#
# An AWS::SecretsManager::RotationSchedule (Cloud Control routed) declared as
# `ScheduleExpression: rate(60 days)` with `RotateImmediatelyOnUpdate: false`.
#
# - #6497: Secrets Manager reads the schedule back with
#   `AutomaticallyAfterDays: 60` too. The drift baseline records both, and
#   `cdkd drift --revert -y` sent both, which Secrets Manager refuses:
#     You cannot specify both rotation frequency and schedule expression together.
# - #6498: the revert dropped the write-only `RotateImmediatelyOnUpdate`, so
#   Secrets Manager rotated immediately. The rotation function does nothing,
#   so an immediate rotation never finishes and leaves an AWSPENDING version.
#
# Phases:
#   1. Deploy. Premise: the schedule is Cloud Control provisioned and its
#      baseline holds the AutomaticallyAfterDays echo beside the expression.
#   2. `cdkd drift` exits 0.
#   3. Out of band: rotation rules AutomaticallyAfterDays=10, no rotation.
#   4. `cdkd drift` exits 1 and names the schedule.
#   5. `cdkd drift --revert -y` exits 0; the live schedule is rate(60 days)
#      and no AWSPENDING version exists (no rotation was started).
#   6. `cdkd drift` exits 0 again.
#   7. Destroy + gone-probes.
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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh

STACK="CdkdDriftRotationScheduleRevertExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SCHEDULE_ID="SecretSchedule18F2CB66"
DRIFT_LOG=""
REVERT_DIR=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  rm -f "${REVERT_DIR:-/nonexistent}"/revert-ids-* 2>/dev/null
  rmdir "${REVERT_DIR:-/nonexistent}" 2>/dev/null
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
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
# Created AFTER the pre-run cleanup above, which removes it (go-to-k/cdkd#6639).
REVERT_DIR="$(mktemp -d)"

run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  rm -f "${DRIFT_LOG:-}"
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
SECRET_ARN="$(jq -r --arg id "${SCHEDULE_ID}" '.resources[$id].physicalId // empty' <<<"${STATE_JSON}")"
FUNCTION_NAME="$(jq -r '.resources.Rotation9515E0C5.physicalId // empty' <<<"${STATE_JSON}")"
LOG_GROUP="$(jq -r '.resources.RotationLogsB9FF37BB.physicalId // empty' <<<"${STATE_JSON}")"
if [ -z "${SECRET_ARN}" ] || [ -z "${FUNCTION_NAME}" ] || [ -z "${LOG_GROUP}" ]; then
  echo "FAIL: Phase 1: the state lacks the schedule, function or log group record" >&2
  exit 1
fi
# Premise: Cloud Control provisioned, and the baseline records Secrets
# Manager's AutomaticallyAfterDays echo beside the declared expression.
# Without both this run proves nothing.
if [ "$(jq -r --arg id "${SCHEDULE_ID}" '.resources[$id].provisionedBy // empty' <<<"${STATE_JSON}")" != "cc-api" ]; then
  echo "FAIL: premise: the rotation schedule record is not Cloud Control provisioned" >&2
  exit 1
fi
if [ "$(jq -r --arg id "${SCHEDULE_ID}" '.resources[$id].observedProperties.RotationRules.AutomaticallyAfterDays // empty' <<<"${STATE_JSON}")" != "60" ]; then
  echo "FAIL: premise: the schedule baseline records no AutomaticallyAfterDays echo" >&2
  exit 1
fi

expect_no_pending() { # usage: expect_no_pending <phase label>
  local described pending
  if ! described="$(aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --output json)"; then
    echo "FAIL: $1: describe-secret failed" >&2
    return 1
  fi
  pending="$(jq '[.VersionIdsToStages // {} | to_entries[] | select(.value | index("AWSPENDING"))] | length' \
    <<<"${described}")" || return 1
  if [ "${pending}" != "0" ]; then
    echo "FAIL: $1: the secret has an AWSPENDING version — a rotation was started" >&2
    exit 1
  fi
  echo "    ok: $1: no AWSPENDING version"
}
expect_no_pending "Phase 1"

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: change the rotation rules out of band"
aws secretsmanager rotate-secret --secret-id "${SECRET_ARN}" \
  --rotation-rules AutomaticallyAfterDays=10 --no-rotate-immediately >/dev/null
expect_no_pending "Phase 3"

echo "==> Phase 4: cdkd drift reports the schedule"
run_drift
expect_drift_rc 1 "Phase 4"
if ! grep -qF "${SCHEDULE_ID} (AWS::SecretsManager::RotationSchedule)" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 4: no drift block for ${SCHEDULE_ID} — the report wording drifted" >&2
  exit 1
fi

echo "==> Phase 5: cdkd drift --revert -y reverts the schedule without rotating"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-1-before" "${STACK}" "${SCHEDULE_ID}" || exit 1
run_drift --revert -y
revert_output_assert_no_replacement "${DRIFT_LOG}" || exit 1
revert_identity_snapshot "${REVERT_DIR}/revert-ids-1-after" "${STACK}" "${SCHEDULE_ID}" || exit 1
revert_identity_assert_unchanged "${REVERT_DIR}/revert-ids-1-before" "${REVERT_DIR}/revert-ids-1-after" 1 || exit 1
expect_drift_rc 0 "Phase 5"
SCHEDULE="$(aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" \
  --query RotationRules.ScheduleExpression --output text)"
if [ "${SCHEDULE}" != "rate(60 days)" ]; then
  echo "FAIL: Phase 5: live schedule is '${SCHEDULE}', want 'rate(60 days)'" >&2
  exit 1
fi
echo "    ok: Phase 5: live schedule rate(60 days)"
expect_no_pending "Phase 5"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
# ForceDeleteWithoutRecovery is asynchronous: describe-secret still answers
# for a few seconds after the call returns, so poll the strict gone-probe.
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_ARN}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" != "1" ]; then
  echo "FAIL: secret ${SECRET_ARN} leaked" >&2
  exit 1
fi
assert_gone "function ${FUNCTION_NAME} leaked" aws lambda get-function --function-name "${FUNCTION_NAME}"
assert_gone "log group ${LOG_GROUP} leaked" aws logs describe-log-streams --log-group-name "${LOG_GROUP}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
echo "PASS: drift-rotation-schedule-revert"
