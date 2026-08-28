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
#   PHASE R (reverse-replacement, issue #1199):
#     R1. Deploy with REPLACE_SUFFIX=b + INJECT_FAIL under --no-rollback:
#         ReplaceParam is REPLACED (old `-replace-a` deleted, new `-replace-b`
#         created — Name is create-only), then FailingQueue fails. Journal
#         records the replacement op.
#     R2. `cdkd rollback --force`: exit 0. The replacement is REVERSED —
#         `-replace-a` re-created, `-replace-b` deleted, journal gone, and
#         the rollback output mentions the reverse-replacement.
#   PHASE F (--revert-failed, issue #1198):
#     F1. Deploy with MARKER_VALUE=vF + INJECT_UPDATE_FAIL under
#         --no-rollback: Marker updates to vF (completes first), then
#         RevertQueue's UPDATE fails (out-of-range retention). The journal
#         segment carries failedOperations[] with the failed op's pre-op
#         state + ATTEMPTED properties.
#     F2. `cdkd rollback --force --revert-failed`: exit 0. Marker back to v1
#         AND the failed RevertQueue is force-reverted (retention 3600),
#         journal gone.
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
REPLACE_A_NAME="${STACK}-replace-a"
REPLACE_B_NAME="${STACK}-replace-b"
REVERT_QUEUE_NAME="${STACK}-revert-queue"
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

# Shared S3 VERSION helpers (issue #2096). Sourced by ABSOLUTE path rather than
# the usual `. ../s3-versions.sh`, because this fixture does not `cd` into its
# own directory until step 1 and the keys below are derived before that.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
# The NEGATIVE CONTROL for the journal version arm below: a state-bucket key
# issue #2346 deliberately does NOT purge (site 5 -- `lock.json` carries no
# secret and sits on the hot path of every command, so the recorded remedy is a
# bucket lifecycle rule, not code).
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
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
  for name in "${MARKER_NAME}" "${EXTRA_NAME}" "${REPLACE_A_NAME}" "${REPLACE_B_NAME}" "${INIT_MARKER_NAME}"; do
    aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for name in "${FAILING_QUEUE_NAME}" "${REVERT_QUEUE_NAME}" "${INIT_FAILING_QUEUE_NAME}"; do
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
if [ "${V1_COUNT}" != "3" ]; then
  echo "[verify] FAIL: v1 state records ${V1_COUNT} resource(s) (expected 3: Marker + ReplaceParam + RevertQueue)"
  exit 1
fi
echo "[verify] step 2 ok: v1 deployed, Marker=v1, state has 3 resources"

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

# --- PREMISE for the version arm at step 4b1 -------------------------------
# That arm certifies that the journal's history is GONE after a clean
# rollback. `0 versions AND 0 leaks` is not a pass, it is an arm that did
# nothing -- so establish here, while the journal is still a live object, that
# there IS a body for the purge to have to remove. `head-object` above already
# proves the CURRENT version is a real object rather than a delete marker; this
# adds the count, and distinguishes "zero" from "could not list" via the
# helper's tri-state (it returns 1 on a failed LIST).
if ! JOURNAL_VERSIONS_BEFORE="$(s3_count_key_versions "${STATE_BUCKET}" "${JOURNAL_KEY}" all)"; then
  echo "[verify] FAIL: could not list object versions for s3://${STATE_BUCKET}/${JOURNAL_KEY}." >&2
  echo "         The step 4b1 version assertion would be unverifiable, so failing here instead." >&2
  exit 1
fi
if [ "${JOURNAL_VERSIONS_BEFORE}" -lt 1 ]; then
  echo "[verify] FAIL: the journal key holds ${JOURNAL_VERSIONS_BEFORE} version(s) while head-object says it exists." >&2
  echo "         Step 4b1 would then certify a purge that had nothing to purge." >&2
  exit 1
fi
echo "[verify]   ok: journal key holds ${JOURNAL_VERSIONS_BEFORE} version row(s) before the rollback"

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
if [ "${V2_COUNT}" != "4" ]; then
  echo "[verify] FAIL: v2 partial state records ${V2_COUNT} resource(s) (expected 4: Marker + Extra + ReplaceParam + RevertQueue)"
  exit 1
fi
echo "[verify] step 3b ok: Marker=v2 on AWS, Extra created, partial state has 4 resources"

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
if [ "${POST_COUNT}" != "3" ]; then
  echo "[verify] FAIL: post-rollback state records ${POST_COUNT} resource(s) (expected 3: the v1 resource set)"
  exit 1
fi

echo "[verify] step 4b ok: journal gone, state back to the v1 resource set"

