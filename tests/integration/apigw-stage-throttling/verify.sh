#!/usr/bin/env bash
# verify.sh — ApiGateway Stage Ref + AccessLogSetting delivery test
# (issues #963 / #609).
#
# HISTORY: this fixture used to pin the #963 CC-routed-Stage compound-id Ref
# regression by carrying a Stage property the SDK provider did not wire
# (MethodSettings until #966, then AccessLogSetting), which sent the Stage
# through Cloud Control with the compound `<restApiId>|<stageName>` physical
# id. The #609 Stage backfill wired ALL remaining Stage top-level properties
# (AccessLogSetting included) into the SDK provider, so no template shape
# routes a Stage via CC anymore; the #963 after-pipe Ref extraction is a
# no-op for the pipe-free SDK physical id and stays pinned by
# tests/unit/deployment/intrinsic-functions.test.ts. This fixture now asserts
# the SDK-routed reality:
#   1. the Stage took the SDK route (provisionedBy == sdk) with the bare
#      stage name as its physical id (no pipe) — if this fails, the routing
#      layer regressed a handled Stage template onto the CC route
#   2. the Lambda resource policy SourceArn carries the bare stage name (no
#      pipe) — the #963 symptom assertion, route-agnostic
#   3. GET /hello actually returns the Lambda body (the functional check a
#      green deploy summary cannot substitute for), and the Stage's
#      accessLogSettings actually reached AWS (the #609 delivery assertion —
#      pre-backfill this only worked because CC forwarded the full map)
#   4. UPDATE: adding a route swaps in a new hash-suffixed Deployment; the new
#      route must serve and the old Deployment must be deleted
# Then destroys and confirms a clean teardown.
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

STACK="ApigwStageThrottlingStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

API_NAME="cdkd-stage-throttling-api"
STAGE_NAME="test"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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

# --- Assertion 1: the Stage took the SDK route (#609 backfill) --------
STAGE_ROW=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGateway::Stage") | .value')
STAGE_PROVISIONED_BY=$(echo "${STAGE_ROW}" | jq -r '.provisionedBy // "sdk"')
STAGE_PHYSICAL_ID=$(echo "${STAGE_ROW}" | jq -r '.physicalId')
if [ "${STAGE_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: Stage provisionedBy is '${STAGE_PROVISIONED_BY}', expected 'sdk'." >&2
  echo "      Since the #609 backfill every Stage top-level property is" >&2
  echo "      SDK-wired, so a CC-routed Stage means the routing layer" >&2
  echo "      regressed (or a new CFn Stage property landed unwired)." >&2
  exit 1
fi
if [ "${STAGE_PHYSICAL_ID}" != "${STAGE_NAME}" ]; then
  echo "FAIL: Stage physicalId '${STAGE_PHYSICAL_ID}' is not the bare stage name '${STAGE_NAME}'" >&2
  exit 1
fi
echo "    OK: Stage is SDK-provisioned with the bare stage name '${STAGE_PHYSICAL_ID}'"

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

# --- Assertion 3b: AccessLogSetting was actually delivered (#609) ------
# Pre-backfill this only reached AWS because Cloud Control forwarded the
# full property map; now the SDK provider must deliver it via the
# post-create UpdateStage patch.
ACCESS_LOG_ARN="$(aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name "${STAGE_NAME}" \
  --region "${REGION}" --query 'accessLogSettings.destinationArn' --output text)"
ACCESS_LOG_FORMAT="$(aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name "${STAGE_NAME}" \
  --region "${REGION}" --query 'accessLogSettings.format' --output text)"
if [ -z "${ACCESS_LOG_ARN}" ] || [ "${ACCESS_LOG_ARN}" = "None" ]; then
  echo "FAIL: Stage accessLogSettings.destinationArn is empty — AccessLogSetting was dropped (#609 regression)" >&2
  exit 1
fi
if [ -z "${ACCESS_LOG_FORMAT}" ] || [ "${ACCESS_LOG_FORMAT}" = "None" ]; then
  echo "FAIL: Stage accessLogSettings.format is empty — AccessLogSetting was dropped (#609 regression)" >&2
  exit 1
fi
echo "    OK: Stage accessLogSettings delivered (arn=${ACCESS_LOG_ARN})"

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

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> apigw-stage-throttling test passed (#963 CC-routed Stage Ref closed + clean destroy)"
