#!/usr/bin/env bash
# verify.sh — a custom resource whose ServiceToken changes is REFUSED, as
# CloudFormation refuses it ("Modifying service token is not allowed"),
# before either handler is invoked (go-to-k/cdkd#4749).
#
# Before #4749 the change was sent as an Update to the NEW handler, and the old
# handler never received a Delete for what it created.
#
# Each handler writes an SSM marker `/cdkd-integ/<stack>/<function>/<RequestType>`
# on every request it receives, so "no request reached it" is read back from
# AWS rather than inferred from cdkd's output.
#
# PHASES.
#   1. Deploy: Cr on HandlerA. PREMISE: A got the Create, B got nothing.
#   2. `cdkd diff` with Cr switched to HandlerB: exits 3, the row under Blocking.
#   3. `cdkd deploy` with Cr switched to HandlerB: refused at plan time, exit
#      non-zero, the state object unchanged (same ETag), no marker for B, no
#      Update / Delete marker for A.
#   4. `cdkd deploy` with HandlerA renamed (replaced, so its ARN moves): refused
#      once Cr's token resolves, the deploy rolls back. HandlerA exists under its
#      old name again, the renamed function is gone, Cr still records A's ARN,
#      and no handler got an Update or Delete.
#   5. Deploy the baseline again: nothing to change, exit 0.
#   6. Clean destroy: Cr's Delete reaches HandlerA (the recorded handler), never
#      HandlerB. Everything is gone.
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

STACK="CdkdCrServiceTokenChange"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Must match `lib/cr-service-token-change-stack.ts`.
CR_ID="Cr"
FN_A="${STACK}-handler-a"
FN_A_RENAMED="${STACK}-handler-a-renamed"
FN_B="${STACK}-handler-b"
MARKER_ROOT="/cdkd-integ/${STACK}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Lambda creates `/aws/lambda/<function>` on first invoke and nothing in the
# stack owns it (#3885); every handler is named `<stack>-...`.
. ../cr-log-groups.sh

# The markers the handlers write are not stack resources. Best-effort: never
# fails its caller.
sweep_markers() {
  (
    set +eu
    names=$(aws ssm get-parameters-by-path --path "${MARKER_ROOT}" --recursive \
      --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null)
    for name in ${names}; do
      case "${name}" in
        "${MARKER_ROOT}/"?*) ;;
        *) continue ;;
      esac
      aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

# The handlers' auto-named service roles (`<stack>-<logicalId>...`) and their
# policies, left behind when a failed run's `state destroy` did not finish.
# Best-effort and scope-guarded (testing.md, "A destructive prefix sweep must
# refuse a widened scope"): never fails its caller.
sweep_stack_roles() {
  (
    set +eu
    case "${STACK}" in
      CdkdCrServiceTokenChange) ;;
      *)
        echo "    WARN: teardown sweep refused a stack scope outside this fixture: '${STACK:-<empty>}'" >&2
        exit 0
        ;;
    esac
    roles=$(aws iam list-roles \
      --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text 2>/dev/null) || exit 0
    for role in ${roles}; do
      case "${role}" in
        "${STACK}-"?*) ;;
        *) continue ;;
      esac
      for arn in $(aws iam list-attached-role-policies --role-name "${role}" \
        --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
        aws iam detach-role-policy --role-name "${role}" --policy-arn "${arn}" >/dev/null 2>&1
      done
      for name in $(aws iam list-role-policies --role-name "${role}" \
        --query 'PolicyNames[]' --output text 2>/dev/null); do
        aws iam delete-role-policy --role-name "${role}" --policy-name "${name}" >/dev/null 2>&1
      done
      aws iam delete-role --role-name "${role}" >/dev/null 2>&1
    done
  )
}

# Safe to run pre-run: every line targets something a phase re-creates.
cleanup() {
  echo "==> Cleanup: dropping any leftover stack resources, markers and state"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # A run interrupted mid-replacement can leave a function no record names.
  for fn in "${FN_A}" "${FN_A_RENAMED}" "${FN_B}"; do
    aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1
  done
  sweep_markers
  sweep_stack_roles
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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

# marker_present <function> <RequestType>: 0 when the handler wrote it, 1 when
# it did not; hard-FAILs on an undetermined read.
marker_present() {
  if gone_probe aws ssm get-parameter --name "${MARKER_ROOT}/$1/$2" --region "${REGION}"; then
    return 1
  fi
  return 0
}

# assert_no_handler_traffic <phase>: no Update / Delete reached HandlerA, and
# nothing at all reached HandlerB or the renamed HandlerA.
assert_no_handler_traffic() {
  local phase="$1" fn rt
  for rt in Update Delete; do
    if marker_present "${FN_A}" "${rt}"; then
      echo "FAIL (${phase}): HandlerA received a ${rt} request" >&2
      exit 1
    fi
  done
  for fn in "${FN_B}" "${FN_A_RENAMED}"; do
    for rt in Create Update Delete; do
      if marker_present "${fn}" "${rt}"; then
        echo "FAIL (${phase}): ${fn} received a ${rt} request" >&2
        exit 1
      fi
    done
  done
  echo "    OK (${phase}): no Update/Delete reached HandlerA; nothing reached ${FN_B} or ${FN_A_RENAMED}"
}

recorded_token() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null) || return 1
  printf '%s' "${state}" | jq -r --arg id "${CR_ID}" '.resources[$id].properties.ServiceToken // "<absent>"'
}