# --- step 4b1: the journal's NONCURRENT VERSIONS are gone too (issue #2346) ---
#
# Step 4b's `head-object` probe is NOT this. The state bucket is VERSIONED
# (`cdkd bootstrap` turns versioning on), so a bare `DeleteObject` writes a
# DELETE MARKER: `head-object` answers 404 while every earlier body stays
# readable through `GetObject --version-id`. That is the whole defect -- the
# journal's `failedOperations[].attemptedProperties` is the properties of the
# FAILED write verbatim, measured 2026-08-20 on
# CdkdDeletionPolicySnapshotHeavyExample as four surviving versions each
# carrying a literal `"MasterUserPassword": "Cdkdcf2f..."`. So step 4b passes
# identically with the fix reverted, and this is the arm that does not.
#
# WHY THE ASSERTION IS `all == 1` AND NOT MERELY "nothing survives".
# An absence is also produced by a run that died before writing a journal, and
# by a teardown sweep having already run. `all == 1` is a POSITIVE marker of
# the fixed path: exactly one row survives, and it can only be the CURRENT
# delete marker that cdkd's own `DeleteObject` wrote -- the purge filters on
# `IsLatest` and so can never remove it. Expected rows here:
#
#   fixed    [DM_latest]                      -> all 1, noncurrent 0
#   reverted [DM_latest, journal body, DM_0]  -> all 3, noncurrent 2
#
# (`DM_0` is the delete marker the step-2 CLEAN deploy wrote over a key that
# never existed -- `deleteRollbackJournal` runs on the success path too.)
echo "[verify] step 4b1: assert the journal's NONCURRENT versions were purged, not just delete-markered"
if ! JOURNAL_ALL_AFTER="$(s3_count_key_versions "${STATE_BUCKET}" "${JOURNAL_KEY}" all)"; then
  echo "[verify] FAIL: could not list object versions for s3://${STATE_BUCKET}/${JOURNAL_KEY} after the rollback." >&2
  echo "         An unverified purge is not a verified purge - failing rather than assuming." >&2
  exit 1
fi
if ! JOURNAL_NONCURRENT_AFTER="$(s3_count_key_versions "${STATE_BUCKET}" "${JOURNAL_KEY}" noncurrent)"; then
  echo "[verify] FAIL: could not list noncurrent versions for s3://${STATE_BUCKET}/${JOURNAL_KEY}." >&2
  exit 1
fi
if [ "${JOURNAL_ALL_AFTER}" -ne 1 ] || [ "${JOURNAL_NONCURRENT_AFTER}" -ne 0 ]; then
  echo "[verify] FAIL: after a clean rollback the journal key holds ${JOURNAL_ALL_AFTER} row(s)" >&2
  echo "         (${JOURNAL_NONCURRENT_AFTER} noncurrent); expected exactly 1 row, the current delete marker," >&2
  echo "         and 0 noncurrent. ${JOURNAL_VERSIONS_BEFORE} row(s) existed before the rollback, so the" >&2
  echo "         journal body was really there to be removed. Inspect with:" >&2
  echo "           aws s3api list-object-versions --bucket ${STATE_BUCKET} --prefix ${JOURNAL_KEY}" >&2
  exit 1
fi
echo "[verify]   ok: journal key down to 1 row (the current delete marker), 0 noncurrent"

# NEGATIVE CONTROL. Every assertion above is also satisfied by a purge that
# fired on EVERYTHING in the state bucket, which would be a different and worse
# bug -- issue #2346 deliberately leaves `state.json` alone (its noncurrent
# versions ARE the recovery capability) and deliberately leaves `lock.json`
# alone (site 5). `lock.json` is the sharper control of the two because this
# fixture has by now run several acquire/release cycles against it, so its
# history is guaranteed non-empty rather than merely likely.
echo "[verify] step 4b2: negative control - lock.json history must SURVIVE"
if ! LOCK_NONCURRENT="$(s3_count_key_versions "${STATE_BUCKET}" "${LOCK_KEY}" noncurrent)"; then
  echo "[verify] FAIL: could not list noncurrent versions for s3://${STATE_BUCKET}/${LOCK_KEY}." >&2
  echo "         Without this count the step 4b1 assertion cannot be told apart from a purge-everything bug." >&2
  exit 1
fi
if [ "${LOCK_NONCURRENT}" -lt 1 ]; then
  echo "[verify] FAIL: lock.json has ${LOCK_NONCURRENT} noncurrent version(s) after three acquire/release" >&2
  echo "         cycles. Either the purge is running on keys issue #2346 excludes, or the lock is no longer" >&2
  echo "         being written per acquisition - both make step 4b1's result meaningless." >&2
  exit 1
