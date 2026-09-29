#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd rollback` re-creates an EXPLICITLY
# named IAM Role under the name its deploy sent (issue #4018), and that the
# rewritten-name holder proof (issue #4010) refuses a squatter on that name.
#
# The IAM Role provider sends `generateResourceNameWithFallback(RoleName)`,
# which prepends the stack name unless the deploy's user-supplied-name prefix
# flag skips it (the default). The deploy records the flag in its journal
# segment; `cdkd rollback` must replay under it. Before the fix it replayed
# with no flag in scope, so it re-created `${STACK}-cdkd-integ-rbrw-a`
# although the deploy had created `cdkd-integ-rbrw-a`.
#
# What this asserts:
#   PHASE 1 (baseline, default flag = prefix skipped):
#     1. Deploy v1: role `cdkd-integ-rbrw-a` exists under EXACTLY that name.
#   PHASE 2 (a failed replacing deploy):
#     2. Deploy ROLE_SUFFIX=b + INJECT_FAIL --no-rollback: `-b` created, `-a`
#        deleted, deploy fails; the journal segment records skipPrefix=true.
#   PHASE 3 (the re-create collides with a squatter -> REFUSED, #4010):
#     3. Create a squatter role OUT OF BAND under `cdkd-integ-rbrw-a` (the name
#        the re-create sends). `cdkd rollback` must fail, name that exact sent
#        name in its refusal, delete NOTHING (the new role `-b` and the
#        squatter survive), keep the journal, and never create the prefixed
#        name.
#   PHASE 4 (the re-create succeeds under the deploy's name):
#     4. Delete the squatter, re-run `cdkd rollback`: exit 0, `cdkd-integ-rbrw-a`
#        is the stack's role again (template description, state physical id),
#        `-b` is deleted, the prefixed name was never created, journal gone.
#   PHASE 4b (an in-place UPDATE revert stays in place):
#     4b. Change only the role's Description + INJECT_FAIL --no-rollback, then
#        `cdkd rollback`: `cdkd-integ-rbrw-a` keeps its name and gets its old
#        description back; the prefixed name is never created. Before the fix
#        the provider's update() derived the prefixed name there and REPLACED
#        the role, deleting `cdkd-integ-rbrw-a`.
#     5. Destroy clean.
#   PHASE 5 (negative control, deploys with --prefix-user-supplied-names):
#     6. Fresh deploy with the flag: role `${STACK}-cdkd-integ-rbrw-a`.
#     7. Failing replacing deploy with the flag: the segment records
#        skipPrefix=false.
#     8. `cdkd rollback` WITHOUT the flag and without the env: the recorded
#        flag wins, so the role comes back as `${STACK}-cdkd-integ-rbrw-a` and
#        the bare `cdkd-integ-rbrw-a` is never created.
#     9. Destroy clean; every role name the run could mint is gone.
#
# BSD/macOS-portable. Integ-exit-code-capture pattern (bash ...; rc=$?) so a
# piped/teed harness cannot mask a failure; "[verify] PASS" only at the end.
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

STACK="CdkdRollbackNameRewriteExample"
ROLE_A="cdkd-integ-rbrw-a"
ROLE_B="cdkd-integ-rbrw-b"
PREFIXED_A="${STACK}-${ROLE_A}"
PREFIXED_B="${STACK}-${ROLE_B}"
FAILING_QUEUE_NAME="${STACK}-failing-queue"
ROLE_DESCRIPTION="cdkd-integ rollback-explicit-name-rewrite subject"
SQUATTER_DESCRIPTION="cdkd-integ rollback-explicit-name-rewrite squatter"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/rollback-explicit-name-rewrite"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rbrw.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} logs=${LOG_DIR}"

# The role's description, or a hard failure when the role cannot be read.
role_description() { # usage: role_description <role-name>
  aws iam get-role --role-name "$1" --query 'Role.Description' --output text
}

# The physical id the stack's state records for NamedRole.
state_role_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.NamedRole.physicalId'
}

# The newest journal segment's recorded prefix flag (`true` / `false` / `null`).
journal_skip_prefix() {
  aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - | jq -r '.segments[-1].skipPrefix'
}

# IAM reads are eventually consistent: a GetRole right after a delete can
# still succeed. Poll (10 x 2s) through the strict gone_probe; a probe error
# other than not-found still hard-fails.
wait_role_gone() { # usage: wait_role_gone "<leak description>" <role-name>
  local desc="$1" name="$2" _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if gone_probe aws iam get-role --role-name "${name}"; then
      return 0
    fi
    sleep 2
  done
  echo "FAIL: ${desc}" >&2
  exit 1
}

