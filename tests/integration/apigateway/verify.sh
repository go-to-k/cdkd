#!/usr/bin/env bash
# verify.sh — cdkd API Gateway Stage config-prop backfill integ test
# (issue #609).
#
# Asserts that the Stage config props wired by the #609 backfill actually
# reach AWS on deploy (they ride on the Stage's OWN CreateStage /
# UpdateStage API call, NOT a separate control-plane call):
#   - AWS::ApiGateway::Stage TracingEnabled (X-Ray) == true
#   - AWS::ApiGateway::Stage Variables == { appVersion, featureFlag }
# Both are read back via `aws apigateway get-stage` and parsed with jq.
#
# Also covers AWS::ApiGateway::Account removal (issue #1160): the baseline
# deploy sets the account's CloudWatch role ARN, then a redeploy with
# CDKD_TEST_REMOVAL=true drops CloudWatchRoleArn from the template and asserts
# the account's role ARN is cleared, as CloudFormation clears it (measured A/B,
# us-east-1). The account setting is a REGION-WIDE singleton: the pre-run value
# is recorded and restored on every exit path. Do not run this fixture
# concurrently, in the same region, with another one that sets the account's
# CloudWatch role: apigw-stage-props, apigw-stage-throttling, and
# apigw-cloudwatch-role-redeploy (#5084).
#
# The same redeploy changes an Authorizer's Type (REQUEST -> TOKEN) and a
# standalone Deployment's Description, and asserts both were updated in place,
# as CloudFormation updates them (issue #5391, A/B in us-east-1). A further
# redeploy (CDKD_TEST_DEPLOYMENT_DESCRIPTION_REMOVAL=true) removes the
# Description and asserts it is cleared on the same deployment.
#
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

STACK="ApiGatewayStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

API_NAME="cdkd-hello-api"
STAGE_NAME="prod"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# --- AWS::ApiGateway::Account singleton helpers (issue #1160) --------------
# The IAM path of the fixture's account role (lib/apigateway-stack.ts). A
# pre-run role ARN under it is a leftover of an earlier run, never restored.
ROLE_PATH="/cdkd-integ-apigateway/"
# The account's CloudWatch role ARN before this run; empty until captured,
# so a cleanup before the capture restores nothing.
PRE_ACCOUNT_ROLE=""
# The caller's account id, read with the pre-run role.
CALLER_ACCOUNT=""

# Prints the account's CloudWatch role ARN, or an empty line when unset.
account_role() {
  local arn
  arn=$(aws apigateway get-account --region "${REGION}" \
    --query cloudwatchRoleArn --output text) || return 1
  [ "${arn}" = "None" ] && arn=""
  printf '%s\n' "${arn}"
}

# Sets the account's CloudWatch role ARN ('' clears it). UpdateAccount is
# throttled hard (TooManyRequests on back-to-back calls), so that one error
# is retried; any other fails.
set_account_role() { # usage: set_account_role <arn-or-empty>
  local i out ops
  # JSON, not shorthand: an IAM role name may contain a comma.
  ops=$(jq -nc --arg v "$1" '[{op: "replace", path: "/cloudwatchRoleArn", value: $v}]') || return 1
  for i in 1 2 3 4 5 6 7 8; do
    if out=$(aws apigateway update-account --region "${REGION}" \
      --patch-operations "${ops}" 2>&1 >/dev/null); then
      return 0
    fi
    printf '%s' "${out}" | grep -q 'TooManyRequests' || { echo "${out}" >&2; return 1; }
    sleep 15
  done
  echo "${out}" >&2
  return 1
}

