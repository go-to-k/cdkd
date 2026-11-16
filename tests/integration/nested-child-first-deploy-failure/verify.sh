#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6396.
#
# A nested child whose FIRST deploy fails rolls back to an empty record at
# cdkd/<Parent>~<Child>/<region>/state.json (plus its rollback-journal.json),
# while the parent's AWS::CloudFormation::Stack row records no physical id.
# Before the fix `cdkd destroy <Parent>` deleted only the parent's record, so
# the child's outlived it and `cdkd state list` kept listing the child.
#
# Two parents, each run through the same phases:
#   CdkdIntegNestedChildFail       holds an SSM parameter of its own (the
#                                  destroy's main path)
#   CdkdIntegNestedChildFailEmpty  holds only the nested row (the empty-record
#                                  path)
# Phases, per parent:
#   0. (CdkdIntegNestedChildFail only) deploy the parent with its parameter and
#      no child, so the parameter survives the failed child deploy below.
#   1. `cdkd deploy` (CDKD_TEST_CHILD=true) fails: the child's SQS queue is refused
#      (MessageRetentionPeriod 59), after its SSM parameter was created.
#   2. Precondition (the leak's shape): the child's state.json exists.
#   3. `cdkd destroy` succeeds; the child's state.json and rollback journal
#      are gone, the parent's state.json is gone, both SSM parameters are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

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

REGION="${AWS_REGION:-us-east-1}"
STACKS=("CdkdIntegNestedChildFail" "CdkdIntegNestedChildFailEmpty")
CHILD_ID="ChildNestedStackChildNestedStackResourceC40294CA"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# cdkd colours its report; compare against the plain text.
strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Drop a stack's child records by key prefix: the regression this fixture
# guards leaves them behind, and a later run must start without them.
purge_child_records() { ( set +eu
  local stack="$1"
  case "${stack}" in
    CdkdIntegNestedChildFail?*|CdkdIntegNestedChildFail) ;;
    *) echo "teardown sweep refused: unexpected stack name '${stack}'" >&2; return 0 ;;
  esac
  [ -n "${STATE_BUCKET:-}" ] || return 0
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}~${CHILD_ID}/${REGION}/" --recursive --region "${REGION}" >/dev/null 2>&1
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  for stack in "${STACKS[@]}"; do
    if [ -f "${LOCAL_DIST}" ]; then
      node "${LOCAL_DIST}" destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    fi
    purge_child_records "${stack}"
    aws ssm delete-parameter --name "/cdkd-integ/${stack}/parent" --region "${REGION}" >/dev/null 2>&1
    aws ssm delete-parameter --name "/cdkd-integ/${stack}/child" --region "${REGION}" >/dev/null 2>&1
  done
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

for STACK in "${STACKS[@]}"; do
  CHILD="${STACK}~${CHILD_ID}"
  CHILD_STATE="cdkd/${CHILD}/${REGION}/state.json"
  CHILD_JOURNAL="cdkd/${CHILD}/${REGION}/rollback-journal.json"

  # --- Phase 0: the resource-holding parent deploys without the child --------
  if [ "${STACK}" = "CdkdIntegNestedChildFail" ]; then
    echo "==> [${STACK}] Phase 0: deploy the parent with its own parameter, no child yet"
    env -u CDKD_TEST_CHILD node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  fi

  # --- Phase 1: the child's first deploy fails -------------------------------
  echo "==> [${STACK}] Phase 1: deploy fails inside the nested child"
  DEPLOY_RC=0
  DEPLOY_OUT="$(CDKD_TEST_CHILD=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || DEPLOY_RC=$?
  DEPLOY_OUT="$(printf '%s\n' "${DEPLOY_OUT}" | strip_ansi)"
  if [ "${DEPLOY_RC}" -eq 0 ]; then
    printf '%s\n' "${DEPLOY_OUT}" >&2
    echo "FAIL: [${STACK}] the deploy succeeded; the child's queue should have been refused" >&2
    exit 1
  fi
  if ! grep -q 'Failed to create BadQueue' <<<"${DEPLOY_OUT}"; then
    printf '%s\n' "${DEPLOY_OUT}" >&2
    echo "FAIL: [${STACK}] the deploy failed, but not on the child's queue" >&2
    exit 1
  fi
  if ! grep -qE 'ChildParam[A-F0-9]* \(AWS::SSM::Parameter\) created' <<<"${DEPLOY_OUT}"; then
    printf '%s\n' "${DEPLOY_OUT}" >&2
    echo "FAIL: [${STACK}] the child's parameter was not created before the failure (nothing to roll back)" >&2
    exit 1
  fi

  # --- Phase 2: the leak's shape is present ------------------------------------
  echo "==> [${STACK}] Phase 2: the failed child's record exists"
  if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE}"; then
    echo "FAIL: [${STACK}] no child record at ${CHILD_STATE}: the case this fixture guards was not produced" >&2
    exit 1
  fi

  # --- Phase 3: the parent's destroy retires it ------------------------------
  echo "==> [${STACK}] Phase 3: destroy retires the child's record"
  if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/state.json"; then
    echo "FAIL: [${STACK}] no parent record before the destroy: the destroy path is not exercised" >&2
    exit 1
  fi
  DESTROY_RC=0
  DESTROY_OUT="$(CDKD_TEST_CHILD=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)" || DESTROY_RC=$?
  DESTROY_OUT="$(printf '%s\n' "${DESTROY_OUT}" | strip_ansi)"
  printf '%s\n' "${DESTROY_OUT}"
  if [ "${DESTROY_RC}" -ne 0 ]; then
    echo "FAIL: [${STACK}] cdkd destroy exited ${DESTROY_RC}" >&2
    exit 1
  fi
  # Which destroy path the parent took: the empty-record fast path for the
  # parent holding only the row, the main path for the one with a resource.
  FAST_PATH_LINE="Stack ${STACK} has no resources, cleaning up state..."
  case "${STACK}" in
    *Empty)
      grep -qF "${FAST_PATH_LINE}" <<<"${DESTROY_OUT}" || {
        echo "FAIL: [${STACK}] the destroy did not take the empty-record path (wording changed?)" >&2
        exit 1
      } ;;
    *)
      if grep -qF "${FAST_PATH_LINE}" <<<"${DESTROY_OUT}"; then
        echo "FAIL: [${STACK}] the destroy took the empty-record path; the main path is not exercised" >&2
        exit 1
      fi ;;
  esac
  assert_gone "#6396: [${STACK}] child ${CHILD_STATE} outlived the parent's destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE}"
  assert_gone "#6396: [${STACK}] child ${CHILD_JOURNAL} outlived the parent's destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_JOURNAL}"
  assert_gone "[${STACK}] parent state.json still exists after destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/state.json"
  assert_gone "[${STACK}] parent parameter still exists" \
    aws ssm get-parameter --name "/cdkd-integ/${STACK}/parent" --region "${REGION}"
  assert_gone "[${STACK}] child parameter still exists" \
    aws ssm get-parameter --name "/cdkd-integ/${STACK}/child" --region "${REGION}"
  LISTED="$(node "${LOCAL_DIST}" state list --state-bucket "${STATE_BUCKET}" 2>/dev/null | strip_ansi | grep -F "${CHILD}" || true)"
  if [ -n "${LISTED}" ]; then
    echo "FAIL: #6396: [${STACK}] cdkd state list still lists ${CHILD}" >&2
    exit 1
  fi
  echo "    [${STACK}] child record retired; nothing left"
done

trap - EXIT INT TERM
echo "PASS: nested-child-first-deploy-failure"