# The rollback must never say it fell back: every segment here was written by
# this build, which records the flag. The unit suite pins the wording.
assert_no_legacy_fallback() { # usage: assert_no_legacy_fallback <log>
  if grep -qF 'did not record the user-supplied-name prefix' "$1"; then
    echo "[verify] FAIL: the rollback fell back to the legacy prefix resolution — the journal segment carried no skipPrefix"
    exit 1
  fi
}

delete_role_best_effort() { # usage: delete_role_best_effort <role-name>
  (
  set +eu
  aws iam delete-role --role-name "$1" >/dev/null 2>&1 || true
  )
}

aggressive_cleanup() {
  echo "[verify] aggressive cleanup: sweeping every role name the run can mint"
  (
  set +eu
  local name q_url
  for name in "${ROLE_A}" "${ROLE_B}" "${PREFIXED_A}" "${PREFIXED_B}"; do
    delete_role_best_effort "${name}"
  done
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
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    aggressive_cleanup
  fi
  # ALWAYS remove the events / journal / state sidecars (events survive destroy).
  echo "[verify] cleanup: remove sidecars"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  rm -rf "${LOG_DIR}"
  exit "${rc}"
}
echo "[verify] step 0: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && CI=true pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

# A leftover (an interrupted earlier run, or a CONCURRENT run of this fixture)
# would turn the squatter phase into a false collision and the gone-probes
# below into false leaks. Checked BEFORE the cleanup trap is armed, so a
# refusal here never sweeps the roles it just refused to touch.
for name in "${ROLE_A}" "${ROLE_B}" "${PREFIXED_A}" "${PREFIXED_B}"; do
  if ! gone_probe aws iam get-role --role-name "${name}"; then
    echo "[verify] FAIL: role ${name} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)"
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for key in "${STATE_KEY}" "${JOURNAL_KEY}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"; then
    echo "[verify] FAIL: s3://${STATE_BUCKET}/${key} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)"
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
# PHASE 1: baseline under the default flag (prefix skipped)
# ---------------------------------------------------------------------------
echo "[verify] step 1: deploy ${STACK} v1 (role ${ROLE_A})"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

if [ "$(role_description "${ROLE_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${ROLE_A} is not the stack's role after the v1 deploy"
  exit 1
fi
assert_gone "v1 created the PREFIXED ${PREFIXED_A} although the default skips the prefix" \
  aws iam get-role --role-name "${PREFIXED_A}"
echo "[verify] step 1 ok: ${ROLE_A} deployed under exactly its declared name"

# ---------------------------------------------------------------------------
# PHASE 2: a failed replacing deploy
# ---------------------------------------------------------------------------
echo "[verify] step 2: deploy ROLE_SUFFIX=b + INJECT_FAIL --no-rollback (expect FAILURE after the replacement)"
set +e
ROLE_SUFFIX=b INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > "${LOG_DIR}/replace.log" 2>&1
REPLACE_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/replace.log" || true
if [ "${REPLACE_RC}" -eq 0 ]; then
  echo "[verify] FAIL: ROLE_SUFFIX=b --no-rollback deploy unexpectedly SUCCEEDED"
  exit 1
fi
if [ "$(role_description "${ROLE_B}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${ROLE_B} missing — the replacement did not land"
  exit 1
fi
wait_role_gone "old ${ROLE_A} still exists — the replacement did not delete it" "${ROLE_A}"
J_SKIP="$(journal_skip_prefix)"
if [ "${J_SKIP}" != "true" ]; then
  echo "[verify] FAIL: the journal segment records skipPrefix=${J_SKIP} (expected true: the deploy skipped the prefix)"
  exit 1
fi
echo "[verify] step 2 ok: ${ROLE_B} created, ${ROLE_A} deleted, journal records skipPrefix=true"

# ---------------------------------------------------------------------------
# PHASE 3: a squatter on the name the re-create sends -> refused (#4010)
# ---------------------------------------------------------------------------
echo "[verify] step 3: create a squatter role ${ROLE_A} out of band, then cdkd rollback (expect REFUSAL)"
aws iam create-role --role-name "${ROLE_A}" --assume-role-policy-document "${TRUST}" \
  --description "${SQUATTER_DESCRIPTION}" >/dev/null
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/refused.log" 2>&1
REFUSED_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/refused.log" || true
if [ "${REFUSED_RC}" -eq 0 ]; then
  echo "[verify] FAIL: cdkd rollback SUCCEEDED over a squatter on ${ROLE_A} — the re-create did not send ${ROLE_A}"
  exit 1
fi
# The parsed marker names the SENT name; the sentinel is the refusal's own
# opening, independent of it. Sentinel without marker = the wording drifted or
# a different name was sent — never read as "no refusal".
SENT_MARKER="which its provider sends as \"${ROLE_A}\""
SENTINEL="Cannot reverse the replacement of NamedRole"
if ! grep -qF "${SENTINEL}" "${LOG_DIR}/refused.log"; then
  echo "[verify] FAIL: rollback exited ${REFUSED_RC} without the #4010 holder refusal (output above)"
  exit 1
fi
if ! grep -F "${SENTINEL}" "${LOG_DIR}/refused.log" | grep -qF "${SENT_MARKER}"; then
  echo "[verify] FAIL: the refusal is present but does not say the re-create sent ${ROLE_A} (wording drifted, or a different name was sent):"
  grep -F "${SENTINEL}" "${LOG_DIR}/refused.log" | sed 's/^/  /'
  exit 1
fi
if [ "$(role_description "${ROLE_A}")" != "${SQUATTER_DESCRIPTION}" ]; then
  echo "[verify] FAIL: the squatter ${ROLE_A} was replaced or deleted by the refused rollback"
  exit 1
fi
if [ "$(role_description "${ROLE_B}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: the refused rollback deleted the live new role ${ROLE_B}"
  exit 1
fi
assert_gone "the refused rollback created the PREFIXED ${PREFIXED_A}" \
  aws iam get-role --role-name "${PREFIXED_A}"
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: the refused rollback dropped the journal"
  exit 1
fi
echo "[verify] step 3 ok: refused naming ${ROLE_A}, nothing deleted, journal kept"

# ---------------------------------------------------------------------------
# PHASE 4: the re-create succeeds under the deploy's name
# ---------------------------------------------------------------------------
echo "[verify] step 4: delete the squatter, re-run cdkd rollback (expect exit 0)"
aws iam delete-role --role-name "${ROLE_A}"
wait_role_gone "squatter ${ROLE_A} still readable ~20s after delete-role" "${ROLE_A}"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback.log" 2>&1
RB_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback.log" || true
if [ "${RB_RC}" -ne 0 ]; then
  echo "[verify] FAIL: cdkd rollback exited ${RB_RC} after the squatter was removed (output above)"
  exit 1
fi
if [ "$(role_description "${ROLE_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${ROLE_A} was not re-created as the stack's role"
  exit 1
fi
RB_ID="$(state_role_id)"
if [ "${RB_ID}" != "${ROLE_A}" ]; then
  echo "[verify] FAIL: state records NamedRole as ${RB_ID} after the rollback (expected ${ROLE_A})"
  exit 1
fi
assert_gone "the rollback re-created the old role under the PREFIXED ${PREFIXED_A}" \
  aws iam get-role --role-name "${PREFIXED_A}"
wait_role_gone "new ${ROLE_B} still exists — the reverse-replacement did not delete it" "${ROLE_B}"
assert_gone "rollback journal still present after the reverse-replacement" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_no_legacy_fallback "${LOG_DIR}/rollback.log"
echo "[verify] step 4 ok: ${ROLE_A} restored under exactly its name, ${ROLE_B} deleted, journal gone"

# ---------------------------------------------------------------------------
# PHASE 4b: an in-place UPDATE revert stays in place
# ---------------------------------------------------------------------------
echo "[verify] step 4b: change only the Description + INJECT_FAIL --no-rollback, then cdkd rollback"
ROLE_ID_BEFORE="$(aws iam get-role --role-name "${ROLE_A}" --query 'Role.RoleId' --output text)"
set +e
ROLE_DESCRIPTION_V2=true INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > "${LOG_DIR}/inplace.log" 2>&1
INPLACE_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inplace.log" || true
if [ "${INPLACE_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the Description-change INJECT_FAIL deploy unexpectedly SUCCEEDED"
  exit 1
fi
if [ "$(role_description "${ROLE_A}")" != "${ROLE_DESCRIPTION} v2" ]; then
  echo "[verify] FAIL: the in-place Description update did not land on ${ROLE_A}"
  exit 1
fi
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback-inplace.log" 2>&1
RB_INPLACE_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback-inplace.log" || true
if [ "${RB_INPLACE_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the in-place cdkd rollback exited ${RB_INPLACE_RC} (output above)"
  exit 1
fi
if [ "$(role_description "${ROLE_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${ROLE_A} did not get its old Description back"
  exit 1
fi
# The SAME role, not a re-created one of the same name.
ROLE_ID_AFTER="$(aws iam get-role --role-name "${ROLE_A}" --query 'Role.RoleId' --output text)"
if [ "${ROLE_ID_AFTER}" != "${ROLE_ID_BEFORE}" ]; then
  echo "[verify] FAIL: ${ROLE_A} was replaced (RoleId ${ROLE_ID_BEFORE} -> ${ROLE_ID_AFTER}), not reverted in place"
  exit 1
fi
assert_gone "the in-place revert REPLACED the role under the PREFIXED ${PREFIXED_A}" \
  aws iam get-role --role-name "${PREFIXED_A}"
assert_gone "rollback journal still present after the in-place revert" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_no_legacy_fallback "${LOG_DIR}/rollback-inplace.log"
echo "[verify] step 4b ok: ${ROLE_A} reverted in place (same RoleId), no prefixed role"

echo "[verify] step 5: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
wait_role_gone "role ${ROLE_A} still exists after destroy" "${ROLE_A}"
echo "[verify] step 5 ok: destroy clean"

# ---------------------------------------------------------------------------
# PHASE 5: negative control — a deploy recorded with the prefix KEPT
# ---------------------------------------------------------------------------
echo "[verify] step 6: fresh deploy with --prefix-user-supplied-names (role ${PREFIXED_A})"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --prefix-user-supplied-names
if [ "$(role_description "${PREFIXED_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${PREFIXED_A} missing after the prefix-kept deploy"
  exit 1
fi
assert_gone "the prefix-kept deploy created the bare ${ROLE_A}" aws iam get-role --role-name "${ROLE_A}"
echo "[verify] step 6 ok"

echo "[verify] step 7: failing replacing deploy with --prefix-user-supplied-names --no-rollback"
set +e
ROLE_SUFFIX=b INJECT_FAIL=true \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback --prefix-user-supplied-names \
  > "${LOG_DIR}/replace-prefixed.log" 2>&1
REPLACE2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/replace-prefixed.log" || true
if [ "${REPLACE2_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the prefix-kept failing deploy unexpectedly SUCCEEDED"
  exit 1
fi
if [ "$(role_description "${PREFIXED_B}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${PREFIXED_B} missing — the prefix-kept replacement did not land"
  exit 1
fi
wait_role_gone "old ${PREFIXED_A} still exists — the prefix-kept replacement did not delete it" "${PREFIXED_A}"
J_SKIP2="$(journal_skip_prefix)"
if [ "${J_SKIP2}" != "false" ]; then
  echo "[verify] FAIL: the journal segment records skipPrefix=${J_SKIP2} (expected false: the deploy kept the prefix)"
  exit 1
fi
echo "[verify] step 7 ok: journal records skipPrefix=false"

echo "[verify] step 8: cdkd rollback WITHOUT the flag (the recorded flag must win)"
set +e
env -u CDKD_PREFIX_USER_SUPPLIED_NAMES \
  ${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback-prefixed.log" 2>&1
RB2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback-prefixed.log" || true
if [ "${RB2_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the prefix-kept cdkd rollback exited ${RB2_RC} (output above)"
  exit 1
fi
if [ "$(role_description "${PREFIXED_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${PREFIXED_A} was not re-created by the prefix-kept rollback"
  exit 1
fi
RB2_ID="$(state_role_id)"
if [ "${RB2_ID}" != "${PREFIXED_A}" ]; then
  echo "[verify] FAIL: state records NamedRole as ${RB2_ID} (expected ${PREFIXED_A})"
  exit 1
fi
assert_gone "the prefix-kept rollback created the bare ${ROLE_A}" aws iam get-role --role-name "${ROLE_A}"
wait_role_gone "new ${PREFIXED_B} still exists after the prefix-kept rollback" "${PREFIXED_B}"
assert_gone "rollback journal still present after the prefix-kept rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_no_legacy_fallback "${LOG_DIR}/rollback-prefixed.log"
echo "[verify] step 8 ok: ${PREFIXED_A} restored under the recorded (prefix-kept) name"

echo "[verify] step 9: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "journal still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for name in "${ROLE_A}" "${ROLE_B}" "${PREFIXED_A}" "${PREFIXED_B}"; do
  wait_role_gone "role ${name} still exists after destroy" "${name}"
done
assert_gone "FailingQueue ${FAILING_QUEUE_NAME} exists — its CreateQueue should have been rejected" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
echo "[verify] step 9 ok: destroy clean, 0 orphans"

echo "[verify] step 10: remove the events sidecars so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive 2>&1 || true)"
if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "[verify] FAIL: sidecar not fully removed for ${STACK}:"
  echo "${REMAINING}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 10 ok: sidecars removed"

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS"
