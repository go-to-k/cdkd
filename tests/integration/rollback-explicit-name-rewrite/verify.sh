#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd rollback` re-creates an EXPLICITLY
# named IAM Role under the name its deploy sent (issue #4018), or under the
# name it had when the prefix flag flipped (issue #4024).
#
# The IAM Role provider sends `generateResourceNameWithFallback(RoleName)`,
# which prepends the stack name unless the deploy's user-supplied-name prefix
# flag skips it (the default). The deploy records the flag in its journal
# segment; `cdkd rollback` must replay under it. Before the fix it replayed
# with no flag in scope, so it re-created `${STACK}-cdkd-integ-rbrw-a`
# although the deploy had created `cdkd-integ-rbrw-a`.
#
# go-to-k/cdkd#6374: a create-first replacement deletes the OLD role only in
# the deploy's cleanup phase, after every other change succeeded, so a failed
# deploy leaves it alive and recorded in state (`supersededResources`), and
# the rollback re-adopts it rather than re-creating it. The re-create under
# test runs only when the old role is GONE, so after each failed --no-rollback
# deploy below the old role is first asserted alive and then deleted by hand
# (out of band): the rollback reads it as gone and must re-create it under the
# right name.
#
# go-to-k/cdkd#6393 (the #4010 squatter, restored): a role created out of band
# under the deleted old role's name answers the rollback's existence read, so
# before the fix the rollback re-adopted that stranger as the stack's role.
# The read now compares the RoleId the stack recorded with the live one; a
# squatter carries another, so the rollback refuses (REPLACED_SURVIVOR_UNPROVEN)
# and sends nothing.
#
# What this asserts:
#   PHASE 1 (baseline, default flag = prefix skipped):
#     1. Deploy v1: role `cdkd-integ-rbrw-a` exists under EXACTLY that name.
#   PHASE 2 (a failed replacing deploy):
#     2. Deploy ROLE_SUFFIX=b + INJECT_FAIL --no-rollback: `-b` created, the
#        deploy fails before its cleanup phase, so `-a` still exists (same
#        RoleId), state keeps it as NamedRole's superseded resource, the log
#        says it was not deleted, and the journal segment records
#        skipPrefix=true. Then `-a` is deleted by hand.
#   PHASE 3 (a squatter took the old name -> REFUSED, #6393 / #4010):
#     3. Create a squatter role OUT OF BAND under `cdkd-integ-rbrw-a`.
#        `cdkd rollback` must fail; the squatter survives with its own RoleId,
#        the new role `-b` survives, state still names `-b`, the journal is
#        kept, and the refusal names `cdkd-integ-rbrw-a` and says its RoleId
#        differs. Then the squatter is deleted.
#   PHASE 4 (the re-create succeeds under the deploy's name):
#     4. `cdkd rollback`: it reads `-a` as gone and re-creates it; exit 0,
#        `cdkd-integ-rbrw-a` is the stack's role again (template description,
#        state physical id, a NEW RoleId), state no longer lists it as
#        superseded, `-b` is deleted, the prefixed name was never created,
#        journal gone.
#   PHASE 4b (an in-place UPDATE revert stays in place):
#     4b. Change only the role's Description + INJECT_FAIL --no-rollback, then
#        `cdkd rollback`: `cdkd-integ-rbrw-a` keeps its name and gets its old
#        description back; the prefixed name is never created. Before the fix
#        the provider's update() derived the prefixed name there and REPLACED
#        the role, deleting `cdkd-integ-rbrw-a`.
#     5. Destroy clean.
#   PHASE 5 (negative control, deploys with --prefix-user-supplied-names):
#     6. Fresh deploy with the flag: role `${STACK}-cdkd-integ-rbrw-a`.
#     7. Failing replacing deploy with the flag: `${STACK}-cdkd-integ-rbrw-a`
#        survives it; the segment records skipPrefix=false. Then it is deleted
#        by hand.
#     8. `cdkd rollback` WITHOUT the flag and without the env: the recorded
#        flag wins, so the role comes back as `${STACK}-cdkd-integ-rbrw-a` and
#        the bare `cdkd-integ-rbrw-a` is never created.
#   PHASE 6 (the flag FLIPPED between the creating and the failed deploy, #4024):
#     8b. The role `${STACK}-cdkd-integ-rbrw-a` was created with the prefix
#        KEPT (step 8). A failing replacing deploy WITHOUT the flag
#        (--no-rollback) creates the bare `cdkd-integ-rbrw-b`; the prefixed
#        `-a` survives it; the segment records skipPrefix=true. Then the
#        prefixed `-a` is deleted by hand.
#     8c. `cdkd rollback`: the old role comes back as EXACTLY its original
#        `${STACK}-cdkd-integ-rbrw-a` (before the fix: the bare
#        `cdkd-integ-rbrw-a`, a name it never had), `-b` is deleted, journal
#        gone, and the log names the setting it chose.
#     8d. The same failing deploy WITH the automatic rollback: nothing deletes
#        the prefixed `-a` this time, so the in-process rollback RE-ADOPTS it
#        (same RoleId, no re-create, so no setting line), deletes `-b`, never
#        creates the bare `-a`, and leaves only the failed CreateQueue in the
#        journal (#1208).
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

