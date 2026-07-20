#!/usr/bin/env bash
# verify.sh — cdkd cross-region Fn::GetStackOutput integ test.
#
# Failure-seeking test for cdkd's UNIQUE same-account / CROSS-REGION
# `Fn::GetStackOutput` intrinsic. A CONSUMER stack deployed in one region
# reads a PRODUCER stack's output from ANOTHER region. This works because
# cdkd's state bucket is account-scoped (not region-scoped), so the
# consumer's resolver reads `cdkd/CdkdGsoProducer/us-west-2/state.json`
# from the same bucket its own state lives in.
#
#   1. Deploy PRODUCER (CdkdGsoProducer) in region X (us-west-2). Writes
#      an SSM parameter + `cdkd/CdkdGsoProducer/us-west-2/state.json`
#      with output ProducerArn.
#   2. Deploy CONSUMER (CdkdGsoConsumer) in region Y (us-east-1). Its SSM
#      parameter Value is `Fn::GetStackOutput` of the producer's
#      ProducerArn WITH an explicit `Region: us-west-2` argument.
#   3. Assert the consumer's SSM parameter on AWS (us-east-1) carries the
#      producer's REAL ARN value (which itself names us-west-2) — proving
#      the cross-region read worked AND resolved the correct value.
#   4. Destroy consumer (us-east-1) then producer (us-west-2); assert
#      both AWS resources AND both region-prefixed state files are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (account-scoped, e.g. cdkd-state-{accountId})
#   AWS_REGION   — informational; this test pins explicit per-stack regions
#                  (producer us-west-2, consumer us-east-1) regardless.
#
# The cdkd `/run-integ` skill exports STATE_BUCKET before invoking.

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

PRODUCER_STACK="CdkdGsoProducer"
CONSUMER_STACK="CdkdGsoConsumer"
PRODUCER_REGION="us-west-2"
CONSUMER_REGION="us-east-1"
PRODUCER_OUTPUT_NAME="ProducerArn"
PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/state.json"
PRODUCER_LOCK_KEY="cdkd/${PRODUCER_STACK}/${PRODUCER_REGION}/lock.json"
CONSUMER_LOCK_KEY="cdkd/${CONSUMER_STACK}/${CONSUMER_REGION}/lock.json"
PRODUCER_PARAM_NAME="/cdkd/getstackoutput-crossregion/producer"
CONSUMER_PARAM_NAME="/cdkd/getstackoutput-crossregion/consumer"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes (both regions)"
  set +e
  # Try the binary's destroy first (cleanest path). Consumer first,
  # producer last — Fn::GetStackOutput is a weak reference so order
  # doesn't strictly matter, but mirrors real-world recommended order.
  # Each stack is destroyed against its OWN region.
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET}" --region "${CONSUMER_REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}" --region "${PRODUCER_REGION}" --yes >/dev/null 2>&1
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak —
  # delete the SSM parameter from the region it was created in.
  aws ssm delete-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}" >/dev/null 2>&1 || true
  # Drop both region-prefixed state + lock sidecars from the
  # account-scoped bucket.
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRODUCER_LOCK_KEY}" >/dev/null 2>&1 || true
  set -e
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local cdkd binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probes from a prior failed integ)"
cleanup

# --- Phase 1: deploy PRODUCER in region X (us-west-2) --------------------
echo "==> Phase 1: deploy PRODUCER ${PRODUCER_STACK} in ${PRODUCER_REGION}"
node "${LOCAL_DIST}" deploy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${PRODUCER_REGION}" \
  --yes

# The producer state must land under the us-west-2 region prefix.
if ! aws s3 ls "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: producer state file not found at ${PRODUCER_STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: producer state written at ${PRODUCER_STATE_KEY}"

# Capture the producer output value recorded in cdkd state so we can
# assert the consumer's cross-region read resolves to EXACTLY this.
PRODUCER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)
PRODUCER_OUTPUT_VALUE=$(echo "${PRODUCER_STATE}" | jq -r --arg k "${PRODUCER_OUTPUT_NAME}" '.outputs[$k] // empty')
if [ -z "${PRODUCER_OUTPUT_VALUE}" ]; then
  echo "FAIL: producer state has no output '${PRODUCER_OUTPUT_NAME}'" >&2
  echo "${PRODUCER_STATE}" | jq '.outputs'
  exit 1
fi
echo "    OK: producer output ${PRODUCER_OUTPUT_NAME} = ${PRODUCER_OUTPUT_VALUE}"

# Sanity: the producer ARN must name us-west-2 (the SSM parameter ARN
# carries the region segment). If it doesn't, the producer didn't land
# in region X and the cross-region claim is moot.
case "${PRODUCER_OUTPUT_VALUE}" in
  *":${PRODUCER_REGION}:"*) : ;;
  *)
    echo "FAIL: producer ARN '${PRODUCER_OUTPUT_VALUE}' does not contain region segment ':${PRODUCER_REGION}:' — producer did not deploy to ${PRODUCER_REGION}" >&2
    exit 1
    ;;
