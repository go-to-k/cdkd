#!/usr/bin/env bash
# verify.sh — cdkd Lambda architecture-switch integ.
#
# Regression coverage for the bug where switching a function's architecture
# (x86_64 <-> arm64) on redeploy was silently dropped when the code was
# unchanged: Architectures rides on UpdateFunctionCode (not
# UpdateFunctionConfiguration), and cdkd only fired UpdateFunctionCode when
# the Code property changed — and never passed Architectures at all. The
# deploy reported success while AWS kept the old architecture, and the next
# diff saw no change (state recorded the new value), so it could never
# self-heal. CloudFormation / `cdk deploy` apply this in place. The fix fires
# UpdateFunctionCode with Architectures on an architecture change even when
# the code is byte-identical.
#
# Phases:
#   1. Deploy an x86_64 function. Assert AWS config AND a live invoke
#      (`process.arch` == x64).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (arm64, code unchanged). Assert
#      AWS config AND a live invoke (`process.arch` == arm64) — the switch
#      actually reached AWS, not just cdkd state.
#   3. Destroy + assert the function is gone and the cdkd state file removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdLambdaArchSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path WITHOUT a `cd` into dist/ that would fail
# cryptically (aborting the script under `set -e`) when dist/ has not been
# built yet — let the friendly `[ ! -f "${LOCAL_DIST}" ]` guard below report
# it instead. We are already in the fixture dir (cd above), which is three
# levels below the repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Gate the raw state/lock object removal on a SUCCESSFUL state destroy —
  # deleting the state file after a failed destroy would strand live AWS
  # resources with no state pointer left to destroy them from.
  local destroy_rc=1
  if [ -n "${STATE_BUCKET:-}" ] && [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # A live invoke in Phase 1/2 creates the function's log group, which
  # survives destroy — sweep it so the run leaves zero orphans.
  # Prefix sweep so a pre-run orphan from an interrupted prior run (FN
  # unknown) is caught too, not just this run's exact function.
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
      --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
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

fn_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["outputs"]["FnName"])'
}

fn_arch() {
  aws lambda get-function-configuration --function-name "$1" --region "${REGION}" \
    --query 'Architectures[0]' --output text
}

invoke_arch() {
  local out
  out="$(mktemp)"
  if ! aws lambda invoke --function-name "$1" --region "${REGION}" "${out}" >/dev/null; then
    rm -f "${out}"
    return 1
  fi
  # Handler returns process.arch as a JSON string, e.g. "x64" / "arm64".
  tr -d '"' < "${out}"
  rm -f "${out}"
}

# --- Phase 1: deploy baseline (x86_64) -----------------------------------
echo "==> Phase 1: deploy x86_64 function"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FN="$(fn_name)"
echo "    function: ${FN}"

ARCH_P1="$(fn_arch "${FN}")"
RUNTIME_ARCH_P1="$(invoke_arch "${FN}")"
echo "    AWS architecture (Phase 1): config=${ARCH_P1} runtime=${RUNTIME_ARCH_P1}"
if [ "${ARCH_P1}" != "x86_64" ] || [ "${RUNTIME_ARCH_P1}" != "x64" ]; then
  echo "FAIL: expected x86_64/x64 after Phase 1, got config='${ARCH_P1}' runtime='${RUNTIME_ARCH_P1}'" >&2
  exit 1
fi

# --- Phase 2: switch to arm64 (code unchanged; must reach AWS) ------------
echo "==> Phase 2: re-deploy as arm64 (Architectures via UpdateFunctionCode, code unchanged)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ARCH_P2="$(fn_arch "${FN}")"
RUNTIME_ARCH_P2="$(invoke_arch "${FN}")"
echo "    AWS architecture (Phase 2): config=${ARCH_P2} runtime=${RUNTIME_ARCH_P2}"
if [ "${ARCH_P2}" != "arm64" ] || [ "${RUNTIME_ARCH_P2}" != "arm64" ]; then
  echo "FAIL: expected arm64/arm64 after Phase 2 (architecture switch silently dropped?), got config='${ARCH_P2}' runtime='${RUNTIME_ARCH_P2}'" >&2
  exit 1
fi
echo "    architecture switched (reached AWS config AND runtime, not just cdkd state)"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN} still exists after destroy" >&2
  exit 1
fi
echo "    function deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Lambda architecture switch (x86_64 -> arm64) reaches AWS, all 3 phases passed"
