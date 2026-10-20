#!/usr/bin/env bash
# Integration test: the API Gateway account's CloudWatch role across destroy
# and redeploy (issue #5064, the user report behind it).
#
# `new apigateway.RestApi(..., { cloudWatchRole: true })` declares an
# `AWS::IAM::Role` and an `AWS::ApiGateway::Account`, both `DeletionPolicy:
# Retain` (CDK's default). `cdkd destroy` keeps them in AWS, as CloudFormation
# does. A released cdkd names the role `{stack}-{logicalId}`, so the next deploy
# of the same app asks IAM for the name the kept role still holds.
#
# Phases:
#   A (premise, released @go-to-k/cdkd@0.301.12): deploy, destroy (the role is
#     kept), redeploy -> FAILS on the IAM name the kept role holds.
#   B (this build): a fresh deploy, destroy (the role is kept and still exists),
#     redeploy -> succeeds: the new role's name differs from the kept one, the
#     account's cloudwatchRoleArn points at the new role, and the deploy warns
#     that it does not take the kept resources back, naming `cdkd import`.
#   C (teardown): every kept role is deleted by direct IAM calls, and the
#     account's cloudwatchRoleArn is put back to what it was before the run.
#
# The API Gateway account setting is ONE per account and region: this fixture
# must not run beside another fixture that sets it (README.md).
#
# Env:
#   STATE_BUCKET — required
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

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

. ../s3-versions.sh

REL_STACK="CdkdApigwCwRoleRel"
NEW_STACK="CdkdApigwCwRoleNew"
REGION="${AWS_REGION:-us-east-1}"
REL_PREFIX="$(s3_stack_prefix "${REL_STACK}" "${REGION}")"
NEW_PREFIX="$(s3_stack_prefix "${NEW_STACK}" "${REGION}")"
ROLE_ID="ApiCloudWatchRole73EC6FC4"

# The last released cdkd before #5064 when this fixture was written.
REL_CDKD_VERSION="0.301.12"
REL_TMPDIR=""
REL_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

STATE_FILE=""
DEPLOY_LOG=""
# The account's cloudwatchRoleArn before the run ("" = unset); "__unread__"
# until the preflight read it, so a cleanup before that touches nothing.
PREFLIGHT_ARN="__unread__"

# Every IAM role this fixture's stacks created: the two stack names followed by
# `-`. A peer run of this fixture shares them (README.md: run it solo).
fixture_roles() { # prints one role name per line — strict: a failed listing fails, never reads as none
  local names
  names="$(aws iam list-roles \
    --query "Roles[?starts_with(RoleName, '${REL_STACK}-') || starts_with(RoleName, '${NEW_STACK}-')].RoleName" \
    --output text)" || return 1
  printf '%s\n' "${names}" | tr '\t' '\n' | awk 'NF'
}
delete_role() { # <role name> — best effort: its managed and inline policies, then the role
  ( set +eu
    local p
    for p in $(aws iam list-attached-role-policies --role-name "$1" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "$1" --policy-arn "${p}" >/dev/null 2>&1
    done
    for p in $(aws iam list-role-policies --role-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "$1" --policy-name "${p}" >/dev/null 2>&1
    done
    aws iam delete-role --role-name "$1" >/dev/null 2>&1
    true )
}
# What the account is restored to: PREFLIGHT_ARN while its role still exists,
# else unset. API Gateway checks the role on update-account, and another
# fixture that set the account may have deleted its role since; an empty value
# is what cdkd's own Account delete sends (apigateway-provider.ts).
restore_target() { # prints the value — strict
  local role
  case "${PREFLIGHT_ARN}" in
    "") printf '\n'; return 0 ;;
    arn:*:role/*) role="${PREFLIGHT_ARN##*/}" ;;
    *) printf '\n'; return 0 ;;
  esac
  if gone_probe aws iam get-role --role-name "${role}"; then
    printf '\n'
  else
    printf '%s\n' "${PREFLIGHT_ARN}"
  fi
}
restore_account() { # puts the account's cloudwatchRoleArn back to restore_target
  local target
  target="$(restore_target)" || return 1
  aws apigateway update-account --region "${REGION}" --patch-operations \
    "[{\"op\":\"replace\",\"path\":\"/cloudwatchRoleArn\",\"value\":\"${target}\"}]" >/dev/null
}

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  # The fixture's two stack names, exactly: an empty or other value refuses
  # (the role sweep below lists by these names).
  case "${REL_STACK}:${NEW_STACK}" in
    CdkdApigwCwRoleRel:CdkdApigwCwRoleNew) ;;
    *)
      echo "WARN: teardown sweep refused -- stacks '${REL_STACK}' / '${NEW_STACK}' are outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  if [ -f "${LOCAL_DIST}" ]; then
    for s in "${REL_STACK}" "${NEW_STACK}"; do
      AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${s}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${s}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  # The account first, so it never points at a role deleted below.
  [ "${PREFLIGHT_ARN}" != "__unread__" ] && restore_account
  for role in $(fixture_roles 2>/dev/null); do
    delete_role "${role}"
  done
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${REL_PREFIX:-}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${NEW_PREFIX:-}" noncurrent || true
  if [ -n "${REL_TMPDIR}" ] && [ -d "${REL_TMPDIR}" ]; then
    rm -rf "${REL_TMPDIR}"
  fi
  rm -f "${STATE_FILE:-}" "${DEPLOY_LOG:-}"
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
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

