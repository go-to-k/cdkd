#!/usr/bin/env bash
# verify.sh — a custom resource whose Update answers a NEW PhysicalResourceId
# gets a Delete for the OLD id, with the OLD properties, once the deploy
# succeeds, as CloudFormation's cleanup phase sends it (go-to-k/cdkd#6117).
#
# Before #6117 cdkd logged "Resource Res was replaced: name-1 -> name-2" and
# never sent the old id a Delete, so whatever the handler made under it was
# orphaned; `cdkd destroy` later deleted only the new id.
#
# The handler (`lib/cr-physid-replace-stack.ts`) writes
# `/cdkd-integ/<stack>/res/<physical id>` on Create / Update, deletes it on
# Delete, and records each Delete as `/cdkd-integ/<stack>/deleted/<physical id>`
# holding the `Name` its ResourceProperties carried.
#
# PHASES.
#   1. Deploy (Name = <stack>-name-1). PREMISE: res/name-1 exists, no Delete yet.
#   2. Redeploy with Name = <stack>-name-2. cdkd reports the replacement; the
#      old id got a Delete carrying the OLD Name; res/name-1 is gone and
#      res/name-2 exists; state records name-2 and no pending old id.
#   3. Clean destroy: name-2 gets its Delete; both res/ parameters are gone.
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

STACK="CdkdCrPhysidReplace"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Must match `lib/cr-physid-replace-stack.ts`.
CR_ID="Res"
FN_ON_EVENT="${STACK}-on-event"
ROOT="/cdkd-integ/${STACK}"
NAME_1="${STACK}-name-1"
NAME_2="${STACK}-name-2"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Lambda creates `/aws/lambda/<function>` on first invoke and nothing in the
# stack owns it (#3885); the handler and the provider framework's function are
# both named `<stack>-...`.
. ../cr-log-groups.sh

# The parameters the handler writes are not stack resources. Best-effort:
# never fails its caller.
sweep_params() {
  (
    set +eu
    names=$(aws ssm get-parameters-by-path --path "${ROOT}" --recursive \
      --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null)
    for name in ${names}; do
      case "${name}" in
        "${ROOT}/"?*) ;;
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
      CdkdCrPhysidReplace) ;;
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

# The provider framework's auto-named function (`<stack>-<logicalId>-<hash>`),
# left behind when a failed run's `state destroy` did not finish. Same guard.
sweep_stack_functions() {
  (
    set +eu
    case "${STACK}" in
      CdkdCrPhysidReplace) ;;
      *)
        echo "    WARN: teardown sweep refused a stack scope outside this fixture: '${STACK:-<empty>}'" >&2
        exit 0
        ;;
    esac
    fns=$(aws lambda list-functions --region "${REGION}" \
      --query "Functions[?starts_with(FunctionName, '${STACK}-')].FunctionName" --output text 2>/dev/null) || exit 0
    for fn in ${fns}; do
      case "${fn}" in
        "${STACK}-"?*) ;;
        *) continue ;;
      esac
      aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

# Safe to run pre-run: every line targets something a phase re-creates.
cleanup() {
  echo "==> Cleanup: dropping any leftover stack resources, parameters and state"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  sweep_stack_functions
  sweep_params
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

# param_present <path under ROOT>: 0 when it exists, 1 when it does not;
# hard-FAILs on an undetermined read.
param_present() {
  if gone_probe aws ssm get-parameter --name "${ROOT}/$1" --region "${REGION}"; then
    return 1
  fi
  return 0
}

param_value() {
  aws ssm get-parameter --name "${ROOT}/$1" --region "${REGION}" \
    --query Parameter.Value --output text
}

state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null
}

strip_ansi() {
  sed $'s/\033\[[0-9;]*m//g'
}

# --- Phase 1: baseline -------------------------------------------------------
echo "==> Phase 1: deploy (Name = ${NAME_1})"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! param_present "res/${NAME_1}"; then
  echo "FAIL: PREMISE not met — the handler did not write res/${NAME_1} (the parameters prove nothing)" >&2
  exit 1
fi
if param_present "deleted/${NAME_1}"; then
  echo "FAIL: PREMISE not met — ${NAME_1} already got a Delete" >&2
  exit 1
fi
RECORDED_1=$(state_json | jq -r --arg id "${CR_ID}" '.resources[$id].physicalId')
if [ "${RECORDED_1}" != "${NAME_1}" ]; then
  echo "FAIL: PREMISE not met — ${CR_ID} records '${RECORDED_1}', expected ${NAME_1}" >&2
  exit 1
fi
echo "    OK: PREMISE — res/${NAME_1} written, ${CR_ID} records ${NAME_1}"

# --- Phase 2: the Update answers a new id ------------------------------------
echo "==> Phase 2: redeploy (Name = ${NAME_2}) — the Update answers a new physical id"
set +e
UPDATE_OUT=$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
UPDATE_RC=$?
set -e
printf '%s\n' "${UPDATE_OUT}"
UPDATE_TXT=$(printf '%s' "${UPDATE_OUT}" | strip_ansi)
if [ "${UPDATE_RC}" -ne 0 ]; then
  echo "FAIL: the redeploy exited ${UPDATE_RC}, expected 0" >&2
  exit 1
