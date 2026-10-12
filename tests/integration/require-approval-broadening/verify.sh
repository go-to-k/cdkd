#!/usr/bin/env bash
# verify.sh — `cdkd diff --fail-on=broadening` and
# `cdkd deploy --require-approval=broadening` against real AWS (issue #4601).
#
# An IAM role plus an inline policy (see lib/require-approval-broadening-stack.ts);
# cdk.json sets "requireApproval": "broadening", and every command runs with
# stdin closed (no terminal):
#   1. the first deploy creates the role (a trust policy broadens), so the
#      cdk.json level refuses it with nothing created; `--yes` then deploys it;
#   2. a Description change and a dropped statement grant nothing (a kept
#      statement reads the role's ARN through Fn::GetAtt): `--fail-on=broadening`
#      passes while `--fail-on=any-change` fails, and the deploy goes through
#      without asking;
#   3. an added `s3:PutObject` statement broadens: `--fail-on=broadening` fails
#      and prints the security table, `--fail-on=destructive` passes,
#      `--security-only` prints only that table (#4827), the
#      deploy refuses with the policy untouched, and `--require-approval=never`
#      (the flag over cdk.json) deploys it;
#   4. destroy.
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

cd "$(dirname "$0")"

STACK="CdkdRequireApprovalBroadeningExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE="cdkd-integ-4601-broadening"
POLICY="broadening-probe"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="${TMPDIR:-/tmp}/cdkd-4601-broadening.$$.log"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found; run 'vp run build' first" >&2
  exit 1
fi

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${LOG}"
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # By name, for a role a failed run left outside any state record.
  aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${POLICY}" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

cleanup
CLEANED_UP=0

# The inline policy's document as AWS holds it (the CLI URL-decodes it).
policy_document() {
  aws iam get-role-policy --role-name "${ROLE}" --policy-name "${POLICY}" \
    --query 'PolicyDocument' --output json
}

# Runs a cdkd command with stdin closed (no terminal), capturing its exit code
# into RC and its combined output into ${LOG}.
run_cdkd() {
  RC=0
  node "${LOCAL_DIST}" "$@" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    </dev/null >"${LOG}" 2>&1 || RC=$?
}

expect_rc() { # usage: expect_rc <code> <what>
  if [ "${RC}" != "$1" ]; then
    echo "FAIL: $2: expected exit $1, got ${RC}" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

expect_log() { # usage: expect_log <fixed string>
  if ! grep -qF -- "$1" "${LOG}"; then
    echo "FAIL: output lacks: $1" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

expect_no_log() { # usage: expect_no_log <fixed string>
  if grep -qF -- "$1" "${LOG}"; then
    echo "FAIL: output unexpectedly contains: $1" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

# Phase 1 is the baseline, with no CDKD_TEST_UPDATE inherited from the caller.
unset CDKD_TEST_UPDATE
REFUSAL="requires approval (--require-approval=broadening), but stdin is not interactive"

echo "==> Phase 1: creating the role broadens; cdk.json's level refuses it"
run_cdkd deploy "${STACK}"
expect_rc 1 "first deploy under cdk.json requireApproval=broadening without a terminal"
expect_log "${REFUSAL}"
expect_log "IAM Statement Changes"
expect_log "Stack includes security-sensitive updates and \"--require-approval\" is set to 'broadening'."
assert_gone "role ${ROLE} was created by a refused deploy" \
  aws iam get-role --role-name "${ROLE}"
run_cdkd deploy "${STACK}" --yes
expect_rc 0 "first deploy with --yes"
policy_document >"${LOG}"
expect_log "s3:GetObject"
expect_log "s3:ListBucket"
expect_no_log "s3:PutObject"

echo "==> Phase 2: a Description change and a dropped statement grant nothing"
CDKD_TEST_UPDATE=describe run_cdkd diff "${STACK}" --fail-on=broadening
expect_rc 0 "diff --fail-on=broadening over a Description change"
expect_no_log "broadens permissions"
CDKD_TEST_UPDATE=describe run_cdkd diff "${STACK}" --fail-on=any-change
expect_rc 1 "diff --fail-on=any-change over a Description change"
# go-to-k/cdkd#4827: --security-only counts only a broadening stack.
CDKD_TEST_UPDATE=describe run_cdkd diff "${STACK}" --security-only --fail-on=any-change
expect_rc 0 "diff --security-only --fail-on=any-change over a Description change"
expect_log "No security-broadening changes for stack ${STACK}"
# No terminal and no --yes: deploys only because nothing broadens.
CDKD_TEST_UPDATE=describe run_cdkd deploy "${STACK}"
expect_rc 0 "deploy under cdk.json broadening over a Description change"
expect_no_log "requires approval"
DESCRIPTION="$(aws iam get-role --role-name "${ROLE}" --query 'Role.Description' --output text)"
[ "${DESCRIPTION}" = "cdkd integ 4601 v2" ] || {
  echo "FAIL: role Description is '${DESCRIPTION}', not v2" >&2
  exit 1
}
policy_document >"${LOG}"
expect_no_log "s3:ListBucket"

echo "==> Phase 3: an added statement broadens"
CDKD_TEST_UPDATE=broaden run_cdkd diff "${STACK}" --fail-on=broadening
expect_rc 1 "diff --fail-on=broadening over an added statement"
expect_log "Stack ${STACK} broadens permissions (--fail-on=broadening):"
expect_log "IAM Statement Changes"
expect_log "s3:PutObject"
# The unchanged Fn::GetAtt statement is not reported as removed and re-added:
# read only the security table, which follows the marker (the ordinary diff
# above it shows the whole policy document).
if sed -n '/broadens permissions (--fail-on=broadening):/,$p' "${LOG}" | grep -qF "iam:GetRole"; then
  echo "FAIL: the security table reports the unchanged iam:GetRole statement" >&2
  cat "${LOG}" >&2
  exit 1
fi
CDKD_TEST_UPDATE=broaden run_cdkd diff "${STACK}" --fail-on=destructive
expect_rc 0 "diff --fail-on=destructive over an added statement"
CDKD_TEST_UPDATE=broaden run_cdkd diff "${STACK}" --security-only --fail-on=any-change
expect_rc 1 "diff --security-only --fail-on=any-change over an added statement"
expect_log "This deployment will make potentially sensitive changes"
expect_log "IAM Statement Changes"
expect_log "s3:PutObject"
# Only the security table: the ordinary diff's resource row is absent.
expect_no_log "AWS::IAM::Policy"
CDKD_TEST_UPDATE=broaden run_cdkd deploy "${STACK}"
expect_rc 1 "deploy under cdk.json broadening over an added statement"
expect_log "${REFUSAL}"
expect_log "IAM Statement Changes"
expect_log "s3:PutObject"
# Refused before any change.
policy_document >"${LOG}"
expect_no_log "s3:PutObject"
# The flag wins over cdk.json.
CDKD_TEST_UPDATE=broaden run_cdkd deploy "${STACK}" --require-approval=never
expect_rc 0 "deploy --require-approval=never over cdk.json broadening"
expect_no_log "requires approval"
policy_document >"${LOG}"
expect_log "s3:PutObject"

echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=broaden node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "role ${ROLE} still exists after destroy" \
  aws iam get-role --role-name "${ROLE}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${LOG}"
echo "[verify] PASS — diff --fail-on=broadening and deploy --require-approval=broadening"
