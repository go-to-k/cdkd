#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the standalone `cdkd rollback` command
# (issue #1183): revert a failed `--no-rollback` deploy back to its pre-deploy
# state via the persisted rollback journal.
#
# What this asserts:
#   PHASE 1 (update + create rollback):
#     1. Deploy v1 clean (Marker=v1). Marker exists on AWS with value v1.
#     2. Deploy v2 with MARKER_VALUE=v2 + a new Extra param + INJECT_FAIL, under
#        --no-rollback: exit NON-ZERO, a rollback-journal.json object is present,
#        partial state records BOTH Marker + Extra, AND (because --no-rollback
#        skipped rollback) the completed ops LANDED on AWS — Marker is at v2 and
#        Extra exists.
#     3. `cdkd rollback --force`: exit 0. Marker is back to v1, Extra is GONE,
#        the journal is GONE, and state.json records exactly the v1 resource set
#        (1 resource: Marker). `cdkd events` shows a rollback run = SUCCEEDED.
#   PHASE 2 (initialDeploy rollback):
#     4. First-ever deploy of a second stack with INJECT_FAIL + --no-rollback:
#        exit non-zero, journal present, InitMarker created.
#     5. `cdkd rollback --force`: exit 0. InitMarker GONE and state.json for that
#        stack REMOVED ENTIRELY (initialDeploy path), journal GONE.
#   PHASE 3 (destroy clean):
#     6. Destroy stack 1: clean, state gone, 0 orphans.
#   Cleanup (EXIT trap) aggressively removes any orphan SSM params / SQS queues
#   + the events sidecars for BOTH stacks — this test INTENTIONALLY fails a
#   deploy, so the trap must not leak resources.
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture pattern
# (bash ...; rc=$?) so a piped/teed harness can't mask a failure; the script
# prints an explicit "[verify] PASS" only at the very end.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdRollbackCommandExample"
INIT_STACK="CdkdRollbackCommandInitial"
MARKER_NAME="${STACK}-marker"
EXTRA_NAME="${STACK}-extra"
FAILING_QUEUE_NAME="${STACK}-failing-queue"
INIT_MARKER_NAME="${INIT_STACK}-marker"
INIT_FAILING_QUEUE_NAME="${INIT_STACK}-failing-queue"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-command"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
INIT_STATE_KEY="cdkd/${INIT_STACK}/${REGION}/state.json"
INIT_JOURNAL_KEY="cdkd/${INIT_STACK}/${REGION}/rollback-journal.json"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# --- Read an SSM parameter's value. Called only where the parameter is
# expected to exist, so a failure aborts loudly under set -e (the probe is the
# tail-less LAST command of the body — legal per #1120). ---
ssm_value() { # usage: ssm_value <name>
  aws ssm get-parameter --name "$1" --region "${REGION}" \
    --query 'Parameter.Value' --output text
}

# --- Count resources recorded in a stack's cdkd state.json (echoes a number,
# or 'gone' when the state object is absent). ---
state_resource_count() { # usage: state_resource_count <state-key>
  local body
  if ! body="$(aws s3 cp "s3://${STATE_BUCKET}/$1" - 2>/dev/null)"; then
    echo "gone"
    return 0
  fi
  echo "${body}" | jq '(.resources // {}) | length'
}

