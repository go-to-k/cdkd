#!/usr/bin/env bash
# verify.sh — cdkd Lambda config-field removal reset (issue #1155) integ.
#
# `UpdateFunctionConfiguration` treats an absent field as "no change", so a
# template that drops a previously-set config field must send the CFn-default
# reset value or AWS silently keeps the old one. cdkd previously passed
# Timeout / MemorySize / Description / Environment / Layers / TracingConfig /
# EphemeralStorage straight through as `undefined` on update — the deploy
# reported success, state dropped the field, and the next diff said "No
# changes" while AWS still held the old value. This test removes five of those
# fields on UPDATE and asserts AWS reverted each to its CloudFormation default.
#
# Phases:
#   1. Deploy with Timeout 30 / MemorySize 256 / Description / env {FOO} /
#      EphemeralStorage 1024; assert all live on AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (all five fields removed). Assert
#      AWS shows the CFn defaults: Timeout 3, MemorySize 128, empty
#      Description, no env vars, EphemeralStorage 512 (a pre-fix run keeps the
#      old values).
#   3. Destroy; assert the function is gone and the state file is removed.
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

STACK="CdkdLambdaConfigFieldRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

fncfg() {
  # Print one field of the function configuration (empty if absent).
  aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
    --query "$1" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1
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
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with all five fields set --------------------------
echo "==> Phase 1: deploy with Timeout/MemorySize/Description/Environment/EphemeralStorage set"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ "$(fncfg Timeout)" != "30" ] || [ "$(fncfg MemorySize)" != "256" ] \
  || [ "$(fncfg Description)" != "before removal" ] \
  || [ "$(fncfg 'Environment.Variables.FOO')" != "bar" ] \
  || [ "$(fncfg 'EphemeralStorage.Size')" != "1024" ]; then
  echo "FAIL: Phase 1 fields not all live: Timeout=$(fncfg Timeout) MemorySize=$(fncfg MemorySize) Description='$(fncfg Description)' FOO=$(fncfg 'Environment.Variables.FOO') Eph=$(fncfg 'EphemeralStorage.Size')" >&2
  exit 1
fi
echo "    all five fields live"

# --- Phase 2: remove all five fields -----------------------------------
echo "==> Phase 2: re-deploy with all five fields removed (must reset to CFn defaults)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

T="$(fncfg Timeout)"; M="$(fncfg MemorySize)"; D="$(fncfg Description)"
F="$(fncfg 'Environment.Variables.FOO')"; E="$(fncfg 'EphemeralStorage.Size')"
if [ "${T}" != "3" ]; then
  echo "FAIL: Timeout not reset to 3 after removal (got '${T}')" >&2; exit 1
fi
if [ "${M}" != "128" ]; then
  echo "FAIL: MemorySize not reset to 128 after removal (got '${M}')" >&2; exit 1
fi
if [ "${D}" != "" ] && [ "${D}" != "None" ]; then
  echo "FAIL: Description not cleared after removal (got '${D}')" >&2; exit 1
fi
if [ "${F}" = "bar" ]; then
  echo "FAIL: Environment.Variables.FOO still present after removal" >&2; exit 1
fi
if [ "${E}" != "512" ]; then
  echo "FAIL: EphemeralStorage not reset to 512 after removal (got '${E}')" >&2; exit 1
fi
echo "    all five fields reset to CFn defaults"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
echo "    function deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Lambda config-field removal reset (issue #1155), all 3 phases passed"
