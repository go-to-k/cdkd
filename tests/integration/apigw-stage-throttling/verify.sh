#!/usr/bin/env bash
# verify.sh — CC-routed ApiGateway Stage compound-id Ref regression test
# (issue #963).
#
# The Stage carries AccessLogSetting (deployOptions.accessLogDestination),
# which the SDK provider does not wire, so the #614 routing provisions the
# Stage via Cloud Control and cdkd stores the compound
# `<restApiId>|<stageName>` physical id. (The original #963 trigger was
# MethodSettings; issue #966 wired that into the SDK provider, so the fixture
# switched triggers to keep the CC route.)
# Pre-fix, `Ref` on the Stage leaked that compound id into the CDK-generated
# Lambda Permission SourceArn and the deployed API returned 500 on every
# request. This test asserts:
#   1. the Stage really took the CC route (provisionedBy == cc-api) — else the
#      fixture is no longer exercising the #963 path and must be updated
#   2. the Lambda resource policy SourceArn carries the bare stage name (no
#      pipe) — the direct Ref-resolution assertion
#   3. GET /hello actually returns the Lambda body (the functional check a
#      green deploy summary cannot substitute for)
#   4. UPDATE: adding a route swaps in a new hash-suffixed Deployment; the new
#      route must serve and the old Deployment must be deleted
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="ApigwStageThrottlingStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

API_NAME="cdkd-stage-throttling-api"
STAGE_NAME="test"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # The functional curls invoke the Lambda, which auto-creates a
  # /aws/lambda/${STACK}* log group that is not stack-managed. Sweep it so the
  # run is orphan-zero.
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
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

# curl with retries: right after a deploy / stage retarget the edge can
# transiently return "Missing Authentication Token" while the new snapshot
# propagates — retry before concluding.
curl_body_with_retry() {
  local url="$1"
  local body=""
  for _ in 1 2 3 4 5 6; do
    body="$(curl -fsS "${url}" 2>/dev/null || true)"
    if echo "${body}" | grep -q '"ok":true'; then
      echo "${body}"
      return 0
    fi
    sleep 5
  done
  echo "${body}"
}

# --- Phase 1: deploy (base) -------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion 1: the Stage took the CC route -------------------------
STAGE_ROW=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGateway::Stage") | .value')
STAGE_PROVISIONED_BY=$(echo "${STAGE_ROW}" | jq -r '.provisionedBy // "sdk"')
STAGE_PHYSICAL_ID=$(echo "${STAGE_ROW}" | jq -r '.physicalId')
if [ "${STAGE_PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: Stage provisionedBy is '${STAGE_PROVISIONED_BY}', expected 'cc-api'." >&2
  echo "      The fixture no longer exercises the #963 CC-routed-Stage path" >&2
  echo "      (did the SDK provider gain AccessLogSetting support? — then swap" >&2
  echo "      in another unwired Stage property to keep the CC route)." >&2
  exit 1
fi
case "${STAGE_PHYSICAL_ID}" in
  *"|${STAGE_NAME}") : ;;
  *)
    echo "FAIL: Stage physicalId '${STAGE_PHYSICAL_ID}' is not the compound '<restApiId>|${STAGE_NAME}'" >&2
    exit 1
    ;;
esac
echo "    OK: Stage is CC-provisioned with compound physical id '${STAGE_PHYSICAL_ID}'"

# --- Resolve the REST API id ------------------------------------------
API_ID=$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAIL: could not resolve REST API id for '${API_NAME}'" >&2
  exit 1
fi
echo "    Resolved REST API id: ${API_ID}"

# --- Assertion 2: Lambda Permission SourceArn has the bare stage name --
FN_NAME=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId')
POLICY=$(aws lambda get-policy --function-name "${FN_NAME}" --region "${REGION}" --query Policy --output text)
if echo "${POLICY}" | grep -q "${API_ID}/${API_ID}|"; then
  echo "FAIL: Lambda Permission SourceArn carries the compound stage id (issue #963 regressed):" >&2
  echo "${POLICY}" | tr ',' '\n' | grep SourceArn >&2
  exit 1
