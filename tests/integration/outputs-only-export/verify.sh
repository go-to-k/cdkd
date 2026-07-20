#!/usr/bin/env bash
# verify.sh — Outputs-only-change export persistence integ test (Issue #875)
#
# Reproduces the exact bug chain: a producer stack already deployed, then a
# downstream consumer starts referencing it. CDK synth adds a new Output/Export
# to the producer WITHOUT changing any of its resources. The producer redeploy
# is a no-op at the resource level, but the new export MUST still be persisted
# to state + the exports index — otherwise the consumer's Fn::ImportValue fails.
#
#   Phase 1: deploy producer alone (no export). Assert no export in state/index.
#   Phase 2a: consumer now exists → redeploy producer alone. Assert it is a
#             no-op ("No changes detected"), the bucket is NOT recreated, yet
#             the export is now persisted to state AND the exports index.
#   Phase 2b: deploy consumer with --exclusively (producer NOT redeployed).
#             Assert its Fn::ImportValue resolves to the producer bucket ARN.
#   Teardown: destroy consumer then producer; assert state is empty.
#
# Run via: /run-integ outputs-only-export
#         or: bash tests/integration/outputs-only-export/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
PRODUCER="CdkdOutputsOnlyProducer"
CONSUMER="CdkdOutputsOnlyConsumer"
EXPORT_NAME="CdkdOutputsOnlyBucketArn"
SSM_PARAM="/cdkd-integ/outputs-only-export/imported-bucket-arn"
STATE_KEY_PREFIX="cdkd"
PRODUCER_STATE_KEY="${STATE_KEY_PREFIX}/${PRODUCER}/${AWS_REGION}/state.json"
CONSUMER_STATE_KEY="${STATE_KEY_PREFIX}/${CONSUMER}/${AWS_REGION}/state.json"
INDEX_KEY="${STATE_KEY_PREFIX}/_index/${AWS_REGION}/exports.json"

PASS_COUNT=0
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "    $1 (✓)"
}

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  CDKD_TEST_WITH_CONSUMER=true ${CDKD} destroy ${CONSUMER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  CDKD_TEST_WITH_CONSUMER=true ${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Pre-flight orphan scan"
for key in "${PRODUCER_STATE_KEY}" "${CONSUMER_STATE_KEY}"; do
  aws s3 ls "s3://${STATE_BUCKET}/${key}" >/dev/null 2>&1 && {
    echo "FAIL: state ${key} already exists — clean up first."
    exit 1
  }
done

# ---------------------------------------------------------------------------
echo ""
echo "==> Phase 1: deploy producer alone (no consumer, no export)"
env -u CDKD_TEST_WITH_CONSUMER ${CDKD} deploy ${PRODUCER} --exclusively --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

PRODUCER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)
HAS_EXPORT=$(echo "${PRODUCER_STATE}" | python3 -c "import sys, json; print('${EXPORT_NAME}' in json.load(sys.stdin).get('outputs', {}))")
if [[ "${HAS_EXPORT}" != "False" ]]; then
  echo "FAIL: producer state already has export ${EXPORT_NAME} after phase 1 (expected none)"
  echo "${PRODUCER_STATE}" | python3 -m json.tool
  exit 1
fi
pass "producer state has no export after phase 1"

# Capture the bucket physical id so phase 2a can prove it was NOT recreated.
BUCKET_PHYS_1=$(echo "${PRODUCER_STATE}" | python3 -c "import sys, json; r = json.load(sys.stdin)['resources']; print(next(v['physicalId'] for v in r.values() if v['resourceType'] == 'AWS::S3::Bucket'))")
echo "    producer bucket physicalId: ${BUCKET_PHYS_1}"

# Exports index must not yet carry a producer entry.
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -n "${INDEX_BODY}" ]]; then
  IDX_HAS_EXPORT=$(echo "${INDEX_BODY}" | python3 -c "import sys, json; print('${EXPORT_NAME}' in json.load(sys.stdin).get('exports', {}))")
  if [[ "${IDX_HAS_EXPORT}" == "True" ]]; then
    echo "FAIL: exports index already has ${EXPORT_NAME} after phase 1"
    exit 1
  fi
fi
pass "exports index has no producer export after phase 1"

