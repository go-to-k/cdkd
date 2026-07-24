#!/usr/bin/env bash
#
# End-to-end real-AWS validation for the SQS name-cooldown reverse-replacement
# (issue #1206) and the failed-only rollback-journal retention cycle (issue
# #1208) — the permanent regression fixture for the two live scenarios verified
# ad-hoc on PR #1211 / PR #1212 (issue #1218).
#
# What this asserts:
#   PHASE 1 (reverse-replacement through the SQS ~60s name cooldown, #1206):
#     1. Deploy v1 clean: custom-named queue `-queue-x`. State has 1 resource.
#     2. Deploy with QUEUE_SUFFIX=y + INJECT_FAIL under --no-rollback
#        --force-stateful-recreation: the create-only QueueName change drives a
#        REPLACEMENT (new `-queue-y` created, old `-queue-x` deleted — its ~60s
#        re-creation cooldown starts here), then FailingQueue's CreateQueue is
#        rejected. Exit NON-ZERO, journal records the completed replacement.
#     3. `cdkd rollback --force --verbose` immediately (< 60s): the
#        reverse-replacement's initial re-create of `-queue-x` must hit
#        `QueueDeletedRecently`, retry through the window (visible in the
#        --verbose retry lines), restore `-queue-x`, delete `-queue-y`, clear
#        the journal, and exit 0.
#   PHASE 2 (failed-only journal retention cycle, #1208):
#     4. Failing deploy (same injected resource) WITHOUT --no-rollback: clean
#        automatic rollback. Exit non-zero, the output prints the "automatic
#        rollback restored the pre-deploy state" guidance, and the journal
#        SURVIVES as reason=auto-rollback-clean / operations=[] /
#        failedOperations=[FailingQueue] (raw S3 read).
#     5. The NEXT deploy (same failing shape) prints the failed-only
#        `--revert-failed` note at its start.
#     6. `cdkd rollback --force --revert-failed` consumes it: the
#        physical-id-less failed CREATE is skipped with a warning (#1198), the
#        journal is cleared, and the exit code is 0 or 2 (2 = the
#        skipped/unrecoverable-operations PartialFailureError).
#     7. Re-create the failing state, then a NO-CHANGE fix-forward deploy (bad
#        resource removed) must exit 0 via "No changes detected" AND clear the
#        journal (the PR #1212 no-change gap regression). One more clean deploy
#        proves the note is gone.
#   PHASE 3 (destroy clean):
#     8. Destroy: clean, state gone, 0 orphans, sidecars removed.
#   Cleanup (EXIT trap) aggressively removes any orphan SQS queues + the
#   events sidecars — this test INTENTIONALLY fails deploys, so the trap must
#   not leak resources.
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

