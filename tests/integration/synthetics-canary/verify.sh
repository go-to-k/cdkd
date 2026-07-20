#!/usr/bin/env bash
# verify.sh — cdkd Synthetics Canary (CC-API) integ.
# Regression guard for the failed-create remnant cleanup: the canary create
# materializes the entity before stabilizing it, and the IAM-propagation race
# routinely fails the first attempt — without the cleanup every retry dies
# with AlreadyExists and the ERROR canary orphans. Deploy succeeding at all
# exercises the fix whenever the race fires (it did on both /hunt-bugs runs).
# Phases: deploy -> assert canary -> UPDATE (schedule) -> destroy -> orphan sweep.

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

STACK="CdkdSyntheticsCanaryExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CANARY="cdkd-integ-canary"
BUCKET="$(echo "${STACK}" | tr '[:upper:]' '[:lower:]')-artifacts"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_canary_backend() {
  # Synthetics provisions a backing Lambda (cwsyn-<name>-<uuid>) + log group.
  # The CC delete handler removes them on the happy path; sweep defensively
  # for interrupted runs.
  for fn in $(aws lambda list-functions --region "${REGION}" \
    --query "Functions[?starts_with(FunctionName,'cwsyn-${CANARY}')].FunctionName" --output text 2>/dev/null); do
    aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for lg in $(aws logs describe-log-groups --region "${REGION}" \
    --log-group-name-prefix "/aws/lambda/cwsyn-${CANARY}" \
    --query "logGroups[].logGroupName" --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws synthetics delete-canary --name "${CANARY}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rb "s3://${BUCKET}" --force >/dev/null 2>&1 || true
  sweep_canary_backend
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Deploy (base: rate(30 minutes))"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE=$(aws synthetics get-canary --name "${CANARY}" --region "${REGION}" \
  --query 'Canary.Status.State' --output text 2>/dev/null || true)
if [ "${STATE}" != "READY" ] && [ "${STATE}" != "STOPPED" ]; then
  echo "FAIL: canary state is '${STATE}', expected READY/STOPPED" >&2
  exit 1
fi
EXPR=$(aws synthetics get-canary --name "${CANARY}" --region "${REGION}" \
  --query 'Canary.Schedule.Expression' --output text)
[ "${EXPR}" = "rate(30 minutes)" ] || { echo "FAIL: base schedule is '${EXPR}'" >&2; exit 1; }
echo "    OK: canary reached AWS (State: ${STATE}, Schedule: ${EXPR})"

echo "==> UPDATE (schedule -> rate(1 hour))"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EXPR=$(aws synthetics get-canary --name "${CANARY}" --region "${REGION}" \
  --query 'Canary.Schedule.Expression' --output text)
[ "${EXPR}" = "rate(1 hour)" ] || { echo "FAIL: updated schedule is '${EXPR}'" >&2; exit 1; }
echo "    OK: in-place UPDATE reached AWS (Schedule: ${EXPR})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "canary still exists after destroy" aws synthetics get-canary --name "${CANARY}" --region "${REGION}"
echo "    OK: canary gone"
LEFT=$(aws lambda list-functions --region "${REGION}" \
  --query "Functions[?starts_with(FunctionName,'cwsyn-${CANARY}')].FunctionName" --output text)
[ -n "${LEFT}" ] && { echo "FAIL: backing lambda remains: ${LEFT}" >&2; exit 1; }
echo "    OK: no cwsyn-* backing lambda remains"
assert_gone "artifacts bucket remains" aws s3api head-bucket --bucket "${BUCKET}"
echo "    OK: artifacts bucket gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> synthetics-canary test passed"
