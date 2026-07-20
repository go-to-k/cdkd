#!/usr/bin/env bash
# verify.sh — 3-stack Fn::ImportValue CHAIN integ test (failure-seeking).
#
# Goes deeper than the existing `cross-stack-references` (1 producer + 1
# consumer, GetStackOutput + ImportValue side by side) and
# `import-value-strong-ref` (1 producer + 1 consumer, schema v3->v4 migration)
# fixtures by exercising a TRANSITIVE chain:
#
#   Stack A (CdkdImportChainA): SNS Topic; exports ChainTopicArn.
#   Stack B (CdkdImportChainB): imports ChainTopicArn (-> SSM Param), DERIVES
#                               a value from it (Fn::Sub), re-exports it as
#                               ChainDerivedValue.
#   Stack C (CdkdImportChainC): imports ChainDerivedValue (-> SSM Param).
#
# So C's import value transitively depends on A's export through B. Neither
# existing fixture has a middle stack that both imports AND re-exports, nor a
# 2-link chain. Resources are cheap (SNS + SSM only, no VPC).
#
# Steps:
#   1. Deploy A + B + C via `deploy --all` (DAG must order A->B->C); assert
#      each import resolved to the REAL upstream export value on AWS (read the
#      SSM Parameter values back), and the exports index carries BOTH exports.
#   2. Error path: against a FRESH bucket prefix with no A/B state, attempt to
#      deploy C alone and assert a clear "export not found" error (cdkd does
#      not silently resolve a dangling token). This step creates no resources
#      (the import fails during resolution), so it cannot collide with the
#      main chain's account-global SSM Parameter names. (We deliberately do
#      NOT re-deploy the whole chain on the fresh prefix — see the Step 2 note
#      in the body for why that would collide; Step 1 already proves ordering.)
#   3. Strong-ref CHAIN protection: with all 3 deployed, attempt to destroy B
#      (a producer that C still imports) -> refusal naming C + ChainDerivedValue;
#      attempt to destroy A (a producer that B still imports) -> refusal naming
#      B + ChainTopicArn.
#   4. Ordered teardown: destroy C, then B, then A — each succeeds once its
#      consumer is gone. Assert state gone for all 3 and the exports index is
#      purged of both exports.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured per step.
#
# Run via: /run-integ importvalue-chain
#         or: bash tests/integration/importvalue-chain/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

STACK_A="CdkdImportChainA"
STACK_B="CdkdImportChainB"
STACK_C="CdkdImportChainC"

# Main run uses the default `cdkd` prefix. The error-path step (Step 2) uses a
# throwaway prefix so a missing-producer deploy can be attempted in isolation
# without colliding with the main run's state.
MAIN_PREFIX="cdkd"
FRESH_PREFIX="cdkd-importchain-fresh-$$"

A_STATE_KEY="${MAIN_PREFIX}/${STACK_A}/${AWS_REGION}/state.json"
B_STATE_KEY="${MAIN_PREFIX}/${STACK_B}/${AWS_REGION}/state.json"
C_STATE_KEY="${MAIN_PREFIX}/${STACK_C}/${AWS_REGION}/state.json"
INDEX_KEY="${MAIN_PREFIX}/_index/${AWS_REGION}/exports.json"

# SSM Parameter names declared in the fixture (lib/stack-b.ts / stack-c.ts).
B_PARAM_NAME="/cdkd-integ/importvalue-chain/b-imported-topic-arn"
C_PARAM_NAME="/cdkd-integ/importvalue-chain/c-imported-derived"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  # Main prefix: destroy consumer-first (C -> B -> A) so strong-ref never blocks.
  ${CDKD} destroy ${STACK_C} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  ${CDKD} destroy ${STACK_B} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  ${CDKD} destroy ${STACK_A} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  # Fresh prefix: tear down anything the error-path step left + drop the prefix.
  ${CDKD} destroy ${STACK_C} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${FRESH_PREFIX}" --force >/dev/null 2>&1 || true
  ${CDKD} destroy ${STACK_B} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${FRESH_PREFIX}" --force >/dev/null 2>&1 || true
  ${CDKD} destroy ${STACK_A} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --state-prefix "${FRESH_PREFIX}" --force >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${FRESH_PREFIX}/" --recursive >/dev/null 2>&1 || true
  # Best-effort SSM param sweep in case a state-less orphan remains.
  aws ssm delete-parameter --name "${B_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${C_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Resolve a single export entry's value from the exports index JSON on stdin.
