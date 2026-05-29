#!/usr/bin/env bash
# verify.sh — cdkd API Gateway V2 (HTTP API) property-coverage backfill
# integ test (issue #609).
#
# Asserts that the ApiGatewayV2 config props wired by the #609 backfill
# actually reach AWS on deploy:
#   - AWS::ApiGatewayV2::Api    DisableExecuteApiEndpoint (false) + Version (v1)
#     via CreateApi.
#   - AWS::ApiGatewayV2::Stage  StageVariables ({env: test}) +
#     DefaultRouteSettings (ThrottlingRateLimit 50 / DetailedMetricsEnabled)
#     via CreateStage.
#   - AWS::ApiGatewayV2::Integration  TimeoutInMillis (15000) +
#     RequestParameters (append:header.x-cdkd-test) + Description via
#     CreateIntegration.
#   - AWS::ApiGatewayV2::Route  AuthorizationScopes (email + openid) +
#     OperationName (GetDefault) on the $default route via CreateRoute.
#   - AWS::ApiGatewayV2::Authorizer  AuthorizerResultTtlInSeconds (300) +
#     EnableSimpleResponses (true) on the standalone REQUEST authorizer
#     via CreateAuthorizer.
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="ServerlessApiStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

API_NAME="cdkd-serverless-api"
STAGE_NAME='$default'
ROUTE_KEY='$default'
REQUEST_AUTHORIZER_NAME="request-authorizer"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    # Only force-remove the state key when `state destroy` SUCCEEDED. A clean
    # `state destroy --yes` already removes state; a FAILED one must leave
    # state behind so the resources it could not delete are NOT orphaned (and
    # so a retry / diagnosis can still find them). The lock key is always safe
    # to drop so a subsequent run can acquire it.
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT

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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the HTTP API id by name --------------------------------------
API_ID=$(aws apigatewayv2 get-apis --region "${REGION}" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAIL: could not resolve HTTP API id for name ${API_NAME}" >&2
  exit 1
fi
echo "    resolved API id: ${API_ID}"

# --- Assertion 1: Api DisableExecuteApiEndpoint + Version reached AWS ------
API=$(aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}")
DEAE=$(echo "${API}" | jq -r '.DisableExecuteApiEndpoint')
API_VERSION=$(echo "${API}" | jq -r '.Version // empty')
if [ "${DEAE}" != "false" ]; then
  echo "FAIL: Api DisableExecuteApiEndpoint is '${DEAE}', expected 'false'" >&2
  echo "      raw GetApi: ${API}" >&2
  exit 1
fi
if [ "${API_VERSION}" != "v1" ]; then
  echo "FAIL: Api Version is '${API_VERSION}', expected 'v1'" >&2
  exit 1
fi
echo "    OK: Api DisableExecuteApiEndpoint == false + Version == v1 on AWS (Api backfill CLOSED)"

# --- Assertion 2: Stage StageVariables + DefaultRouteSettings reached AWS --
STAGE=$(aws apigatewayv2 get-stage --api-id "${API_ID}" --stage-name "${STAGE_NAME}" \
  --region "${REGION}")
STAGE_ENV=$(echo "${STAGE}" | jq -r '.StageVariables.env // empty')
# API Gateway returns ThrottlingRateLimit as a double (e.g. "50.0"); strip the
# fractional part so the integer comparison below matches the templated "50".
RATE_LIMIT_RAW=$(echo "${STAGE}" | jq -r '.DefaultRouteSettings.ThrottlingRateLimit // empty')
RATE_LIMIT="${RATE_LIMIT_RAW%.*}"
DETAILED=$(echo "${STAGE}" | jq -r '.DefaultRouteSettings.DetailedMetricsEnabled // empty')
if [ "${STAGE_ENV}" != "test" ]; then
  echo "FAIL: Stage StageVariables.env is '${STAGE_ENV}', expected 'test'" >&2
  echo "      raw GetStage: ${STAGE}" >&2
  exit 1
fi
if [ "${RATE_LIMIT}" != "50" ]; then
  echo "FAIL: Stage DefaultRouteSettings.ThrottlingRateLimit is '${RATE_LIMIT}', expected '50'" >&2
  exit 1
fi
if [ "${DETAILED}" != "true" ]; then
  echo "FAIL: Stage DefaultRouteSettings.DetailedMetricsEnabled is '${DETAILED}', expected 'true'" >&2
  exit 1
fi
echo "    OK: Stage StageVariables.env == test + DefaultRouteSettings reached AWS (Stage backfill CLOSED)"

# --- Assertion 3: Integration TimeoutInMillis + RequestParameters + Description
INTEGRATIONS=$(aws apigatewayv2 get-integrations --api-id "${API_ID}" --region "${REGION}")
TIMEOUT=$(echo "${INTEGRATIONS}" | jq -r '.Items[0].TimeoutInMillis // empty')
REQ_PARAM=$(echo "${INTEGRATIONS}" | jq -r '.Items[0].RequestParameters["append:header.x-cdkd-test"] // empty')
INT_DESC=$(echo "${INTEGRATIONS}" | jq -r '.Items[0].Description // empty')
if [ "${TIMEOUT}" != "15000" ]; then
  echo "FAIL: Integration TimeoutInMillis is '${TIMEOUT}', expected '15000'" >&2
  echo "      raw GetIntegrations: ${INTEGRATIONS}" >&2
  exit 1
fi
if [ "${REQ_PARAM}" != "'serverless-api'" ]; then
  echo "FAIL: Integration RequestParameters[append:header.x-cdkd-test] is '${REQ_PARAM}', expected \"'serverless-api'\"" >&2
  exit 1
fi
if [ -z "${INT_DESC}" ]; then
  echo "FAIL: Integration Description is empty on AWS" >&2
  exit 1
fi
echo "    OK: Integration TimeoutInMillis + RequestParameters + Description reached AWS (Integration backfill CLOSED)"

# --- Assertion 4: Route AuthorizationScopes + OperationName reached AWS ----
ROUTES=$(aws apigatewayv2 get-routes --api-id "${API_ID}" --region "${REGION}")
ROUTE=$(echo "${ROUTES}" | jq -c --arg key "${ROUTE_KEY}" '.Items[] | select(.RouteKey == $key)')
if [ -z "${ROUTE}" ]; then
  echo "FAIL: could not find route with RouteKey '${ROUTE_KEY}'" >&2
  echo "      raw GetRoutes: ${ROUTES}" >&2
  exit 1
fi
HAS_EMAIL=$(echo "${ROUTE}" | jq -r '(.AuthorizationScopes // []) | index("email") != null')
HAS_OPENID=$(echo "${ROUTE}" | jq -r '(.AuthorizationScopes // []) | index("openid") != null')
OP_NAME=$(echo "${ROUTE}" | jq -r '.OperationName // empty')
if [ "${HAS_EMAIL}" != "true" ] || [ "${HAS_OPENID}" != "true" ]; then
  echo "FAIL: Route AuthorizationScopes missing email/openid (email=${HAS_EMAIL} openid=${HAS_OPENID})" >&2
  echo "      raw route: ${ROUTE}" >&2
  exit 1
fi
if [ "${OP_NAME}" != "GetDefault" ]; then
  echo "FAIL: Route OperationName is '${OP_NAME}', expected 'GetDefault'" >&2
  exit 1
fi
echo "    OK: Route AuthorizationScopes (email+openid) + OperationName == GetDefault reached AWS (Route backfill CLOSED)"

# --- Assertion 5: Authorizer AuthorizerResultTtlInSeconds + EnableSimpleResponses
AUTHORIZERS=$(aws apigatewayv2 get-authorizers --api-id "${API_ID}" --region "${REGION}")
AUTHORIZER=$(echo "${AUTHORIZERS}" | jq -c --arg name "${REQUEST_AUTHORIZER_NAME}" \
  '.Items[] | select(.Name == $name)')
if [ -z "${AUTHORIZER}" ]; then
  echo "FAIL: could not find authorizer named '${REQUEST_AUTHORIZER_NAME}'" >&2
  echo "      raw GetAuthorizers: ${AUTHORIZERS}" >&2
  exit 1
fi
TTL=$(echo "${AUTHORIZER}" | jq -r '.AuthorizerResultTtlInSeconds // empty')
SIMPLE=$(echo "${AUTHORIZER}" | jq -r '.EnableSimpleResponses // empty')
if [ "${TTL}" != "300" ]; then
  echo "FAIL: Authorizer AuthorizerResultTtlInSeconds is '${TTL}', expected '300'" >&2
  echo "      raw authorizer: ${AUTHORIZER}" >&2
  exit 1
fi
if [ "${SIMPLE}" != "true" ]; then
  echo "FAIL: Authorizer EnableSimpleResponses is '${SIMPLE}', expected 'true'" >&2
  exit 1
fi
echo "    OK: Authorizer AuthorizerResultTtlInSeconds == 300 + EnableSimpleResponses == true reached AWS (Authorizer backfill CLOSED)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: HTTP API ${API_ID} still exists after destroy" >&2
  exit 1
fi
echo "    OK: HTTP API is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> serverless-api test passed (ApiGatewayV2 Api/Stage/Integration/Route/Authorizer property-coverage backfill closed + clean destroy)"
