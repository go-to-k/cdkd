#!/usr/bin/env bash
# verify.sh — DeletionPolicy: Retain skip-on-destroy integ test.
#
# Closes the scenario-coverage matrix orphan for `deletion-policy-retain`
# (Issue #423 follow-up). Verifies end-to-end:
#
#   1. cdkd deploy creates both SSM Parameters on AWS.
#   2. cdkd destroy --force SKIPS the RemovalPolicy.RETAIN resource and
#      DELETES the RemovalPolicy.DESTROY resource.
#   3. cdkd state is cleared after destroy (state.json gone).
#   4. The Retain resource is manually deleted at end-of-test so the
#      fixture leaves AWS clean.
#
# Run via: /run-integ deletion-policy-retain
#         or: bash tests/integration/deletion-policy-retain/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="CdkdDeletionPolicyRetainExample"
RETAIN_PARAM="/cdkd-integ/deletion-policy-retain/retain"
DESTROY_PARAM="/cdkd-integ/deletion-policy-retain/destroy"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"

# Cleanup must:
#  - destroy any leftover state from a failed run (so re-runs work);
#  - delete the intentionally-Retain SSM Parameter so AWS stays clean;
#  - tolerate errors (e.g. parameter already gone from a clean exit).
cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  aws ssm delete-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --region "${AWS_REGION}" --name "${DESTROY_PARAM}" >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo ""
echo "==> Pre-flight: stale state / SSM Parameter check"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: stack state already exists at ${STATE_KEY} — clean up first."
  exit 1
}
aws ssm get-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}" >/dev/null 2>&1 && {
  echo "FAIL: ${RETAIN_PARAM} already exists in SSM — clean up first."
  exit 1
} || true
aws ssm get-parameter --region "${AWS_REGION}" --name "${DESTROY_PARAM}" >/dev/null 2>&1 && {
  echo "FAIL: ${DESTROY_PARAM} already exists in SSM — clean up first."
  exit 1
} || true
echo "    no stale state or SSM parameters (✓)"

echo ""
echo "==> Step 1: Deploy stack"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Step 1a: Verify both SSM Parameters exist on AWS"
RETAIN_VALUE=$(aws ssm get-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}" --query 'Parameter.Value' --output text)
DESTROY_VALUE=$(aws ssm get-parameter --region "${AWS_REGION}" --name "${DESTROY_PARAM}" --query 'Parameter.Value' --output text)
if [[ "${RETAIN_VALUE}" != "this-parameter-must-survive-cdkd-destroy" ]]; then
  echo "FAIL: retain param has unexpected value: ${RETAIN_VALUE}"
  exit 1
fi
if [[ "${DESTROY_VALUE}" != "this-parameter-must-be-deleted-on-cdkd-destroy" ]]; then
  echo "FAIL: destroy param has unexpected value: ${DESTROY_VALUE}"
  exit 1
fi
echo "    both SSM Parameters present with expected values (✓)"

echo ""
echo "==> Step 2: cdkd destroy ${STACK} --force"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Step 2a: Verify Retain resource SURVIVED destroy"
set +e
SURVIVED_VALUE=$(aws ssm get-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}" --query 'Parameter.Value' --output text 2>&1)
SURVIVED_RC=$?
set -e
if [[ "${SURVIVED_RC}" -ne 0 ]]; then
  echo "FAIL: retain param was DELETED by cdkd destroy (DeletionPolicy: Retain not honored)"
  echo "${SURVIVED_VALUE}"
  exit 1
fi
if [[ "${SURVIVED_VALUE}" != "this-parameter-must-survive-cdkd-destroy" ]]; then
  echo "FAIL: retain param survived but with unexpected value: ${SURVIVED_VALUE}"
  exit 1
fi
echo "    retain param survived (✓) — DeletionPolicy: Retain honored"

echo ""
echo "==> Step 2b: Verify Destroy resource was DELETED"
set +e
DELETED_OUT=$(aws ssm get-parameter --region "${AWS_REGION}" --name "${DESTROY_PARAM}" 2>&1)
DELETED_RC=$?
set -e
if [[ "${DELETED_RC}" -eq 0 ]]; then
  echo "FAIL: destroy param was NOT deleted by cdkd destroy"
  echo "${DELETED_OUT}"
  exit 1
fi
if ! echo "${DELETED_OUT}" | grep -q -E "ParameterNotFound|not.*found"; then
  echo "FAIL: get-parameter failed but with unexpected error shape:"
  echo "${DELETED_OUT}"
  exit 1
fi
echo "    destroy param gone (ParameterNotFound) (✓)"

echo ""
echo "==> Step 3: Verify cdkd state cleared"
assert_gone "cdkd state still exists at ${STATE_KEY} after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state cleared (✓)"

echo ""
echo "==> Step 4: Manually delete the Retain-policy resource (it survived by design)"
aws ssm delete-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}"
set +e
aws ssm get-parameter --region "${AWS_REGION}" --name "${RETAIN_PARAM}" >/dev/null 2>&1
POST_CLEAN_RC=$?
set -e
if [[ "${POST_CLEAN_RC}" -eq 0 ]]; then
  echo "FAIL: retain param still exists after manual cleanup"
  exit 1
fi
echo "    retain param manually deleted, AWS clean (✓)"

echo ""
echo "==> All deletion-policy-retain checks passed"
trap - EXIT INT TERM
