#!/usr/bin/env bash
# verify.sh — Fn::ImportValue strong reference integ test (Issue #343)
#
# Exercises the end-to-end strong-reference enforcement against real AWS:
#
#   1. Deploy Producer + Consumer; verify consumer's state.imports[]
#      is populated and the exports index file exists.
#   2. Attempt `cdkd destroy <producer>` → expect REFUSAL with
#      `StackHasActiveImportsError` and exit code 2.
#   3. Simulate the v3 → v4 migration: rewrite Consumer's state.json
#      as `version: 3` (dropping the imports[] field), then attempt
#      producer destroy → expect SUCCESS (gradual activation, v3
#      consumer not yet recording imports). Restore v4 state after.
#   4. Destroy Consumer first, then Producer — both succeed.
#   5. Verify exports index is empty / has no stale entries.
#
# Run via: /run-integ import-value-strong-ref
#         or: bash tests/integration/import-value-strong-ref/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
PRODUCER="CdkdImportValueProducer"
CONSUMER="CdkdImportValueConsumer"
STATE_KEY_PREFIX="cdkd"
PRODUCER_STATE_KEY="${STATE_KEY_PREFIX}/${PRODUCER}/${AWS_REGION}/state.json"
CONSUMER_STATE_KEY="${STATE_KEY_PREFIX}/${CONSUMER}/${AWS_REGION}/state.json"
INDEX_KEY="${STATE_KEY_PREFIX}/_index/${AWS_REGION}/exports.json"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  ${CDKD} destroy ${CONSUMER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  ${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Pre-flight orphan scan"
aws s3 ls "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: producer state already exists — clean up first."
  exit 1
}
aws s3 ls "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: consumer state already exists — clean up first."
  exit 1
}

echo ""
echo "==> Step 1: Deploy Producer + Consumer"
${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Step 1a: Verify consumer state.imports[] populated"
CONSUMER_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - 2>/dev/null)
IMPORTS_COUNT=$(echo "${CONSUMER_STATE}" | python3 -c 'import sys, json; s = json.load(sys.stdin); print(len(s.get("imports", [])))')
if [[ "${IMPORTS_COUNT}" -lt 1 ]]; then
  echo "FAIL: consumer state has no imports[] entries (got ${IMPORTS_COUNT})"
  echo "${CONSUMER_STATE}" | python3 -m json.tool
  exit 1
fi
echo "    consumer state.imports[]: ${IMPORTS_COUNT} entries (✓)"
SCHEMA_V=$(echo "${CONSUMER_STATE}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["version"])')
# imports[] has been recorded since schema v4; assert version-agnostically (>= 4)
# so a later schema bump (now at v8) does not re-break this test. The imports[]
# presence is asserted separately above.
if [[ "${SCHEMA_V}" -lt 4 ]]; then
  echo "FAIL: consumer state schema version is ${SCHEMA_V}, expected >= 4 (imports[] supported since v4)"
  exit 1
fi
echo "    consumer state schema version: ${SCHEMA_V} (✓)"

echo ""
echo "==> Step 1b: Verify exports index file exists"
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -z "${INDEX_BODY}" ]]; then
  echo "FAIL: exports index file ${INDEX_KEY} not found"
  exit 1
fi
INDEX_EXPORTS=$(echo "${INDEX_BODY}" | python3 -c 'import sys, json; e = json.load(sys.stdin).get("exports", {}); print(len(e))')
echo "    exports index has ${INDEX_EXPORTS} entries (✓)"
if [[ "${INDEX_EXPORTS}" -lt 1 ]]; then
  echo "FAIL: exports index has no entries — should contain at least IntegBucketArn"
  echo "${INDEX_BODY}" | python3 -m json.tool
  exit 1
fi

