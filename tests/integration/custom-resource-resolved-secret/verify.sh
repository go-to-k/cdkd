#!/usr/bin/env bash
# verify.sh — cdkd never sends a secret's PLAINTEXT to a custom-resource handler
# (go-to-k/cdkd#4009), on the two deploy routes the #3976 template pre-flight
# cannot see.
#
# The handler logs its whole event, so "what cdkd sent the handler" is readable
# from CloudWatch. Every arm deploys a FRESH stack after tearing the last down.
#
# PHASES.
#   A (ssm-secure) — a custom resource whose Value is a PLAIN
#     `{{resolve:ssm:...}}` naming a SecureString verify.sh created. The deploy
#     must FAIL with the #4009 refusal naming `SsmReader: Value`, and the
#     secure value must appear in NO log event of the stack's Lambdas.
#   B (nested) — a nested child's custom resource whose Value is `{Ref}` to a
#     child parameter the parent fills from a Secrets Manager secret. Same
#     assertions, naming `NestedReader: Value`.
#   U (update) — deploy a custom resource with a plain value, update it to the
#     SecureString reference (refused), then `cdkd rollback --revert-failed`,
#     which re-resolves the failed op's attempted properties as the PREVIOUS
#     side (OldResourceProperties) — also refused.
#   C — a plain deploy (handler + a benign custom resource) and a CLEAN destroy,
#     the run the `integ-destroy` gate reads.
#
# After every refused arm, every state version (parent and child state,
# journal, lock) is scanned for the secret values BEFORE any sweep.
#
# DISCRIMINATOR. Pre-#4009 both A and B deploy successfully and the handler
# logs the secret, so the non-zero exit, the refusal line and the log scan all
# go red. A POSITIVE log control (the benign reader's event is found) keeps the
# absence scan from passing merely because CloudWatch had not ingested yet.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.


set -euo pipefail

export AWS_PAGER=""

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

cd "$(dirname "$0")"

STACK="CdkdCrResolvedSecretExample"
CHILD_STACK="${STACK}~Child"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"

# Must match `lib/custom-resource-resolved-secret-stack.ts`. Fixed, inert
# literals -- not credentials -- distinctive enough to grep for anywhere.
SECURE_PARAM="/cdkd-integ/${STACK}/secure"
SECURE_VALUE="cdkd-4009-secure-ssm-literal"
NESTED_SECRET="cdkd-integ/${STACK}/nested"
NESTED_VALUE="cdkd-4009-nested-secret-literal"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
VERSIONS_FILE=""

. ../s3-versions.sh
. ../cr-log-groups.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"

# Tear down the stack (child first) and its state; keep the seeded secret and
# parameter. Called between arms and from `cleanup`.
teardown_stack() {
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ]; then
      node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    fi
    if [ -n "${STATE_BUCKET:-}" ]; then
      for key in "${STATE_KEY}" "${CHILD_KEY}" \
                 "cdkd/${STACK}/${REGION}/lock.json" "cdkd/${CHILD_STACK}/${REGION}/lock.json"; do
        aws s3 rm "s3://${STATE_BUCKET}/${key}" >/dev/null 2>&1
      done
    fi
    sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  )
}

