#!/usr/bin/env bash
#
# End-to-end real-AWS validation for issue #5096: `cdkd rollback` of a
# replacement that deleted the old resource first and re-created it under the
# SAME physical id. The classifier used to read such an op as an in-place
# update (the id did not change), so the rollback called the provider's
# update(), which cannot change a create-only property: it printed success and
# wrote the old record while AWS kept the new resource.
#
# What this asserts:
#   PHASE A (the reversal):
#     A1. Deploy v1: table `<stack>-table` with key `pk`. AWS reports key pk.
#     A2. Deploy TABLE_KEY=id + INJECT_FAIL under --replace
#         --force-stateful-recreation --no-rollback: exit NON-ZERO. The premise
#         is read back, not assumed: AWS reports key `id` under the SAME table
#         name, and the journal holds the table's op stamped
#         `oldDeletedBeforeCreate` with an unchanged physical id.
#     A3. `cdkd rollback --force`: exit 0, and THE POINT: AWS reports key `pk`
#         again (describe-table), the state record says `pk`, and the journal
#         is gone. Before the fix AWS kept `id` while state said `pk`.
#   PHASE B (the refusal):
#     B1. Deploy LOG_CLASS=INFREQUENT_ACCESS + INJECT_FAIL under the same
#         flags: exit NON-ZERO. Premise: the log group (fixed name) has the new
#         class and its log stream exists (re-created with it), and state
#         records the stream.
#     B2. `cdkd rollback --force`: exit NON-ZERO with the same-id parent
#         refusal (reversing would delete the group again, and the stream it
#         stores). Nothing deleted: the group keeps the new class, the stream
#         still exists, and the journal is kept.
#     B3. The remedy the refusal names: `cdkd deploy --replace
#         --force-stateful-recreation` of the previous template. Exit 0, class
#         STANDARD, stream present, journal gone.
#   PHASE C: destroy clean, 0 orphans, sidecars removed.
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture pattern
# (cmd; rc=$?) so a piped/teed harness can't mask a failure; the script prints
# an explicit "[verify] PASS" only at the very end.

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

STACK="CdkdRollbackSameIdRecreateExample"
TABLE_NAME="${STACK}-table"
LOG_GROUP_NAME="/cdkd-integ/${STACK}"
LOG_STREAM_NAME="cdkd-integ-stream"
FAILING_QUEUE_NAME="${STACK}-failing-queue"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-same-id-recreate"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} logs=${LOG_DIR}"

# --- Live readbacks. Each is a strict capture: a failed read fails the run. ---
table_key() { # echoes the live table's partition key name
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.KeySchema[0].AttributeName' --output text
}
log_group_class() { # echoes the live log group's class (None when absent)
  aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP_NAME}" --region "${REGION}" \
    --query "logGroups[?logGroupName=='${LOG_GROUP_NAME}'].logGroupClass | [0]" --output text
}
log_stream_name() { # echoes the stream's name when it exists, empty otherwise
  aws logs describe-log-streams --log-group-name "${LOG_GROUP_NAME}" \
    --log-stream-name-prefix "${LOG_STREAM_NAME}" --region "${REGION}" \
    --query "logStreams[?logStreamName=='${LOG_STREAM_NAME}'].logStreamName" --output text
}
state_body() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -
}
journal_present() {
  if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
    return 1
  fi
  return 0
}

