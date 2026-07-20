#!/usr/bin/env bash
# verify.sh — cdkd Lambda Version + Alias provisioned concurrency integ.
# Asserts the alias provisioned-concurrency config reaches AWS, then destroys
# clean. Confirmed-clean /hunt-bugs pattern; regression guard.

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

STACK="CdkdLambdaAliasProvisionedConcurrencyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
ALIAS="live"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Provisioned-concurrency setup is async; poll for a non-empty config on the alias.
PC_OK=""
for _ in $(seq 1 24); do
  # The config 404s until the async provisioned-concurrency setup registers;
  # gone_probe treats that as "not yet" and hard-FAILs on any other error.
  if gone_probe aws lambda get-provisioned-concurrency-config --function-name "${FN}" --qualifier "${ALIAS}" --region "${REGION}"; then
    REQ=""
  elif ! REQ=$(aws lambda get-provisioned-concurrency-config --function-name "${FN}" --qualifier "${ALIAS}" --region "${REGION}" \
      --query 'RequestedProvisionedConcurrentExecutions' --output text 2>&1); then
    # TOCTOU: the config can 404 again between gone_probe and this requery --
    # a canonical not-found is still "not yet" (retry); anything else fails.
    printf '%s' "${REQ}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && REQ="" \
      || { echo "FAIL: get-provisioned-concurrency-config requery undetermined: ${REQ}" >&2; exit 1; }
  fi
  if [ "${REQ}" = "1" ]; then PC_OK=1; break; fi
  sleep 5
done
[ -z "${PC_OK}" ] && { echo "FAIL: alias '${ALIAS}' RequestedProvisionedConcurrentExecutions != 1 (silent-drop?)" >&2; exit 1; }
echo "    OK: alias provisioned concurrency == 1 on AWS"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> lambda-alias-provisioned-concurrency test passed"
