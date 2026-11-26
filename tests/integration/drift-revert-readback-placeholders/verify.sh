#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#7027, #7028 and #7029.
#
# `cdkd drift --revert` after an unrelated out-of-band change failed on an
# AppSync GraphQL API without logging, a Glue job and a Glue trigger: the
# read-back's placeholders for members AWS reports none of (`LogConfig: {}`,
# `ExecutionClass: ''`, `NotifyDelayAfter: 0`, `EventBatchingCondition: {}`)
# and the job's computed `MaxCapacity` were sent back, and AWS refused them.
#
# Phases:
#   1. Deploy. Premise: the three records are SDK provisioned and their
#      baselines hold the placeholders the revert sent back.
#   2. `cdkd drift` exits 0.
#   3. Out of band: rename the API, change the job's and the trigger's
#      Description.
#   4. `cdkd drift` exits 1 and names all three.
#   5. `cdkd drift --revert -y` exits 0 and keeps all three (identity); the
#      live name and descriptions are the template's again, and the job keeps
#      its workers.
#   6. `cdkd drift` exits 0.
#   7. Out of band: set the job's ExecutionClass to FLEX, a member its
#      baseline holds as a placeholder (AWS also lowers its Timeout to 120).
#   8. `cdkd drift` exits 1; `cdkd drift --revert -y` exits 0; the job is no
#      longer FLEX and its Timeout is 2880 again.
#   9. `cdkd drift` exits 0.
# (The API's logging is not in this arm: a LogConfig the template does not
# declare is not compared, as in CloudFormation, so turning it on out of band
# is not drift.)
#  10. Destroy + gone-probes.
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
# shellcheck source=../cr-log-groups.sh
. ../cr-log-groups.sh

STACK="CdkdDriftRevertPlaceholdersExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
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
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
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
# The logical id of the record whose constructPath is <path>.
logical_id_at() { # usage: logical_id_at <constructPath>
  jq -r --arg p "$1" '[.resources | to_entries[] | select(.value.constructPath == $p) | .key] | if length == 1 then .[0] else empty end' \
    <<<"${STATE_JSON}"
}
pid_of() { jq -r --arg id "$1" '.resources[$id].physicalId // empty' <<<"${STATE_JSON}"; }

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
API_ID_LID="$(logical_id_at "${STACK}/Api")"
JOB_LID="$(logical_id_at "${STACK}/Job")"
TRIGGER_LID="$(logical_id_at "${STACK}/Trigger")"
if [ -z "${API_ID_LID}" ] || [ -z "${JOB_LID}" ] || [ -z "${TRIGGER_LID}" ]; then
  echo "FAIL: Phase 1: the state lacks the API, job or trigger record" >&2
  exit 1
fi
API_ID="$(pid_of "${API_ID_LID}")"
JOB="$(pid_of "${JOB_LID}")"
TRIGGER="$(pid_of "${TRIGGER_LID}")"
SCRIPTS="$(pid_of "$(logical_id_at "${STACK}/Scripts/Resource")")"
GLUE_ROLE="$(pid_of "$(logical_id_at "${STACK}/GlueRole/Resource")")"
if [ -z "${SCRIPTS}" ] || [ -z "${GLUE_ROLE}" ]; then
  echo "FAIL: Phase 1: the state lacks the bucket or the role record" >&2
  exit 1
fi
for id in "${API_ID_LID}" "${JOB_LID}" "${TRIGGER_LID}"; do
  if [ "$(jq -r --arg id "${id}" '.resources[$id].provisionedBy // empty' <<<"${STATE_JSON}")" != "sdk" ]; then
    echo "FAIL: premise: ${id} is not SDK provisioned" >&2
    exit 1
  fi
done
# Premise: each baseline holds a placeholder the revert sent back.
premise() { # usage: premise <logical id> <jq path under observedProperties> <want>
  local got
  got="$(jq -c --arg id "$1" ".resources[\$id].observedProperties$2" <<<"${STATE_JSON}")" || return 1
  if [ "${got}" != "$3" ]; then
    echo "FAIL: premise: ${1}${2} is ${got}, want $3" >&2
    exit 1
  fi
}
premise "${API_ID_LID}" '.LogConfig' '{}'
premise "${JOB_LID}" '.ExecutionClass' '""'
premise "${JOB_LID}" '.NotificationProperty' '{"NotifyDelayAfter":0}'
premise "${TRIGGER_LID}" '.EventBatchingCondition' '{}'
API_NAME="$(aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}" --query graphqlApi.name --output text)"

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: change all three out of band"
aws appsync update-graphql-api --region "${REGION}" --api-id "${API_ID}" --name "${API_NAME}-oob" \
  --authentication-type API_KEY >/dev/null