STACK="CdkdRollbackSqsCooldownExample"
QUEUE_X_NAME="${STACK}-queue-x"
QUEUE_Y_NAME="${STACK}-queue-y"
FAILING_QUEUE_NAME="${STACK}-failing-queue"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-sqs-cooldown"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# --- Count resources recorded in the stack's cdkd state.json (echoes a number,
# or 'gone' when the state object is absent). ---
state_resource_count() { # usage: state_resource_count
  local body
  if ! body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"; then
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
  for name in "${QUEUE_X_NAME}" "${QUEUE_Y_NAME}" "${FAILING_QUEUE_NAME}"; do
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
    aggressive_cleanup
  fi
  # ALWAYS remove the events / journal / state sidecars so the integ leaves
  # nothing behind (events deliberately survive destroy).
  echo "[verify] cleanup: remove sidecars"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
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
# PHASE 1: reverse-replacement through the SQS name cooldown (issue #1206)
# ---------------------------------------------------------------------------
echo "[verify] step 2: deploy ${STACK} v1 (clean, queue suffix x)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

if ! aws sqs get-queue-url --queue-name "${QUEUE_X_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${QUEUE_X_NAME} missing after the v1 deploy"
  exit 1
fi
V1_COUNT="$(state_resource_count)"
if [ "${V1_COUNT}" != "1" ]; then
  echo "[verify] FAIL: v1 state records ${V1_COUNT} resource(s) (expected 1: NamedQueue)"
  exit 1
fi
echo "[verify] step 2 ok: v1 deployed, ${QUEUE_X_NAME} exists, state has 1 resource"

echo "[verify] step 3: deploy with QUEUE_SUFFIX=y + INJECT_FAIL --no-rollback --force-stateful-recreation (expect FAILURE after the replacement)"
set +e
QUEUE_SUFFIX=y INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback --force-stateful-recreation > /tmp/rollback-sqs-replace.log 2>&1
REPLACE_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-sqs-replace.log || true
if [ "${REPLACE_RC}" -eq 0 ]; then
  echo "[verify] FAIL: QUEUE_SUFFIX=y --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: no rollback journal after the replacement deploy"
  exit 1
fi
# The replacement landed: the new-named queue exists...
if ! aws sqs get-queue-url --queue-name "${QUEUE_Y_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${QUEUE_Y_NAME} missing — the replacement did not land"
  exit 1
fi
# ...and the old-named queue is deleted (its ~60s re-creation cooldown started
# at the delete). DeleteQueue visibility is eventually consistent, so poll
# briefly instead of asserting a single snapshot.
X_GONE=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if gone_probe aws sqs get-queue-url --queue-name "${QUEUE_X_NAME}" --region "${REGION}"; then
    X_GONE=true
    break
  fi
  sleep 2
done
if [ "${X_GONE}" != "true" ]; then
  echo "[verify] FAIL: old ${QUEUE_X_NAME} still resolvable ~20s after the replacement delete"
  exit 1
fi
echo "[verify] step 3 ok: replacement landed (y created, x deleted — cooldown running), journal present"

echo "[verify] step 4: cdkd rollback ${STACK} --force --verbose immediately (expect the re-create to retry through QueueDeletedRecently, exit 0)"
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force --verbose > /tmp/rollback-sqs-rb.log 2>&1
sed 's/^/  /' /tmp/rollback-sqs-rb.log || true
if ! grep -qi 'reverse-replace\|Reversing replacement' /tmp/rollback-sqs-rb.log; then
  echo "[verify] FAIL: rollback output does not mention the reverse-replacement"
  exit 1
fi
# The --verbose retry lines embed the AWS error message, proving the initial
# re-create actually hit the cooldown and was retried (issue #1206) rather
# than sneaking through after the window expired.
if ! grep -qiE 'QueueDeletedRecently|wait 60 seconds|deleted recently' /tmp/rollback-sqs-rb.log; then
  echo "[verify] FAIL: rollback output shows no QueueDeletedRecently cooldown retry — the #1206 path was not exercised"
  exit 1
fi
if ! aws sqs get-queue-url --queue-name "${QUEUE_X_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${QUEUE_X_NAME} was not re-created by the reverse-replacement"
  exit 1
fi
assert_gone "new ${QUEUE_Y_NAME} still exists — the reverse-replacement did not delete it" \
  aws sqs get-queue-url --queue-name "${QUEUE_Y_NAME}" --region "${REGION}"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal still present after the reverse-replacement rollback"
  exit 1
fi
RB_COUNT="$(state_resource_count)"
if [ "${RB_COUNT}" != "1" ]; then
  echo "[verify] FAIL: post-rollback state records ${RB_COUNT} resource(s) (expected 1)"
  exit 1
fi
echo "[verify] step 4 ok: cooldown retried, x re-created, y deleted, journal gone"

# ---------------------------------------------------------------------------
# PHASE 2: failed-only journal retention cycle (issue #1208)
# ---------------------------------------------------------------------------
echo "[verify] step 5: deploy with INJECT_FAIL WITHOUT --no-rollback (expect FAILURE + clean automatic rollback)"
set +e
INJECT_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-sqs-autorb.log 2>&1
AUTORB_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-sqs-autorb.log || true
if [ "${AUTORB_RC}" -eq 0 ]; then
  echo "[verify] FAIL: INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! grep -qi 'automatic rollback restored the pre-deploy state' /tmp/rollback-sqs-autorb.log; then
  echo "[verify] FAIL: deploy output missing the #1208 failed-only retention guidance line"
  exit 1
fi
assert_gone "FailingQueue ${FAILING_QUEUE_NAME} exists — the injected CreateQueue should have been rejected" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"

echo "[verify] step 5a: assert the journal survived as the failed-only shape (raw S3 read)"
JOURNAL_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
J_REASON="$(echo "${JOURNAL_BODY}" | jq -r '.segments[-1].reason')"
J_OPS_LEN="$(echo "${JOURNAL_BODY}" | jq '.segments[-1].operations | length')"
J_FAILED_ID="$(echo "${JOURNAL_BODY}" | jq -r '.segments[-1].failedOperations[0].logicalId')"
if [ "${J_REASON}" != "auto-rollback-clean" ] || [ "${J_OPS_LEN}" != "0" ] || [ "${J_FAILED_ID}" != "FailingQueue" ]; then
  echo "[verify] FAIL: journal shape wrong (reason=${J_REASON} ops=${J_OPS_LEN} failedId=${J_FAILED_ID}; expected auto-rollback-clean / 0 / FailingQueue)"
  exit 1
fi
echo "[verify] step 5 ok: clean auto-rollback retained the failed-only journal (auto-rollback-clean, operations=[], failedOperations=[FailingQueue])"

echo "[verify] step 6: next deploy must print the --revert-failed note at its start (re-run the failing deploy)"
set +e
INJECT_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-sqs-note.log 2>&1
NOTE_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-sqs-note.log || true
if [ "${NOTE_RC}" -eq 0 ]; then
  echo "[verify] FAIL: second INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! grep -qi 'failed and was automatically rolled back' /tmp/rollback-sqs-note.log; then
  echo "[verify] FAIL: next deploy did not print the failed-only journal note"
  exit 1
fi
if ! grep -q -- '--revert-failed' /tmp/rollback-sqs-note.log; then
  echo "[verify] FAIL: the journal note does not point at --revert-failed"
  exit 1
fi
echo "[verify] step 6 ok: the next deploy printed the failed-only --revert-failed note"

echo "[verify] step 7: cdkd rollback ${STACK} --force --revert-failed (expect the #1198 skip-with-warning; exit 0 or 2)"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force --revert-failed > /tmp/rollback-sqs-revertfailed.log 2>&1
RF_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-sqs-revertfailed.log || true
if [ "${RF_RC}" -ne 0 ] && [ "${RF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: rollback --revert-failed exited ${RF_RC} (expected 0, or 2 for the skipped-operations partial result)"
  exit 1
fi
if ! grep -qi 'recorded no physical id' /tmp/rollback-sqs-revertfailed.log; then
  echo "[verify] FAIL: rollback output missing the #1198 physical-id-less failed-CREATE skip warning"
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: rollback journal still present after --revert-failed consumed it"
  exit 1
fi
if ! aws sqs get-queue-url --queue-name "${QUEUE_X_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${QUEUE_X_NAME} disappeared during --revert-failed (it must stay untouched)"
  exit 1
fi
echo "[verify] step 7 ok: --revert-failed consumed the journal (skip-with-warning, rc=${RF_RC})"

echo "[verify] step 8: re-create the failing state (INJECT_FAIL deploy)"
set +e
INJECT_FAIL=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-sqs-refail.log 2>&1
REFAIL_RC=$?
set -e
sed 's/^/  /' /tmp/rollback-sqs-refail.log || true
if [ "${REFAIL_RC}" -eq 0 ]; then
  echo "[verify] FAIL: third INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: no retained journal after re-creating the failing state"
  exit 1
fi
echo "[verify] step 8 ok: failing state re-created, journal retained"

echo "[verify] step 9: NO-CHANGE fix-forward deploy (bad resource removed) must clear the journal (PR #1212 regression)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-sqs-fixforward.log 2>&1
sed 's/^/  /' /tmp/rollback-sqs-fixforward.log || true
if ! grep -qi 'No changes detected' /tmp/rollback-sqs-fixforward.log; then
  echo "[verify] FAIL: fix-forward deploy was not the no-change path — the #1212 regression is not being exercised"
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: journal still present after the no-change fix-forward deploy (the PR #1212 gap)"
  exit 1
fi
echo "[verify] step 9 ok: no-change deploy cleared the journal"

echo "[verify] step 10: one more clean deploy must NOT print the journal note"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" > /tmp/rollback-sqs-clean.log 2>&1
sed 's/^/  /' /tmp/rollback-sqs-clean.log || true
if grep -qi 'automatically rolled back\|revert-failed' /tmp/rollback-sqs-clean.log; then
  echo "[verify] FAIL: the journal note survived the fix-forward deploy"
  exit 1
fi
echo "[verify] step 10 ok: note cleared"

# ---------------------------------------------------------------------------
# PHASE 3: destroy clean
# ---------------------------------------------------------------------------
echo "[verify] step 11: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 11a: assert destroy is clean (state gone, 0 orphans)"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "NamedQueue ${QUEUE_X_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_X_NAME}" --region "${REGION}"
assert_gone "old-replacement ${QUEUE_Y_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_Y_NAME}" --region "${REGION}"
assert_gone "FailingQueue ${FAILING_QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
echo "[verify] step 11a ok: destroy clean"

echo "[verify] step 12: cleanup — remove the events sidecars so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" 2>&1 || true)"
if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "[verify] FAIL: sidecar not fully removed for ${STACK}:"
  echo "${REMAINING}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 12 ok: sidecars removed"

trap - EXIT INT TERM
echo "[verify] PASS"