# Puts the account's CloudWatch role back to its pre-run value (none when
# that value was unset, a leftover of this fixture, or a role that no longer
# exists: UpdateAccount refuses a deleted role, and another fixture can leave
# the account pointing at one). Returns 1 when the readback does not match or
# the role's existence cannot be determined.
restore_account_role() {
  [ -n "${PRE_ACCOUNT_ROLE}" ] || return 0
  local want now probe
  want="${PRE_ACCOUNT_ROLE}"
  case "${want}" in
    NONE | *":role${ROLE_PATH}"*) want="" ;;
  esac
  now=$(account_role) || return 1
  [ "${now}" = "${want}" ] && return 0
  # Probe only a role in THIS account: another account's role reads as
  # NoSuchEntity here, and must not be mistaken for a deleted one.
  case "${want}" in
    arn:*:iam::"${CALLER_ACCOUNT}":role/*)
      # Not gone_probe: it exits on an undetermined probe, and this also runs
      # from the EXIT trap, where the rest of cleanup must still run.
      if ! probe=$(aws iam get-role --role-name "${want##*/}" 2>&1 >/dev/null); then
        if printf '%s' "${probe}" | grep -q 'NoSuchEntity'; then
          echo "WARN: the pre-run account CloudWatch role ${want} no longer exists; leaving the account role unset" >&2
          want=""
          [ "${now}" = "${want}" ] && return 0
        else
          echo "${probe}" >&2
          return 1
        fi
      fi
      ;;
  esac
  set_account_role "${want}" || return 1
  now=$(account_role) || return 1
  [ "${now}" = "${want}" ]
}
# ---------------------------------------------------------------------------

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_REMOVAL -u CDKD_TEST_DEPLOYMENT_DESCRIPTION_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # After the destroy: it clears the account's CloudWatch role.
  if ! restore_account_role; then
    echo "WARN: could not restore the API Gateway account CloudWatch role in ${REGION} to '${PRE_ACCOUNT_ROLE}' (NONE = unset); set it by hand" >&2
  fi
  # The {proxy+} ANY curl in Assertion 4 invokes the Lambda, which auto-creates a
  # /aws/lambda/${STACK}* log group that is not stack-managed (CFn leaves it too).
  # Sweep it so the run is orphan-zero.
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

echo "==> Recording the API Gateway account CloudWatch role (region-wide singleton)"
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PRE_ROLE_READ=$(account_role)
PRE_ACCOUNT_ROLE="${PRE_ROLE_READ:-NONE}"
echo "    pre-run account CloudWatch role: ${PRE_ACCOUNT_ROLE}"

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

# --- Resolve the REST API id ------------------------------------------
API_ID=$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAIL: could not resolve REST API id for '${API_NAME}'" >&2
  exit 1
fi
echo "    Resolved REST API id: ${API_ID}"

# --- Read the stage back from AWS -------------------------------------
STAGE=$(aws apigateway get-stage \
  --rest-api-id "${API_ID}" \
  --stage-name "${STAGE_NAME}" \
  --region "${REGION}")

# --- Assertion 1: TracingEnabled reached AWS --------------------------
TRACING=$(echo "${STAGE}" | jq -r '.tracingEnabled')
if [ "${TRACING}" != "true" ]; then
  echo "FAIL: Stage tracingEnabled is '${TRACING}', expected 'true'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
echo "    OK: Stage tracingEnabled == true on AWS (TracingEnabled backfill CLOSED)"

# --- Assertion 2: Variables reached AWS -------------------------------
APP_VERSION=$(echo "${STAGE}" | jq -r '.variables.appVersion // empty')
FEATURE_FLAG=$(echo "${STAGE}" | jq -r '.variables.featureFlag // empty')
if [ "${APP_VERSION}" != "1.0.0" ]; then
  echo "FAIL: Stage variables.appVersion is '${APP_VERSION}', expected '1.0.0'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
if [ "${FEATURE_FLAG}" != "enabled" ]; then
  echo "FAIL: Stage variables.featureFlag is '${FEATURE_FLAG}', expected 'enabled'" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
echo "    OK: Stage variables {appVersion, featureFlag} reached AWS (Variables backfill CLOSED)"

