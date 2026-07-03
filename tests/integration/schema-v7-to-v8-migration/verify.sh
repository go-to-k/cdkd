#!/usr/bin/env bash
# verify.sh — cdkd state schema v7 -> v8 migration round-trip integ test
# (issue #668).
#
# Proves that v7 -> v8 is transparently auto-migrated by the new binary
# AND that Fn::GetStackOutput resolutions populate the new outputReads
# field on the consumer's state:
#   1. Deploy Producer + Consumer under the latest v7 binary
#      (@go-to-k/cdkd@0.167.1) so AWS has real resources AND cdkd S3
#      state for both stacks is written as `version: 7`. The Consumer
#      has NO `outputReads` field (v7 doesn't know about it).
#   2. Read the Consumer state with the local v8 binary — must succeed
#      against the v7 blob without any user-side migration action.
#   3. Re-deploy the Consumer with the local v8 binary. The v8 writer
#      must auto-migrate the on-disk state to `version: 8` AND populate
#      the new `outputReads[]` field with one entry pointing at
#      (Producer, region, ProducerArn).
#   4. Destroy Consumer then Producer with the v8 binary. State + AWS
#      resources both gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# The cdkd `/run-integ` skill exports both before invoking verify.sh.

set -euo pipefail

cd "$(dirname "$0")"

PRODUCER_STACK="CdkdSchemaV7ToV8MigrationProducer"
CONSUMER_STACK="CdkdSchemaV7ToV8MigrationConsumer"
REGION="${AWS_REGION:-us-east-1}"
PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${REGION}/state.json"
PRODUCER_PARAM_NAME="/cdkd/schema-v7-to-v8-migration/producer"
CONSUMER_PARAM_NAME="/cdkd/schema-v7-to-v8-migration/consumer"

# The LATEST v7-shipped cdkd version on npm at the time this integ was
# written. The integ uses this as the "pre-PR binary" — deploys under
# it produce real `version: 7` state files. When v9 lands, this integ
# will be renamed `schema-v8-to-v9-migration` and the version below
# bumps to whatever v8 actually shipped as.
V7_CDKD_VERSION="0.167.1"
V7_TMPDIR=""
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  set +e
  # Try the v8 binary's destroy first (cleanest path). Consumer first,
  # producer last — Fn::GetStackOutput is a weak reference so order
  # doesn't strictly matter, but mirrors real-world recommended order.
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${CONSUMER_STACK}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${PRODUCER_STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak.
  aws ssm delete-parameter --name "${CONSUMER_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PRODUCER_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CONSUMER_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${PRODUCER_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  if [ -n "${V7_TMPDIR}" ] && [ -d "${V7_TMPDIR}" ]; then
    rm -rf "${V7_TMPDIR}"
  fi
  set -e
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local v8 binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probes from a prior failed integ)"
cleanup

# --- Phase 1: deploy Producer + Consumer under the v7 binary -------------
V7_TMPDIR=$(mktemp -d)
echo "==> Installing @go-to-k/cdkd@${V7_CDKD_VERSION} into ${V7_TMPDIR} (the pre-PR v7 binary)"
( cd "${V7_TMPDIR}" && npm init -y >/dev/null && npm install --no-audit --no-fund "@go-to-k/cdkd@${V7_CDKD_VERSION}" >/dev/null )
V7_BIN="${V7_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${V7_BIN}" ]; then
  echo "FAIL: v7 binary not found at ${V7_BIN} after install" >&2
  exit 1
fi

echo "==> Phase 1a: deploy Producer with v7 binary (cdkd ${V7_CDKD_VERSION}) -> writes version: 7 state"
CDKD_TEST_SCHEMA_PHASE=v7 node "${V7_BIN}" deploy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

PRODUCER_V7_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)
PRODUCER_V7_VERSION=$(echo "${PRODUCER_V7_STATE}" | jq -r '.version')
if [ "${PRODUCER_V7_VERSION}" != "7" ]; then
  echo "FAIL: producer state.version after v7 deploy is ${PRODUCER_V7_VERSION}, expected 7" >&2
  echo "${PRODUCER_V7_STATE}" | jq .
  exit 1