# Args: <export-name>. Prints the value or empty string.
index_export_value() {
  python3 -c '
import sys, json
name = sys.argv[1]
try:
    e = json.load(sys.stdin).get("exports", {})
except Exception:
    print(""); sys.exit(0)
entry = e.get(name)
print(entry.get("value", "") if isinstance(entry, dict) else "")
' "$1"
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline || pnpm install --ignore-workspace
fi

echo ""
echo "==> Pre-flight orphan scan (main + fresh prefixes)"
for KEY in "${A_STATE_KEY}" "${B_STATE_KEY}" "${C_STATE_KEY}"; do
  if aws s3 ls "s3://${STATE_BUCKET}/${KEY}" >/dev/null 2>&1; then
    echo "FAIL: state already exists at ${KEY} — clean up first."
    exit 1
  fi
done
# The two SSM Parameters are account-GLOBAL (their names are not state-prefix
# scoped), so a prior crashed run that left one behind would make this run's
# CREATE collide with "parameter already exists" (the orphan-collision the
# error-path step historically hit). Sweep them best-effort before deploying so
# a re-run always starts from a clean slate; the post-run cleanup trap does the
# same on the way out.
aws ssm delete-parameter --name "${B_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
aws ssm delete-parameter --name "${C_PARAM_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || true
# Drop any stale fresh-prefix state from a crashed prior run before reusing the
# error path (the prefix carries the PID, but a same-PID re-run can recur).
aws s3 rm "s3://${STATE_BUCKET}/${FRESH_PREFIX}/" --recursive >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
echo ""
echo "==> Step 1: Deploy A + B + C via deploy --all (DAG must order A->B->C)"
${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Step 1a: Assert B's import resolved to A's REAL topic ARN on AWS"
TOPIC_ARN=$(aws sns list-topics --region "${AWS_REGION}" \
  --query "Topics[?contains(TopicArn, ':${STACK_A}-') == \`true\`].TopicArn | [0]" \
  --output text 2>/dev/null || true)
B_PARAM_VALUE=$(aws ssm get-parameter --name "${B_PARAM_NAME}" --region "${AWS_REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
if [[ -z "${B_PARAM_VALUE}" || "${B_PARAM_VALUE}" == "None" ]]; then
  echo "FAIL: Stack B's SSM Parameter ${B_PARAM_NAME} is missing/empty — import did not resolve"
  exit 1
fi
# Shape check only (any SNS ARN). The exact-value match below is the real
# guard; this just catches a grossly-wrong import (e.g. an unresolved token).
case "${B_PARAM_VALUE}" in
  arn:aws:sns:*) : ;;
  *)
    echo "FAIL: Stack B imported value is not an SNS topic ARN: '${B_PARAM_VALUE}'"
    exit 1 ;;
esac
# If we could enumerate the real topic ARN, assert an EXACT match (not just shape).
if [[ -n "${TOPIC_ARN}" && "${TOPIC_ARN}" != "None" && "${B_PARAM_VALUE}" != "${TOPIC_ARN}" ]]; then
  echo "FAIL: B's imported ARN '${B_PARAM_VALUE}' != A's real topic ARN '${TOPIC_ARN}'"
  exit 1
fi
echo "    B imported A's ChainTopicArn = ${B_PARAM_VALUE} (✓)"

echo ""
echo "==> Step 1b: Assert C's import resolved to B's DERIVED value (transitive)"
C_PARAM_VALUE=$(aws ssm get-parameter --name "${C_PARAM_NAME}" --region "${AWS_REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
if [[ -z "${C_PARAM_VALUE}" || "${C_PARAM_VALUE}" == "None" ]]; then
  echo "FAIL: Stack C's SSM Parameter ${C_PARAM_NAME} is missing/empty — import did not resolve"
  exit 1
fi
# The derived value is `derived::<topicArn>::from-b`. Assert the wrapping shape
# AND that the embedded ARN equals the value B imported (full A->B->C chain).
EXPECTED_DERIVED="derived::${B_PARAM_VALUE}::from-b"
if [[ "${C_PARAM_VALUE}" != "${EXPECTED_DERIVED}" ]]; then
  echo "FAIL: C's imported derived value mismatch."
  echo "      got:      '${C_PARAM_VALUE}'"
  echo "      expected: '${EXPECTED_DERIVED}'"
  exit 1
fi
echo "    C imported B's ChainDerivedValue = ${C_PARAM_VALUE} (✓)"
echo "    transitive A->B->C chain resolved correctly (✓)"

echo ""
echo "==> Step 1c: Assert exports index carries BOTH exports with right producers"
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -z "${INDEX_BODY}" ]]; then
  echo "FAIL: exports index ${INDEX_KEY} not found"
  exit 1