echo ""
echo "==> Step 2: Attempt producer destroy → expect refusal (strong-ref check)"
set +e
DESTROY_OUTPUT=$(${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force 2>&1)
DESTROY_RC=$?
set -e
if [[ "${DESTROY_RC}" -eq 0 ]]; then
  echo "FAIL: producer destroy unexpectedly succeeded — strong-ref check did not fire"
  echo "${DESTROY_OUTPUT}"
  exit 1
fi
if ! echo "${DESTROY_OUTPUT}" | grep -q "Cannot destroy stack"; then
  echo "FAIL: destroy failed but error message does not match StackHasActiveImportsError shape"
  echo "${DESTROY_OUTPUT}"
  exit 1
fi
if ! echo "${DESTROY_OUTPUT}" | grep -q "IntegBucketArn"; then
  echo "FAIL: error message does not name the offending export"
  echo "${DESTROY_OUTPUT}"
  exit 1
fi
if ! echo "${DESTROY_OUTPUT}" | grep -q "${CONSUMER}"; then
  echo "FAIL: error message does not name the consumer stack"
  echo "${DESTROY_OUTPUT}"
  exit 1
fi
echo "    destroy refused with StackHasActiveImportsError (exit ${DESTROY_RC}) (✓)"
echo "    error message names export IntegBucketArn + consumer ${CONSUMER} (✓)"

echo ""
echo "==> Step 3: Simulate v3 → v4 migration (downgrade consumer state to v3)"
# This exercises the "gradual activation" migration story: a consumer
# left over from a v3 cdkd installation has no imports[] field; producer
# destroy should proceed (no recorded imports to enforce against), and
# subsequent v4 redeploys of the consumer repopulate imports[].
echo "    Rewriting consumer state as version: 3 (dropping imports[])..."
echo "${CONSUMER_STATE}" | python3 -c '
import json, sys
s = json.load(sys.stdin)
s["version"] = 3
if "imports" in s: del s["imports"]
sys.stdout.write(json.dumps(s, indent=2))
' > /tmp/cdkd-consumer-v3.json
aws s3 cp /tmp/cdkd-consumer-v3.json "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" --content-type application/json >/dev/null
echo "    consumer state downgraded to v3 (✓)"

echo ""
echo "==> Step 3a: Producer destroy now proceeds (no imports[] to refuse against)"
set +e
${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
V3_DESTROY_RC=$?
set -e
if [[ "${V3_DESTROY_RC}" -ne 0 ]]; then
  echo "FAIL: producer destroy failed under v3 consumer state (expected to pass)"
  exit 1
fi
echo "    producer destroyed successfully under v3 consumer (✓)"

echo ""
echo "==> Step 3b: Verify exports index dropped the producer's entries"
INDEX_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - 2>/dev/null || true)
if [[ -n "${INDEX_BODY}" ]]; then
  PRODUCER_ENTRIES=$(echo "${INDEX_BODY}" | python3 -c '
import sys, json
e = json.load(sys.stdin).get("exports", {})
count = sum(1 for v in e.values() if v.get("producerStack") == "'${PRODUCER}'")
print(count)
')
  if [[ "${PRODUCER_ENTRIES}" -ne 0 ]]; then
    echo "FAIL: exports index still has ${PRODUCER_ENTRIES} entries owned by ${PRODUCER}"
    echo "${INDEX_BODY}" | python3 -m json.tool
    exit 1
  fi
  echo "    exports index purged ${PRODUCER} entries (✓)"
fi

echo ""
echo "==> Step 3c: Destroy v3 consumer + re-deploy (v3 → v4 transition test)"
# A v3-era consumer becomes v4 on its NEXT change-triggered deploy
# (cdkd skips state-save on no-change deploys, so a clean redeploy
# of an unchanged consumer doesn't promote the schema by itself —
# the user-facing migration story is "consumers re-deploy as part
# of their normal change cycle", which is what we simulate here by
# destroying + recreating). Real-world upgraders will get the same
# promotion the first time any of their consumer's resources change.
${CDKD} destroy ${CONSUMER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
CONSUMER_STATE_V4=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - 2>/dev/null)
V4_VERSION=$(echo "${CONSUMER_STATE_V4}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["version"])')
if [[ "${V4_VERSION}" -lt 4 ]]; then
  echo "FAIL: consumer state version after redeploy is ${V4_VERSION}, expected >= 4"
  exit 1
fi
V4_IMPORTS=$(echo "${CONSUMER_STATE_V4}" | python3 -c 'import sys, json; print(len(json.load(sys.stdin).get("imports", [])))')
if [[ "${V4_IMPORTS}" -lt 1 ]]; then
  echo "FAIL: consumer state.imports[] is empty after redeploy (got ${V4_IMPORTS}), expected at least 1"
  exit 1
fi
echo "    consumer state promoted v3 → v4 with imports[]=${V4_IMPORTS} entries (✓)"

echo ""
echo "==> Step 3d: Strong-ref enforcement now applies again"
set +e
DESTROY_OUTPUT=$(${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force 2>&1)
DESTROY_RC=$?
set -e
if [[ "${DESTROY_RC}" -eq 0 ]]; then
  echo "FAIL: producer destroy unexpectedly succeeded after consumer redeploy — strong-ref check did not re-engage"
  echo "${DESTROY_OUTPUT}"
  exit 1
fi
echo "    producer destroy refused again after consumer redeploy (exit ${DESTROY_RC}) (✓)"

echo ""
echo "==> Step 4: Clean up — destroy Consumer then Producer"
${CDKD} destroy ${CONSUMER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
${CDKD} destroy ${PRODUCER} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Step 5: Final cleanup verification"
# NB: producer state may transiently exist if --force destroy is racing
# AWS resource teardown; the verify trap handles the leftover case.
aws s3 ls "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: producer state still exists after destroy"
  exit 1
} || true
aws s3 ls "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: consumer state still exists after destroy"
  exit 1
} || true
echo "    all state files removed (✓)"

echo ""
echo "==> All import-value-strong-ref smoke tests passed"
trap - EXIT INT TERM