fi
echo "[verify]   ok: ${LOCK_NONCURRENT} noncurrent lock.json version(s) survive, as site 5 intends"

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
# PHASE R: reverse-replacement rollback (issue #1199)
# ---------------------------------------------------------------------------
echo "[verify] step R1: deploy ${STACK} with REPLACE_SUFFIX=b + INJECT_FAIL --no-rollback (expect FAILURE after the replacement)"
# --force-stateful-recreation: AWS::SSM::Parameter is a stateful type, so the
# property-driven replacement (create-only Name change) requires the explicit
# data-loss confirmation flag.
set +e
REPLACE_SUFFIX=b INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback --force-stateful-recreation > /tmp/rollback-cmd-replace.log 2>&1
REPLACE_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-replace.log || true
if [ "${REPLACE_RC}" -eq 0 ]; then
  echo "[verify] FAIL: REPLACE_SUFFIX=b --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: no rollback journal after the replacement deploy"
  exit 1
fi
# The replacement landed: new-named param exists, old-named param deleted.
if ! aws ssm get-parameter --name "${REPLACE_B_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${REPLACE_B_NAME} missing — the replacement did not land"
  exit 1
fi
assert_gone "old ${REPLACE_A_NAME} still exists — the replacement did not delete it" \
  aws ssm get-parameter --name "${REPLACE_A_NAME}" --region "${REGION}"
echo "[verify] step R1 ok: replacement landed (b created, a deleted), journal present"

echo "[verify] step R2: cdkd rollback ${STACK} --force (expect reverse-replacement, exit 0)"
# Success-expected, but echo the captured output BEFORE asserting the exit
# code — a bare invocation under `set -e` would abort before the sed echo,
# losing the failing rollback's output from the harness log (issue #1220).
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > /tmp/rollback-cmd-replace-rb.log 2>&1
R2_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-replace-rb.log || true
if [ "${R2_RC}" -ne 0 ]; then
  echo "[verify] FAIL: reverse-replacement rollback exited ${R2_RC} (output above)"
  exit 1
fi
if ! grep -qi 'reverse-replace\|Reversing replacement' /tmp/rollback-cmd-replace-rb.log; then
  echo "[verify] FAIL: rollback output does not mention the reverse-replacement"
  exit 1
fi
if ! aws ssm get-parameter --name "${REPLACE_A_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${REPLACE_A_NAME} was not re-created by the reverse-replacement"
  exit 1
fi
assert_gone "new ${REPLACE_B_NAME} still exists — the reverse-replacement did not delete it" \
  aws ssm get-parameter --name "${REPLACE_B_NAME}" --region "${REGION}"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal still present after the reverse-replacement rollback"
  exit 1
fi
R2_COUNT="$(state_resource_count "${STATE_KEY}")"
if [ "${R2_COUNT}" != "3" ]; then
  echo "[verify] FAIL: post-reverse-replacement state records ${R2_COUNT} resource(s) (expected 3)"
  exit 1
fi
echo "[verify] step R2 ok: replacement reversed (a re-created, b deleted), journal gone"

# ---------------------------------------------------------------------------
# PHASE F: --revert-failed (issue #1198)
# ---------------------------------------------------------------------------
echo "[verify] step F1: deploy ${STACK} with MARKER_VALUE=vF + INJECT_UPDATE_FAIL --no-rollback (expect FAILURE on the RevertQueue UPDATE)"
set +e
MARKER_VALUE=vF INJECT_UPDATE_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > /tmp/rollback-cmd-updfail.log 2>&1
UPDFAIL_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-updfail.log || true
if [ "${UPDFAIL_RC}" -eq 0 ]; then
  echo "[verify] FAIL: INJECT_UPDATE_FAIL --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
FM_MARKER="$(ssm_value "${MARKER_NAME}")"
if [ "${FM_MARKER}" != "vF" ]; then
  echo "[verify] FAIL: Marker is '${FM_MARKER}' (expected 'vF' — the completed update should have landed before the queue UPDATE failed)"
  exit 1
fi
echo "[verify] step F1a: assert the journal records failedOperations with the attempted properties"
JOURNAL_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
FAILED_COUNT="$(echo "${JOURNAL_BODY}" | jq '.segments[-1].failedOperations | length')"
FAILED_ID="$(echo "${JOURNAL_BODY}" | jq -r '.segments[-1].failedOperations[0].logicalId')"
FAILED_ATTEMPTED="$(echo "${JOURNAL_BODY}" | jq -r '.segments[-1].failedOperations[0].attemptedProperties.MessageRetentionPeriod')"
FAILED_PREV="$(echo "${JOURNAL_BODY}" | jq -r '.segments[-1].failedOperations[0].previousState.properties.MessageRetentionPeriod')"
if [ "${FAILED_COUNT}" != "1" ] || [ "${FAILED_ID}" != "RevertQueue" ]; then
  echo "[verify] FAIL: journal failedOperations wrong (count=${FAILED_COUNT} id=${FAILED_ID})"
  exit 1