# The role's RoleId (IAM's unique id): a re-created role gets a new one.
role_id() { # usage: role_id <role-name>
  aws iam get-role --role-name "$1" --query 'Role.RoleId' --output text
}

# How many superseded resources state records under physical id "$1".
state_superseded_count() { # usage: state_superseded_count <physical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
    | jq -r --arg id "$1" '[.supersededResources // [] | .[] | select(.state.physicalId == $id)] | length'
}

# go-to-k/cdkd#6374: after a failed deploy the replaced role is alive, the
# same role as before, kept in state as superseded, and the deploy says so.
# AWS and state before the wording.
assert_old_role_kept() { # usage: assert_old_role_kept <role-name> <expected-role-id> <deploy-log>
  local name="$1" want_id="$2" log="$3" got_id n
  got_id="$(role_id "${name}")" || { echo "[verify] FAIL: old ${name} is gone after the failed deploy -- a failed deploy must never send the replaced role's delete (go-to-k/cdkd#6374)"; exit 1; }
  if [ "${got_id}" != "${want_id}" ]; then
    echo "[verify] FAIL: old ${name} has RoleId ${got_id} after the failed deploy (expected ${want_id}: the same role, untouched)"
    exit 1
  fi
  n="$(state_superseded_count "${name}")"
  if [ "${n}" != "1" ]; then
    echo "[verify] FAIL: state records ${n} superseded resources named ${name} after the failed deploy (expected 1: kept for a later run to delete)"
    exit 1
  fi
  if ! grep -qF "Old NamedRole (${name}) was not deleted: the deploy failed first" <<<"$(sed 's/\x1b\[[0-9;]*m//g' "${log}")"; then
    echo "[verify] FAIL: the failed deploy did not say old ${name} was not deleted (output above)"
    exit 1
  fi
}

# Delete the replaced role OUT OF BAND, so the rollback finds it gone and must
# re-create it: the arm this fixture is about.
delete_old_role_out_of_band() { # usage: delete_old_role_out_of_band <role-name>
  aws iam delete-role --role-name "$1"
  wait_role_gone "old $1 still readable ~20s after its delete by hand" "$1"
}

