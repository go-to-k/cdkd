#!/usr/bin/env bash
# verify.sh — cdkd state schema v5 -> v6 migration round-trip integ test
# (issue #459 prep PR).
#
# Proves that v5 -> v6 is transparently auto-migrated by the new binary:
#   1. Deploy the fixture under the latest v5 binary (`@go-to-k/cdkd@0.139.0`)
#      so AWS has a real resource AND cdkd S3 state is written as
#      `version: 5`.
#   2. Swap to the local v6 binary (built from this PR's `dist/cli.js`).
#   3. Re-deploy. The v6 reader must auto-tolerate the missing v6 fields
#      (parentStack / parentLogicalId / parentRegion), the next write
#      must persist `version: 6` silently, and the new parent-* fields
#      must stay undefined on the top-level stack (= absent from the
#      serialized JSON).
#   4. Destroy with the v6 binary. State + AWS resource both gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# The cdkd `/run-integ` skill exports both before invoking verify.sh.

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

STACK="CdkdSchemaV5ToV6Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM_NAME="/cdkd/schema-v5-to-v6-migration/probe"

# The LATEST v5-shipped cdkd version on npm at the time this integ was
# written. The integ uses this as the "pre-PR binary" — deploys under
# it produce a real `version: 5` state file. When v7 lands, this integ
# will be renamed `schema-v6-to-v7-migration` and the version below
# bumps to whatever v6 actually shipped as.
V5_CDKD_VERSION="0.139.0"
V5_TMPDIR=""
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  set +e
  # Try the v6 binary's destroy first (cleanest path).
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak.
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  # v5 binary's lock key (legacy path) — drop just in case.
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  if [ -n "${V5_TMPDIR}" ] && [ -d "${V5_TMPDIR}" ]; then
    rm -rf "${V5_TMPDIR}"
  fi
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
  echo "FAIL: local v6 binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probe from a prior failed integ)"
cleanup

# --- Phase 1: deploy under the v5 binary ---------------------------------
V5_TMPDIR=$(mktemp -d)
echo "==> Installing @go-to-k/cdkd@${V5_CDKD_VERSION} into ${V5_TMPDIR} (the pre-PR v5 binary)"
( cd "${V5_TMPDIR}" && npm init -y >/dev/null && npm install --no-audit --no-fund "@go-to-k/cdkd@${V5_CDKD_VERSION}" >/dev/null )
V5_BIN="${V5_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${V5_BIN}" ]; then
  echo "FAIL: v5 binary not found at ${V5_BIN} after install" >&2
  exit 1
fi

echo "==> Phase 1: deploy with v5 binary (cdkd ${V5_CDKD_VERSION}) -> writes version: 5 state"
CDKD_TEST_SCHEMA_PHASE=v5 node "${V5_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V5_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${V5_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after v5 deploy" >&2
  exit 1
fi
V5_VERSION=$(echo "${V5_STATE}" | jq -r '.version')
if [ "${V5_VERSION}" != "5" ]; then
  echo "FAIL: state.version after v5 deploy is ${V5_VERSION}, expected 5" >&2
  echo "${V5_STATE}" | jq .
  exit 1
fi
echo "    OK: state.version == 5 after v5 deploy"

# --- Phase 2: read v5 state with v6 binary (transparent auto-migration) --
echo "==> Phase 2: read v5 state with v6 binary (transparent auto-migration on read)"
# `state show` is read-only — it must succeed against the v5 blob without
# requiring any user-side migration action. If the v6 reader rejected the
# v5 state, this exits non-zero and the test fails.
node "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" >/dev/null
echo "    OK: v6 binary read v5 state cleanly"

# Confirm the v5 state on S3 is still version: 5 (read alone must not flip it).
V5_STATE_AFTER_READ=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
V5_VERSION_AFTER_READ=$(echo "${V5_STATE_AFTER_READ}" | jq -r '.version')
if [ "${V5_VERSION_AFTER_READ}" != "5" ]; then
  echo "FAIL: read-only 'state show' bumped state.version to ${V5_VERSION_AFTER_READ} (expected 5 — writes only on deploy/destroy)" >&2
  exit 1
fi
echo "    OK: read alone left state.version at 5 (no spurious write)"

# --- Phase 3: re-deploy with v6 binary -> writes version: 6 --------------
echo "==> Phase 3: re-deploy with v6 binary -> upgrades state to version: 6 silently"
# Bump CDKD_TEST_SCHEMA_PHASE so the synthesized template differs from
# Phase 1's — without an actual change cdkd's deploy short-circuits with
# "No changes detected" and skips the state write entirely. The state
# write is what exercises the v5 -> v6 transparent auto-migration we are
# trying to assert; without forcing a write we'd assert nothing.
CDKD_TEST_SCHEMA_PHASE=v6 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V6_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
V6_VERSION=$(echo "${V6_STATE}" | jq -r '.version')
# The local binary always writes the CURRENT schema version, which advances
# over time (v6 -> v7 -> v8 -> ...). Read it from source rather than hardcoding
# so this round-trip keeps asserting "a v5 state auto-migrates to whatever the
# current binary writes" instead of going stale on every schema bump.
EXPECTED_VERSION=$(grep -oE 'STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = [0-9]+' ../../../src/types/state.ts | grep -oE '[0-9]+$')
if [ -z "${EXPECTED_VERSION}" ]; then
  echo "FAIL: could not read STATE_SCHEMA_VERSION_CURRENT from ../../../src/types/state.ts" >&2
  exit 1
fi
if [ "${V6_VERSION}" != "${EXPECTED_VERSION}" ]; then
  echo "FAIL: state.version after re-deploy is ${V6_VERSION}, expected current schema ${EXPECTED_VERSION} (v5 -> current transparent auto-migration)" >&2
  echo "${V6_STATE}" | jq .
  exit 1
fi
echo "    OK: state.version == ${EXPECTED_VERSION} after re-deploy (v5 -> current transparent upgrade)"

# Top-level stack — parent-* fields must stay absent from the serialized
# JSON (JSON.stringify drops undefined values). A spurious `null` or `""`
# here means the writer is leaking placeholder data and the integ should
# fail.
for FIELD in parentStack parentLogicalId parentRegion; do
  if echo "${V6_STATE}" | jq -e "has(\"${FIELD}\")" >/dev/null; then
    echo "FAIL: top-level stack state has ${FIELD} key (= writer leaked a nested-stack-only field)" >&2
    echo "${V6_STATE}" | jq .
    exit 1
  fi
done
echo "    OK: parent-* fields absent from top-level stack state (correct)"

# The AWS resource must still be there — deploy-then-redeploy is a UPDATE
# with no template diff, so cdkd should not have touched the SSM Parameter.
if ! aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${PARAM_NAME} disappeared during the v5 -> v6 migration" >&2
  exit 1
fi
echo "    OK: AWS resource (${PARAM_NAME}) survived the v5 -> v6 migration"

# --- Phase 4: destroy with v6 binary -> clean ----------------------------
echo "==> Phase 4: destroy with v6 binary"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
echo "    OK: SSM parameter is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> schema-v5-to-v6-migration test passed (transparent auto-migration verified)"
