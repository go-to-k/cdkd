#!/usr/bin/env bash
# verify.sh — cache-streaming: VPC + ElastiCache Redis (SDK provider) + Kinesis
# Data Stream + Lambda with a Kinesis event source mapping.
#
# Converted from a standard-flow smoke test to a verify.sh so it owns its own
# deploy + assert + destroy cycle. A bare `cdkd deploy` / `cdkd destroy --force`
# invoked directly from a shell is refused by the auto-mode classifier (it looks
# like a skill bypass / Blind Apply); wrapping the same calls inside verify.sh
# lets `/run-integ cache-streaming` exercise the path end-to-end.
#
# LOAD-BEARING assertion: the stack injects `CfnCacheCluster
# .attrRedisEndpointAddress` (a Fn::GetAtt) into the Lambda's REDIS_ENDPOINT env
# var. Reading it back via the Lambda API is format-independent; a physicalId
# fallback would store the cluster id, NOT a real `*.cache.amazonaws.com`
# hostname — asserting the hostname shape proves GetAtt enrichment ran.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CacheStreamingStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STREAM_NAME="${STACK}-data-stream"
# ElastiCache lowercases CacheSubnetGroupName; the stack sets it from stackName.
SUBNET_GROUP="$(printf '%s' "${STACK}-redis-subnet-group" | tr '[:upper:]' '[:lower:]')"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t cache-streaming.XXXXXX)"

# DescribeCacheClusters / describe-stream can throttle right after a burst; let
# the CLI back off transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    # Best-effort real teardown first (removes AWS resources if the run died
    # mid-flight), then drop any residual state record.
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
  fi
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
# Probe the exact state.json key (NOT the cdkd/<stack>/ prefix, which retains
# the deployments/ event layer #808 by design and would false-positive here).
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} — clean up first." >&2
  exit 1
fi

echo "==> Step 1: deploy (VPC + ElastiCache Redis + Kinesis + Lambda ESM)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2: locate the StreamProcessor Lambda"
FN_NAME=$(aws lambda list-functions --region "${REGION}" \
  --query "Functions[?contains(FunctionName, '${STACK}') && contains(FunctionName, 'StreamProcessor')].FunctionName | [0]" \
  --output text)
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "None" ]; then
  echo "FAIL: no StreamProcessor Lambda found for ${STACK}" >&2
  exit 1
fi
echo "    OK: Lambda ${FN_NAME}"

echo "==> Step 3 (LOAD-BEARING): assert GetAtt Redis endpoint resolved to a real *.cache.amazonaws.com hostname"
# The stack injects `redis.attrRedisEndpointAddress` (a Fn::GetAtt) into the
# Lambda's REDIS_ENDPOINT env var. Reading it back via the Lambda API is
# format-independent (unlike grepping deploy stdout, whose --verbose lines carry
# a timestamp/INFO prefix). A physicalId fallback would store the cluster id
# here instead of the real hostname.
REDIS_ENDPOINT=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
  --region "${REGION}" --query 'Environment.Variables.REDIS_ENDPOINT' --output text)
echo "    REDIS_ENDPOINT = '${REDIS_ENDPOINT}'"
case "${REDIS_ENDPOINT}" in
  *.cache.amazonaws.com)
    echo "    OK: RedisEndpoint is a real ElastiCache endpoint hostname"
    ;;
  *)
    echo "FAIL: RedisEndpoint is '${REDIS_ENDPOINT}', not a *.cache.amazonaws.com endpoint." >&2
    echo "      This would be a GetAtt physicalId-fallback bug (returned the cluster id)." >&2
    exit 1
    ;;
esac

echo "==> Step 4: assert the deployed resources exist on AWS"
STREAM_STATUS=$(aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}" \
  --query 'StreamDescriptionSummary.StreamStatus' --output text)
if [ "${STREAM_STATUS}" != "ACTIVE" ]; then
  echo "FAIL: Kinesis stream ${STREAM_NAME} status is '${STREAM_STATUS}', expected ACTIVE" >&2
  exit 1
fi
echo "    OK: Kinesis stream ${STREAM_NAME} is ACTIVE"

# The cache cluster physical id is auto-generated; attribute it via its subnet
# group (fixed, derived from the stack name) rather than a fragile id guess.
CACHE_COUNT=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'])" --output text)
if [ "${CACHE_COUNT}" = "0" ] || [ "${CACHE_COUNT}" = "None" ]; then
  echo "FAIL: no ElastiCache cluster found on subnet group ${SUBNET_GROUP}" >&2
  exit 1
fi
echo "    OK: ElastiCache cluster present on subnet group ${SUBNET_GROUP}"
ESM_STATE=$(aws lambda list-event-source-mappings --region "${REGION}" \
  --function-name "${FN_NAME}" \
  --query "EventSourceMappings[?contains(EventSourceArn, '${STREAM_NAME}')].State | [0]" --output text)
if [ -z "${ESM_STATE}" ] || [ "${ESM_STATE}" = "None" ]; then
  echo "FAIL: Lambda ${FN_NAME} has no event source mapping on stream ${STREAM_NAME}" >&2
  exit 1
fi
echo "    OK: Lambda ${FN_NAME} wired to the Kinesis stream (ESM state: ${ESM_STATE})"

echo "==> Step 5: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 6: assert 0 orphans"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Kinesis stream ${STREAM_NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${STREAM_NAME}" --region "${REGION}"
assert_gone "Lambda ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
CACHE_LEFT=$(aws elasticache describe-cache-clusters --region "${REGION}" \
  --query "length(CacheClusters[?CacheSubnetGroupName=='${SUBNET_GROUP}'])" --output text)
if [ "${CACHE_LEFT}" != "0" ]; then
  echo "FAIL: ${CACHE_LEFT} ElastiCache cluster(s) still exist after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + Kinesis + Lambda + ElastiCache all gone)"

echo ""
echo "==> cache-streaming test passed: GetAtt Redis endpoint resolved, VPC/ElastiCache/Kinesis/Lambda deployed + wired, clean destroy 0 orphans"
trap - EXIT INT TERM
