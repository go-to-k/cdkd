#!/usr/bin/env bash
# verify.sh - cdkd lambda integ (broad-set) + RecursiveLoop backfill assertion.
#
# Deploys the lambda fixture and asserts that RecursiveLoop reaches AWS
# via the dedicated PutFunctionRecursionConfig post-create API
# (LambdaFunctionProvider.create wires it after CreateFunction with
# delete-on-failure atomicity). Read-back uses the dedicated
# `aws lambda get-function-recursion-config` API. Then destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="LambdaStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the Handler function name from state (CDK auto-names it) ----
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.physicalId] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve Handler Lambda function name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved Handler function name: ${FN_NAME}"

# --- Assertion: provisionedBy == 'sdk' (RecursiveLoop now handled by SDK provider) ----
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED}" != "sdk" ]; then
  echo "FAIL: Handler Lambda has provisionedBy='${PROVISIONED}', expected 'sdk' (RecursiveLoop should NOT auto-route to CC now that the SDK provider handles it)" >&2
  exit 1
fi
echo "    OK: Handler Lambda provisionedBy == 'sdk' (RecursiveLoop is handled, no CC auto-route)"

# --- Assertion: RecursiveLoop reached AWS via PutFunctionRecursionConfig --
RECURSIVE_LOOP=$(aws lambda get-function-recursion-config \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'RecursiveLoop' --output text 2>/dev/null)
if [ "${RECURSIVE_LOOP}" != "Allow" ]; then
  echo "FAIL: Lambda RecursiveLoop is '${RECURSIVE_LOOP}', expected 'Allow' (PutFunctionRecursionConfig should have wired it)" >&2
  exit 1
fi
echo "    OK: Lambda RecursiveLoop == 'Allow' on AWS (SDK provider wired via PutFunctionRecursionConfig)"

# --- Assertion: ReservedConcurrentExecutions reached AWS via PutFunctionConcurrency --
# Same pattern as RecursiveLoop above — separate post-create control-plane
# API. Fixture sets reservedConcurrentExecutions: 5; assert the AWS-side
# response carries it via the dedicated `get-function-concurrency` API.
RESERVED_CC=$(aws lambda get-function-concurrency \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'ReservedConcurrentExecutions' --output text 2>/dev/null)
if [ "${RESERVED_CC}" != "5" ]; then
  echo "FAIL: Lambda ReservedConcurrentExecutions is '${RESERVED_CC}', expected '5' (PutFunctionConcurrency should have wired it)" >&2
  exit 1
fi
echo "    OK: Lambda ReservedConcurrentExecutions == 5 on AWS (SDK provider wired via PutFunctionConcurrency)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> lambda test passed (RecursiveLoop + ReservedConcurrentExecutions backfills verified end-to-end + clean destroy)"
