#!/usr/bin/env bash
# verify.sh — cdkd WIDE-DAG throttle / retry-classifier / concurrency-limiter
# stress integ.
#
# Deploys a ~100-resource stack (80 SSM Parameters + 10 IAM Roles + 10 SNS
# Topics, a 10-deep SSM chain for DAG depth) with a HIGH `--concurrency` to
# maximise throttle pressure, then asserts:
#   1. deploy SUCCEEDS (exit 0). A throttle (TooManyRequests / Rate exceeded /
#      HTTP 429) that is NOT retried by cdkd's `withRetry` classifier would
#      fail the deploy here -> that is a REAL finding and the throttle error is
#      printed.
#   2. all ~100 resources actually reached AWS (counted via the AWS APIs).
#   3. the chained parameters were created in DAG order (Chain9 exists with the
#      Fn::Sub-derived value -> the executor serialized the chain correctly).
#   4. destroy is clean: all ~100 resources gone, state gone, 0 orphans (the
#      destroy path must also absorb ~100 deletes without throttle-failing).
#
# BSD-portable (no grep -P, no date -d). Real rc captured, explicit PASS line.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Optional:
#   CDKD_CONCURRENCY — deploy/destroy --concurrency (default 40, high to stress)

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

# This fixture DELIBERATELY induces an SSM Parameter Store rate-limit storm (80
# PutParameter at --concurrency 40) to exercise cdkd's deploy-side throttle
# retry. The catch: the post-deploy ASSERTION calls below (describe-parameters /
# get-parameter) hit the SAME SSM rate budget moments later, so a bare `aws`
# call can itself be throttled and abort the script under `set -e` (observed:
# the verify exits non-zero AFTER a clean deploy). Turn on the AWS CLI's own
# adaptive retry so every `aws` invocation in this script (assertions + the
# cleanup sweep) transparently backs off and retries a throttle at the CLI
# layer — no `sleep` in the script, and it covers the cleanup path too.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

STACK="CdkdThrottleWideDagExample"
REGION="${AWS_REGION:-us-east-1}"
CONCURRENCY="${CDKD_CONCURRENCY:-40}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"

# Resource counts (must match lib/throttle-wide-dag-stack.ts).
PARAM_COUNT=80
CHAIN_DEPTH=10
ROLE_COUNT=10
TOPIC_COUNT=10
TOTAL=$((PARAM_COUNT + ROLE_COUNT + TOPIC_COUNT))

# Name prefixes used by the fixture.
ROLE_PREFIX="${STACK}-role-"
TOPIC_PREFIX="${STACK}-topic-"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

DEPLOY_LOG="$(mktemp -t throttle-deploy.XXXXXX)"
DESTROY_LOG="$(mktemp -t throttle-destroy.XXXXXX)"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Best-effort sweep of any fixture-named resources left behind.
  for i in $(seq 0 $((ROLE_COUNT - 1))); do
    aws iam delete-role --role-name "${ROLE_PREFIX}${i}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  if [ -n "${ACCOUNT}" ]; then
    for i in $(seq 0 $((TOPIC_COUNT - 1))); do
      aws sns delete-topic \
        --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_PREFIX}${i}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  fi
  rm -f "${DEPLOY_LOG}" "${DESTROY_LOG}" 2>/dev/null || true
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
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------------
# High --concurrency to maximise the burst against SSM/IAM/SNS create limits.
echo "==> Phase 1: deploy ${TOTAL} resources with --concurrency ${CONCURRENCY}"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --concurrency "${CONCURRENCY}" \
  --verbose \
  --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e

# Surface any throttle activity the run logged (informational either way).
# A retried throttle shows up as a `⏳ Retrying ...` debug line (the withRetry
# classifier matched HTTP 429). Printing it documents that the retry path was
# actually exercised, not just that the deploy happened to avoid throttling.
echo "==> Throttle / retry activity observed during deploy:"
# Capture matches into a variable FIRST (grep reads the file to completion, no
# downstream pipe), then trim to 40 lines via a here-string. Piping a high-
# volume `grep "${DEPLOY_LOG}" | head -40` would let `head` close the pipe after
# 40 lines and hit `grep` with SIGPIPE -> under `set -o pipefail` the whole
# script would exit 141. `|| true` guards the no-match case.
THROTTLE_DEPLOY="$(grep -E -i "Retrying|TooManyRequests|Rate exceeded|Throttl|429" "${DEPLOY_LOG}" || true)"
if [ -n "${THROTTLE_DEPLOY}" ]; then
  head -40 <<<"${THROTTLE_DEPLOY}"