# --- helpers ----------------------------------------------------------------

pass() { echo "    OK: $1"; }
fail() {
  echo "FAIL: $1" >&2
  exit 1
}
assert_eq() { # <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    fail "$1: got '$2', expected '$3'"
  fi
  pass "$1"
}
assert_ne() { # <label> <actual> <unexpected>
  if [ "$2" = "$3" ]; then
    fail "$1: got '$2', which it must not be"
  fi
  pass "$1"
}

account_role_arn() { # the account's cloudwatchRoleArn, "" when unset — strict
  local arn
  arn="$(aws apigateway get-account --region "${REGION}" --query 'cloudwatchRoleArn' --output text)" || return 1
  [ "${arn}" = "None" ] && arn=""
  printf '%s\n' "${arn}"
}
role_name_in_state() { # <stack> — the role's physical id (its name) — strict
  aws s3 cp "s3://${STATE_BUCKET}/cdkd/$1/${REGION}/state.json" "${STATE_FILE}" >/dev/null || return 1
  jq -r ".resources[\"${ROLE_ID}\"].physicalId // \"\"" "${STATE_FILE}"
}
assert_role_exists() { # <label> <role name>
  if gone_probe aws iam get-role --role-name "$2"; then
    fail "$1: role $2 is gone"
  fi
  pass "$1: role $2 still exists"
}

run_cdkd() { # <expect: ok|fail|any> <label> <binary> <stack> <args...>
  local expect="$1" label="$2" bin="$3" stack="$4" rc
  shift 4
  set +e
  ACRR_STACK="${stack}" AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${expect}" = "ok" ] && [ "${rc}" -ne 0 ]; then
    tail -60 "${DEPLOY_LOG}" >&2
    fail "${label}: exited ${rc}"
  fi
  if [ "${expect}" = "fail" ] && [ "${rc}" -eq 0 ]; then
    tail -60 "${DEPLOY_LOG}" >&2
    fail "${label}: exited 0, expected a failure"
  fi
  pass "${label}: exited ${rc} (${expect})"
}
deploy_stack() { # <expect> <label> <binary> <stack>
  run_cdkd "$1" "$2" "$3" "$4" deploy "$4" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
}
destroy_stack() { # <expect> <label> <binary> <stack>
  local expect="$1" label="$2" CDKD="$3" stack="$4"
  run_cdkd "${expect}" "${label}" "${CDKD}" "${stack}" destroy "${stack}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
}

# A line of cdkd's output, with a sentinel: <needle> must appear, and when the
# <sentinel> (an independent marker of the same message) is present without
# it, the wording drifted.
assert_log_has() { # <label> <needle> [sentinel]
  if grep -qF -- "$2" "${DEPLOY_LOG}"; then
    pass "$1: output names '$2'"
    return
  fi
  if [ -n "${3:-}" ] && grep -qF -- "$3" "${DEPLOY_LOG}"; then
    fail "$1: output carries '$3' but no longer '$2' — the message's wording drifted"
  fi
  tail -60 "${DEPLOY_LOG}" >&2
  fail "$1: output lacks '$2'"
}

# ---------------------------------------------------------------------------

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup || true

STATE_FILE="$(mktemp)"
DEPLOY_LOG="$(mktemp)"

echo "==> Preflight: the account's CloudWatch role setting"
PREFLIGHT_ARN="$(account_role_arn)" || fail "preflight: could not read the API Gateway account"
case "${PREFLIGHT_ARN}" in
  */"${REL_STACK}"-* | */"${NEW_STACK}"-*)
    # An earlier run of this fixture died before restoring it: the role it
    # names is this fixture's and was just deleted by the pre-run cleanup.
    echo "    the account names a role an earlier run of this fixture left; it is restored to unset"
    PREFLIGHT_ARN=""
    restore_account || fail "preflight: could not clear the account's role"
    ;;
esac
LEFT_ROLES="$(fixture_roles)" || fail "preflight: could not list IAM roles"
assert_eq "preflight: no role of this fixture survives an earlier run" "${LEFT_ROLES}" ""
pass "preflight: the account's cloudwatchRoleArn is '${PREFLIGHT_ARN:-<unset>}'"

echo "==> Phase A: the premise under @go-to-k/cdkd@${REL_CDKD_VERSION}"
REL_TMPDIR="$(mktemp -d)"
(cd "${REL_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${REL_CDKD_VERSION}" >/dev/null)
REL_BIN="${REL_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${REL_BIN}" ] || fail "the released binary was not installed at ${REL_BIN}"

