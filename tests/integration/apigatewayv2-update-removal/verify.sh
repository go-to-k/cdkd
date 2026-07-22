#!/usr/bin/env bash
# verify.sh — cdkd ApiGatewayV2 update-field removal reset (issue #1160) integ.
#
# Every AWS::ApiGatewayV2::* Update* API MERGES (an absent field = "no change"),
# so a template that drops a previously-set field must send an explicit reset
# value or AWS silently keeps the old one. cdkd previously passed each optional
# field straight through as `undefined` on update — the deploy reported success,
# state dropped the field, and the next diff said "No changes" while AWS still
# held the old value. This test removes one-or-more fields on each of the five
# resources on UPDATE and asserts AWS reverted each to its CloudFormation
# default (a pre-fix run keeps the old values).
#
# Phases:
#   1. Deploy with Api Description/Cors/DisableExecuteApiEndpoint/IpAddressType,
#      Integration Description/RequestParameters, Authorizer
#      AuthorizerResultTtlInSeconds, Route OperationName, Stage StageVariables
#      set; assert all live on AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (those fields removed). Assert AWS
#      shows the CFn defaults: Description empty, CorsConfiguration gone (cleared
#      via DeleteCorsConfiguration), DisableExecuteApiEndpoint false,
#      IpAddressType ipv4, Integration Description empty + RequestParameters
#      empty, AuthorizerResultTtlInSeconds 0, Route OperationName empty, Stage
#      StageVariables empty.
#   3. Destroy; assert the API is gone and the state file is removed.
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

STACK="CdkdApiGatewayV2UpdateRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="${STACK}-api"
AUTH_FN="${STACK}-authfn"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

