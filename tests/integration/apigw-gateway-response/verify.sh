#!/usr/bin/env bash
# verify.sh — cdkd API Gateway GatewayResponse (4xx/5xx CORS headers) integ.
#
# Asserts the DEFAULT_4XX gateway response (CORS header + custom error
# template) actually serves on a live 403, then re-deploys with a changed
# header value + an added DEFAULT_5XX response — which rotates the CDK
# Deployment logical-id hash, exercising the new-Deployment + Stage-repoint +
# old-Deployment-delete dance. Confirmed-clean /hunt-bugs pattern; regression
# guard.
#
# Phases:
#   1. Deploy; curl an unknown path -> 403 must carry
#      access-control-allow-origin: * and the custom error template body.
#   2. Re-deploy with CDKD_TEST_UPDATE=true; the served 403 header must flip
#      to https://app.example.com (proves the Stage repointed to the NEW
#      deployment), DEFAULT_5XX must exist, and the API id must be unchanged
#      (no API replacement).
#   3. Destroy + assert the API is gone and the cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdApigwGatewayResponseExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="cdkd-integ-gwresponse"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

api_id() {
  # `|| true` so a transient AWS CLI failure (throttle, creds) surfaces as an
  # empty id — which the callers turn into an explicit FAIL message — instead
  # of aborting the `$(api_id)` assignment under `set -e` with no diagnostics.
  aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='${API_NAME}'].id | [0]" --output text 2>/dev/null || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local id
  id="$(api_id)"
  if [ -n "${id}" ] && [ "${id}" != "None" ]; then
    aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

# Curl the live 403 until the expected origin header serves (edge propagation
# can lag a deployment by a few seconds). $1 = expected origin value.
wait_403_origin() {
  local expected="$1" id origin
  id="$(api_id)"
  for _ in $(seq 1 12); do
    # `|| true` keeps the loop alive when the header is ABSENT (fresh
    # deployment before the gateway response propagates): without it, grep's
    # exit 1 + pipefail would kill the script on iteration 1 under `set -e`.
    origin="$(curl -si "https://${id}.execute-api.${REGION}.amazonaws.com/prod/nonexistent" 2>/dev/null \
      | tr -d '\r' | grep -i '^access-control-allow-origin:' | awk '{print $2}' || true)"
    if [ "${origin}" = "${expected}" ]; then
      return 0
    fi
    sleep 5
  done
  echo "FAIL: 403 access-control-allow-origin expected '${expected}', last saw '${origin:-<none>}'" >&2
  return 1
}

# --- Phase 1: deploy baseline (DEFAULT_4XX with wildcard origin) --------
echo "==> Phase 1: deploy REST API with DEFAULT_4XX gateway response"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

API_ID_P1="$(api_id)"
if [ -z "${API_ID_P1}" ] || [ "${API_ID_P1}" = "None" ]; then
  echo "FAIL: REST API '${API_NAME}' not found after deploy" >&2
  exit 1
fi

wait_403_origin "*"
BODY="$(curl -s "https://${API_ID_P1}.execute-api.${REGION}.amazonaws.com/prod/nonexistent")"
if ! printf '%s' "${BODY}" | grep -q 'MISSING_AUTHENTICATION_TOKEN'; then
  echo "FAIL: 403 body does not carry the custom gateway response template: ${BODY}" >&2
  exit 1
fi
OK_BODY="$(curl -s "https://${API_ID_P1}.execute-api.${REGION}.amazonaws.com/prod/")"
if ! printf '%s' "${OK_BODY}" | grep -q '"ok":true'; then
  echo "FAIL: GET / did not return the mock integration body: ${OK_BODY}" >&2
  exit 1
fi
echo "    DEFAULT_4XX serves CORS wildcard + custom template; GET / returns mock body"

# --- Phase 2: change header value + add DEFAULT_5XX ---------------------
echo "==> Phase 2: re-deploy with changed origin + added DEFAULT_5XX (Deployment rotation)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

API_ID_P2="$(api_id)"
if [ "${API_ID_P1}" != "${API_ID_P2}" ]; then
  echo "FAIL: REST API was REPLACED (id ${API_ID_P1} -> ${API_ID_P2})" >&2
  exit 1
fi

# Served header must flip — proves the Stage repointed to the NEW deployment.
wait_403_origin "https://app.example.com"
echo "    served 403 origin flipped — Stage repointed to the new Deployment"

FIVEXX="$(aws apigateway get-gateway-responses --rest-api-id "${API_ID_P2}" --region "${REGION}" \
  --query "items[?responseType=='DEFAULT_5XX' && !defaultResponse] | length(@)" --output text)"
if [ "${FIVEXX}" != "1" ]; then
  echo "FAIL: DEFAULT_5XX gateway response not found after update" >&2
  exit 1
fi
echo "    DEFAULT_5XX gateway response added"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

API_ID_P3="$(api_id)"
if [ -n "${API_ID_P3}" ] && [ "${API_ID_P3}" != "None" ]; then
  echo "FAIL: REST API '${API_NAME}' still exists after destroy" >&2
  exit 1
fi
echo "    REST API deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — API Gateway GatewayResponse deploy/update/destroy, all 3 phases passed"