# ---------------------------------------------------------------------------
echo ""
echo "==> Phase 2a: consumer now exists → redeploy producer alone (Outputs-only change)"
set +e
DEPLOY_OUT=$(CDKD_TEST_WITH_CONSUMER=true ${CDKD} deploy ${PRODUCER} --exclusively --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
DEPLOY_RC=$?
set -e
echo "${DEPLOY_OUT}"
if [[ "${DEPLOY_RC}" -ne 0 ]]; then
  echo "FAIL: producer redeploy failed (rc=${DEPLOY_RC})"
  exit 1
fi
if ! echo "${DEPLOY_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: producer redeploy was not a no-op resource diff (expected 'No changes detected')"
  exit 1
fi
pass "producer redeploy was a no-op resource diff"

PRODUCER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)

# The export must now be persisted in state.outputs.
EXPORT_VAL=$(echo "${PRODUCER_STATE}" | python3 -c "import sys, json; o = json.load(sys.stdin).get('outputs', {}); print(o.get('${EXPORT_NAME}', ''))")
if [[ -z "${EXPORT_VAL}" ]]; then
  echo "FAIL: producer state.outputs is missing export ${EXPORT_NAME} after the Outputs-only change (#875 regression)"
  echo "${PRODUCER_STATE}" | python3 -m json.tool
  exit 1
fi
pass "producer state now persists export ${EXPORT_NAME}=${EXPORT_VAL}"

# The bucket must NOT have been recreated by the no-op deploy.
BUCKET_PHYS_2=$(echo "${PRODUCER_STATE}" | python3 -c "import sys, json; r = json.load(sys.stdin)['resources']; print(next(v['physicalId'] for v in r.values() if v['resourceType'] == 'AWS::S3::Bucket'))")
if [[ "${BUCKET_PHYS_2}" != "${BUCKET_PHYS_1}" ]]; then
  echo "FAIL: bucket physicalId changed (${BUCKET_PHYS_1} -> ${BUCKET_PHYS_2}) — no-op deploy recreated the resource"
  exit 1
fi
pass "producer bucket NOT recreated (physicalId stable)"

# The exports index must now carry the producer entry.
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -z "${INDEX_BODY}" ]]; then
  echo "FAIL: exports index file ${INDEX_KEY} not found after phase 2a"
  exit 1
fi
IDX_PRODUCER=$(echo "${INDEX_BODY}" | python3 -c "
import sys, json
e = json.load(sys.stdin).get('exports', {})
ent = e.get('${EXPORT_NAME}')
print(ent.get('producerStack') if ent else '')
")
if [[ "${IDX_PRODUCER}" != "${PRODUCER}" ]]; then
  echo "FAIL: exports index does not carry ${EXPORT_NAME} owned by ${PRODUCER} (got '${IDX_PRODUCER}')"
  echo "${INDEX_BODY}" | python3 -m json.tool
  exit 1
fi
pass "exports index now carries ${EXPORT_NAME} owned by ${PRODUCER}"

# ---------------------------------------------------------------------------
echo ""
echo "==> Phase 2b: deploy consumer with --exclusively (producer NOT redeployed)"
# --exclusively means the consumer must resolve the export purely from the
# producer state/index persisted in phase 2a. If the no-op deploy had not
# persisted the export, this Fn::ImportValue would fail here.
CDKD_TEST_WITH_CONSUMER=true ${CDKD} deploy ${CONSUMER} --exclusively --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

SSM_VALUE=$(aws ssm get-parameter --name "${SSM_PARAM}" --region "${AWS_REGION}" --query 'Parameter.Value' --output text 2>/dev/null || true)
if [[ "${SSM_VALUE}" != "${EXPORT_VAL}" ]]; then
  echo "FAIL: consumer SSM param resolved to '${SSM_VALUE}', expected the producer bucket ARN '${EXPORT_VAL}'"
  exit 1
fi
pass "consumer Fn::ImportValue resolved to the producer bucket ARN"

# ---------------------------------------------------------------------------
echo ""
echo "==> Teardown: destroy consumer then producer"
CDKD_TEST_WITH_CONSUMER=true ${CDKD} destroy ${CONSUMER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
CDKD_TEST_WITH_CONSUMER=true ${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

for key in "${PRODUCER_STATE_KEY}" "${CONSUMER_STATE_KEY}"; do
  assert_gone "state ${key} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
pass "all state files removed"

echo ""
echo "==> All ${PASS_COUNT} outputs-only-export checks passed"
trap - EXIT INT TERM