deploy_stack ok "A1 released deploy" "${REL_BIN}" "${REL_STACK}"
A_ROLE="$(role_name_in_state "${REL_STACK}")" || fail "A1: could not read the state"
[ -n "${A_ROLE}" ] || fail "A1: state records no ${ROLE_ID}"
assert_eq "A1: the released binary names the role {stack}-{logicalId}" "${A_ROLE}" "${REL_STACK}-${ROLE_ID}"
destroy_stack ok "A2 released destroy" "${REL_BIN}" "${REL_STACK}"
assert_role_exists "A2 (DeletionPolicy: Retain)" "${A_ROLE}"
deploy_stack fail "A3 released redeploy" "${REL_BIN}" "${REL_STACK}"
assert_log_has "A3: the role's create collides with the kept role" "${A_ROLE}" "already exists"
# One line must carry both: a failure of another resource whose log also
# prints the role name is not the premise.
if ! grep -F -- "${A_ROLE}" "${DEPLOY_LOG}" | grep -qiE 'EntityAlreadyExists|already exists'; then
  tail -60 "${DEPLOY_LOG}" >&2
  fail "A3: the failure is not the IAM name collision"
fi
pass "A3: the redeploy fails on the IAM name the kept role holds (the premise holds)"
# The failed redeploy rolled its creates back; whatever record it left is
# cleared here, and the state must then be gone.
destroy_stack any "A4 released destroy after the failed redeploy" "${REL_BIN}" "${REL_STACK}"
node "${LOCAL_DIST}" state destroy "${REL_STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1 || true
assert_gone "A4: the released stack's state survived its destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${REL_STACK}/${REGION}/state.json"
pass "A4: the released stack is torn down"

echo "==> Phase B: this build"
deploy_stack ok "B1 fresh deploy" "${LOCAL_DIST}" "${NEW_STACK}"
B_ROLE1="$(role_name_in_state "${NEW_STACK}")" || fail "B1: could not read the state"
[ -n "${B_ROLE1}" ] || fail "B1: state records no ${ROLE_ID}"
case "${B_ROLE1}" in
  "${NEW_STACK}-${ROLE_ID}-"????????????) pass "B1: the role carries a generated suffix (${B_ROLE1})" ;;
  *) fail "B1: the role name '${B_ROLE1}' is not {stack}-{logicalId}-{12 hex}" ;;
esac
B_ARN1="$(account_role_arn)" || fail "B1: could not read the API Gateway account"
assert_eq "B1: the account points at the deployed role" "${B_ARN1##*/}" "${B_ROLE1}"

destroy_stack ok "B2 destroy" "${LOCAL_DIST}" "${NEW_STACK}"
assert_role_exists "B2 (DeletionPolicy: Retain)" "${B_ROLE1}"

deploy_stack ok "B3 redeploy" "${LOCAL_DIST}" "${NEW_STACK}"
assert_log_has "B3: the warning names the remedy" "adopt it with 'cdkd import'" "This deploy does not take"
B_ROLE2="$(role_name_in_state "${NEW_STACK}")" || fail "B3: could not read the state"
[ -n "${B_ROLE2}" ] || fail "B3: state records no ${ROLE_ID}"
assert_ne "B3: the new role's name differs from the kept one" "${B_ROLE2}" "${B_ROLE1}"
assert_role_exists "B3: the new role" "${B_ROLE2}"
assert_role_exists "B3: the kept role is left alone" "${B_ROLE1}"
B_ARN2="$(account_role_arn)" || fail "B3: could not read the API Gateway account"
assert_eq "B3: the account points at the new role" "${B_ARN2##*/}" "${B_ROLE2}"

destroy_stack ok "B4 destroy" "${LOCAL_DIST}" "${NEW_STACK}"

echo "==> Phase C: teardown"
C_TARGET="$(restore_target)" || fail "C: could not read whether the preflight role still exists"
restore_account || fail "C: could not restore the account's cloudwatchRoleArn"
C_ARN="$(account_role_arn)" || fail "C: could not read the API Gateway account"
assert_eq "C: the account's cloudwatchRoleArn is back to its preflight value (unset when that role is gone)" "${C_ARN}" "${C_TARGET}"
for role in "${A_ROLE}" "${B_ROLE1}" "${B_ROLE2}"; do
  delete_role "${role}"
  assert_gone "C: kept role ${role} survived its delete" aws iam get-role --role-name "${role}"
done
pass "C: every kept role is deleted"
LEFT_ROLES="$(fixture_roles)" || fail "C: could not list IAM roles"
assert_eq "C: no other role of this fixture is left" "${LEFT_ROLES}" ""

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${REL_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${NEW_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${REL_PREFIX}" "apigw-cloudwatch-role-redeploy released-stack state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${NEW_PREFIX}" "apigw-cloudwatch-role-redeploy state teardown"

echo ""
echo "==> apigw-cloudwatch-role-redeploy test passed (a released cdkd's redeploy collides with the role destroy kept; this build creates a new role, points the account at it, and names 'cdkd import' for the kept one)"