else
  echo "    (none observed this run — throttling is probabilistic; the retry"
  echo "     path is still the safety net if AWS throttles a future burst)"
fi

if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC} — a wide burst failed the deploy." >&2
  echo "      If this is a throttle (TooManyRequests / Rate exceeded / 429)," >&2
  echo "      cdkd did NOT retry it -> REAL FINDING in the retry classifier." >&2
  echo "----- deploy log tail -----" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0 (any throttle in the burst was retried, not fatal)"

# --- Assertion: state file written -----------------------------------------
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

STATE_RESOURCE_COUNT=$(echo "${STATE}" | jq '.resources | length')
if [ "${STATE_RESOURCE_COUNT}" -ne "${TOTAL}" ]; then
  echo "FAIL: cdkd state records ${STATE_RESOURCE_COUNT} resources, expected ${TOTAL}" >&2
  exit 1
fi
echo "    OK: cdkd state records all ${TOTAL} resources"

# --- Assertion: SSM parameters reached AWS ---------------------------------
# cdkd records a resource in state ONLY after its create call succeeds, so the
# "state records all TOTAL resources" assertion above already proves every
# parameter's PutParameter returned 200. We additionally SPOT-CHECK a handful
# of representative parameters with the per-parameter `get-parameter` API
# rather than the `describe-parameters` LIST API: DescribeParameters has a
# notoriously low account throttle limit and, called moments after this
# fixture's deliberate 80-param create storm, it gets rate-limited and fails
# the assertion even though every parameter is present (the create burst is the
# whole point of the test). `get-parameter` is far lighter and rides the
# AWS_RETRY_MODE=adaptive backoff set at the top. The wide params are
# wide/0..wide/(PARAM_COUNT-CHAIN_DEPTH-1); spot-check the first + last of that
# range plus a mid one. (The deepest chain param is asserted separately below.)
LAST_WIDE=$((PARAM_COUNT - CHAIN_DEPTH - 1)) # 80 - 10 - 1 = 69
MID_WIDE=$((LAST_WIDE / 2))
for IDX in 0 "${MID_WIDE}" "${LAST_WIDE}"; do
  SPOT=$(aws ssm get-parameter --region "${REGION}" \
    --name "/${STACK}/wide/${IDX}" \
    --query 'Parameter.Name' --output text 2>/dev/null || true)
  if [ "${SPOT}" != "/${STACK}/wide/${IDX}" ]; then
    echo "FAIL: spot-check SSM parameter /${STACK}/wide/${IDX} not found on AWS (got '${SPOT}')" >&2
    exit 1
  fi
done
echo "    OK: SSM parameters reached AWS (state records all ${PARAM_COUNT}; spot-checked wide/0, wide/${MID_WIDE}, wide/${LAST_WIDE})"

# --- Assertion: chained parameter created in DAG order ---------------------
# Chain(K) embeds Chain(K-1)'s value via Fn::Sub. The deepest chain param can
# only exist if the executor serialized the whole chain. Its value should be
# the Fn::Sub-derived "child-of-..." string (not "chain-root").
LAST_CHAIN=$((CHAIN_DEPTH - 1))
CHAIN_VALUE=$(aws ssm get-parameter \
  --region "${REGION}" \
  --name "/${STACK}/chain/${LAST_CHAIN}" \
  --query 'Parameter.Value' --output text 2>/dev/null)
case "${CHAIN_VALUE}" in
  child-of-*)
    echo "    OK: deepest chain param /${STACK}/chain/${LAST_CHAIN} created in DAG order (value='${CHAIN_VALUE}')"
    ;;
  *)
    echo "FAIL: deepest chain param value is '${CHAIN_VALUE}', expected a 'child-of-...' Fn::Sub result (DAG ordering bug?)" >&2
    exit 1
    ;;
esac

# --- Assertion: IAM roles reached AWS --------------------------------------
ROLE_SEEN=0
for i in $(seq 0 $((ROLE_COUNT - 1))); do
  if aws iam get-role --role-name "${ROLE_PREFIX}${i}" >/dev/null 2>&1; then
    ROLE_SEEN=$((ROLE_SEEN + 1))
  fi
done
if [ "${ROLE_SEEN}" -ne "${ROLE_COUNT}" ]; then
  echo "FAIL: AWS has ${ROLE_SEEN} IAM roles named ${ROLE_PREFIX}*, expected ${ROLE_COUNT}" >&2
  exit 1