# The rollback read the old role as gone (go-to-k/cdkd#2631) before the
# re-create, and state no longer lists it as superseded (the next deploy would
# delete the re-created role).
assert_recreated_from_gone() { # usage: assert_recreated_from_gone <role-name> <old-role-id> <rollback-log>
  local name="$1" old_id="$2" log="$3" got_id n
  got_id="$(role_id "${name}")"
  if [ "${got_id}" = "${old_id}" ]; then
    echo "[verify] FAIL: ${name} still has the deleted role's RoleId ${old_id}; it was not re-created"
    exit 1
  fi
  n="$(state_superseded_count "${name}")"
  if [ "${n}" != "0" ]; then
    echo "[verify] FAIL: state still records ${name} as superseded after the rollback re-created it -- the next deploy would delete the stack's live role"
    exit 1
  fi
  if ! grep -qF "Rollback: the old resource of NamedRole (${name}) is gone — re-creating it" <<<"$(sed 's/\x1b\[[0-9;]*m//g' "${log}")"; then
    echo "[verify] FAIL: the rollback did not say it read old ${name} as gone before re-creating it (output above)"
    exit 1
  fi
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
  # ROLE_A is also the step-3 squatter's name.
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
# would turn the gone-probes below into false leaks. Checked BEFORE the cleanup trap is armed, so a
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
ROLE_A_ID_V1="$(role_id "${ROLE_A}")"
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
assert_old_role_kept "${ROLE_A}" "${ROLE_A_ID_V1}" "${LOG_DIR}/replace.log"
J_SKIP="$(journal_skip_prefix)"
if [ "${J_SKIP}" != "true" ]; then
  echo "[verify] FAIL: the journal segment records skipPrefix=${J_SKIP} (expected true: the deploy skipped the prefix)"
  exit 1
fi
delete_old_role_out_of_band "${ROLE_A}"
echo "[verify] step 2 ok: ${ROLE_B} created, ${ROLE_A} kept by the failed deploy then deleted by hand, journal records skipPrefix=true"

# ---------------------------------------------------------------------------
# PHASE 3: a squatter took the old role's name -> refused (#6393 / #4010)
# ---------------------------------------------------------------------------
echo "[verify] step 3: create a squatter role ${ROLE_A} out of band, then cdkd rollback (expect REFUSAL)"
SQUATTER_ID="$(aws iam create-role --role-name "${ROLE_A}" --assume-role-policy-document "${TRUST}" \
  --description "${SQUATTER_DESCRIPTION}" --query 'Role.RoleId' --output text)"
if [ -z "${SQUATTER_ID}" ] || [ "${SQUATTER_ID}" = "${ROLE_A_ID_V1}" ]; then
  echo "[verify] FAIL: the squatter's RoleId '${SQUATTER_ID}' is empty or equals the deleted role's ${ROLE_A_ID_V1}"
  exit 1
fi
# IAM is eventually consistent: a read that does not see the squatter yet
# would take the gone arm and collide on the re-create instead of refusing.
aws iam wait role-exists --role-name "${ROLE_A}"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/refused.log" 2>&1
REFUSED_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/refused.log" || true
if [ "${REFUSED_RC}" -eq 0 ]; then
  echo "[verify] FAIL: cdkd rollback SUCCEEDED with a squatter on ${ROLE_A} -- it took a stranger's role as the stack's (go-to-k/cdkd#6393)"
  exit 1
fi
# AWS, state and journal before the wording.
SQUATTER_ID_AFTER="$(role_id "${ROLE_A}")" || { echo "[verify] FAIL: the squatter ${ROLE_A} is gone after the refused rollback"; exit 1; }
if [ "${SQUATTER_ID_AFTER}" != "${SQUATTER_ID}" ]; then
  echo "[verify] FAIL: ${ROLE_A} has RoleId ${SQUATTER_ID_AFTER} after the refused rollback (expected the squatter's ${SQUATTER_ID}: untouched)"
  exit 1
fi
if [ "$(role_description "${ROLE_A}")" != "${SQUATTER_DESCRIPTION}" ]; then
  echo "[verify] FAIL: the refused rollback changed the squatter ${ROLE_A}"
  exit 1
fi
if [ "$(role_description "${ROLE_B}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: the refused rollback deleted the live new role ${ROLE_B}"
  exit 1
fi
REFUSED_STATE_ID="$(state_role_id)"
if [ "${REFUSED_STATE_ID}" != "${ROLE_B}" ]; then
  echo "[verify] FAIL: state records NamedRole as ${REFUSED_STATE_ID} after the refused rollback (expected ${ROLE_B}, unchanged)"
  exit 1
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
  echo "[verify] FAIL: the refused rollback dropped the journal"
  exit 1
fi
assert_gone "the refused rollback created the PREFIXED ${PREFIXED_A}" \
  aws iam get-role --role-name "${PREFIXED_A}"
# The parsed marker names the old role and its differing RoleId; the sentinel
# is the refusal's own opening, independent of it. Sentinel without marker =
# the wording drifted (or another refusal fired) -- never read as "no refusal".
REFUSAL_SENTINEL="Cannot reverse the replacement of NamedRole (AWS::IAM::Role)"
REFUSAL_NAME_MARKER="AWS reports a resource under the old physical id (${ROLE_A})"
REFUSAL_ID_MARKER="but not the one this stack recorded (its RoleId differs)"
REFUSED_TEXT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/refused.log")"
if ! grep -qF "${REFUSAL_SENTINEL}" <<<"${REFUSED_TEXT}"; then
  echo "[verify] FAIL: rollback exited ${REFUSED_RC} without the reverse-replacement refusal (output above)"
  exit 1
fi
REFUSAL_LINE="$(grep -F "${REFUSAL_SENTINEL}" <<<"${REFUSED_TEXT}")"
if ! grep -qF "${REFUSAL_NAME_MARKER}" <<<"${REFUSAL_LINE}" || ! grep -qF "${REFUSAL_ID_MARKER}" <<<"${REFUSAL_LINE}"; then
  echo "[verify] FAIL: the refusal does not name ${ROLE_A} and say its RoleId differs (wording drifted, or another refusal fired):"
  printf '%s\n' "${REFUSAL_LINE}" | sed 's/^/  /'
  exit 1
fi
aws iam delete-role --role-name "${ROLE_A}"
wait_role_gone "squatter ${ROLE_A} still readable ~20s after delete-role" "${ROLE_A}"
echo "[verify] step 3 ok: refused naming ${ROLE_A} (RoleId differs), squatter and ${ROLE_B} untouched, journal kept; squatter deleted"

# ---------------------------------------------------------------------------
# PHASE 4: the re-create succeeds under the deploy's name
# ---------------------------------------------------------------------------
echo "[verify] step 4: cdkd rollback (the old role is gone: expect a re-create, exit 0)"
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback.log" 2>&1
RB_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback.log" || true
if [ "${RB_RC}" -ne 0 ]; then
  echo "[verify] FAIL: cdkd rollback exited ${RB_RC} with the old role gone (output above)"
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
assert_recreated_from_gone "${ROLE_A}" "${ROLE_A_ID_V1}" "${LOG_DIR}/rollback.log"
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
PREFIXED_A_ID_6="$(role_id "${PREFIXED_A}")"
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
assert_old_role_kept "${PREFIXED_A}" "${PREFIXED_A_ID_6}" "${LOG_DIR}/replace-prefixed.log"
J_SKIP2="$(journal_skip_prefix)"
if [ "${J_SKIP2}" != "false" ]; then
  echo "[verify] FAIL: the journal segment records skipPrefix=${J_SKIP2} (expected false: the deploy kept the prefix)"
  exit 1
fi
delete_old_role_out_of_band "${PREFIXED_A}"
echo "[verify] step 7 ok: ${PREFIXED_A} kept by the failed deploy then deleted by hand, journal records skipPrefix=false"

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
assert_recreated_from_gone "${PREFIXED_A}" "${PREFIXED_A_ID_6}" "${LOG_DIR}/rollback-prefixed.log"
assert_gone "the prefix-kept rollback created the bare ${ROLE_A}" aws iam get-role --role-name "${ROLE_A}"
wait_role_gone "new ${PREFIXED_B} still exists after the prefix-kept rollback" "${PREFIXED_B}"
assert_gone "rollback journal still present after the prefix-kept rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_no_legacy_fallback "${LOG_DIR}/rollback-prefixed.log"
echo "[verify] step 8 ok: ${PREFIXED_A} restored under the recorded (prefix-kept) name"

# ---------------------------------------------------------------------------
# PHASE 6: the flag flipped between the creating deploy and the failed one (#4024)
# ---------------------------------------------------------------------------
# The parsed marker names the chosen and the recorded setting; the sentinel is
# the line's own opening, independent of it. Sentinel without marker = the
# wording drifted — never read as "no choice was made".
FLIP_SENTINEL="Rollback: re-creating NamedRole (AWS::IAM::Role) under the user-supplied-name prefix setting that created"
FLIP_MARKER="(stack-name prefix KEPT; the failed deploy ran with it SKIPPED)"
assert_flip_logged() { # usage: assert_flip_logged <log>
  if ! grep -qF "${FLIP_SENTINEL}" "$1"; then
    echo "[verify] FAIL: the rollback did not say it re-created NamedRole under the setting that created it"
    exit 1
  fi
  if ! grep -F "${FLIP_SENTINEL}" "$1" | grep -qF "${FLIP_MARKER}"; then
    echo "[verify] FAIL: the setting line is present but does not name prefix KEPT over the recorded SKIPPED (wording drifted, or another setting was chosen):"
    grep -F "${FLIP_SENTINEL}" "$1" | sed 's/^/  /'
    exit 1
  fi
}

# Replaces NamedRole with the bare `-b` in a deploy WITHOUT the flag, so its
# segment records skipPrefix=true while the old role was created with the
# prefix kept. Leaves the deploy's log in the named file.
#
# `--yes`: the state still holds the PREFIXED role, so the deploy's
# prefix-migration check lists it as a pending REPLACE and asks first — which
# refuses outright in a non-interactive run. Its warning is asserted: it is
# the evidence this deploy really ran with the flag dropped.
MIGRATION_WARNING="WARNING: --no-prefix-user-supplied-names will REPLACE"
replace_without_flag() { # usage: replace_without_flag <log> [extra deploy args...]
  local log="$1" rc
  shift
  set +e
  env -u CDKD_PREFIX_USER_SUPPLIED_NAMES ROLE_SUFFIX=b INJECT_FAIL=true \
    ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes "$@" > "${log}" 2>&1
  rc=$?
  set -e
  sed 's/^/  /' "${log}" || true
  if [ "${rc}" -eq 0 ]; then
    echo "[verify] FAIL: the flag-dropped failing deploy unexpectedly SUCCEEDED"
    exit 1
  fi
  if ! grep -qF "${MIGRATION_WARNING}" "${log}"; then
    echo "[verify] FAIL: the flag-dropped deploy printed no prefix-migration warning — it did not run with the prefix skipped against the prefixed role"
    exit 1
  fi
}

echo "[verify] step 8b: failing replacing deploy WITHOUT --prefix-user-supplied-names --no-rollback"
PREFIXED_A_ID_8="$(role_id "${PREFIXED_A}")"
replace_without_flag "${LOG_DIR}/replace-flipped.log" --no-rollback
if [ "$(role_description "${ROLE_B}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${ROLE_B} missing — the flag-dropped replacement did not land"
  exit 1
fi
assert_old_role_kept "${PREFIXED_A}" "${PREFIXED_A_ID_8}" "${LOG_DIR}/replace-flipped.log"
J_SKIP3="$(journal_skip_prefix)"
if [ "${J_SKIP3}" != "true" ]; then
  echo "[verify] FAIL: the journal segment records skipPrefix=${J_SKIP3} (expected true: the deploy dropped the flag)"
  exit 1
fi
delete_old_role_out_of_band "${PREFIXED_A}"
echo "[verify] step 8b ok: ${ROLE_B} created, ${PREFIXED_A} kept by the failed deploy then deleted by hand, journal records skipPrefix=true"

echo "[verify] step 8c: cdkd rollback (the old role must come back as ${PREFIXED_A})"
set +e
env -u CDKD_PREFIX_USER_SUPPLIED_NAMES \
  ${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${LOG_DIR}/rollback-flipped.log" 2>&1
RB3_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/rollback-flipped.log" || true
if [ "${RB3_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the flag-flipped cdkd rollback exited ${RB3_RC} (output above)"
  exit 1
fi
if [ "$(role_description "${PREFIXED_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: ${PREFIXED_A} was not re-created under its original name"
  exit 1
fi
RB3_ID="$(state_role_id)"
if [ "${RB3_ID}" != "${PREFIXED_A}" ]; then
  echo "[verify] FAIL: state records NamedRole as ${RB3_ID} after the flag-flipped rollback (expected ${PREFIXED_A})"
  exit 1
fi
assert_recreated_from_gone "${PREFIXED_A}" "${PREFIXED_A_ID_8}" "${LOG_DIR}/rollback-flipped.log"
assert_gone "the flag-flipped rollback re-created the old role under the bare ${ROLE_A}, a name it never had" \
  aws iam get-role --role-name "${ROLE_A}"
wait_role_gone "new ${ROLE_B} still exists after the flag-flipped rollback" "${ROLE_B}"
assert_gone "rollback journal still present after the flag-flipped rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_no_legacy_fallback "${LOG_DIR}/rollback-flipped.log"
assert_flip_logged "${LOG_DIR}/rollback-flipped.log"
echo "[verify] step 8c ok: ${PREFIXED_A} restored under its original name, ${ROLE_B} deleted, journal gone"

echo "[verify] step 8d: the same flag-dropped failing deploy WITH the automatic rollback"
PREFIXED_A_ID_8D="$(role_id "${PREFIXED_A}")"
replace_without_flag "${LOG_DIR}/replace-flipped-auto.log"
if [ "$(role_description "${PREFIXED_A}")" != "${ROLE_DESCRIPTION}" ]; then
  echo "[verify] FAIL: the automatic rollback did not restore ${PREFIXED_A} under its original name"
  exit 1
fi
# go-to-k/cdkd#6374: the failed deploy never sent the old role's delete, so
# the rollback takes back the SAME role. AWS and state before the wording.
if [ "$(role_id "${PREFIXED_A}")" != "${PREFIXED_A_ID_8D}" ]; then
  echo "[verify] FAIL: ${PREFIXED_A} has a new RoleId after the automatic rollback: it was deleted and re-created, not re-adopted (go-to-k/cdkd#6374)"
  exit 1
fi
if [ "$(state_superseded_count "${PREFIXED_A}")" != "0" ]; then
  echo "[verify] FAIL: state still records ${PREFIXED_A} as superseded after the automatic rollback re-adopted it -- the next deploy would delete the stack's live role"
  exit 1
fi
RB4_ID="$(state_role_id)"
if [ "${RB4_ID}" != "${PREFIXED_A}" ]; then
  echo "[verify] FAIL: state records NamedRole as ${RB4_ID} after the automatic rollback (expected ${PREFIXED_A})"
  exit 1
fi
assert_gone "the automatic rollback re-created the old role under the bare ${ROLE_A}, a name it never had" \
  aws iam get-role --role-name "${ROLE_A}"
wait_role_gone "new ${ROLE_B} still exists after the automatic rollback" "${ROLE_B}"
# A clean automatic rollback keeps only the failed CreateQueue (#1208): one
# `auto-rollback-clean` segment with no completed operation left to revert.
AUTO_JOURNAL="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
AUTO_SHAPE="$(printf '%s' "${AUTO_JOURNAL}" | jq -r '"\(.segments | length) \(.segments[-1].reason) \([.segments[].operations | length] | add) \([.segments[-1].failedOperations[]?.logicalId] | join(","))"')"
if [ "${AUTO_SHAPE}" != "1 auto-rollback-clean 0 FailingQueue" ]; then
  echo "[verify] FAIL: journal after the automatic rollback is '${AUTO_SHAPE}' (expected '1 auto-rollback-clean 0 FailingQueue': the rollback did not complete cleanly)"
  exit 1
fi
# The re-adopt line is the positive marker; the setting line belongs to a
# re-create, which must not have run.
if ! grep -qF "Rollback: the old resource of NamedRole (${PREFIXED_A}) was not deleted yet — re-adopting it" \
  <<<"$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/replace-flipped-auto.log")"; then
  echo "[verify] FAIL: the automatic rollback did not say it re-adopted ${PREFIXED_A} (output above)"
  exit 1
fi
if grep -qF "${FLIP_SENTINEL}" "${LOG_DIR}/replace-flipped-auto.log"; then
  echo "[verify] FAIL: the automatic rollback re-created NamedRole although its old role was never deleted (output above)"
  exit 1
fi
echo "[verify] step 8d ok: the automatic rollback re-adopted ${PREFIXED_A}, ${ROLE_B} deleted, failed-only journal left for destroy"

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