fi
if [ "${FAILED_ATTEMPTED}" != "9999999" ] || [ "${FAILED_PREV}" != "3600" ]; then
  echo "[verify] FAIL: failed op properties wrong (attempted=${FAILED_ATTEMPTED} previous=${FAILED_PREV})"
  exit 1
fi
echo "[verify] step F1 ok: deploy failed on the UPDATE, journal carries the failed op (prev=3600, attempted=9999999)"

echo "[verify] step F2: cdkd rollback ${STACK} --force --revert-failed (expect exit 0)"
# Same echo-before-assert pattern as step R2 (issue #1220).
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force --revert-failed > /tmp/rollback-cmd-updfail-rb.log 2>&1
F2_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-cmd-updfail-rb.log || true
if [ "${F2_RC}" -ne 0 ]; then
  echo "[verify] FAIL: --revert-failed rollback exited ${F2_RC} (output above)"
  exit 1
fi
if ! grep -qi 'force-reverting failed UPDATE' /tmp/rollback-cmd-updfail-rb.log; then
  echo "[verify] FAIL: rollback output does not mention the failed-op force-revert"
  exit 1
fi
F2_MARKER="$(ssm_value "${MARKER_NAME}")"
if [ "${F2_MARKER}" != "v1" ]; then
  echo "[verify] FAIL: after --revert-failed rollback, Marker is '${F2_MARKER}' (expected 'v1')"
  exit 1
fi
REVERT_Q_URL="$(aws sqs get-queue-url --queue-name "${REVERT_QUEUE_NAME}" --region "${REGION}" --query 'QueueUrl' --output text)"
REVERT_RETENTION="$(aws sqs get-queue-attributes --queue-url "${REVERT_Q_URL}" --region "${REGION}" \
  --attribute-names MessageRetentionPeriod --query 'Attributes.MessageRetentionPeriod' --output text)"
if [ "${REVERT_RETENTION}" != "3600" ]; then
  echo "[verify] FAIL: RevertQueue retention is '${REVERT_RETENTION}' (expected 3600 — the failed UPDATE was not force-reverted)"
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal still present after the --revert-failed rollback"
  exit 1
fi
echo "[verify] step F2 ok: Marker back to v1, RevertQueue force-reverted to 3600, journal gone"

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
assert_gone "ReplaceParam ${REPLACE_A_NAME} still exists after destroy" aws ssm get-parameter --name "${REPLACE_A_NAME}" --region "${REGION}"
assert_gone "RevertQueue ${REVERT_QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${REVERT_QUEUE_NAME}" --region "${REGION}"
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

# --- SUCCESS-PATH VERSION SWEEP + ASSERTION (issue #2096) -------------------
# Step 8 above removes the sidecars with `aws s3 rm` and then proves it with
# `aws s3 ls`, which is precisely the vacuous shape #2096 was raised about: on
# a VERSIONED bucket `aws s3 rm` writes a DELETE MARKER, so the listing goes
# empty while every byte this fixture ever wrote -- including the rollback
# journal's `failedOperations[].attemptedProperties` -- stays readable through
# `GetObject --version-id`. This fixture drives THREE failing deploys, so it
# writes more journal bodies than most.
#
# Mode is `all`, not `noncurrent`, and that follows the DESTROY rather than the
# script: step 7a has already asserted both stacks are gone, so nothing needs
# the state any more -- and after step 8's `aws s3 rm` the delete marker is the
# entry carrying `IsLatest == true`, so a noncurrent-only sweep would leave one
# marker per key behind forever and the zero-assertion could never pass.
# Placed AFTER the trap disarm so it runs on the NORMAL path (trap 1), which a
# trap-only sweep never does.
#
# Both stacks, because this fixture owns two: `INIT_STACK` is the
# initial-deploy-failure arm and writes its own journal.
for sweep_stack in "${STACK}" "${INIT_STACK}"; do
  SWEEP_PREFIX="$(s3_stack_prefix "${sweep_stack}" "${REGION}")"
  s3_purge_prefix_versions "${STATE_BUCKET}" "${SWEEP_PREFIX}" all || true
  s3_assert_versions_swept "${STATE_BUCKET}" "${SWEEP_PREFIX}" \
    "rollback-command state teardown (${sweep_stack})"
done

echo "[verify] PASS"
