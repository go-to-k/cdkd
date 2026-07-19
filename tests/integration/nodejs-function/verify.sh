#!/usr/bin/env bash
# verify.sh — cdkd NodejsFunction (esbuild-bundled TS Lambda) functional integ.
#
# NodejsFunction runs esbuild at synth time to bundle a TS entry into one JS
# file; cdkd must publish that bundled asset and wire Code.S3Bucket/S3Key. No
# existing fixture covers it (others use inline code or pre-built directories).
# This test invokes the function and asserts the bundled handler ran (returns the
# expected body) — proving the esbuild output + asset publish reached AWS.
#
# Phases:
#   1. Deploy. Resolve the function name from the stack output.
#   2. Functional: invoke the function, assert HTTP 200 + the expected body.
#   3. Destroy + assert the function and the cdkd state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdNodejsFunctionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

FUNCTION_NAME=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FUNCTION_NAME="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.FunctionName')"
if [ -z "${FUNCTION_NAME}" ] || [ "${FUNCTION_NAME}" = "null" ]; then
  echo "FAIL: could not resolve FunctionName output after deploy" >&2
  exit 1
fi
echo "    function: ${FUNCTION_NAME}"

# --- Phase 2: functional — invoke, assert the bundled handler ran -----
echo "==> Phase 2: invoke and assert the bundled handler ran"
STATUS="$(aws lambda invoke --function-name "${FUNCTION_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out /tmp/cdkd-nodejs-out.json --query 'StatusCode' --output text)"
if [ "${STATUS}" != "200" ]; then
  echo "FAIL: invoke returned StatusCode ${STATUS}, expected 200" >&2
  exit 1
fi
BODY="$(cat /tmp/cdkd-nodejs-out.json 2>/dev/null || echo "")"
if ! echo "${BODY}" | grep -q "hello cdkd from nodejs-function"; then
  echo "FAIL: invoke response missing expected body; got: ${BODY}" >&2
  exit 1
fi
echo "    OK: bundled handler ran (response body matches)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FUNCTION_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: function is gone"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — NodejsFunction esbuild bundle invoked successfully, all 3 phases passed"