JOB_DEF="$(aws glue get-job --region "${REGION}" --job-name "${JOB}" --output json)"
aws glue update-job --region "${REGION}" --job-name "${JOB}" --job-update "$(jq -c \
  '.Job | {Role, Command, Description: "oob", GlueVersion, WorkerType, NumberOfWorkers}' <<<"${JOB_DEF}")" >/dev/null
aws glue update-trigger --region "${REGION}" --name "${TRIGGER}" --trigger-update "$(jq -cn \
  --arg job "${JOB}" '{Description: "oob", Actions: [{JobName: $job}]}')" >/dev/null

echo "==> Phase 4: cdkd drift reports all three"
run_drift
expect_drift_rc 1 "Phase 4"
for id in "${API_ID_LID} (AWS::AppSync::GraphQLApi)" "${JOB_LID} (AWS::Glue::Job)" "${TRIGGER_LID} (AWS::Glue::Trigger)"; do
  if ! grep -qF "${id}" "${DRIFT_LOG}"; then
    echo "FAIL: Phase 4: no drift block for ${id} — the report wording drifted" >&2
    exit 1
  fi
done

echo "==> Phase 5: cdkd drift --revert -y reverts all three in place"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-1-before" "${STACK}" "${API_ID_LID}" "${JOB_LID}" "${TRIGGER_LID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-1-before" "${REVERT_DIR}/revert-ids-1-after" 3 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 5"
expect_text() { # usage: expect_text <phase label> <what> <got> <want>
  if [ "$3" != "$4" ]; then
    echo "FAIL: $1: $2 is '$3', want '$4'" >&2
    exit 1
  fi
  echo "    ok: $1: $2 '$4'"
}
expect_text "Phase 5" "API name" \
  "$(aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}" --query graphqlApi.name --output text)" "${API_NAME}"
expect_text "Phase 5" "job description / workers" \
  "$(aws glue get-job --region "${REGION}" --job-name "${JOB}" --query 'Job.[Description,WorkerType,NumberOfWorkers]' --output text)" \
  "$(printf 'integ job\tG.1X\t2')"
expect_text "Phase 5" "trigger description" \
  "$(aws glue get-trigger --region "${REGION}" --name "${TRIGGER}" --query Trigger.Description --output text)" "integ trigger"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

echo "==> Phase 7: set the job's ExecutionClass to FLEX, out of band"
JOB_DEF="$(aws glue get-job --region "${REGION}" --job-name "${JOB}" --output json)"
aws glue update-job --region "${REGION}" --job-name "${JOB}" --job-update "$(jq -c \
  '.Job | {Role, Command, Description, GlueVersion, WorkerType, NumberOfWorkers, ExecutionClass: "FLEX"}' <<<"${JOB_DEF}")" >/dev/null

echo "==> Phase 8: cdkd drift reports it, and --revert takes it back off"
run_drift
expect_drift_rc 1 "Phase 8 (drift)"
# A `+ <path>` change line under each resource's block, and both blocks.
if ! grep -qF "${JOB_LID} (AWS::Glue::Job)" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 8: no drift block for ${JOB_LID} — the report wording drifted" >&2
  exit 1
fi
for path in "ExecutionClass"; do
  if ! grep -qE "^ +\+ ${path}[.:]" "${DRIFT_LOG}"; then
    echo "FAIL: Phase 8: the drift report has no '+ ${path}' change line" >&2
    exit 1
  fi
done
revert_identity_snapshot "${REVERT_DIR}/revert-ids-2-before" "${STACK}" "${JOB_LID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-2-before" "${REVERT_DIR}/revert-ids-2-after" 1 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 8 (revert)"
JOB_CLASS="$(aws glue get-job --region "${REGION}" --job-name "${JOB}" --query Job.ExecutionClass --output text)"
if [ "${JOB_CLASS}" = "FLEX" ]; then
  echo "FAIL: Phase 8: the job is still FLEX after the revert" >&2
  exit 1
fi
echo "    ok: Phase 8: job execution class '${JOB_CLASS}'"
expect_text "Phase 8" "job timeout" \
  "$(aws glue get-job --region "${REGION}" --job-name "${JOB}" --query Job.Timeout --output text)" "2880"

echo "==> Phase 9: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 9"

echo "==> Phase 10: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "API ${API_ID} leaked" aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}"
assert_gone "job ${JOB} leaked" aws glue get-job --region "${REGION}" --job-name "${JOB}"
assert_gone "trigger ${TRIGGER} leaked" aws glue get-trigger --region "${REGION}" --name "${TRIGGER}"
assert_gone "bucket ${SCRIPTS} leaked" aws s3api head-bucket --bucket "${SCRIPTS}"
assert_gone "role ${GLUE_ROLE} leaked" aws iam get-role --role-name "${GLUE_ROLE}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
rm -f "${DRIFT_LOG:-}"
rm -f "${REVERT_DIR}"/revert-ids-* 2>/dev/null || true
rmdir "${REVERT_DIR}" 2>/dev/null || true
echo "PASS: drift-revert-readback-placeholders"