fi
if ! echo "${POLICY}" | grep -q "${API_ID}/${STAGE_NAME}/GET/hello"; then
  echo "FAIL: Lambda Permission SourceArn does not carry the expected .../${STAGE_NAME}/GET/hello:" >&2
  echo "${POLICY}" | tr ',' '\n' | grep SourceArn >&2
  exit 1
fi
echo "    OK: Lambda Permission SourceArn carries the bare stage name (Ref resolved correctly)"

# --- Assertion 3: the route actually serves ----------------------------
API_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}"
HELLO_BODY="$(curl_body_with_retry "${API_URL}/hello")"
if ! echo "${HELLO_BODY}" | grep -q '"ok":true'; then
  echo "FAIL: GET /hello did not return the Lambda body (the #963 symptom); got: ${HELLO_BODY}" >&2
  exit 1
fi
echo "    OK: GET /hello returns the Lambda body (API functional, not just deployed)"

# --- Assertion 4: throttling reached AWS -------------------------------
THROTTLE_RATE=$(aws apigateway get-stage --rest-api-id "${API_ID}" \
  --stage-name "${STAGE_NAME}" --region "${REGION}" \
  --query 'methodSettings."*/*".throttlingRateLimit' --output text)
if [ "${THROTTLE_RATE}" != "100.0" ] && [ "${THROTTLE_RATE}" != "100" ]; then
  echo "FAIL: stage throttlingRateLimit is '${THROTTLE_RATE}', expected 100" >&2
  exit 1
fi
echo "    OK: Stage MethodSettings throttling reached AWS (via the CC route)"

OLD_DEPLOYMENT_IDS=$(aws apigateway get-deployments --rest-api-id "${API_ID}" \
  --region "${REGION}" --query 'items[].id' --output text)

# --- Phase 2: UPDATE (add a route -> replacement Deployment) -----------
echo "==> Phase 2: UPDATE (add /items route + change throttling)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

ITEMS_BODY="$(curl_body_with_retry "${API_URL}/items")"
if ! echo "${ITEMS_BODY}" | grep -q '"ok":true'; then
  echo "FAIL: GET /items (added on update) did not return the Lambda body; got: ${ITEMS_BODY}" >&2
  exit 1
fi
echo "    OK: GET /items (added on update) serves"

NEW_THROTTLE_RATE=$(aws apigateway get-stage --rest-api-id "${API_ID}" \
  --stage-name "${STAGE_NAME}" --region "${REGION}" \
  --query 'methodSettings."*/*".throttlingRateLimit' --output text)
if [ "${NEW_THROTTLE_RATE}" != "50.0" ] && [ "${NEW_THROTTLE_RATE}" != "50" ]; then
  echo "FAIL: post-update throttlingRateLimit is '${NEW_THROTTLE_RATE}', expected 50" >&2
  exit 1
fi
echo "    OK: updated throttling reached AWS"

NEW_DEPLOYMENT_IDS=$(aws apigateway get-deployments --rest-api-id "${API_ID}" \
  --region "${REGION}" --query 'items[].id' --output text)
DEPLOYMENT_COUNT=$(echo "${NEW_DEPLOYMENT_IDS}" | wc -w | tr -d ' ')
if [ "${DEPLOYMENT_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 Deployment after the update (old one deleted); got: ${NEW_DEPLOYMENT_IDS}" >&2
  exit 1
fi
if [ "${NEW_DEPLOYMENT_IDS}" = "${OLD_DEPLOYMENT_IDS}" ]; then
  echo "FAIL: Deployment id unchanged after the update — the hash-suffixed replacement Deployment did not swap in" >&2
  exit 1
fi
echo "    OK: replacement Deployment swapped in and the old one was deleted"

# --- Phase 3: destroy ---------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

API_ID_AFTER=$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)
if [ "${API_ID_AFTER}" != "None" ] && [ -n "${API_ID_AFTER}" ]; then
  echo "FAIL: REST API '${API_NAME}' still exists after destroy (id ${API_ID_AFTER})" >&2
  exit 1
fi
echo "    OK: REST API is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> apigw-stage-throttling test passed (#963 CC-routed Stage Ref closed + clean destroy)"
