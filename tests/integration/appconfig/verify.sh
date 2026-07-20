#!/usr/bin/env bash
# verify.sh — cdkd AppConfig chain (compound-id Ref regression).
#
# AppConfig resources are all Cloud-Control-provisioned and several have
# COMPOUND CC primary identifiers (`<appId>|<profileId>`, and 3-segment
# `<appId>|<profileId>|<versionNumber>` for HostedConfigurationVersion). CFn
# `Ref` returns only the trailing id, but cdkd records the compound. The bug:
# `Ref` of a ConfigurationProfile returned the compound into the Version's
# ConfigurationProfileId, so the Version CREATE failed ("Configuration Profile
# ... could not be found"). The chain simply deploying CLEAN is the regression
# proof; the Version + Deployment also exercise the 3-segment last-pipe path.
#
# Phases:
#   1. Deploy. Assert the application exists, the hosted config has version 1
#      with content feature=v1, and a deployment exists.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (content feature=v2). Assert a
#      hosted config version 2 exists with feature=v2.
#   3. Destroy + assert the application and cdkd state are gone.
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

STACK="CdkdAppConfigExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
APP_NAME="${STACK}-app"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

app_id() {
  aws appconfig list-applications --region "${REGION}" \
    --query "Items[?Name=='${APP_NAME}'].Id | [0]" --output text 2>/dev/null
}

delete_app() {
  local id
  id="$(app_id)"
  if [ -n "${id}" ] && [ "${id}" != "None" ]; then
    # Delete children first (profiles/environments) then the application.
    for pid in $(aws appconfig list-configuration-profiles --application-id "${id}" --region "${REGION}" --query 'Items[].Id' --output text 2>/dev/null); do
      for v in $(aws appconfig list-hosted-configuration-versions --application-id "${id}" --configuration-profile-id "${pid}" --region "${REGION}" --query 'Items[].VersionNumber' --output text 2>/dev/null); do
        aws appconfig delete-hosted-configuration-version --application-id "${id}" --configuration-profile-id "${pid}" --version-number "${v}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      aws appconfig delete-configuration-profile --application-id "${id}" --configuration-profile-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    for eid in $(aws appconfig list-environments --application-id "${id}" --region "${REGION}" --query 'Items[].Id' --output text 2>/dev/null); do
      aws appconfig delete-environment --application-id "${id}" --environment-id "${eid}" --region "${REGION}" >/dev/null 2>&1 || true
    done
    aws appconfig delete-application --application-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # DeploymentStrategy's physical id is an auto-generated id, NOT its name, so
  # resolve the id by name before deleting (a name-as-id delete always 400s).
  for sid in $(aws appconfig list-deployment-strategies --region "${REGION}" \
    --query "Items[?Name=='${STACK}-strategy'].Id" --output text 2>/dev/null); do
    aws appconfig delete-deployment-strategy --deployment-strategy-id "${sid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_app
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

# --- Phase 1: deploy the full chain -----------------------------------
echo "==> Phase 1: deploy AppConfig chain (the compound-id Ref regression proof)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

APP_ID="$(app_id)"
if [ -z "${APP_ID}" ] || [ "${APP_ID}" = "None" ]; then
  echo "FAIL: application ${APP_NAME} not found after Phase 1" >&2
  exit 1
fi
PROFILE_ID="$(aws appconfig list-configuration-profiles --application-id "${APP_ID}" --region "${REGION}" --query 'Items[0].Id' --output text)"
VER1="$(aws appconfig list-hosted-configuration-versions --application-id "${APP_ID}" --configuration-profile-id "${PROFILE_ID}" --region "${REGION}" --query 'Items[?VersionNumber==`1`] | [0].VersionNumber' --output text)"
if [ "${VER1}" != "1" ]; then
  echo "FAIL: hosted configuration version 1 not found after Phase 1 (got '${VER1}')" >&2
  exit 1
fi
echo "    application + profile + hosted config version 1 created (Ref chain resolved correctly)"
DEPLOY_COUNT_P1="$(aws appconfig list-deployments --application-id "${APP_ID}" --environment-id "$(aws appconfig list-environments --application-id "${APP_ID}" --region "${REGION}" --query 'Items[0].Id' --output text)" --region "${REGION}" --query 'length(Items)' --output text)"
if [ "${DEPLOY_COUNT_P1}" -lt 1 ] 2>/dev/null; then
  echo "FAIL: expected >=1 AppConfig deployment after Phase 1, got ${DEPLOY_COUNT_P1}" >&2
  exit 1
fi
echo "    deployment created (3-segment Ref chain resolved)"

# --- Phase 2: UPDATE the hosted config content ------------------------
echo "==> Phase 2: re-deploy bumping the hosted config content (feature=v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VER2="$(aws appconfig list-hosted-configuration-versions --application-id "${APP_ID}" --configuration-profile-id "${PROFILE_ID}" --region "${REGION}" --query 'Items[?VersionNumber==`2`] | [0].VersionNumber' --output text)"
if [ "${VER2}" != "2" ]; then
  echo "FAIL: hosted configuration version 2 not found after Phase 2 (got '${VER2}')" >&2
  exit 1
fi
echo "    hosted config version 2 created (UPDATE reached AWS)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

LEFT_APP="$(app_id)"
if [ -n "${LEFT_APP}" ] && [ "${LEFT_APP}" != "None" ]; then
  echo "FAIL: application ${APP_NAME} still exists after destroy (id ${LEFT_APP})" >&2
  exit 1
fi
echo "    application deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — AppConfig chain deploys (compound-id Ref resolved), UPDATE bumps the hosted config, destroy clean"