fi
echo "    OK: producer state.version == 7 after v7 deploy"

echo "==> Phase 1b: deploy Consumer with v7 binary -> writes version: 7 state, NO outputReads field"
CDKD_TEST_SCHEMA_PHASE=v7 node "${V7_BIN}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

CONSUMER_V7_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - 2>/dev/null)
CONSUMER_V7_VERSION=$(echo "${CONSUMER_V7_STATE}" | jq -r '.version')
if [ "${CONSUMER_V7_VERSION}" != "7" ]; then
  echo "FAIL: consumer state.version after v7 deploy is ${CONSUMER_V7_VERSION}, expected 7" >&2
  echo "${CONSUMER_V7_STATE}" | jq .
  exit 1
fi
echo "    OK: consumer state.version == 7 after v7 deploy"

# The v7 binary must NOT have written `outputReads` on the consumer's
# state. v7 doesn't know about the field; if it leaked there, the integ
# tells us that the chosen V7_CDKD_VERSION is actually v8+ and we
# picked the wrong pre-PR pin.
CONSUMER_V7_HAS_OUTPUT_READS=$(echo "${CONSUMER_V7_STATE}" | jq -r 'has("outputReads")')
if [ "${CONSUMER_V7_HAS_OUTPUT_READS}" = "true" ]; then
  echo "FAIL: v7 binary wrote outputReads on consumer state (= wrong V7_CDKD_VERSION pin)" >&2
  echo "${CONSUMER_V7_STATE}" | jq .
  exit 1
fi
echo "    OK: v7 binary left outputReads unset on consumer (correct)"

# --- Phase 2: read v7 consumer state with v8 binary (transparent auto-migration) --
echo "==> Phase 2: read v7 consumer state with v8 binary (transparent auto-migration on read)"
node "${LOCAL_DIST}" state show "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" >/dev/null
echo "    OK: v8 binary read v7 consumer state cleanly"

# Confirm the v7 state on S3 is still version: 7 (read alone must not flip it).
CONSUMER_V7_AFTER_READ=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - 2>/dev/null)
CONSUMER_V7_VERSION_AFTER_READ=$(echo "${CONSUMER_V7_AFTER_READ}" | jq -r '.version')
if [ "${CONSUMER_V7_VERSION_AFTER_READ}" != "7" ]; then
  echo "FAIL: read-only 'state show' bumped consumer state.version to ${CONSUMER_V7_VERSION_AFTER_READ} (expected 7 — writes only on deploy/destroy)" >&2
  exit 1
fi
echo "    OK: read alone left consumer state.version at 7 (no spurious write)"

# --- Phase 3: re-deploy consumer with v8 binary -> writes version: 8 + outputReads --
echo "==> Phase 3: re-deploy consumer with v8 binary -> upgrades to version: 8 + populates outputReads silently"
CDKD_TEST_SCHEMA_PHASE=v8 node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

CONSUMER_V8_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" - 2>/dev/null)
CONSUMER_V8_VERSION=$(echo "${CONSUMER_V8_STATE}" | jq -r '.version')
if [ "${CONSUMER_V8_VERSION}" != "8" ]; then
  echo "FAIL: consumer state.version after v8 deploy is ${CONSUMER_V8_VERSION}, expected 8" >&2
  echo "${CONSUMER_V8_STATE}" | jq .
  exit 1
fi
echo "    OK: consumer state.version == 8 after v8 deploy (transparent upgrade)"

# The v8 binary must have populated outputReads with one entry that
# names the producer + region + output. This is the load-bearing
# assertion of #668 — the new binary explicitly records every
# Fn::GetStackOutput resolution so findDownstreamConsumers can name
# the GetStackOutput-side consumers in the recreate warn block.
OUTPUT_READS_COUNT=$(echo "${CONSUMER_V8_STATE}" | jq -r '(.outputReads // []) | length')
if [ "${OUTPUT_READS_COUNT}" -ne 1 ]; then
  echo "FAIL: expected 1 outputReads entry on consumer state, got ${OUTPUT_READS_COUNT}" >&2
  echo "${CONSUMER_V8_STATE}" | jq .
  exit 1
fi

