#!/usr/bin/env bash
# verify.sh — cdkd CloudFormation-fallback cross-stack reference integ test
# (issue #1697).
#
# A PRODUCER stack is created with raw `aws cloudformation deploy` (never
# touched by cdkd — it has NO cdkd state record). A cdkd-deployed CONSUMER
# references it BOTH ways:
#
#   * `Fn::ImportValue 'CdkdCfnFallbackExport'`  -> ListExports fallback
#   * `Fn::GetStackOutput {StackName, OutputName}` -> DescribeStacks fallback
#
# Phases:
#   1. Deploy the producer via `aws cloudformation deploy` with a per-run
#      suffix baked into the output VALUES (fixed names, fresh values —
#      a stale leftover from a prior run cannot satisfy the equality
#      assertions below).
#   2. `cdkd deploy` the consumer; both SSM parameters must land with the
#      producer's CURRENT output values (read back from real AWS).
#   3. Weak-reference contract: the consumer's state.json must record NO
#      `imports[]` and NO `outputReads[]` entries (CFn-sourced resolutions
#      are deliberately not recorded).
#   4. Opt-out: `cdkd deploy --no-cfn-fallback` must FAIL at resolve time
#      with the cdkd-state-only not-found error (live proof of the flag).
#   5. Destroy the consumer, delete the producer CFn stack; assert both
#      SSM parameters, the consumer state file, and the CFn stack are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (account-scoped)
#   AWS_REGION   — target region (defaults to us-east-1)

set -euo pipefail

export AWS_PAGER=""

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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

PRODUCER_STACK="CdkdCfnFallbackProducer"
CONSUMER_STACK="CdkdCfnFallbackConsumer"
IMPORTVALUE_PARAM_NAME="/cdkd/cfn-fallback-integ/via-importvalue"
GETSTACKOUTPUT_PARAM_NAME="/cdkd/cfn-fallback-integ/via-getstackoutput"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${REGION}/state.json"
CONSUMER_LOCK_KEY="cdkd/${CONSUMER_STACK}/${REGION}/lock.json"

# Per-run unique suffix baked into the producer's output VALUES (names are
# fixed so pre-run cleanup is deterministic; the suffix proves the consumer
# resolved THIS run's values). epoch + RANDOM, not `date +%s%N`: BSD date
# (macOS) does not support %N (a literal 'N' lands in the value and
# uniqueness degrades to second granularity).
SUFFIX="$(date +%s)${RANDOM}"
EXPECTED_EXPORTED_VALUE="cfn-exported-${SUFFIX}"
EXPECTED_SHARED_VALUE="cfn-shared-${SUFFIX}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover consumer state / producer CFn stack / probes"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct API fallback so half-deployed resources don't leak.
  aws ssm delete-parameter --name "${IMPORTVALUE_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${GETSTACKOUTPUT_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The CFn producer (never cdkd-managed) goes through raw CFn.
  if aws cloudformation describe-stacks --stack-name "${PRODUCER_STACK}" --region "${REGION}" >/dev/null 2>&1; then
    aws cloudformation delete-stack --stack-name "${PRODUCER_STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${PRODUCER_STACK}" --region "${REGION}" || true
  fi
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_LOCK_KEY}" >/dev/null 2>&1 || true
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

echo "==> Pre-run cleanup (drop any stranded state / stacks from a prior failed integ)"
cleanup

# --- Phase 1: create the CloudFormation-managed producer -------------------
echo "==> Phase 1: aws cloudformation deploy ${PRODUCER_STACK} (suffix ${SUFFIX})"
aws cloudformation deploy \
  --stack-name "${PRODUCER_STACK}" \
  --template-file cfn-producer-template.json \
  --parameter-overrides "ResourceSuffix=${SUFFIX}" \
  --region "${REGION}"

# Sanity: the producer's outputs must carry THIS run's suffix.
PRODUCER_SHARED_VALUE=$(aws cloudformation describe-stacks \
  --stack-name "${PRODUCER_STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='SharedValue'].OutputValue | [0]" --output text)
PRODUCER_EXPORTED_VALUE=$(aws cloudformation describe-stacks \
  --stack-name "${PRODUCER_STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ExportedValue'].OutputValue | [0]" --output text)
if [ "${PRODUCER_SHARED_VALUE}" != "${EXPECTED_SHARED_VALUE}" ] || [ "${PRODUCER_EXPORTED_VALUE}" != "${EXPECTED_EXPORTED_VALUE}" ]; then
  echo "FAIL: producer outputs do not carry this run's suffix (shared='${PRODUCER_SHARED_VALUE}', exported='${PRODUCER_EXPORTED_VALUE}', suffix='${SUFFIX}')" >&2
  exit 1
fi
echo "    OK: producer outputs live with suffix ${SUFFIX}"

# The producer must NOT have a cdkd state record — that absence is the whole
# point (the consumer's resolve must go through the CFn fallback).
assert_gone "producer unexpectedly has a cdkd state record — the fallback would never fire" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${PRODUCER_STACK}/${REGION}/state.json" --region "${REGION}"
echo "    OK: producer has no cdkd state record (fallback is the only resolution path)"

# --- Phase 2: cdkd deploy the consumer -------------------------------------
echo "==> Phase 2: cdkd deploy ${CONSUMER_STACK} (resolves both refs via the CFn fallback)"
node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

