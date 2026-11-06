#!/usr/bin/env bash
# verify.sh — cdkd AppConfig Environment destroy honors DeletionProtectionCheck
# (go-to-k/cdkd#5875).
#
# The environment declares DeletionProtectionCheck BYPASS. AppConfig takes that
# value on DeleteEnvironment itself and stores it nowhere, so a delete that does
# not forward it gets the account default (check on) and is refused with
# "actively being used" while the environment was read recently. Cloud Control
# sent only the identifier, which is the failure this fixture reproduces.
#
# Phases:
#   1. Deploy. Assert the environment exists and has a COMPLETE deployment.
#   2. Read the configuration through appconfigdata so AppConfig counts the
#      environment as recently used (no account setting is changed).
#   3. Destroy. Assert it succeeds, the application is gone and cdkd state too.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdAppConfigEnvDelProtExample"
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
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_app
  [ -z "${CONFIG_OUT:-}" ] || rm -f "${CONFIG_OUT}"
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (Environment with DeletionProtectionCheck BYPASS)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

APP_ID="$(app_id)"
if [ -z "${APP_ID}" ] || [ "${APP_ID}" = "None" ]; then
  echo "FAIL: application ${APP_NAME} not found after Phase 1" >&2
  exit 1
fi
ENV_ID="$(aws appconfig list-environments --application-id "${APP_ID}" --region "${REGION}" --query 'Items[0].Id' --output text)"
PROFILE_ID="$(aws appconfig list-configuration-profiles --application-id "${APP_ID}" --region "${REGION}" --query 'Items[0].Id' --output text)"
ENV_STATE="$(aws appconfig get-environment --application-id "${APP_ID}" --environment-id "${ENV_ID}" --region "${REGION}" --query State --output text)"
if [ "${ENV_STATE}" != "ReadyForDeployment" ]; then
  echo "FAIL: environment state is '${ENV_STATE}', expected ReadyForDeployment" >&2
  exit 1
fi
echo "    environment ${ENV_ID} is ReadyForDeployment"

# --- Phase 2: read the configuration so the environment counts as in use --
echo "==> Phase 2: read the configuration through appconfigdata"
TOKEN="$(aws appconfigdata start-configuration-session --application-identifier "${APP_ID}" \
  --environment-identifier "${ENV_ID}" --configuration-profile-identifier "${PROFILE_ID}" \
  --region "${REGION}" --query InitialConfigurationToken --output text)"
if [ -z "${TOKEN}" ] || [ "${TOKEN}" = "None" ]; then
  echo "FAIL: no configuration session token from appconfigdata" >&2
  exit 1
fi
CONFIG_OUT="$(mktemp)"
aws appconfigdata get-latest-configuration --configuration-token "${TOKEN}" \
  --region "${REGION}" "${CONFIG_OUT}" >/dev/null
if ! grep -q '"feature"' "${CONFIG_OUT}"; then
  echo "FAIL: the polled configuration does not hold the deployed content" >&2
  exit 1
fi
echo "    configuration read (the environment was just polled)"

# --- Phase 3: destroy straight after the read ----------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

LEFT_APP="$(app_id)"
if [ -n "${LEFT_APP}" ] && [ "${LEFT_APP}" != "None" ]; then
  echo "FAIL: application ${APP_NAME} still exists after destroy (id ${LEFT_APP})" >&2
  exit 1
fi
echo "    application and environment deleted"

assert_gone "environment ${ENV_ID} still exists after destroy" aws appconfig get-environment --application-id "${APP_ID}" --environment-id "${ENV_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — destroy of a recently polled AppConfig Environment honors DeletionProtectionCheck BYPASS"