OUTPUT_READS_SOURCE_STACK=$(echo "${CONSUMER_V8_STATE}" | jq -r '.outputReads[0].sourceStack')
OUTPUT_READS_SOURCE_REGION=$(echo "${CONSUMER_V8_STATE}" | jq -r '.outputReads[0].sourceRegion')
OUTPUT_READS_OUTPUT_NAME=$(echo "${CONSUMER_V8_STATE}" | jq -r '.outputReads[0].outputName')

if [ "${OUTPUT_READS_SOURCE_STACK}" != "${PRODUCER_STACK}" ]; then
  echo "FAIL: outputReads[0].sourceStack = '${OUTPUT_READS_SOURCE_STACK}', expected '${PRODUCER_STACK}'" >&2
  exit 1
fi
if [ "${OUTPUT_READS_SOURCE_REGION}" != "${REGION}" ]; then
  echo "FAIL: outputReads[0].sourceRegion = '${OUTPUT_READS_SOURCE_REGION}', expected '${REGION}'" >&2
  exit 1
fi
if [ "${OUTPUT_READS_OUTPUT_NAME}" != "ProducerArn" ]; then
  echo "FAIL: outputReads[0].outputName = '${OUTPUT_READS_OUTPUT_NAME}', expected 'ProducerArn'" >&2
  exit 1
fi
echo "    OK: consumer state.outputReads[0] = (${OUTPUT_READS_SOURCE_STACK}, ${OUTPUT_READS_SOURCE_REGION}, ${OUTPUT_READS_OUTPUT_NAME})"

# Producer state should still be version: 7 (we only re-deployed the
# consumer in Phase 3 — the producer's state hasn't been touched).
# This is the test that v8 readers correctly tolerate v7 state files
# (= reads degrade gracefully, no spurious writes).
PRODUCER_AFTER_PHASE_3=$(aws s3 cp "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" - 2>/dev/null)
PRODUCER_VERSION_AFTER_PHASE_3=$(echo "${PRODUCER_AFTER_PHASE_3}" | jq -r '.version')
if [ "${PRODUCER_VERSION_AFTER_PHASE_3}" != "7" ]; then
  echo "FAIL: producer state.version drifted to ${PRODUCER_VERSION_AFTER_PHASE_3} during consumer-only Phase 3 deploy (expected 7 — consumer redeploy must not touch producer)" >&2
  exit 1
fi
echo "    OK: producer state.version still 7 after consumer-only Phase 3 deploy"

# The consumer's SSM parameter must hold the producer's ARN value
# (Fn::GetStackOutput resolved correctly under the v8 binary).
CONSUMER_PARAM_VALUE=$(aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${REGION}" --query 'Parameter.Value' --output text 2>/dev/null)
PRODUCER_PARAM_ARN=$(aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${REGION}" --query 'Parameter.ARN' --output text 2>/dev/null)
if [ "${CONSUMER_PARAM_VALUE}" != "${PRODUCER_PARAM_ARN}" ]; then
  echo "FAIL: consumer parameter value '${CONSUMER_PARAM_VALUE}' does not match producer ARN '${PRODUCER_PARAM_ARN}'" >&2
  exit 1
fi
echo "    OK: consumer parameter value resolved to producer ARN via Fn::GetStackOutput"

# --- Phase 4: destroy under v8 binary -> clean ---------------------------
echo "==> Phase 4a: destroy Consumer with v8 binary"
node "${LOCAL_DIST}" destroy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: consumer parameter still exists after destroy" >&2
  exit 1
fi
if aws s3 ls "s3://${STATE_BUCKET}/${CONSUMER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: consumer state file still exists after destroy" >&2
  exit 1
fi
echo "    OK: consumer is gone (AWS resource + state)"

echo "==> Phase 4b: destroy Producer with v8 binary"
node "${LOCAL_DIST}" destroy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: producer parameter still exists after destroy" >&2
  exit 1
fi
if aws s3 ls "s3://${STATE_BUCKET}/${PRODUCER_STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: producer state file still exists after destroy" >&2
  exit 1
fi
echo "    OK: producer is gone (AWS resource + state)"

echo ""
echo "==> schema-v7-to-v8-migration test passed (transparent auto-migration + outputReads populated)"
