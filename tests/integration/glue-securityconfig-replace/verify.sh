#!/usr/bin/env bash
# verify.sh — cdkd `--replace` flag integ (immutable Glue SecurityConfiguration).
#
# `AWS::Glue::SecurityConfiguration` is immutable on AWS (no
# UpdateSecurityConfiguration API), so cdkd's provider update() throws a typed
# ResourceUpdateNotSupportedError. cdkd has no replacement rule for the type, so
# an EncryptionConfiguration change is classified as an in-place UPDATE. This
# fixture proves the new `--replace` flag:
#   - WITHOUT --replace, re-deploying the immutable change FAILS (the provider
#     rejects the update) — the flag is load-bearing.
#   - WITH --replace, the engine falls back to DELETE + CREATE and the live
#     config reflects the new mode. The type is NOT stateful, so no
#     --force-stateful-recreation is needed.
#
# Phases:
#   1. Deploy with S3EncryptionMode=SSE-S3. Assert the live config shows SSE-S3.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (mode=DISABLED) WITHOUT --replace.
#      Assert the deploy FAILS and the live config is UNCHANGED (still SSE-S3).
#   3. Re-deploy the same change WITH --replace. Assert the deploy SUCCEEDS and
#      the live config now shows DISABLED (the replacement happened).
#   4. Destroy + assert the config is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdGlueSecurityConfigReplaceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SEC_CONFIG="cdkd-replace-test-secconfig"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws glue delete-security-configuration --name "${SEC_CONFIG}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

sec_config_mode() {
  aws glue get-security-configuration --name "${SEC_CONFIG}" --region "${REGION}" \
    --query 'SecurityConfiguration.EncryptionConfiguration.S3Encryption[0].S3EncryptionMode' \
    --output text
}

# --- Phase 1: deploy baseline (SSE-S3) --------------------------------
echo "==> Phase 1: deploy SecurityConfiguration (S3EncryptionMode=SSE-S3)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MODE_P1="$(sec_config_mode)"
if [ "${MODE_P1}" != "SSE-S3" ]; then
  echo "FAIL: expected S3EncryptionMode=SSE-S3 after Phase 1, got '${MODE_P1}'" >&2
  exit 1
fi
echo "    live config S3EncryptionMode=SSE-S3"

# --- Phase 2: immutable change WITHOUT --replace must FAIL -------------
echo "==> Phase 2: re-deploy (mode=DISABLED) WITHOUT --replace (must fail)"
if CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: deploy WITHOUT --replace unexpectedly SUCCEEDED on an immutable change" >&2
  exit 1
fi
echo "    deploy without --replace failed as expected"

# The live config must be UNCHANGED (the failed update touched nothing).
MODE_AFTER_FAIL="$(sec_config_mode)"
if [ "${MODE_AFTER_FAIL}" != "SSE-S3" ]; then
  echo "FAIL: live config changed after a FAILED no-replace deploy (got '${MODE_AFTER_FAIL}')" >&2
  exit 1
fi
echo "    live config unchanged after the failed deploy (still SSE-S3)"

# --- Phase 3: same change WITH --replace must SUCCEED -----------------
echo "==> Phase 3: re-deploy (mode=DISABLED) WITH --replace (must succeed)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --replace --yes

MODE_P3="$(sec_config_mode)"
if [ "${MODE_P3}" != "DISABLED" ]; then
  echo "FAIL: expected S3EncryptionMode=DISABLED after --replace, got '${MODE_P3}'" >&2
  exit 1
fi
echo "    live config S3EncryptionMode=DISABLED — replacement (DELETE + CREATE) applied"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SecurityConfiguration ${SEC_CONFIG} still exists after destroy" aws glue get-security-configuration --name "${SEC_CONFIG}" --region "${REGION}"
echo "    SecurityConfiguration deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — --replace turns an immutable Glue SecurityConfiguration change into a clean DELETE + CREATE (and is required: the no-flag deploy fails), all 4 phases passed"