fi
if ! grep -qF "Resource ${CR_ID} was replaced: ${NAME_1} -> ${NAME_2}" <<<"${UPDATE_TXT}"; then
  echo "FAIL: PREMISE not met — cdkd did not report ${CR_ID} replaced ${NAME_1} -> ${NAME_2}" >&2
  exit 1
fi
echo "    OK: PREMISE — the Update answered ${NAME_2}"

# The #6117 assertion: the OLD id got its Delete (pre-fix: never sent).
if ! param_present "deleted/${NAME_1}"; then
  echo "FAIL (#6117): the old physical id ${NAME_1} never got a Delete" >&2
  exit 1
fi
DELETED_WITH=$(param_value "deleted/${NAME_1}")
if [ "${DELETED_WITH}" != "${NAME_1}" ]; then
  echo "FAIL (#6117): the Delete of ${NAME_1} carried Name '${DELETED_WITH}', expected the OLD properties (${NAME_1})" >&2
  exit 1
fi
assert_gone "res/${NAME_1} survived the cleanup Delete (#6117 orphan)" \
  aws ssm get-parameter --name "${ROOT}/res/${NAME_1}" --region "${REGION}"
if ! param_present "res/${NAME_2}"; then
  echo "FAIL: res/${NAME_2} does not exist after the Update" >&2
  exit 1
fi
if param_present "deleted/${NAME_2}"; then
  echo "FAIL: the NEW id ${NAME_2} got a Delete" >&2
  exit 1
fi
echo "    OK: ${NAME_1} got a Delete with the old properties; res/${NAME_1} gone, res/${NAME_2} live"

STATE_2=$(state_json)
RECORDED_2=$(printf '%s' "${STATE_2}" | jq -r --arg id "${CR_ID}" '.resources[$id].physicalId')
PENDING_2=$(printf '%s' "${STATE_2}" | jq -r '(.supersededResources // []) | length')
if [ "${RECORDED_2}" != "${NAME_2}" ]; then
  echo "FAIL: ${CR_ID} records '${RECORDED_2}' after the Update, expected ${NAME_2}" >&2
  exit 1
fi
if [ "${PENDING_2}" != "0" ]; then
  echo "FAIL: state still lists ${PENDING_2} superseded resource(s) after a successful cleanup" >&2
  exit 1
fi
echo "    OK: state records ${NAME_2} and no pending old id"

# --- Phase 3: the CLEAN destroy ----------------------------------------------
echo "==> Phase 3: clean destroy (this is the run the integ-destroy gate reads)"
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
if grep -q 'Destroy skipped ' <<<"${DESTROY_TXT}"; then
  echo "FAIL: the clean destroy still skipped something" >&2
  exit 1
fi
if ! param_present "deleted/${NAME_2}"; then
  echo "FAIL: ${NAME_2} did not get its Delete from the destroy" >&2
  exit 1
fi
for name in "${NAME_1}" "${NAME_2}"; do
  assert_gone "res/${name} still exists after the clean destroy (orphan)" \
    aws ssm get-parameter --name "${ROOT}/res/${name}" --region "${REGION}"
done
assert_gone "Lambda ${FN_ON_EVENT} still exists after the clean destroy (orphan)" \
  aws lambda get-function --function-name "${FN_ON_EVENT}" --region "${REGION}"
LEFT_FNS=$(aws lambda list-functions --region "${REGION}" \
  --query "Functions[?starts_with(FunctionName, '${STACK}-')].FunctionName" --output text)
if [ -n "${LEFT_FNS}" ]; then
  echo "FAIL: functions still exist after the clean destroy (orphan): ${LEFT_FNS}" >&2
  exit 1
fi
LEFT_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text)
if [ -n "${LEFT_ROLES}" ]; then
  echo "FAIL: IAM roles still exist after the clean destroy (orphan): ${LEFT_ROLES}" >&2
  exit 1
fi
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: both ids got their Delete; functions, roles, parameters and the state file are gone"

trap - EXIT INT TERM
sweep_params
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
for name in "${NAME_1}" "${NAME_2}"; do
  assert_gone "marker ${ROOT}/deleted/${name} survived the sweep" \
    aws ssm get-parameter --name "${ROOT}/deleted/${name}" --region "${REGION}"
done
assert_gone "log group /aws/lambda/${FN_ON_EVENT} survived the sweep" \
  aws logs describe-log-streams --log-group-name "/aws/lambda/${FN_ON_EVENT}" --region "${REGION}"
# The provider framework's function is auto-named `<stack>-...` too.
LEFT_GROUPS=$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}-" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text)
if [ -n "${LEFT_GROUPS}" ]; then
  echo "FAIL: log groups survived the sweep: ${LEFT_GROUPS}" >&2
  exit 1
fi

echo ""
echo "[verify] PASS — custom-resource-physid-replace (#6117: the old physical id gets a Delete with the old properties after the Update; clean destroy)"