esac
echo "    OK: producer ARN carries the ${PRODUCER_REGION} region segment"

# Cross-check against the real AWS parameter in us-west-2.
PRODUCER_PARAM_ARN=$(aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}" --query 'Parameter.ARN' --output text 2>/dev/null)
if [ -z "${PRODUCER_PARAM_ARN}" ] || [ "${PRODUCER_PARAM_ARN}" = "None" ]; then
  echo "FAIL: producer SSM parameter not found in ${PRODUCER_REGION}" >&2
  exit 1
fi
echo "    OK: producer SSM parameter exists in ${PRODUCER_REGION} (ARN ${PRODUCER_PARAM_ARN})"

# --- Phase 2: deploy CONSUMER in region Y (us-east-1) -------------------
# The consumer's Fn::GetStackOutput reads the producer's output FROM
# us-west-2 (cross-region). If cdkd cannot read the producer's
# region-X state from the account-scoped bucket, this deploy fails at
# resolve time ("stack not found in region 'us-west-2'") and the test
# fails here with that error surfaced.
echo "==> Phase 2: deploy CONSUMER ${CONSUMER_STACK} in ${CONSUMER_REGION} (reads producer output cross-region from ${PRODUCER_REGION})"
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" \
  --yes

if ! aws s3 ls "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: consumer state file not found at ${CONSUMER_STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: consumer state written at ${CONSUMER_STATE_KEY}"

# --- Phase 3: assert the cross-region read resolved correctly ----------
# The consumer's SSM parameter (in us-east-1) must hold the producer's
# REAL output value (the us-west-2 ARN). This is the load-bearing
# assertion: it proves the cross-region Fn::GetStackOutput read both
# WORKED and resolved the CORRECT value (not stale / wrong / empty).
echo "==> Phase 3: assert consumer (${CONSUMER_REGION}) carries the producer's cross-region output value"
CONSUMER_PARAM_VALUE=$(aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}" --query 'Parameter.Value' --output text 2>/dev/null)
if [ -z "${CONSUMER_PARAM_VALUE}" ] || [ "${CONSUMER_PARAM_VALUE}" = "None" ]; then
  echo "FAIL: consumer SSM parameter not found in ${CONSUMER_REGION}" >&2
  exit 1
fi

if [ "${CONSUMER_PARAM_VALUE}" != "${PRODUCER_OUTPUT_VALUE}" ]; then
  echo "FAIL: cross-region Fn::GetStackOutput resolved WRONG value." >&2
  echo "      consumer (${CONSUMER_REGION}) param value: '${CONSUMER_PARAM_VALUE}'" >&2
  echo "      expected producer (${PRODUCER_REGION}) output: '${PRODUCER_OUTPUT_VALUE}'" >&2
  exit 1
fi
echo "    OK: consumer param value == producer cross-region output (${CONSUMER_PARAM_VALUE})"

# Belt-and-suspenders: the resolved value must name the PRODUCER's
# region, not the consumer's — guards against a resolver that silently
# fell back to the consumer's own region and happened to find nothing /
# something else.
case "${CONSUMER_PARAM_VALUE}" in
  *":${PRODUCER_REGION}:"*) : ;;
  *)
    echo "FAIL: resolved consumer value '${CONSUMER_PARAM_VALUE}' does not name producer region '${PRODUCER_REGION}' — cross-region read may have resolved against the wrong region" >&2
    exit 1
    ;;
esac
echo "    OK: resolved value names producer region ${PRODUCER_REGION} (true cross-region read)"

# --- Phase 4: destroy both, assert clean in BOTH regions ---------------
echo "==> Phase 4a: destroy CONSUMER ${CONSUMER_STACK} (${CONSUMER_REGION})"
node "${LOCAL_DIST}" destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CONSUMER_REGION}" \
  --force

assert_gone "consumer parameter still exists in ${CONSUMER_REGION} after destroy" aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${CONSUMER_REGION}"
assert_gone "consumer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
echo "    OK: consumer is gone (AWS resource in ${CONSUMER_REGION} + state)"

echo "==> Phase 4b: destroy PRODUCER ${PRODUCER_STACK} (${PRODUCER_REGION})"
node "${LOCAL_DIST}" destroy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${PRODUCER_REGION}" \
  --force

assert_gone "producer parameter still exists in ${PRODUCER_REGION} after destroy" aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${PRODUCER_REGION}"
assert_gone "producer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
echo "    OK: producer is gone (AWS resource in ${PRODUCER_REGION} + state)"

echo ""
echo "==> getstackoutput-crossregion test passed (cross-region Fn::GetStackOutput resolved correctly + both regions clean)"