cleanup() {
  echo "==> Cleanup: dropping stack resources, state, the seeded secret and parameter"
  set +eu
  teardown_stack
  aws ssm delete-parameter --region "${REGION}" --name "${SECURE_PARAM}" >/dev/null 2>&1
  aws secretsmanager delete-secret --region "${REGION}" --secret-id "${NESTED_SECRET}" \
    --force-delete-without-recovery >/dev/null 2>&1
  if [ -n "${VERSIONS_FILE}" ]; then
    rm -f "${VERSIONS_FILE}" "${VERSIONS_FILE}.body" "${VERSIONS_FILE}.invoke"
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    # NONCURRENT only: this also runs pre-run and from the failure traps.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX:-}" noncurrent
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

# --- Seed the secure parameter and the secret -------------------------------
echo "==> Seeding ${SECURE_PARAM} (SecureString) and ${NESTED_SECRET}"
aws ssm put-parameter --region "${REGION}" --name "${SECURE_PARAM}" --type SecureString \
  --value "${SECURE_VALUE}" --overwrite >/dev/null
seeded=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if seed_err=$(aws secretsmanager create-secret --region "${REGION}" --name "${NESTED_SECRET}" \
    --secret-string "${NESTED_VALUE}" 2>&1 >/dev/null); then
    seeded=1
    break
  fi
  # A force-deleted secret's name is released asynchronously.
  if ! printf '%s' "${seed_err}" | grep -q 'scheduled for deletion'; then
    echo "FAIL: could not create ${NESTED_SECRET}: ${seed_err}" >&2
    exit 1
  fi
  echo "    (${NESTED_SECRET} name still held by a deletion — attempt ${attempt}/12)"
  sleep 5
done
if [ "${seeded}" -ne 1 ]; then
  echo "FAIL: ${NESTED_SECRET} was never released for re-creation" >&2
  exit 1
fi

# The handler's physical name: `<stack>-<logicalId>` (untruncated here).
HANDLER_NAME="${STACK}-EventLogger455115CB"

epoch_ms() { printf '%s000' "$(date +%s)"; }

# Every log event of the stack's Lambdas since `$1` (epoch ms), as one blob.
# A read failure prints nothing and returns non-zero; callers retry.
stack_log_text() {
  local since="$1" groups group
  groups=$(aws logs describe-log-groups --region "${REGION}" \
    --log-group-name-prefix "/aws/lambda/${STACK}-" \
    --query 'logGroups[].logGroupName' --output text) || return 1
  for group in ${groups}; do
    [ "${group}" = "None" ] && continue
    aws logs filter-log-events --region "${REGION}" --log-group-name "${group}" \
      --start-time "${since}" --query 'events[].message' --output text || return 1
  done
}

# assert_logs_clean <since-ms> <control-marker> <secret-value> <what>
assert_logs_clean() {
  local since="$1" marker="$2" value="$3" what="$4" logs="" attempt
  for attempt in $(seq 1 36); do
    logs=$(stack_log_text "${since}") || logs=""
    if printf '%s' "${logs}" | grep -qF "${marker}"; then break; fi
    sleep 5
  done
  if ! printf '%s' "${logs}" | grep -qF "${marker}"; then
    echo "FAIL: ${what}: the benign reader's '${marker}' event never appeared in the handler" >&2
    echo "    logs -- the absence check below would prove nothing" >&2
    exit 1
  fi
  if printf '%s' "${logs}" | grep -qF "${value}"; then
    echo "FAIL: ${what}: the secret value reached the handler's logged event (pre-#4009 behaviour)" >&2
    exit 1
  fi
  echo "    OK: ${what}: the handler logged '${marker}' and never the secret value"
}

# The redaction must hold in EVERY state version this run wrote (the parent's
# and the child's state, journal, lock and deployments event store), before any
# sweep removes them.
assert_versions_clean() {
  local what="$1" prefix key vid
  for prefix in "${STATE_PREFIX}" "${CHILD_PREFIX}"; do
    aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${prefix}" \
      --query 'Versions[].[Key,VersionId]' --output text > "${VERSIONS_FILE}"
    while read -r key vid || [ -n "${key}" ]; do
      [ -z "${key}" ] || [ "${key}" = "None" ] && continue
      if ! aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" --version-id "${vid}" \
        "${VERSIONS_FILE}.body" >/dev/null; then
        echo "FAIL: ${what}: could not read ${key} (version ${vid}) to scan it" >&2
        exit 1
      fi
      if grep -qF -e "${SECURE_VALUE}" -e "${NESTED_VALUE}" "${VERSIONS_FILE}.body"; then
        echo "FAIL: ${what}: a secret value is readable in ${key} (version ${vid})" >&2
        exit 1
      fi
    done < "${VERSIONS_FILE}"
  done
  echo "    OK: ${what}: no state version holds a secret value"
}

# assert_refusal_text <output> <reader-and-path> <what>
assert_refusal_text() {
  local txt="$1" line="$2" what="$3" head_seen=0 line_seen=0
  if printf '%s' "${txt}" | grep -q 'resolved to the value of a secret'; then head_seen=1; fi
  if printf '%s' "${txt}" | grep -qF "Custom resource ${line}"; then line_seen=1; fi
  if [ "${line_seen}" -eq 1 ] && [ "${head_seen}" -eq 0 ]; then
    echo "FAIL: ${what}: the refusal names ${line} but its wording drifted — fix verify.sh" >&2
    exit 1
  fi
  if [ "${head_seen}" -eq 0 ] || [ "${line_seen}" -eq 0 ]; then
    echo "FAIL: ${what}: no #4009 refusal naming '${line}'" >&2
    exit 1
  fi
  if printf '%s' "${txt}" | grep -qF -e "${SECURE_VALUE}" -e "${NESTED_VALUE}"; then
    echo "FAIL: ${what}: a secret value appeared in cdkd's own output" >&2
    exit 1
  fi
}

# cdkd_run <command...>: run it, print its output, and leave the exit code in
# CDKD_RC and the colour-stripped text in CDKD_TXT.
cdkd_run() {
  set +e
  CDKD_OUT=$("$@" 2>&1)
  CDKD_RC=$?
  set -e
  printf '%s\n' "${CDKD_OUT}"
  CDKD_TXT=$(printf '%s' "${CDKD_OUT}" | sed $'s/\033\[[0-9;]*m//g')
}

# assert_refused <arm> <mode> <reader> <value> <since-ms>, after the caller ran
# the arm's deploy through `cdkd_run` with a LITERAL mode list (the
# mode-gated-resource fence reads each deploy's CDKD_TEST_UPDATE statically).
assert_refused() {
  local arm="$1" mode="$2" reader="$3" value="$4" since="$5"
  if [ "${CDKD_RC}" -eq 0 ]; then
    echo "FAIL: the ${mode} deploy succeeded — the handler was sent the secret (pre-#4009 behaviour)" >&2
    exit 1
  fi
  assert_refusal_text "${CDKD_TXT}" "${reader}: Value" "phase ${arm}"
  echo "    OK: refused, naming ${reader}: Value; cdkd's output does not carry the value"
  assert_logs_clean "${since}" "not-a-secret-${mode}" "${value}" "phase ${arm}"
  assert_versions_clean "phase ${arm}"

  teardown_stack
  assert_gone "state file ${STATE_KEY} still exists after the ${arm} teardown" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
  assert_gone "handler Lambda ${HANDLER_NAME} still exists after the ${arm} teardown" \
    aws lambda get-function --region "${REGION}" --function-name "${HANDLER_NAME}"
}

VERSIONS_FILE=$(mktemp)
echo "    (state-version scan scratch: ${VERSIONS_FILE})"

echo "==> Phase A: deploy with ssm-secure — must be refused at the handler invoke"
A_SINCE=$(epoch_ms)
cdkd_run env CDKD_TEST_UPDATE=ssm-secure node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
assert_refused A ssm-secure SsmReader "${SECURE_VALUE}" "${A_SINCE}"

echo "==> Phase B: deploy with nested — must be refused at the handler invoke"
B_SINCE=$(epoch_ms)
cdkd_run env CDKD_TEST_UPDATE=nested node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
assert_refused B nested NestedReader "${NESTED_VALUE}" "${B_SINCE}"

# --- Phase U: an UPDATE to the SecureString, then --revert-failed ------------
# The update is refused; the journal keeps the failed op's attempted
# properties, which `cdkd rollback --revert-failed` re-resolves as the PREVIOUS
# side (sent as OldResourceProperties). That replay must be refused too.
echo "==> Phase U: deploy SsmUpdater with a plain value"
env CDKD_TEST_UPDATE=update-clean node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
echo "==> Phase U: update SsmUpdater to the SecureString reference — must be refused"
U_SINCE=$(epoch_ms)
cdkd_run env CDKD_TEST_UPDATE=update-secret node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
if [ "${CDKD_RC}" -eq 0 ]; then
  echo "FAIL: the update to the SecureString succeeded — the handler was sent the secret" >&2
  exit 1
fi
assert_refusal_text "${CDKD_TXT}" "SsmUpdater: Value" "phase U update"
echo "    OK: the update was refused, naming SsmUpdater: Value"

echo "==> Phase U: cdkd rollback --revert-failed — the replay must be refused too"
cdkd_run node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" \
  --revert-failed \
  --force
if [ "${CDKD_RC}" -eq 0 ]; then
  echo "FAIL: rollback --revert-failed succeeded — it replayed the secret into OldResourceProperties" >&2
  exit 1
fi
assert_refusal_text "${CDKD_TXT}" "SsmUpdater: OldResourceProperties.Value" "phase U revert-failed"
echo "    OK: the revert-failed replay was refused, naming OldResourceProperties.Value"
# Positive control AFTER the replay: a direct invoke with a unique marker, so
# the log read below provably covers the window the replay would have logged in.
aws lambda invoke --region "${REGION}" --function-name "${HANDLER_NAME}" \
  --cli-binary-format raw-in-base64-out --payload '{"marker":"u-after-revert"}' \
  "${VERSIONS_FILE}.invoke" >/dev/null
assert_logs_clean "${U_SINCE}" "u-after-revert" "${SECURE_VALUE}" "phase U"
assert_versions_clean "phase U"
teardown_stack
assert_gone "state file ${STATE_KEY} still exists after the U teardown" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "handler Lambda ${HANDLER_NAME} still exists after the U teardown" \
  aws lambda get-function --region "${REGION}" --function-name "${HANDLER_NAME}"

# --- Phase C: the CLEAN deploy / destroy ------------------------------------
echo "==> Phase C: plain deploy and clean destroy (the run the integ-destroy gate reads)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
STATE_C=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
HANDLER_C=$(printf '%s' "${STATE_C}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .physicalId] | first // ""')
if [ "${HANDLER_C}" != "${HANDLER_NAME}" ]; then
  echo "FAIL: the handler's physical name is '${HANDLER_C}', expected '${HANDLER_NAME}'" >&2
  echo "    => the gone-probes between arms checked the wrong name" >&2
  exit 1
fi
set +e
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY_RC=$?
set -e
printf '%s\n' "${DESTROY_OUT}"
DESTROY_TXT=$(printf '%s' "${DESTROY_OUT}" | sed $'s/\033\[[0-9;]*m//g')
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: the clean destroy exited ${DESTROY_RC}, expected 0" >&2
  exit 1
fi
if printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped '; then
  echo "FAIL: the clean destroy skipped something" >&2
  exit 1
fi
assert_gone "handler Lambda ${HANDLER_NAME} still exists after the clean destroy (orphan)" \
  aws lambda get-function --region "${REGION}" --function-name "${HANDLER_NAME}"
assert_gone "state file ${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: clean destroy; handler and state file are gone"

trap - EXIT INT TERM
rm -f "${VERSIONS_FILE}" "${VERSIONS_FILE}.body" "${VERSIONS_FILE}.invoke"
teardown_stack
aws ssm delete-parameter --region "${REGION}" --name "${SECURE_PARAM}" >/dev/null 2>&1 || true
aws secretsmanager delete-secret --region "${REGION}" --secret-id "${NESTED_SECRET}" \
  --force-delete-without-recovery >/dev/null 2>&1 || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "custom-resource-resolved-secret parent state"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "custom-resource-resolved-secret child state"

echo ""
echo "[verify] PASS — custom-resource-resolved-secret (#4009 SecureString-via-ssm and nested-parameter routes refused at the invoke + clean destroy)"