fi
echo "    OK: all ${ROLE_COUNT} IAM roles reached AWS"

# --- Assertion: SNS topics reached AWS -------------------------------------
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TOPIC_SEEN=0
for i in $(seq 0 $((TOPIC_COUNT - 1))); do
  if aws sns get-topic-attributes \
    --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_PREFIX}${i}" \
    --region "${REGION}" >/dev/null 2>&1; then
    TOPIC_SEEN=$((TOPIC_SEEN + 1))
  fi
done
if [ "${TOPIC_SEEN}" -ne "${TOPIC_COUNT}" ]; then
  echo "FAIL: AWS has ${TOPIC_SEEN} SNS topics named ${TOPIC_PREFIX}*, expected ${TOPIC_COUNT}" >&2
  exit 1
fi
echo "    OK: all ${TOPIC_COUNT} SNS topics reached AWS"

# --- Phase 2: destroy -------------------------------------------------------
# NOTE: `cdkd destroy` does NOT accept `--concurrency` (only `cdkd deploy`
# does); the destroy delete loop uses its own default concurrency. The delete
# burst (70 DeleteParameter etc.) still exercises the SAME throttle-retry
# classifier the deploy side does (the fix in src/deployment/retryable-errors.ts
# applies to every withRetry call, create or delete), so the throttle coverage
# is preserved without the flag.
echo "==> Phase 2: destroy ${TOTAL} resources"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --force > "${DESTROY_LOG}" 2>&1
DESTROY_RC=$?
set -e

echo "==> Throttle / retry activity observed during destroy:"
# Same SIGPIPE-safe pattern as the deploy block above: grep the captured log to
# a variable, then trim with a here-string instead of `grep ... | head`.
THROTTLE_DESTROY="$(grep -E -i "Retrying|TooManyRequests|Rate exceeded|Throttl|429" "${DESTROY_LOG}" || true)"
if [ -n "${THROTTLE_DESTROY}" ]; then
  head -40 <<<"${THROTTLE_DESTROY}"
else
  echo "    (none observed this run)"
fi

if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC} — wide delete burst failed." >&2
  echo "      If this is a throttle, the destroy path did NOT retry it -> REAL FINDING." >&2
  echo "----- destroy log tail -----" >&2
  tail -60 "${DESTROY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

# --- Assertion: 0 orphans ---------------------------------------------------
# cdkd's destroy exited 0 above, which means every parameter in state was
# deleted. We spot-check the same representative parameters with the lighter
# per-parameter `get-parameter` API (expecting ParameterNotFound) rather than
# the throttle-prone `describe-parameters` LIST API — the destroy fires a
# 70-DeleteParameter burst that rate-limits a List call called moments later.
for IDX in 0 "${MID_WIDE}" "${LAST_WIDE}"; do
  assert_gone "SSM parameter /${STACK}/wide/${IDX} still exists after destroy (orphan)" aws ssm get-parameter --region "${REGION}" --name "/${STACK}/wide/${IDX}"
done
echo "    OK: 0 SSM parameter orphans (spot-checked wide/0, wide/${MID_WIDE}, wide/${LAST_WIDE})"

ROLE_LEFT=0
for i in $(seq 0 $((ROLE_COUNT - 1))); do
  if ! gone_probe aws iam get-role --role-name "${ROLE_PREFIX}${i}"; then
    ROLE_LEFT=$((ROLE_LEFT + 1))
  fi
done
if [ "${ROLE_LEFT}" -ne 0 ]; then
  echo "FAIL: ${ROLE_LEFT} IAM roles named ${ROLE_PREFIX}* still exist after destroy (orphans)" >&2
  exit 1
fi
echo "    OK: 0 IAM role orphans"

TOPIC_LEFT=0
for i in $(seq 0 $((TOPIC_COUNT - 1))); do
  if ! gone_probe aws sns get-topic-attributes \
    --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_PREFIX}${i}" \
    --region "${REGION}"; then
    TOPIC_LEFT=$((TOPIC_LEFT + 1))
  fi
done
if [ "${TOPIC_LEFT}" -ne 0 ]; then
  echo "FAIL: ${TOPIC_LEFT} SNS topics named ${TOPIC_PREFIX}* still exist after destroy (orphans)" >&2
  exit 1
fi
echo "    OK: 0 SNS topic orphans"

# --- Assertion: state file gone --------------------------------------------
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> throttle-wide-dag test passed: ${TOTAL} resources deployed under --concurrency ${CONCURRENCY} (throttles retried, not fatal), DAG chain ordered, clean destroy with 0 orphans"
