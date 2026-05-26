#!/usr/bin/env bash
# verify.sh — cdkd state schema v6 -> v7 migration round-trip integ test
# (issue #614).
#
# Proves that v6 -> v7 is transparently auto-migrated by the new binary:
#   1. Deploy the fixture under the latest v6 binary (`@go-to-k/cdkd@0.159.3`)
#      so AWS has a real resource AND cdkd S3 state is written as
#      `version: 6` with no `provisionedBy` field on the resource.
#   2. Swap to the local v7 binary (built from this PR's `dist/cli.js`).
#   3. Re-deploy. The v7 reader must auto-tolerate the missing
#      `provisionedBy` field, the next write must persist `version: 7`
#      silently, and every resource without a state-recorded layer must
#      land at `provisionedBy: 'sdk'` (legacy default — the SSM Parameter
#      has no silent-drop properties, so the auto-route does not fire).
#   4. Destroy with the v7 binary. State + AWS resource both gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# The cdkd `/run-integ` skill exports both before invoking verify.sh.

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdSchemaV6ToV7Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_NAME="/cdkd/schema-v6-to-v7-migration/probe"

# The LATEST v6-shipped cdkd version on npm at the time this integ was
# written. The integ uses this as the "pre-PR binary" — deploys under
# it produce a real `version: 6` state file. When v8 lands, this integ
# will be renamed `schema-v7-to-v8-migration` and the version below
# bumps to whatever v7 actually shipped as.
V6_CDKD_VERSION="0.159.3"
V6_TMPDIR=""
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  set +e
  # Try the v7 binary's destroy first (cleanest path).
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak.
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  if [ -n "${V6_TMPDIR}" ] && [ -d "${V6_TMPDIR}" ]; then
    rm -rf "${V6_TMPDIR}"
  fi
  set -e
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local v7 binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probe from a prior failed integ)"
cleanup

# --- Phase 1: deploy under the v6 binary ---------------------------------
V6_TMPDIR=$(mktemp -d)
echo "==> Installing @go-to-k/cdkd@${V6_CDKD_VERSION} into ${V6_TMPDIR} (the pre-PR v6 binary)"
( cd "${V6_TMPDIR}" && npm init -y >/dev/null && npm install --no-audit --no-fund "@go-to-k/cdkd@${V6_CDKD_VERSION}" >/dev/null )
V6_BIN="${V6_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${V6_BIN}" ]; then
  echo "FAIL: v6 binary not found at ${V6_BIN} after install" >&2
  exit 1
fi

echo "==> Phase 1: deploy with v6 binary (cdkd ${V6_CDKD_VERSION}) -> writes version: 6 state"
CDKD_TEST_SCHEMA_PHASE=v6 node "${V6_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V6_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${V6_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after v6 deploy" >&2
  exit 1
fi
V6_VERSION=$(echo "${V6_STATE}" | jq -r '.version')
if [ "${V6_VERSION}" != "6" ]; then
  echo "FAIL: state.version after v6 deploy is ${V6_VERSION}, expected 6" >&2
  echo "${V6_STATE}" | jq .
  exit 1
fi
echo "    OK: state.version == 6 after v6 deploy"

# The v6 binary must NOT have written `provisionedBy` on the resource.
# v6 doesn't know about the field; if it leaked there, the integ tells us
# that the chosen V6_CDKD_VERSION is actually v7+ and we picked the wrong
# pre-PR pin.
if echo "${V6_STATE}" | jq -e '.resources.MigrationProbe | has("provisionedBy")' >/dev/null; then
  echo "FAIL: v6 binary wrote provisionedBy on the resource (= wrong V6_CDKD_VERSION pin)" >&2
  echo "${V6_STATE}" | jq .
  exit 1
fi
echo "    OK: v6 binary left provisionedBy unset (correct)"

# --- Phase 2: read v6 state with v7 binary (transparent auto-migration) --
echo "==> Phase 2: read v6 state with v7 binary (transparent auto-migration on read)"
# `state show` is read-only — it must succeed against the v6 blob without
# requiring any user-side migration action.
node "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" >/dev/null
echo "    OK: v7 binary read v6 state cleanly"

# Confirm the v6 state on S3 is still version: 6 (read alone must not flip it).
V6_STATE_AFTER_READ=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
V6_VERSION_AFTER_READ=$(echo "${V6_STATE_AFTER_READ}" | jq -r '.version')
if [ "${V6_VERSION_AFTER_READ}" != "6" ]; then
  echo "FAIL: read-only 'state show' bumped state.version to ${V6_VERSION_AFTER_READ} (expected 6 — writes only on deploy/destroy)" >&2
  exit 1
fi
echo "    OK: read alone left state.version at 6 (no spurious write)"

# --- Phase 3: re-deploy with v7 binary -> writes version: 7 --------------
echo "==> Phase 3: re-deploy with v7 binary -> upgrades state to version: 7 silently"
# Bump CDKD_TEST_SCHEMA_PHASE so the synthesized template differs from
# Phase 1's — without an actual change cdkd's deploy short-circuits with
# "No changes detected" and skips the state write entirely.
CDKD_TEST_SCHEMA_PHASE=v7 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V7_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
V7_VERSION=$(echo "${V7_STATE}" | jq -r '.version')
if [ "${V7_VERSION}" != "7" ]; then
  echo "FAIL: state.version after v7 deploy is ${V7_VERSION}, expected 7" >&2
  echo "${V7_STATE}" | jq .
  exit 1
fi
echo "    OK: state.version == 7 after v7 deploy (transparent upgrade)"

# The SSM Parameter has no silent-drop properties, so the v7 writer must
# land it on the SDK Provider path. After the Phase 3 update the resource
# record MUST carry provisionedBy: 'sdk'. This is the load-bearing
# assertion of #614 — the new binary explicitly stamps the routing layer
# on every resource so the next update / destroy is deterministic.
PROVISIONED=$(echo "${V7_STATE}" | jq -r '.resources.MigrationProbe.provisionedBy // ""')
if [ "${PROVISIONED}" != "sdk" ]; then
  echo "FAIL: resources.MigrationProbe.provisionedBy is '${PROVISIONED}', expected 'sdk'" >&2
  echo "${V7_STATE}" | jq .
  exit 1
fi
echo "    OK: resources.MigrationProbe.provisionedBy == 'sdk' (correct routing)"

# The AWS resource must still be there — deploy-then-redeploy is a UPDATE
# with a string-value diff only; the SSM parameter survives the update.
if ! aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${PARAM_NAME} disappeared during the v6 -> v7 migration" >&2
  exit 1
fi
echo "    OK: AWS resource (${PARAM_NAME}) survived the v6 -> v7 migration"

# --- Phase 4: destroy with v7 binary -> clean ----------------------------
echo "==> Phase 4: destroy with v7 binary"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${PARAM_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: SSM parameter is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> schema-v6-to-v7-migration test passed (transparent auto-migration verified)"