aggressive_cleanup() {
  echo "[verify] aggressive cleanup: sweeping any fixture orphans"
  (
  set +eu
  local name q_url
  for name in "${MARKER_NAME}" "${EXTRA_NAME}" "${INIT_MARKER_NAME}"; do
    aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for name in "${FAILING_QUEUE_NAME}" "${INIT_FAILING_QUEUE_NAME}"; do
    q_url="$(aws sqs get-queue-url --queue-name "${name}" --region "${REGION}" \
      --query 'QueueUrl' --output text 2>/dev/null || true)"
    if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
      aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1 || true
    fi
  done
  )
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INIT_STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${INIT_STACK}"
      ${CLI} destroy "${INIT_STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    aggressive_cleanup
  fi
  # ALWAYS remove the events / journal / state sidecars for BOTH stacks so the
  # integ leaves nothing behind (events deliberately survive destroy).
  echo "[verify] cleanup: remove sidecars for both stacks"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${INIT_STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && CI=true pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

# ---------------------------------------------------------------------------
# PHASE 1: v1 clean → v2 --no-rollback failure → cdkd rollback
# ---------------------------------------------------------------------------
echo "[verify] step 2: deploy ${STACK} v1 (clean, Marker=v1)"
MARKER_VALUE=v1 ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

V1_MARKER="$(ssm_value "${MARKER_NAME}")"
if [ "${V1_MARKER}" != "v1" ]; then
  echo "[verify] FAIL: after v1 deploy, Marker value is '${V1_MARKER}' (expected 'v1')"
  exit 1
fi
V1_COUNT="$(state_resource_count "${STATE_KEY}")"
if [ "${V1_COUNT}" != "1" ]; then
  echo "[verify] FAIL: v1 state records ${V1_COUNT} resource(s) (expected 1: Marker)"
  exit 1
fi
echo "[verify] step 2 ok: v1 deployed, Marker=v1, state has 1 resource"

echo "[verify] step 3: deploy ${STACK} v2 (Marker=v2 + Extra + INJECT_FAIL) --no-rollback (expect FAILURE)"
set +e
MARKER_VALUE=v2 WITH_EXTRA=true INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > /tmp/rollback-cmd-v2.log 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-v2.log || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "[verify] FAIL: v2 --no-rollback deploy unexpectedly SUCCEEDED (rc=0)"
  exit 1
fi
echo "[verify] step 3 ok: v2 --no-rollback deploy failed (rc=${DEPLOY_RC})"

echo "[verify] step 3a: assert the rollback journal was written"
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: no rollback journal at s3://${STATE_BUCKET}/${JOURNAL_KEY}"
  exit 1
fi
echo "[verify]   ok: rollback journal present"

echo "[verify] step 3b: assert --no-rollback left the completed ops on AWS + in partial state"
V2_MARKER="$(ssm_value "${MARKER_NAME}")"
if [ "${V2_MARKER}" != "v2" ]; then
  echo "[verify] FAIL: after v2 --no-rollback, Marker value is '${V2_MARKER}' (expected 'v2' — the update landed and was NOT rolled back)"
  exit 1
fi
if ! aws ssm get-parameter --name "${EXTRA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: Extra parameter ${EXTRA_NAME} missing after v2 --no-rollback (should have been created)"
  exit 1
fi
V2_COUNT="$(state_resource_count "${STATE_KEY}")"
if [ "${V2_COUNT}" != "2" ]; then
  echo "[verify] FAIL: v2 partial state records ${V2_COUNT} resource(s) (expected 2: Marker + Extra)"
  exit 1
fi
echo "[verify] step 3b ok: Marker=v2 on AWS, Extra created, partial state has 2 resources"

echo "[verify] step 4: cdkd rollback ${STACK} --force (expect exit 0)"
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 4a: assert the update was reverted + the created resource is gone"
POST_MARKER="$(ssm_value "${MARKER_NAME}")"
if [ "${POST_MARKER}" != "v1" ]; then
  echo "[verify] FAIL: after rollback, Marker value is '${POST_MARKER}' (expected 'v1' — the UPDATE was not reverted)"
  exit 1
fi
assert_gone "Extra parameter ${EXTRA_NAME} still exists — rollback did not delete the v2-created resource" \
  aws ssm get-parameter --name "${EXTRA_NAME}" --region "${REGION}"
echo "[verify]   ok: Marker reverted to v1, Extra deleted"

echo "[verify] step 4b: assert the journal is gone and state matches v1"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal still present after a clean rollback"
  exit 1
fi
POST_COUNT="$(state_resource_count "${STATE_KEY}")"
if [ "${POST_COUNT}" != "1" ]; then
  echo "[verify] FAIL: post-rollback state records ${POST_COUNT} resource(s) (expected 1: Marker only)"
  exit 1
fi
echo "[verify] step 4b ok: journal gone, state back to the v1 resource set"

echo "[verify] step 4c: assert cdkd events recorded a rollback run = SUCCEEDED"
EVENTS_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --format json 2>&1)"
RB_CMD="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].command')"
RB_RESULT="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].result')"
if [ "${RB_CMD}" != "rollback" ] || [ "${RB_RESULT}" != "SUCCEEDED" ]; then
  echo "[verify] FAIL: newest run is not a SUCCEEDED rollback (command=${RB_CMD} result=${RB_RESULT})"
  echo "${EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 4c ok: newest run = rollback / SUCCEEDED"

# ---------------------------------------------------------------------------
# PHASE 2: first-ever failing deploy → cdkd rollback deletes state.json
# ---------------------------------------------------------------------------
echo "[verify] step 5: first-ever deploy of ${INIT_STACK} with INJECT_FAIL --no-rollback (expect FAILURE)"
set +e
INJECT_FAIL=true ${CLI} deploy "${INIT_STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > /tmp/rollback-cmd-init.log 2>&1
INIT_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-init.log || true
if [ "${INIT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: first-ever ${INIT_STACK} --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INIT_JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: no rollback journal for ${INIT_STACK}"
  exit 1
fi
if ! aws ssm get-parameter --name "${INIT_MARKER_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${INIT_MARKER_NAME} missing — the created sibling was not recorded"
  exit 1
fi
echo "[verify] step 5 ok: first-ever deploy failed, journal present, InitMarker created"

echo "[verify] step 6: cdkd rollback ${INIT_STACK} --force (initialDeploy path)"
${CLI} rollback "${INIT_STACK}" --state-bucket "${STATE_BUCKET}" --force

assert_gone "InitMarker ${INIT_MARKER_NAME} still exists after rollback" \
  aws ssm get-parameter --name "${INIT_MARKER_NAME}" --region "${REGION}"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INIT_STATE_KEY}"; then
  echo "[verify] FAIL: state.json for ${INIT_STACK} still present — the initialDeploy rollback must delete it"
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${INIT_JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal for ${INIT_STACK} still present after a clean rollback"
  exit 1
fi
echo "[verify] step 6 ok: initialDeploy rollback deleted InitMarker + state.json + journal"

# ---------------------------------------------------------------------------
# PHASE 3: destroy stack 1 clean
# ---------------------------------------------------------------------------
echo "[verify] step 7: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 7a: assert destroy is clean (state gone, 0 orphans)"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Marker ${MARKER_NAME} still exists after destroy" aws ssm get-parameter --name "${MARKER_NAME}" --region "${REGION}"
echo "[verify] step 7a ok: destroy clean"

echo "[verify] step 8: cleanup — remove the events sidecars so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${INIT_STACK}/" --recursive >/dev/null 2>&1 || true
for prefix in "${STACK}" "${INIT_STACK}"; do
  REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${prefix}/" 2>&1 || true)"
  if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
    echo "[verify] FAIL: sidecar not fully removed for ${prefix}:"
    echo "${REMAINING}" | sed 's/^/  /'
    exit 1
  fi
done
echo "[verify] step 8 ok: sidecars removed"

trap - EXIT INT TERM
echo "[verify] PASS"