aggressive_cleanup() {
  echo "[verify] aggressive cleanup: sweeping any fixture orphans"
  (
  set +eu
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  local q_url
  q_url="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -n "${q_url}" ] && [ "${q_url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  )
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    if aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    aggressive_cleanup
  fi
  # ALWAYS remove the events / journal / state sidecars so the integ leaves
  # nothing behind (events deliberately survive destroy).
  echo "[verify] cleanup: remove sidecars"
  aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && CI=true pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

# ---------------------------------------------------------------------------
# PHASE A: a same-id delete-first replacement is reversed (issue #5096)
# ---------------------------------------------------------------------------
echo "[verify] step A1: deploy ${STACK} v1 (table key pk, log group STANDARD)"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
A1_KEY="$(table_key)"
if [ "${A1_KEY}" != "pk" ]; then
  echo "[verify] FAIL: v1 table key is '${A1_KEY}' (expected pk)"
  exit 1
fi
echo "[verify] step A1 ok: ${TABLE_NAME} has key pk"

echo "[verify] step A2: deploy TABLE_KEY=id + INJECT_FAIL --replace --force-stateful-recreation --no-rollback (expect FAILURE after the replacement)"
set +e
TABLE_KEY=id INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --replace --force-stateful-recreation --no-rollback \
  > "${LOG_DIR}/a2-deploy.log" 2>&1
A2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/a2-deploy.log" || true
if [ "${A2_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
A2_KEY="$(table_key)"
if [ "${A2_KEY}" != "id" ]; then
  echo "[verify] FAIL: premise: after the failed deploy the table key is '${A2_KEY}' (expected id: the replacement did not land)"
  exit 1
fi
if ! journal_present; then
  echo "[verify] FAIL: no rollback journal after the failed deploy"
  exit 1
fi
SAME_ID_OPS="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - | jq '[.segments[].operations[]
  | select(.resourceType == "AWS::DynamoDB::Table" and .oldDeletedBeforeCreate == true
      and .physicalId != null and .physicalId == .previousState.physicalId)] | length')"
if [ "${SAME_ID_OPS}" != "1" ]; then
  echo "[verify] FAIL: premise: the journal holds ${SAME_ID_OPS} same-id delete-first table op(s) (expected 1)"
  exit 1
fi
echo "[verify] step A2 ok: deploy failed, the table was re-created as ${TABLE_NAME} with key id, journal holds the same-id op"

echo "[verify] step A3: cdkd rollback ${STACK} --force (expect exit 0 and the live key back to pk)"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/a3-rollback.log" 2>&1
A3_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/a3-rollback.log" || true
if [ "${A3_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the rollback exited ${A3_RC} (output above)"
  exit 1
fi
A3_KEY="$(table_key)"
if [ "${A3_KEY}" != "pk" ]; then
  echo "[verify] FAIL: THE BUG: after the rollback the LIVE table key is '${A3_KEY}' (expected pk)"
  exit 1
fi
A3_STATE_KEY="$(state_body | jq -r '[.resources[] | select(.resourceType == "AWS::DynamoDB::Table")
  | .properties.KeySchema[0].AttributeName] | join(",")')"
if [ "${A3_STATE_KEY}" != "pk" ]; then
  echo "[verify] FAIL: after the rollback state records table key '${A3_STATE_KEY}' (expected pk)"
  exit 1
fi
if journal_present; then
  echo "[verify] FAIL: rollback journal still present after a successful rollback"
  exit 1
fi
echo "[verify] step A3 ok: live key pk, state agrees, journal gone"

# ---------------------------------------------------------------------------
# PHASE B: a same-id parent holding a child is refused, then fixed forward
# ---------------------------------------------------------------------------
echo "[verify] step B1: deploy LOG_CLASS=INFREQUENT_ACCESS + INJECT_FAIL --replace --force-stateful-recreation --no-rollback (expect FAILURE)"
set +e
LOG_CLASS=INFREQUENT_ACCESS INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --replace --force-stateful-recreation --no-rollback \
  > "${LOG_DIR}/b1-deploy.log" 2>&1
B1_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b1-deploy.log" || true
if [ "${B1_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
B1_CLASS="$(log_group_class)"
if [ "${B1_CLASS}" != "INFREQUENT_ACCESS" ]; then
  echo "[verify] FAIL: premise: after the failed deploy the log group class is '${B1_CLASS}' (expected INFREQUENT_ACCESS)"
  exit 1
fi
B1_STREAM="$(log_stream_name)"
if [ "${B1_STREAM}" != "${LOG_STREAM_NAME}" ]; then
  echo "[verify] FAIL: premise: the log stream is missing after the failed deploy (got '${B1_STREAM}')"
  exit 1
fi
B1_STREAM_RECORDS="$(state_body | jq '[.resources[] | select(.resourceType == "AWS::Logs::LogStream")] | length')"
if [ "${B1_STREAM_RECORDS}" != "1" ]; then
  echo "[verify] FAIL: premise: state records ${B1_STREAM_RECORDS} log stream(s) (expected 1)"
  exit 1
fi
if ! journal_present; then
  echo "[verify] FAIL: no rollback journal after the failed deploy"
  exit 1
fi
echo "[verify] step B1 ok: log group re-created as INFREQUENT_ACCESS, stream present and recorded, journal present"

echo "[verify] step B2: cdkd rollback ${STACK} --force (expect the same-id parent REFUSAL, nothing deleted)"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/b2-rollback.log" 2>&1
B2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b2-rollback.log" || true
if [ "${B2_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rollback exited 0 (expected the same-id parent refusal)"
  exit 1
fi
# The parsed marker, and an independent sentinel on the same line so a reworded
# refusal fails loudly instead of reading as "the refusal did not fire".
B2_OUT="$(cat "${LOG_DIR}/b2-rollback.log")"
if ! grep -q 'what AWS stores inside it' <<<"${B2_OUT}"; then
  if grep -q 'Cannot reverse the replacement of' <<<"${B2_OUT}"; then
    echo "[verify] FAIL: a replacement refusal printed, but not the same-id parent wording: the message drifted, update this fixture"
  else
    echo "[verify] FAIL: no same-id parent refusal in the rollback output"
  fi
  exit 1
fi
if ! grep -q 'Nothing was deleted' <<<"${B2_OUT}"; then
  echo "[verify] FAIL: the refusal does not say nothing was deleted"
  exit 1
fi
B2_CLASS="$(log_group_class)"
if [ "${B2_CLASS}" != "INFREQUENT_ACCESS" ]; then
  echo "[verify] FAIL: the refused rollback changed the log group (class '${B2_CLASS}', expected INFREQUENT_ACCESS)"
  exit 1
fi
B2_STREAM="$(log_stream_name)"
if [ "${B2_STREAM}" != "${LOG_STREAM_NAME}" ]; then
  echo "[verify] FAIL: the refused rollback lost the log stream (got '${B2_STREAM}')"
  exit 1
fi
if ! journal_present; then
  echo "[verify] FAIL: the refused rollback dropped the journal"
  exit 1
fi
echo "[verify] step B2 ok: refused, log group and stream untouched, journal kept"

echo "[verify] step B3: the named remedy: deploy the previous template with --replace --force-stateful-recreation"
set +e
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --replace --force-stateful-recreation \
  > "${LOG_DIR}/b3-deploy.log" 2>&1
B3_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b3-deploy.log" || true
if [ "${B3_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${B3_RC} (output above)"
  exit 1
fi
B3_CLASS="$(log_group_class)"
if [ "${B3_CLASS}" != "STANDARD" ]; then
  echo "[verify] FAIL: after the fix-forward deploy the log group class is '${B3_CLASS}' (expected STANDARD)"
  exit 1
fi
B3_STREAM="$(log_stream_name)"
if [ "${B3_STREAM}" != "${LOG_STREAM_NAME}" ]; then
  echo "[verify] FAIL: the log stream is missing after the fix-forward deploy (got '${B3_STREAM}')"
  exit 1
fi
if journal_present; then
  echo "[verify] FAIL: rollback journal still present after the fix-forward deploy"
  exit 1
fi
echo "[verify] step B3 ok: class STANDARD, stream present, journal gone"

# ---------------------------------------------------------------------------
# PHASE C: destroy clean
# ---------------------------------------------------------------------------
echo "[verify] step C1: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# A table can still answer DELETING right after DeleteTable: poll briefly.
TABLE_GONE=false
for _ in $(seq 1 30); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    TABLE_GONE=true
    break
  fi
  sleep 2
done
if [ "${TABLE_GONE}" != "true" ]; then
  echo "[verify] FAIL: table ${TABLE_NAME} still exists ~60s after destroy"
  exit 1
fi
assert_gone "log group ${LOG_GROUP_NAME} still exists after destroy" aws logs describe-log-streams --log-group-name "${LOG_GROUP_NAME}" --region "${REGION}"
assert_gone "FailingQueue ${FAILING_QUEUE_NAME} exists (its CreateQueue should have been rejected)" aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
echo "[verify] step C1 ok: destroy clean"

echo "[verify] step C2: remove the events sidecars so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive 2>&1 || true)"
if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "[verify] FAIL: sidecar not fully removed for ${STACK}:"
  echo "${REMAINING}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step C2 ok: sidecars removed"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo "[verify] PASS"