IMPORTED_VALUE=$(aws ssm get-parameter --name "${IMPORTVALUE_PARAM_NAME}" --region "${REGION}" --query 'Parameter.Value' --output text)
if [ "${IMPORTED_VALUE}" != "${EXPECTED_EXPORTED_VALUE}" ]; then
  echo "FAIL: Fn::ImportValue fallback resolved WRONG value: '${IMPORTED_VALUE}' (expected '${EXPECTED_EXPORTED_VALUE}')" >&2
  exit 1
fi
echo "    OK: Fn::ImportValue resolved via ListExports fallback (${IMPORTED_VALUE})"

GSO_VALUE=$(aws ssm get-parameter --name "${GETSTACKOUTPUT_PARAM_NAME}" --region "${REGION}" --query 'Parameter.Value' --output text)
if [ "${GSO_VALUE}" != "${EXPECTED_SHARED_VALUE}" ]; then
  echo "FAIL: Fn::GetStackOutput fallback resolved WRONG value: '${GSO_VALUE}' (expected '${EXPECTED_SHARED_VALUE}')" >&2
  exit 1
fi
echo "    OK: Fn::GetStackOutput resolved via DescribeStacks fallback (${GSO_VALUE})"

# --- Phase 3: weak-reference contract --------------------------------------
# CFn-sourced resolutions must NOT be recorded into state.imports /
# state.outputReads (cdkd cannot destroy-protect a producer it does not
# manage; outputReads names cdkd-managed producers for recreate warnings).
echo "==> Phase 3: assert the consumer state records NO imports / outputReads"
CONSUMER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - --region "${REGION}")
IMPORTS_LEN=$(echo "${CONSUMER_STATE}" | jq '.imports // [] | length')
OUTPUT_READS_LEN=$(echo "${CONSUMER_STATE}" | jq '.outputReads // [] | length')
if [ "${IMPORTS_LEN}" != "0" ] || [ "${OUTPUT_READS_LEN}" != "0" ]; then
  echo "FAIL: CFn-sourced resolutions were recorded into state (imports=${IMPORTS_LEN}, outputReads=${OUTPUT_READS_LEN}; both must be 0 — weak-reference contract)" >&2
  echo "${CONSUMER_STATE}" | jq '{imports, outputReads}' >&2
  exit 1
fi
echo "    OK: state carries no imports[] / outputReads[] entries (weak reference)"

# --- Phase 4: --no-cfn-fallback opt-out must fail at resolve time ----------
echo "==> Phase 4: cdkd deploy --no-cfn-fallback must FAIL with the cdkd-state-only error"
set +e
NO_FALLBACK_OUT=$(node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-cfn-fallback \
  --yes 2>&1)
NO_FALLBACK_RC=$?
set -e
if [ "${NO_FALLBACK_RC}" -eq 0 ]; then
  echo "FAIL: deploy with --no-cfn-fallback unexpectedly SUCCEEDED — the opt-out did not disable the fallback" >&2
  exit 1
fi
# Either intrinsic may fail first (DAG order is not deterministic across the
# two independent SSM parameters) — accept both cdkd-state-only messages.
if ! printf '%s' "${NO_FALLBACK_OUT}" | grep -qE "not found in any stack|not found in region"; then
  echo "FAIL: --no-cfn-fallback deploy failed with an UNEXPECTED error (wanted a cross-stack not-found error):" >&2
  printf '%s\n' "${NO_FALLBACK_OUT}" | tail -20 >&2
  exit 1
fi
if printf '%s' "${NO_FALLBACK_OUT}" | grep -qE "and CloudFormation exports|Searched cdkd state and CloudFormation stacks"; then
  echo "FAIL: --no-cfn-fallback error message claims CloudFormation was searched — the flag did not reach the resolver" >&2
  exit 1
fi
echo "    OK: --no-cfn-fallback fails at resolve time with the cdkd-state-only error"

# --- Phase 5: destroy + leak assertions ------------------------------------
echo "==> Phase 5a: cdkd destroy ${CONSUMER_STACK}"
node "${LOCAL_DIST}" destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "consumer SSM parameter ${IMPORTVALUE_PARAM_NAME} leaked after destroy" \
  aws ssm get-parameter --name "${IMPORTVALUE_PARAM_NAME}" --region "${REGION}"
assert_gone "consumer SSM parameter ${GETSTACKOUTPUT_PARAM_NAME} leaked after destroy" \
  aws ssm get-parameter --name "${GETSTACKOUTPUT_PARAM_NAME}" --region "${REGION}"
assert_gone "consumer state file leaked after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}" --region "${REGION}"
echo "    OK: consumer resources + state gone"

echo "==> Phase 5b: delete producer CFn stack"
aws cloudformation delete-stack --stack-name "${PRODUCER_STACK}" --region "${REGION}"
aws cloudformation wait stack-delete-complete --stack-name "${PRODUCER_STACK}" --region "${REGION}"
assert_gone "producer CFn stack still describeable after delete" \
  aws cloudformation describe-stacks --stack-name "${PRODUCER_STACK}" --region "${REGION}"
echo "    OK: producer CFn stack gone"

trap - EXIT INT TERM
echo "PASS: cross-stack-cfn-fallback"