# --- Assertion 2b: MethodSettings applied via the SDK path (issue #966) ---
# `deployOptions.throttling*` synthesizes a Stage MethodSettings wildcard
# entry. The SDK provider must (a) apply it via the post-create UpdateStage
# patch AND (b) keep the Stage on the SDK path (pre-#966 the property
# CC-routed the whole Stage via the #614 silent-drop routing).
THROTTLE_RATE=$(echo "${STAGE}" | jq -r '.methodSettings."*/*".throttlingRateLimit // empty')
if [ "${THROTTLE_RATE}" != "100" ] && [ "${THROTTLE_RATE}" != "100.0" ]; then
  echo "FAIL: Stage methodSettings */* throttlingRateLimit is '${THROTTLE_RATE}', expected 100" >&2
  echo "      raw stage: ${STAGE}" >&2
  exit 1
fi
STAGE_PROVISIONED_BY=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGateway::Stage") | .value.provisionedBy // "sdk"')
if [ "${STAGE_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: Stage provisionedBy is '${STAGE_PROVISIONED_BY}', expected 'sdk' — MethodSettings should no longer CC-route the Stage (issue #966)" >&2
  exit 1
fi
echo "    OK: Stage MethodSettings throttling reached AWS via the SDK path (issue #966 CLOSED)"

# --- Assertion 3: Authorizer AuthType reached AWS (#609 backfill) -----
AUTHORIZERS=$(aws apigateway get-authorizers --rest-api-id "${API_ID}" --region "${REGION}")
AUTHORIZER_AUTH_TYPE=$(echo "${AUTHORIZERS}" | jq -r '.items[] | select(.name == "cdkd-request-authorizer") | .authType // empty')
if [ "${AUTHORIZER_AUTH_TYPE}" != "custom" ]; then
  echo "FAIL: Authorizer authType is '${AUTHORIZER_AUTH_TYPE}', expected 'custom'" >&2
  echo "      raw authorizers: ${AUTHORIZERS}" >&2
  exit 1
fi
echo "    OK: Authorizer authType == 'custom' on AWS (AuthType backfill CLOSED)"

# --- Assertion 3b: baselines for the #5391 in-place updates in Phase 1b ---
AUTHORIZER_ID=$(echo "${AUTHORIZERS}" | jq -r '.items[] | select(.name == "cdkd-request-authorizer") | .id // empty')
AUTHORIZER_TYPE=$(echo "${AUTHORIZERS}" | jq -r '.items[] | select(.name == "cdkd-request-authorizer") | .type // empty')
if [ -z "${AUTHORIZER_ID}" ] || [ "${AUTHORIZER_TYPE}" != "REQUEST" ]; then
  echo "FAIL: Authorizer cdkd-request-authorizer is id '${AUTHORIZER_ID}' type '${AUTHORIZER_TYPE}', expected a REQUEST authorizer" >&2
  exit 1
fi
# Ids of the API's deployments carrying the given description, one per line.
deployments_described() { # usage: deployments_described <description>
  aws apigateway get-deployments --rest-api-id "${API_ID}" --region "${REGION}" \
    --output json | jq -r --arg d "$1" '.items[] | select(.description == $d) | .id'
}
DESCRIBED_DEPLOYMENT_ID=$(deployments_described cdkd-5391-v1)
if [ -z "${DESCRIBED_DEPLOYMENT_ID}" ] || [ "$(printf '%s\n' "${DESCRIBED_DEPLOYMENT_ID}" | wc -l | tr -d " ")" -ne 1 ]; then
  echo "FAIL: expected exactly one deployment described 'cdkd-5391-v1', got: '${DESCRIBED_DEPLOYMENT_ID}'" >&2
  exit 1
fi
echo "    OK: REQUEST authorizer ${AUTHORIZER_ID} and deployment ${DESCRIBED_DEPLOYMENT_ID} described 'cdkd-5391-v1' (baselines for #5391)"

# --- Assertion 4: {proxy+} ANY method routes to the Lambda ------------
# The greedy proxy resource + ANY method (the LambdaRestApi proxy pattern). A
# curl to an arbitrary sub-path must reach the Lambda — proving the {proxy+}
# Resource, the ANY Method, and the Deployment-depends-on-Method DAG all
# deployed (a missed DAG edge would leave the proxy route out of the snapshot).
API_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}"
PROXY_BODY="$(curl -fsS "${API_URL}/some/arbitrary/proxy/path" || echo "")"
if ! echo "${PROXY_BODY}" | grep -q "Hello from cdkd!"; then
  echo "FAIL: {proxy+} ANY route did not return the Lambda body; got: ${PROXY_BODY}" >&2
  exit 1