fi
IDX_TOPIC=$(echo "${INDEX_BODY}" | index_export_value "ChainTopicArn")
IDX_DERIVED=$(echo "${INDEX_BODY}" | index_export_value "ChainDerivedValue")
if [[ -z "${IDX_TOPIC}" ]]; then
  echo "FAIL: exports index has no ChainTopicArn entry"
  echo "${INDEX_BODY}" | python3 -m json.tool
  exit 1
fi
if [[ -z "${IDX_DERIVED}" ]]; then
  echo "FAIL: exports index has no ChainDerivedValue entry"
  echo "${INDEX_BODY}" | python3 -m json.tool
  exit 1
fi
# The index's ChainTopicArn value must equal what B imported.
if [[ "${IDX_TOPIC}" != "${B_PARAM_VALUE}" ]]; then
  echo "FAIL: exports index ChainTopicArn '${IDX_TOPIC}' != B's imported ARN '${B_PARAM_VALUE}'"
  exit 1
fi
echo "    exports index has ChainTopicArn + ChainDerivedValue (✓)"

# ---------------------------------------------------------------------------
echo ""
echo "==> Step 2: ERROR PATH — deploy C EXCLUSIVELY on a fresh prefix (no producers)"
# C imports ChainDerivedValue, which does not exist on the fresh prefix. cdkd
# must surface a clear "export not found" error rather than silently producing
# a dangling token / unresolved string.
#
# `-e` / `--exclusively` is LOAD-BEARING here: like `cdk deploy`, a bare
# `cdkd deploy <stack>` also deploys the stack's DEPENDENCY CLOSURE, so without
# `--exclusively` cdkd would deploy A -> B -> C on the fresh prefix (resolving
# the import by producing it) and B's account-global SSM Parameter would then
# collide with the main chain's still-live B parameter (`ImportedTopicArnParam
# ... already exists`) — masking the missing-export path entirely. With
# `--exclusively` only C is deployed, so its `Fn::ImportValue: ChainDerivedValue`
# genuinely has no producer on the fresh prefix and fails at resolution BEFORE
# any resource is created (no collision with the main chain's global names).
set +e
ERR_OUTPUT=$(${CDKD} deploy ${STACK_C} --exclusively --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${FRESH_PREFIX}" 2>&1)
ERR_RC=$?
set -e
if [[ "${ERR_RC}" -eq 0 ]]; then
  echo "FAIL: deploying C with no upstream producer unexpectedly succeeded"
  echo "${ERR_OUTPUT}"
  exit 1
fi
# cdkd surfaces a missing Fn::ImportValue export as a ProvisioningError whose
# CAUSE is the resolver's own message. The full output (logger.error line +
# the handleError `Caused by:` line) reads, verbatim from
# src/deployment/intrinsic-function-resolver.ts:
#
#   Fn::ImportValue: export 'ChainDerivedValue' not found in any stack.
#   Searched N state record(s). Make sure the exporting stack has been
#   deployed and the Output has an Export.Name property.
#
# Assert the resolver's distinctive "Fn::ImportValue:" phrase together with
# the "not found" wording — this is cdkd's actual missing-export contract and
# is not brittle on the surrounding ProvisioningError envelope. We do NOT also
# require the literal export NAME: the resolver names it (and the assertion
# below confirms it WHEN present), but the load-bearing proof of correct
# behavior is that cdkd refused to silently resolve a dangling import.
if ! echo "${ERR_OUTPUT}" | grep -Eq "Fn::ImportValue.*not found|not found in any stack"; then
  echo "FAIL: error output does not report a missing Fn::ImportValue export"
  echo "${ERR_OUTPUT}"
  exit 1
fi
# Best-effort: when cdkd's message names the export (current behavior), make
# sure it is the RIGHT one. Skipped automatically if a future cdkd reword
# drops the name from the message.
if echo "${ERR_OUTPUT}" | grep -q "ChainTopicArn" && ! echo "${ERR_OUTPUT}" | grep -q "ChainDerivedValue"; then
  echo "FAIL: error names the wrong export (ChainTopicArn, not ChainDerivedValue)"
  echo "${ERR_OUTPUT}"
  exit 1
fi
echo "    C alone failed with a clear missing-export error (exit ${ERR_RC}) (✓)"

# NOTE: we intentionally do NOT re-deploy the full A->B->C chain on the fresh
# prefix here. Stack B's and Stack C's SSM Parameters carry EXPLICIT, account-
# GLOBAL names (`/cdkd-integ/importvalue-chain/b-imported-topic-arn` /
# `.../c-imported-derived`), so a second chain deployed under a different
# state-prefix while the main chain (Step 1) is still live would collide with
# `ParameterAlreadyExists` on B's create (the two deployments share one
# synthesized cdk.out, hence the same global names). The same shared-name
# overlap would also let the fresh-prefix teardown delete the main chain's
# auto-named SNS topic out from under it. The error-path assertion above
# (deploy C alone -> missing export) does NOT create any resource — the import
# fails during intrinsic resolution before any create — so it is collision-
# free. The "deploy --all orders A->B->C" coverage is already provided more
# strongly by Step 1 (which asserts the RESOLVED chain values, not just that
# state was written), so re-deploying the whole chain on the fresh prefix added
# no unique coverage while making the fixture flaky.

# ---------------------------------------------------------------------------
echo ""
echo "==> Step 3: STRONG-REF CHAIN — destroy a producer that a consumer imports"
echo "==> Step 3a: Destroy B (C still imports ChainDerivedValue) -> expect refusal"
set +e
DESTROY_B=$(${CDKD} destroy ${STACK_B} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force 2>&1)
DESTROY_B_RC=$?
set -e
if [[ "${DESTROY_B_RC}" -eq 0 ]]; then
  echo "FAIL: destroying B (mid-chain producer) unexpectedly succeeded — strong-ref did not fire"
  echo "${DESTROY_B}"
  exit 1
fi
if ! echo "${DESTROY_B}" | grep -q "Cannot destroy stack"; then
  echo "FAIL: B destroy refusal does not match StackHasActiveImportsError shape"
  echo "${DESTROY_B}"
  exit 1
fi
if ! echo "${DESTROY_B}" | grep -q "${STACK_C}"; then
  echo "FAIL: B destroy refusal does not name consumer ${STACK_C}"
  echo "${DESTROY_B}"
  exit 1
fi
if ! echo "${DESTROY_B}" | grep -q "ChainDerivedValue"; then
  echo "FAIL: B destroy refusal does not name export ChainDerivedValue"
  echo "${DESTROY_B}"
  exit 1
fi
echo "    B destroy refused, names ${STACK_C} + ChainDerivedValue (exit ${DESTROY_B_RC}) (✓)"

echo ""
echo "==> Step 3b: Destroy A (B still imports ChainTopicArn) -> expect refusal"
set +e
DESTROY_A=$(${CDKD} destroy ${STACK_A} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force 2>&1)
DESTROY_A_RC=$?
set -e
if [[ "${DESTROY_A_RC}" -eq 0 ]]; then
  echo "FAIL: destroying A (head producer) unexpectedly succeeded — strong-ref did not fire"
  echo "${DESTROY_A}"
  exit 1
fi
if ! echo "${DESTROY_A}" | grep -q "Cannot destroy stack"; then
  echo "FAIL: A destroy refusal does not match StackHasActiveImportsError shape"
  echo "${DESTROY_A}"
  exit 1
fi
if ! echo "${DESTROY_A}" | grep -q "${STACK_B}"; then
  echo "FAIL: A destroy refusal does not name consumer ${STACK_B}"
  echo "${DESTROY_A}"
  exit 1
fi
if ! echo "${DESTROY_A}" | grep -q "ChainTopicArn"; then
  echo "FAIL: A destroy refusal does not name export ChainTopicArn"
  echo "${DESTROY_A}"
  exit 1
fi
echo "    A destroy refused, names ${STACK_B} + ChainTopicArn (exit ${DESTROY_A_RC}) (✓)"

# ---------------------------------------------------------------------------
echo ""
echo "==> Step 4: Ordered teardown C -> B -> A (each succeeds once consumer gone)"
echo "==> Step 4a: Destroy C (tail consumer) -> clean"
${CDKD} destroy ${STACK_C} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "C state still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${C_STATE_KEY}"
assert_gone "C's SSM Parameter ${C_PARAM_NAME} still exists after destroy (orphan)" aws ssm get-parameter --name "${C_PARAM_NAME}" --region "${AWS_REGION}"
echo "    C destroyed, state + SSM Parameter gone (✓)"

echo ""
echo "==> Step 4b: Destroy B (now no consumer) -> clean"
${CDKD} destroy ${STACK_B} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "B state still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${B_STATE_KEY}"
assert_gone "B's SSM Parameter ${B_PARAM_NAME} still exists after destroy (orphan)" aws ssm get-parameter --name "${B_PARAM_NAME}" --region "${AWS_REGION}"
echo "    B destroyed, state + SSM Parameter gone (✓)"

echo ""
echo "==> Step 4c: Destroy A (head, now no consumer) -> clean"
${CDKD} destroy ${STACK_A} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "A state still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${A_STATE_KEY}"
# Assert the SNS topic that Stack A created is gone (state-empty can miss an
# orphan that carries no stack name; assert the real resource directly).
LEFTOVER_TOPIC=$(aws sns list-topics --region "${AWS_REGION}" \
  --query "Topics[?contains(TopicArn, ':${STACK_A}-') == \`true\`].TopicArn | [0]" \
  --output text 2>/dev/null || true)
if [[ -n "${LEFTOVER_TOPIC}" && "${LEFTOVER_TOPIC}" != "None" ]]; then
  echo "FAIL: Stack A's SNS topic still exists after destroy (orphan): ${LEFTOVER_TOPIC}"
  exit 1
fi
echo "    A destroyed, state + SNS topic gone (✓)"

echo ""
echo "==> Step 5: Assert exports index purged of both chain exports"
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -n "${INDEX_BODY}" ]]; then
  IDX_TOPIC=$(echo "${INDEX_BODY}" | index_export_value "ChainTopicArn")
  IDX_DERIVED=$(echo "${INDEX_BODY}" | index_export_value "ChainDerivedValue")
  if [[ -n "${IDX_TOPIC}" ]]; then
    echo "FAIL: exports index still has a ChainTopicArn entry after teardown"
    echo "${INDEX_BODY}" | python3 -m json.tool
    exit 1
  fi
  if [[ -n "${IDX_DERIVED}" ]]; then
    echo "FAIL: exports index still has a ChainDerivedValue entry after teardown"
    echo "${INDEX_BODY}" | python3 -m json.tool
    exit 1
  fi
fi
echo "    exports index purged of ChainTopicArn + ChainDerivedValue (✓)"

echo ""
echo "==> All importvalue-chain smoke tests passed"
trap - EXIT INT TERM