# HandlerA's RevisionId: a new one means the function was re-created (or
# updated), the same one that nothing touched it.
revision_a() {
  aws lambda get-function-configuration --function-name "${FN_A}" --region "${REGION}" \
    --query RevisionId --output text
}

state_etag() {
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --query ETag --output text
}

strip_ansi() {
  sed $'s/\033\[[0-9;]*m//g'
}

# --- Phase 1: baseline -------------------------------------------------------
echo "==> Phase 1: deploy (Cr on HandlerA)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! marker_present "${FN_A}" Create; then
  echo "FAIL: PREMISE not met — HandlerA did not record the Create (the markers prove nothing)" >&2
  exit 1
fi
echo "    OK: PREMISE — HandlerA recorded the Create"
assert_no_handler_traffic "phase 1"

TOKEN_A=$(recorded_token)
case "${TOKEN_A}" in
  arn:aws*:lambda:*:function:"${FN_A}")
    echo "    OK: Cr records HandlerA's ARN (${TOKEN_A})"
    ;;
  *)
    echo "FAIL: Cr's recorded ServiceToken is '${TOKEN_A}', expected HandlerA's ARN" >&2
    exit 1
    ;;
esac
REVISION_A1=$(revision_a)

# --- Phase 2: the diff previews the refusal ----------------------------------
echo "==> Phase 2: cdkd diff with Cr switched to HandlerB"
set +e
DIFF_OUT=$(CDKD_TEST_UPDATE=switch-token node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" 2>&1)
DIFF_RC=$?
set -e
printf '%s\n' "${DIFF_OUT}"
DIFF_TXT=$(printf '%s' "${DIFF_OUT}" | strip_ansi)
if [ "${DIFF_RC}" -ne 3 ]; then
  echo "FAIL: cdkd diff exited ${DIFF_RC}, expected 3 (the deploy would refuse)" >&2
  exit 1
fi
if ! printf '%s' "${DIFF_TXT}" | grep -qF "${CR_ID}: ServiceToken changes to arn:"; then
  echo "FAIL: cdkd diff did not name '${CR_ID}: ServiceToken changes to arn:...'" >&2
  exit 1
fi
echo "    OK: diff exits 3 with the ServiceToken row under Blocking"

# --- Phase 3: the deploy refuses at plan time --------------------------------
echo "==> Phase 3: cdkd deploy with Cr switched to HandlerB — must be refused"
ETAG_BEFORE=$(state_etag)
set +e
SWITCH_OUT=$(CDKD_TEST_UPDATE=switch-token node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
SWITCH_RC=$?
set -e
printf '%s\n' "${SWITCH_OUT}"
SWITCH_TXT=$(printf '%s' "${SWITCH_OUT}" | strip_ansi)
if [ "${SWITCH_RC}" -eq 0 ]; then
  echo "FAIL: the deploy switching Cr's ServiceToken succeeded (pre-#4749 behaviour)" >&2
  exit 1
fi
if ! printf '%s' "${SWITCH_TXT}" | grep -qF 'Modifying service token is not allowed'; then
  echo "FAIL: deploy failed (rc=${SWITCH_RC}) without the #4749 refusal" >&2
  exit 1
fi
if ! printf '%s' "${SWITCH_TXT}" | grep -qF "${CR_ID}: ServiceToken changes to arn:"; then
  echo "FAIL: the refusal does not name '${CR_ID}: ServiceToken changes to arn:...'" >&2
  exit 1
fi
ETAG_AFTER=$(state_etag)
if [ "${ETAG_BEFORE}" != "${ETAG_AFTER}" ]; then
  echo "FAIL: the refused deploy rewrote state (ETag ${ETAG_BEFORE} -> ${ETAG_AFTER})" >&2
  exit 1
fi
echo "    OK: refused with the named row, state object unchanged"
assert_no_handler_traffic "phase 3"

# --- Phase 4: a replaced backing Lambda --------------------------------------
echo "==> Phase 4: cdkd deploy with HandlerA renamed (replaced) — refused, rolled back"
ETAG_BEFORE4=$(state_etag)
set +e
RENAME_OUT=$(CDKD_TEST_UPDATE=rename-a node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
RENAME_RC=$?
set -e
printf '%s\n' "${RENAME_OUT}"
RENAME_TXT=$(printf '%s' "${RENAME_OUT}" | strip_ansi)
if [ "${RENAME_RC}" -eq 0 ]; then
  echo "FAIL: the deploy moving Cr to the renamed HandlerA succeeded (pre-#4749 behaviour)" >&2
  exit 1
fi
if ! printf '%s' "${RENAME_TXT}" | grep -qF "${CR_ID}: ServiceToken changes to arn:"; then
  echo "FAIL: deploy failed (rc=${RENAME_RC}) without the #4749 refusal naming ${CR_ID}" >&2
  exit 1
fi
echo "    OK: refused once the token resolved"
# cdkd's replacement creates the renamed function and deletes the OLD one
# before Cr is reached; the rollback then RE-CREATES the old one under its
# name. So "HandlerA exists" below means "was re-created", not "survived".
if gone_probe aws lambda get-function --function-name "${FN_A}" --region "${REGION}"; then
  echo "FAIL: HandlerA (${FN_A}) is gone after the rollback" >&2
  exit 1
fi
assert_gone "the renamed HandlerA (${FN_A_RENAMED}) survived the rollback" \
  aws lambda get-function --function-name "${FN_A_RENAMED}" --region "${REGION}"
TOKEN_AFTER_RENAME=$(recorded_token)
if [ "${TOKEN_AFTER_RENAME}" != "${TOKEN_A}" ]; then
  echo "FAIL: Cr records '${TOKEN_AFTER_RENAME}' after the refused deploy, expected ${TOKEN_A}" >&2
  exit 1
fi
echo "    OK: HandlerA restored, the renamed function gone, Cr still records HandlerA"
# The two facts only the PROVISIONING-time refusal produces: a plan-time one
# touches nothing (phase 3), while this one replaced HandlerA and rolled it back.
REVISION_A4=$(revision_a)
if [ "${REVISION_A4}" = "${REVISION_A1}" ]; then
  echo "FAIL: HandlerA's RevisionId did not change (${REVISION_A1}): the replacement never ran," >&2
  echo "    so this refusal was not the provisioning-time one" >&2
  exit 1
fi
ETAG_AFTER4=$(state_etag)
if [ "${ETAG_BEFORE4}" = "${ETAG_AFTER4}" ]; then
  echo "FAIL: state was not rewritten by the replacement and its rollback (ETag ${ETAG_AFTER4})" >&2
  exit 1
fi
echo "    OK: HandlerA was re-created (RevisionId moved) and state was rewritten"
assert_no_handler_traffic "phase 4"

# --- Phase 5: the baseline again ---------------------------------------------
echo "==> Phase 5: deploy the baseline again"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
REVISION_A5=$(revision_a)
if [ "${REVISION_A5}" != "${REVISION_A4}" ]; then
  echo "FAIL: the baseline deploy after the rollback touched HandlerA (RevisionId ${REVISION_A4} -> ${REVISION_A5})" >&2
  exit 1
fi
echo "    OK: nothing to change — HandlerA untouched"
assert_no_handler_traffic "phase 5"

# --- Phase 6: the CLEAN destroy ----------------------------------------------
echo "==> Phase 6: clean destroy (this is the run the integ-destroy gate reads)"
set +e
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY_RC=$?
set -e
printf '%s\n' "${DESTROY_OUT}"
DESTROY_TXT=$(printf '%s' "${DESTROY_OUT}" | strip_ansi)
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: the clean destroy exited ${DESTROY_RC}, expected 0" >&2
  exit 1
fi
if printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped '; then
  echo "FAIL: the clean destroy still skipped something" >&2
  exit 1
fi
# Positive control: the Delete goes to the RECORDED handler.
if ! marker_present "${FN_A}" Delete; then
  echo "FAIL: Cr's Delete did not reach HandlerA" >&2
  exit 1
fi
for rt in Create Update Delete; do
  if marker_present "${FN_B}" "${rt}"; then
    echo "FAIL: HandlerB received a ${rt} request" >&2
    exit 1
  fi
done
echo "    OK: Cr's Delete reached HandlerA only"

for fn in "${FN_A}" "${FN_A_RENAMED}" "${FN_B}"; do
  assert_gone "Lambda ${fn} still exists after the clean destroy (orphan)" \
    aws lambda get-function --function-name "${fn}" --region "${REGION}"
done
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: handlers and the state file are gone"

trap - EXIT INT TERM
sweep_markers
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
for fn in "${FN_A}" "${FN_B}"; do
  for rt in Create Delete; do
    assert_gone "marker ${MARKER_ROOT}/${fn}/${rt} survived the sweep" \
      aws ssm get-parameter --name "${MARKER_ROOT}/${fn}/${rt}" --region "${REGION}"
  done
  assert_gone "log group /aws/lambda/${fn} survived the sweep" \
    aws logs describe-log-streams --log-group-name "/aws/lambda/${fn}" --region "${REGION}"
done

echo ""
echo "[verify] PASS — custom-resource-service-token-change (#4749: diff blocks, plan-time refusal, replaced-Lambda refusal + rollback, clean destroy)"