fi
echo "    OK: {proxy+} ANY method routed to the Lambda (proxy path)"

# --- Assertion 5: request validation (Model + RequestValidator Ref) ----
# POST /pets is wired with a RequestValidator (validateRequestBody) + a Model
# requiring `name`. This exercises the `Ref` resolution fix: the method's
# RequestModels `{ Ref: <Model> }` and RequestValidatorId `{ Ref: <Validator> }`
# must resolve to the model NAME / validator id, NOT cdkd's compound
# `<restApiId>|<ref>` physical id (which AWS rejects at method-create time).
# A valid body must reach the Lambda (200); an invalid body (missing required
# `name`) must be rejected by the validator BEFORE the Lambda (400).
PETS_URL="${API_URL}/pets"
VALID_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${PETS_URL}" \
  -H 'Content-Type: application/json' -d '{"name":"rex","age":3}')
if [ "${VALID_CODE}" != "200" ]; then
  echo "FAIL: POST /pets with a valid body returned HTTP ${VALID_CODE}, expected 200" >&2
  exit 1
fi
echo "    OK: POST /pets valid body -> 200 (Model + RequestValidator Ref resolved)"

INVALID_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${PETS_URL}" \
  -H 'Content-Type: application/json' -d '{"age":3}')
if [ "${INVALID_CODE}" != "400" ]; then
  echo "FAIL: POST /pets with an invalid body returned HTTP ${INVALID_CODE}, expected 400" >&2
  exit 1
fi
echo "    OK: POST /pets invalid body -> 400 (request validator enforced)"

# --- Assertion 6: the Account's CloudWatchRoleArn reached AWS (baseline) ---
# The removal phase below is vacuous unless the role ARN is live first.
ACCOUNT_ROLE_NAME=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role" and (.key | startswith("AccountCloudWatchRole"))) | .value.physicalId // empty')
if [ -z "${ACCOUNT_ROLE_NAME}" ]; then
  echo "FAIL: no AccountCloudWatchRole* AWS::IAM::Role record in state" >&2
  exit 1
fi
ACCOUNT_ROLE_NOW=$(account_role)
case "${ACCOUNT_ROLE_NOW}" in
  *":role${ROLE_PATH}${ACCOUNT_ROLE_NAME}") ;;
  *)
    echo "FAIL: account CloudWatch role is '${ACCOUNT_ROLE_NOW}', expected the fixture role ${ROLE_PATH}${ACCOUNT_ROLE_NAME}" >&2
    exit 1
    ;;
esac
echo "    OK: account CloudWatch role == the fixture role (baseline for the #1160 removal)"

# --- Phase 1b: remove CloudWatchRoleArn from the Account (issue #1160) ---
# CloudFormation clears the account's role ARN when the property is removed
# (A/B, us-east-1). Pre-fix, cdkd sent UpdateAccount with an empty patch list,
# which succeeds and keeps the role ARN.
echo "==> Phase 1b: redeploy with CDKD_TEST_REMOVAL=true (Account drops CloudWatchRoleArn; Authorizer Type and Deployment Description change)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

ACCOUNT_ROLE_NOW=$(account_role)
if [ -n "${ACCOUNT_ROLE_NOW}" ]; then
  echo "FAIL: account CloudWatch role is still '${ACCOUNT_ROLE_NOW}' after CloudWatchRoleArn was removed from the template; CloudFormation clears it (issue #1160)" >&2
  exit 1
