#!/usr/bin/env bash
# verify.sh — cdkd IAM Role sibling-policy phantom-drift integ.
#
# Regression coverage for the phantom drift where `cdkd drift` reports a false
# positive on an AWS::IAM::Role right after deploy:
#   ~ FnServiceRole (AWS::IAM::Role)
#     - Policies: [{"PolicyName":"FnServiceRoleDefaultPolicy...",...}]
#     + Policies: []
# CDK emits a construct's grants as a SEPARATE AWS::IAM::Policy (the
# `Default Policy*`) attached to the role; AWS implements that via
# `iam:PutRolePolicy`, so the inline policy shows up in `ListRolePolicies`.
# The deploy-time observedProperties capture for the role passed NO sibling
# context, so its `ListRolePolicies` read RACED the sibling's `PutRolePolicy`
# and sometimes captured the Default Policy into observedProperties.Policies.
# `cdkd drift`'s AWS-current side filters sibling-managed inline policies, so
# the baseline-vs-current mismatch surfaced as phantom drift. The fix builds a
# template-derived sibling context at capture time (deploy-order-independent)
# so the same filter runs on both sides.
#
# Phases:
#   1. Deploy a Lambda whose grant emits a service-role Default Policy + a
#      standalone role with a declared inline policy AND an addToPolicy()
#      Default Policy sibling.
#   2. Run `cdkd drift` (twice) and assert NO drift on any AWS::IAM::Role.
#   3. Destroy + assert the function / queue / role are gone and the cdkd
#      state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdIamRolePoliciesDriftCleanExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-iam-drift-clean-test-fn"
QUEUE_NAME="cdkd-iam-drift-clean-test-queue"
ROLE_NAME="cdkd-iam-drift-clean-test-role"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  QUEUE_URL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${QUEUE_URL}" ] && [ "${QUEUE_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # The standalone role keeps its inline + sibling-managed policies; delete
  # them before the role or DeleteRole 409s.
  for pn in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --region "${REGION}" \
      --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${pn}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The function's auto-created log group survives a function delete.
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy Lambda-with-grant + standalone role"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
echo "    deploy complete"

# --- Phase 2: no phantom drift on any IAM Role -------------------------
# The capture baseline must exclude the sibling-managed Default Policy, so the
# role compares clean against the (also-filtered) AWS-current snapshot. Run
# twice — the first immediately after deploy (tightest race window), the
# second after a short settle — both must be clean.
assert_no_role_drift() {
  local label="$1"
  local out
  out="$(node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
  if printf '%s' "${out}" | grep -q 'AWS::IAM::Role'; then
    echo "FAIL: cdkd drift reported phantom drift on an AWS::IAM::Role (${label}):" >&2
    printf '%s\n' "${out}" | grep -B1 -A6 'AWS::IAM::Role' >&2
    exit 1
  fi
  echo "    ${label}: no IAM Role drift"
}

echo "==> Phase 2: assert no phantom drift on any AWS::IAM::Role"
assert_no_role_drift "immediately after deploy"
assert_no_role_drift "second pass"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    function deleted"

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
echo "    standalone role deleted"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    queue deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — IAM Role with a sibling Default Policy shows no phantom drift after deploy; all 3 phases passed"