api_id() {
  aws apigatewayv2 get-apis --region "${REGION}" \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null
}
api_field() { # api_field <API_ID> <JMESPath>
  aws apigatewayv2 get-api --api-id "$1" --region "${REGION}" \
    --query "$2" --output text 2>/dev/null
}
first_id() { # first_id <API_ID> <get-verb> <IdField>
  aws apigatewayv2 "$2" --api-id "$1" --region "${REGION}" \
    --query "Items[0].$3" --output text 2>/dev/null
}
int_field() { # int_field <API_ID> <INT_ID> <JMESPath>
  aws apigatewayv2 get-integration --api-id "$1" --integration-id "$2" --region "${REGION}" \
    --query "$3" --output text 2>/dev/null
}
route_field() { # route_field <API_ID> <ROUTE_ID> <JMESPath>
  aws apigatewayv2 get-route --api-id "$1" --route-id "$2" --region "${REGION}" \
    --query "$3" --output text 2>/dev/null
}
auth_field() { # auth_field <API_ID> <AUTH_ID> <JMESPath>
  aws apigatewayv2 get-authorizer --api-id "$1" --authorizer-id "$2" --region "${REGION}" \
    --query "$3" --output text 2>/dev/null
}
stage_field() { # stage_field <API_ID> <JMESPath>
  aws apigatewayv2 get-stage --api-id "$1" --stage-name '$default' --region "${REGION}" \
    --query "$2" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local aid
  aid="$(api_id)"
  if [ -n "${aid}" ] && [ "${aid}" != "None" ]; then
    aws apigatewayv2 delete-api --api-id "${aid}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${AUTH_FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${AUTH_FN}" --region "${REGION}" >/dev/null 2>&1
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
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with all fields set --------------------------------
echo "==> Phase 1: deploy with removable fields set on all five resources"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

AID="$(api_id)"
if [ -z "${AID}" ] || [ "${AID}" = "None" ]; then
  echo "FAIL: could not resolve ApiId for ${API_NAME}" >&2; exit 1
fi
INT_ID="$(first_id "${AID}" get-integrations IntegrationId)"
ROUTE_ID="$(first_id "${AID}" get-routes RouteId)"
AUTH_ID="$(first_id "${AID}" get-authorizers AuthorizerId)"

if [ "$(api_field "${AID}" 'Description')" != "before removal" ] \
  || [ "$(api_field "${AID}" 'CorsConfiguration.AllowOrigins[0]')" != "https://example.com" ] \
  || [ "$(api_field "${AID}" 'DisableExecuteApiEndpoint')" != "True" ] \
  || [ "$(api_field "${AID}" 'IpAddressType')" != "dualstack" ]; then
  echo "FAIL: Phase 1 Api fields not all live: Desc='$(api_field "${AID}" Description)' Cors='$(api_field "${AID}" 'CorsConfiguration.AllowOrigins[0]')' DisableExec='$(api_field "${AID}" DisableExecuteApiEndpoint)' Ip='$(api_field "${AID}" IpAddressType)'" >&2
  exit 1
fi
if [ "$(int_field "${AID}" "${INT_ID}" 'Description')" != "before removal" ] \
  || [ "$(int_field "${AID}" "${INT_ID}" 'RequestParameters."append:header.x-cdkd"')" != "y" ]; then
  echo "FAIL: Phase 1 Integration fields not live: Desc='$(int_field "${AID}" "${INT_ID}" Description)' RP='$(int_field "${AID}" "${INT_ID}" 'RequestParameters."append:header.x-cdkd"')'" >&2
  exit 1
fi
if [ "$(auth_field "${AID}" "${AUTH_ID}" 'AuthorizerResultTtlInSeconds')" != "300" ]; then
  echo "FAIL: Phase 1 Authorizer TTL not 300 (got '$(auth_field "${AID}" "${AUTH_ID}" AuthorizerResultTtlInSeconds)')" >&2
  exit 1
fi
if [ "$(route_field "${AID}" "${ROUTE_ID}" 'OperationName')" != "probeOp" ]; then
  echo "FAIL: Phase 1 Route OperationName not set (got '$(route_field "${AID}" "${ROUTE_ID}" OperationName)')" >&2
  exit 1
fi
if [ "$(stage_field "${AID}" 'StageVariables.foo')" != "bar" ]; then
  echo "FAIL: Phase 1 Stage StageVariables.foo not set (got '$(stage_field "${AID}" 'StageVariables.foo')')" >&2
  exit 1
fi
echo "    all Phase 1 fields live"

# --- Phase 2: remove the fields ----------------------------------------
echo "==> Phase 2: re-deploy with the fields removed (must reset to CFn defaults)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# `--output text` prints the literal `None` for an absent key; an empty string
# means the probe itself failed (throttle/auth), which must NOT be read as
# "removed" (issue #1097 pattern 2 — negative assertion over an error-swallowing
# probe). So a cleared string field must read exactly `None`, never `''`.
D="$(api_field "${AID}" 'Description')"
C="$(api_field "${AID}" 'CorsConfiguration.AllowOrigins[0]')"
DE="$(api_field "${AID}" 'DisableExecuteApiEndpoint')"
IP="$(api_field "${AID}" 'IpAddressType')"
if [ "${D}" != "None" ]; then echo "FAIL: Api Description not cleared (got '${D}'; empty = probe error)" >&2; exit 1; fi
if [ "${C}" != "None" ]; then echo "FAIL: Api CorsConfiguration not cleared (got '${C}'; empty = probe error)" >&2; exit 1; fi
if [ "${DE}" != "False" ]; then echo "FAIL: Api DisableExecuteApiEndpoint not reset to false (got '${DE}')" >&2; exit 1; fi
if [ "${IP}" != "ipv4" ]; then echo "FAIL: Api IpAddressType not reset to ipv4 (got '${IP}')" >&2; exit 1; fi

ID="$(int_field "${AID}" "${INT_ID}" 'Description')"
RP="$(int_field "${AID}" "${INT_ID}" 'RequestParameters."append:header.x-cdkd"')"
if [ "${ID}" != "None" ]; then echo "FAIL: Integration Description not cleared (got '${ID}'; empty = probe error)" >&2; exit 1; fi
if [ "${RP}" != "None" ]; then echo "FAIL: Integration RequestParameters not cleared (got '${RP}'; empty = probe error)" >&2; exit 1; fi

TTL="$(auth_field "${AID}" "${AUTH_ID}" 'AuthorizerResultTtlInSeconds')"
if [ "${TTL}" != "0" ]; then echo "FAIL: Authorizer TTL not reset to 0 (got '${TTL}')" >&2; exit 1; fi

ON="$(route_field "${AID}" "${ROUTE_ID}" 'OperationName')"
if [ "${ON}" != "None" ]; then echo "FAIL: Route OperationName not cleared (got '${ON}'; empty = probe error)" >&2; exit 1; fi

SV="$(stage_field "${AID}" 'StageVariables.foo')"
if [ "${SV}" != "None" ]; then echo "FAIL: Stage StageVariables.foo not cleared (got '${SV}'; empty = probe error)" >&2; exit 1; fi
echo "    all fields reset to CFn defaults (Cors cleared via DeleteCorsConfiguration)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "API ${AID} still exists after destroy" aws apigatewayv2 get-api --api-id "${AID}" --region "${REGION}"
echo "    API deleted"

assert_gone "authorizer Lambda ${AUTH_FN} still exists after destroy" aws lambda get-function --function-name "${AUTH_FN}" --region "${REGION}"
echo "    authorizer Lambda deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ApiGatewayV2 update-field removal reset (issue #1160), all 3 phases passed"
