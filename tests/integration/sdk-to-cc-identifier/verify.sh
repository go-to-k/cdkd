#!/usr/bin/env bash
# verify.sh — SDK-recorded resource moved to Cloud Control keeps working (#6976).
#
# AWS::ApiGateway::Deployment is SDK-served; its physical id is the bare
# deployment id. StageDescription is SDK-unwired and not create-only, so adding
# it routes the UPDATE to Cloud Control, whose identifier is
# `<DeploymentId>|<RestApiId>`.
#
# Phases:
#   1. Deploy: Deployment recorded by the SDK provider, bare physicalId.
#   2. Deploy with CDKD_TEST_UPDATE=true (adds StageDescription): exit 0,
#      record provisionedBy == cc-api, physicalId == "<deploymentId>|<restApiId>",
#      live deployment still exists.
#   3. Destroy: REST API + deployment gone, state removed.
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

STACK="CdkdSdkToCcIdentifier"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="cdkd-sdk-to-cc-id-api"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi

  local api_id
  for api_id in $(aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='${API_NAME}'].id" --output text 2>/dev/null); do
    aws apigateway delete-rest-api --region "${REGION}" --rest-api-id "${api_id}" >/dev/null 2>&1
  done

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

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# state_field <resource-type> <jq-field>: read one field of the single record
# of that type from the state file; fails loudly unless exactly one matches.
state_field() {
  local rtype="$1" field="$2" body count
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
  count="$(printf '%s' "${body}" | jq -r --arg t "${rtype}" \
    '[.resources[] | select(.resourceType==$t)] | length')"
  if [ "${count}" != "1" ]; then
    echo "FAIL: expected exactly one ${rtype} record in state, found ${count}" >&2
    exit 1
  fi
  printf '%s' "${body}" | jq -r --arg t "${rtype}" \
    ".resources[] | select(.resourceType==\$t) | ${field}"
}

# --- Phase 1: SDK-created Deployment ----------------------------------------
echo "==> Phase 1: deploy (Deployment via the SDK provider)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ROUTE_P1="$(state_field AWS::ApiGateway::Deployment '.provisionedBy // "sdk"')"
DEPLOYMENT_ID="$(state_field AWS::ApiGateway::Deployment '.physicalId')"
API_ID="$(state_field AWS::ApiGateway::RestApi '.physicalId')"
if [ "${ROUTE_P1}" != "sdk" ]; then
  echo "FAIL: phase 1 Deployment routed via '${ROUTE_P1}', expected sdk" >&2
  exit 1
fi
case "${DEPLOYMENT_ID}" in
  ''|*'|'*) echo "FAIL: phase 1 Deployment physicalId '${DEPLOYMENT_ID}' empty or contains '|'" >&2; exit 1 ;;
esac
if [ -z "${API_ID}" ]; then
  echo "FAIL: RestApi physicalId empty" >&2
  exit 1
fi
echo "    Deployment recorded by sdk, physicalId=${DEPLOYMENT_ID}, restApiId=${API_ID}"

# --- Phase 2: UPDATE routed to Cloud Control --------------------------------
echo "==> Phase 2: re-deploy adding StageDescription (SDK-unwired -> Cloud Control)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ROUTE_P2="$(state_field AWS::ApiGateway::Deployment '.provisionedBy // "sdk"')"
PID_P2="$(state_field AWS::ApiGateway::Deployment '.physicalId')"
if [ "${ROUTE_P2}" != "cc-api" ]; then
  echo "FAIL: phase 2 Deployment provisionedBy '${ROUTE_P2}', expected cc-api" >&2
  exit 1
fi
if [ "${PID_P2}" != "${DEPLOYMENT_ID}|${API_ID}" ]; then
  echo "FAIL: phase 2 physicalId '${PID_P2}', expected '${DEPLOYMENT_ID}|${API_ID}'" >&2
  exit 1
fi
aws apigateway get-deployment --region "${REGION}" \
  --rest-api-id "${API_ID}" --deployment-id "${DEPLOYMENT_ID}" >/dev/null
echo "    provisionedBy=cc-api, physicalId=${PID_P2}, live deployment still exists"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "Deployment ${DEPLOYMENT_ID} still exists after destroy" \
  aws apigateway get-deployment --region "${REGION}" --rest-api-id "${API_ID}" --deployment-id "${DEPLOYMENT_ID}"
assert_gone "REST API ${API_ID} still exists after destroy" \
  aws apigateway get-rest-api --region "${REGION}" --rest-api-id "${API_ID}"
echo "    deployment and REST API gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "    cdkd state removed"

echo "[verify] PASS — SDK-recorded Deployment moved to Cloud Control via StageDescription: identifier translated to <DeploymentId>|<RestApiId>, deployment intact, destroy clean"