fi
echo "    OK: removed CloudWatchRoleArn cleared the account's CloudWatch role (issue #1160)"

# --- Phase 1b (issue #5391): the Authorizer Type and Deployment Description
# changes were applied in place, as CloudFormation applies them (A/B, us-east-1:
# both kept their ids). Pre-fix, the Type change sent nothing and the
# Description change failed the redeploy above.
AUTHORIZER_AFTER=$(aws apigateway get-authorizer --rest-api-id "${API_ID}" \
  --authorizer-id "${AUTHORIZER_ID}" --region "${REGION}" --query type --output text)
if [ "${AUTHORIZER_AFTER}" != "TOKEN" ]; then
  echo "FAIL: Authorizer ${AUTHORIZER_ID} type is '${AUTHORIZER_AFTER}' after the template changed it to TOKEN (issue #5391)" >&2
  exit 1
fi
echo "    OK: Authorizer ${AUTHORIZER_ID} type changed REQUEST -> TOKEN in place (issue #5391)"

DESCRIBED_AFTER=$(aws apigateway get-deployment --rest-api-id "${API_ID}" \
  --deployment-id "${DESCRIBED_DEPLOYMENT_ID}" --region "${REGION}" --query description --output text)
if [ "${DESCRIBED_AFTER}" != "cdkd-5391-v2" ]; then
  echo "FAIL: deployment ${DESCRIBED_DEPLOYMENT_ID} description is '${DESCRIBED_AFTER}', expected 'cdkd-5391-v2' (issue #5391)" >&2
  exit 1
fi
echo "    OK: deployment ${DESCRIBED_DEPLOYMENT_ID} description updated in place to 'cdkd-5391-v2' (issue #5391)"

# --- Phase 1c (issue #5391): REMOVE the Deployment Description. CloudFormation
# clears it (A/B, us-east-1: the field is then absent); cdkd sends
# `replace /description ''`. Same deployment id.
echo "==> Phase 1c: redeploy with CDKD_TEST_DEPLOYMENT_DESCRIPTION_REMOVAL=true (Deployment drops Description)"
CDKD_TEST_REMOVAL=true CDKD_TEST_DEPLOYMENT_DESCRIPTION_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

DESCRIBED_CLEARED=$(aws apigateway get-deployment --rest-api-id "${API_ID}" \
  --deployment-id "${DESCRIBED_DEPLOYMENT_ID}" --region "${REGION}" --query description --output text)
if [ "${DESCRIBED_CLEARED}" != "None" ] && [ -n "${DESCRIBED_CLEARED}" ]; then
  echo "FAIL: deployment ${DESCRIBED_DEPLOYMENT_ID} description is '${DESCRIBED_CLEARED}' after Description was removed; CloudFormation clears it (issue #5391)" >&2
  exit 1
fi
echo "    OK: deployment ${DESCRIBED_DEPLOYMENT_ID} description cleared in place after removal (issue #5391)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
CDKD_TEST_REMOVAL=true CDKD_TEST_DEPLOYMENT_DESCRIPTION_REMOVAL=true node "${LOCAL_DIST}" destroy "${STACK}" \
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

assert_gone "account CloudWatch role ${ROLE_PATH}${ACCOUNT_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ACCOUNT_ROLE_NAME}"
echo "    OK: account CloudWatch role is gone"

if ! restore_account_role; then
  echo "FAIL: could not restore the API Gateway account CloudWatch role in ${REGION} to '${PRE_ACCOUNT_ROLE}' (NONE = unset)" >&2
  exit 1
fi
echo "    OK: account CloudWatch role restored to its pre-run value (${PRE_ACCOUNT_ROLE})"

echo ""
echo "==> apigateway test passed (Stage config-prop backfill closed + clean destroy)"
