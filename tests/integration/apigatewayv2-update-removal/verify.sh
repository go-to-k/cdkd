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
# default, except the properties CloudFormation KEEPS (issue #5004), which must
# stay live (a pre-#5004 cdkd reset them).
#
# Phases:
#   1. Deploy with Api Description/Cors/DisableExecuteApiEndpoint/IpAddressType,
#      Integration Description/RequestParameters, Authorizer
#      AuthorizerResultTtlInSeconds, Route OperationName, Stage StageVariables
#      and the map-shaped Api / Stage Tags (#5390) set; assert all live on AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (those fields removed). Assert AWS
#      keeps what CloudFormation keeps (#5004: Api Description /
#      DisableExecuteApiEndpoint / IpAddressType, Integration Description +
#      RequestParameters, AuthorizerResultTtlInSeconds, Route OperationName,
#      Stage StageVariables stay live) and resets CorsConfiguration (cleared via
#      DeleteCorsConfiguration) and ClearAuthorizer's IdentitySource (#1160 A/B:
#      CloudFormation clears it). Api Tags re-tag a changed key and untag a
#      dropped one; the Stage's removed Tags block untags every key (#5390 A/B).
#   2b. CDKD_TEST_REMOVAL=true: the delete-API-only members, plus (#1160) the
#      WebSocket MOCK integration's and $default route's #609 fields, which
#      CloudFormation keeps, and a Description-only change on the service
#      integration, which AWS accepts only with the full RequestParameters.
#   2c. CDKD_TEST_SUBTYPE_REMOVED=true: the service integration drops its
#      IntegrationSubtype. CloudFormation fails that update (#1160 A/B), so the
#      deploy must be refused and the subtype must stay live.
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
WS_API_NAME="${STACK}-ws"
FLAT_API_NAME="${STACK}-flat"
AUTH_FN="${STACK}-authfn"
EVENTS_ROLE="${STACK}-events"

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
int_id_by_type() { # int_id_by_type <API_ID> <IntegrationType> — issue #609:
  # the HTTP API now carries TWO integrations (HTTP_PROXY + AWS_PROXY) and the
  # WebSocket API one (MOCK), so an Items[0] pick would be order-dependent.
  # The count guard keeps that true: the moment a second integration of the
  # same type is added to either API, this fails loudly instead of silently
  # asserting against whichever one AWS happened to list first.
  local n
  n="$(aws apigatewayv2 get-integrations --api-id "$1" --region "${REGION}" \
    --query "length(Items[?IntegrationType=='$2'])" --output text)" || return 1
  if [ "${n}" != "1" ]; then
    echo "FAIL: expected exactly 1 '$2' integration on api $1, found '${n}'" >&2
    return 1
  fi
  aws apigatewayv2 get-integrations --api-id "$1" --region "${REGION}" \
    --query "Items[?IntegrationType=='$2'].IntegrationId | [0]" --output text
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
ws_api_id() {
  aws apigatewayv2 get-apis --region "${REGION}" \
    --query "Items[?Name=='${WS_API_NAME}'].ApiId | [0]" --output text 2>/dev/null
}
flat_api_id() {
  aws apigatewayv2 get-apis --region "${REGION}" \
    --query "Items[?Name=='${FLAT_API_NAME}'].ApiId | [0]" --output text 2>/dev/null
}
ws_stage_field() { # ws_stage_field <API_ID> <JMESPath>
  aws apigatewayv2 get-stage --api-id "$1" --stage-name 'ws' --region "${REGION}" \
    --query "$2" --output text 2>/dev/null
}
stage_field() { # stage_field <API_ID> <JMESPath>
  aws apigatewayv2 get-stage --api-id "$1" --stage-name '$default' --region "${REGION}" \
    --query "$2" --output text 2>/dev/null
}

# Issue #1602: drop the `observedProperties` of the resources under test so the
# drift run below compares them against the `properties` baseline — the ONLY
# baseline on which these phantom-drift shapes fire.
#
# This is not a trick to make the test pass; it is what makes it BIND. The
# deploy-time observed snapshot comes from the SAME `readCurrentState` the fix
# changes, so with it present both sides move together and a reverted fix still
# reports "no drift" (i.e. the assertion would be vacuous). The properties
# baseline is the real user condition: state written before observed-capture
# existed, observed-capture turned off by flag or cdk.json, or a capture that
# failed. (The opt-out flag is deliberately NOT named here: the cli-flag
# coverage matrix reads this file's text, and a mention in a comment would be
# reported as integ coverage the fixture does not actually provide.)
#
# Scoped to the two integrations under test — every OTHER resource keeps its
# observed baseline, so this cannot surface unrelated properties-baseline
# mismatches. `Integration` is included because the CFn-arm mirror (declared
# entry ORDER + declared SCALAR type) is only observable on this baseline too:
# that resource declares an unquoted numeric `Source`, which AWS returns as a
# string.
STRIP_OBSERVED_LOGICAL_IDS="FlatIntegration Integration"
strip_observed_for_drift() {
  # PID-suffixed so two concurrent runs of this fixture cannot share a scratch
  # file, and removed on the guard's exit path as well as the happy one.
  local tmp_in="${TMPDIR:-/tmp}/cdkd-1602-state-in.$$.json"
  local tmp_out="${TMPDIR:-/tmp}/cdkd-1602-state-out.$$.json"
  local lid
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${tmp_in}" --region "${REGION}" >/dev/null
  # Fail loudly if a key we are about to strip is not there: a silent no-op
  # would turn the drift assertion back into the vacuous check this exists to
  # replace.
  for lid in ${STRIP_OBSERVED_LOGICAL_IDS}; do
    if [ "$(jq -r --arg l "${lid}" '.resources[$l].observedProperties | type' "${tmp_in}")" != "object" ]; then
      echo "FAIL: ${lid} has no observedProperties to strip — the drift assertion would be vacuous" >&2
      rm -f "${tmp_in}" "${tmp_out}"
      exit 1
    fi
  done
  jq --arg ids "${STRIP_OBSERVED_LOGICAL_IDS}" \
    'reduce ($ids | split(" ")[]) as $l (.; del(.resources[$l].observedProperties))' \
    "${tmp_in}" > "${tmp_out}"
  aws s3 cp "${tmp_out}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
  rm -f "${tmp_in}" "${tmp_out}"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local aid
  aid="$(api_id)"
  if [ -n "${aid}" ] && [ "${aid}" != "None" ]; then
    aws apigatewayv2 delete-api --api-id "${aid}" --region "${REGION}" >/dev/null 2>&1
  fi
  local wsaid
  wsaid="$(ws_api_id)"
  if [ -n "${wsaid}" ] && [ "${wsaid}" != "None" ]; then
    aws apigatewayv2 delete-api --api-id "${wsaid}" --region "${REGION}" >/dev/null 2>&1
  fi
  local flataid
  flataid="$(flat_api_id)"
  if [ -n "${flataid}" ] && [ "${flataid}" != "None" ]; then
    aws apigatewayv2 delete-api --api-id "${flataid}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws logs delete-log-group --log-group-name "/aws/apigatewayv2/${WS_API_NAME}" \
    --region "${REGION}" >/dev/null 2>&1
  aws lambda delete-function --function-name "${AUTH_FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${AUTH_FN}" --region "${REGION}" >/dev/null 2>&1
  # Issue #609: the AWS_PROXY service integration's invocation role. An inline
  # policy blocks DeleteRole, so it has to come off first.
  aws iam delete-role-policy --role-name "${EVENTS_ROLE}" --policy-name putEvents >/dev/null 2>&1
  aws iam delete-role --role-name "${EVENTS_ROLE}" >/dev/null 2>&1
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

# Precondition: WsStage declares AccessLogSettings, which API Gateway accepts
# only when the REGION's API Gateway account has a CloudWatch Logs role
# (`cloudwatchRoleArn`). Without one, phase 1 fails with an opaque
# BadRequestException. This fixture never sets the account role itself: it is
# a region-wide setting other stacks may own.
if ! APIGW_CW_ROLE="$(aws apigateway get-account --region "${REGION}" \
  --query cloudwatchRoleArn --output text 2>&1)"; then
  echo "FAIL: precheck could not read the API Gateway account in ${REGION}: ${APIGW_CW_ROLE}" >&2
  exit 1
fi
case "${APIGW_CW_ROLE}" in
  '' | None)
    echo "FAIL: precondition: the API Gateway account in ${REGION} has no cloudwatchRoleArn, so the WebSocket stage's AccessLogSettings would be rejected. Set an account CloudWatch Logs role first, e.g. the dedicated cdkd-integ-apigw-cloudwatch-logs role: aws apigateway update-account --region ${REGION} --patch-operations op=replace,path=/cloudwatchRoleArn,value=<role arn>" >&2
    exit 1
    ;;
esac

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
INT_ID="$(int_id_by_type "${AID}" HTTP_PROXY)"
EVENTS_INT_ID="$(int_id_by_type "${AID}" AWS_PROXY)"
ROUTE_ID="$(first_id "${AID}" get-routes RouteId)"
# By NAME: the HTTP API carries two authorizers (issue #1160 added the
# caching-off one), so an Items[0] pick would be order-dependent.
auth_id_by_name() { # auth_id_by_name <NAME>
  aws apigatewayv2 get-authorizers --api-id "${AID}" --region "${REGION}" \
    --query "Items[?Name=='$1'].AuthorizerId | [0]" --output text 2>/dev/null
}
AUTH_ID="$(auth_id_by_name "${STACK}-auth")"
CLEAR_AUTH_ID="$(auth_id_by_name "${STACK}-clear-auth")"
for ID_PAIR in "auth:${AUTH_ID}" "clear-auth:${CLEAR_AUTH_ID}"; do
  case "${ID_PAIR#*:}" in
    '' | None) echo "FAIL: could not resolve the ${ID_PAIR%%:*} authorizer id" >&2; exit 1 ;;
  esac
done

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
# Issue #609 (::Integration backfill), phase 1. Each of these is delivered on
# CREATE only if the provider wires the member — the pre-fix binary dropped
# them silently and the deploy still reported success, so an empty readback
# here IS the bug.
# The CFn list-of-pairs must arrive as the SDK's flat map: AWS reports the
# Destination as the KEY. A verbatim forward of the CFn shape yields `{}`.
if [ "$(int_field "${AID}" "${INT_ID}" 'ResponseParameters."404"."append:header.x-cdkd-resp"')" != "before" ] \
  || [ "$(int_field "${AID}" "${INT_ID}" 'ResponseParameters."404"."overwrite:statuscode"')" != "404" ]; then
  echo "FAIL: Phase 1 Integration ResponseParameters not folded to the SDK map (got '$(int_field "${AID}" "${INT_ID}" 'ResponseParameters."404"')')" >&2
  exit 1
fi
# Issue #1602: TlsConfig and the flat ResponseParameters spelling both ride the
# dedicated FlatIntegration, so the drift assertions below can name one
# resource whose only comparable properties are the shapes under test.
FLAT_AID="$(flat_api_id)"
if [ -z "${FLAT_AID}" ] || [ "${FLAT_AID}" = "None" ]; then
  echo "FAIL: could not resolve ApiId for ${FLAT_API_NAME}" >&2; exit 1
fi
FLAT_INT_ID="$(int_id_by_type "${FLAT_AID}" HTTP_PROXY)"

# Part 1: TlsConfig on a PUBLIC integration. The template DOES declare it and
# AWS silently discards it, so the read-back must be absent. This is the
# issue's PREMISE — if AWS ever starts honoring the field, this fails loudly
# instead of the drift scoping silently hiding a real value.
TLS_SNI="$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'TlsConfig.ServerNameToVerify')"
if [ "${TLS_SNI}" != "None" ]; then
  echo "FAIL: expected AWS to discard TlsConfig on a public integration, but it read back '${TLS_SNI}' — issue #1602's premise no longer holds, re-measure before trusting the drift scoping" >&2
  exit 1
fi
echo "    TlsConfig confirmed discarded by AWS on the public integration (#1602 premise)"

# Part 2: the flat SDK spelling of ResponseParameters must be delivered
# verbatim (the pass-through branch of toSdkResponseParameters).
if [ "$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'ResponseParameters."404"."append:header.x-cdkd-flat"')" != "flat-before" ] \
  || [ "$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'ResponseParameters."404"."overwrite:statuscode"')" != "200" ]; then
  echo "FAIL: Phase 1 flat-spelled ResponseParameters not delivered (got '$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'ResponseParameters."404"')')" >&2
  exit 1
fi

if [ "$(int_field "${AID}" "${EVENTS_INT_ID}" 'IntegrationSubtype')" != "EventBridge-PutEvents" ] \
  || [ "$(int_field "${AID}" "${EVENTS_INT_ID}" 'CredentialsArn')" = "None" ] \
  || [ "$(int_field "${AID}" "${EVENTS_INT_ID}" 'RequestParameters.DetailType')" != "before" ]; then
  echo "FAIL: Phase 1 service Integration fields not live: Subtype='$(int_field "${AID}" "${EVENTS_INT_ID}" IntegrationSubtype)' Creds='$(int_field "${AID}" "${EVENTS_INT_ID}" CredentialsArn)' DetailType='$(int_field "${AID}" "${EVENTS_INT_ID}" 'RequestParameters.DetailType')'" >&2
  exit 1
fi
if [ "$(auth_field "${AID}" "${AUTH_ID}" 'AuthorizerResultTtlInSeconds')" != "300" ]; then
  echo "FAIL: Phase 1 Authorizer TTL not 300 (got '$(auth_field "${AID}" "${AUTH_ID}" AuthorizerResultTtlInSeconds)')" >&2
  exit 1
fi
if [ "$(auth_field "${AID}" "${CLEAR_AUTH_ID}" 'IdentitySource[0]')" != '$request.header.Authorization' ]; then
  echo "FAIL: Phase 1 ClearAuthorizer IdentitySource not set (got '$(auth_field "${AID}" "${CLEAR_AUTH_ID}" 'IdentitySource[0]')')" >&2
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
# Issue #5390: the map-shaped Tags of the Api and the $default Stage reach AWS
# on CREATE. A pre-fix cdkd read Tags only as a {Key,Value} list and sent none.
# `|| true` so a failed probe reads as '' and fails the comparison loudly
# instead of exiting silently under `set -e`.
A_TAGS="$(api_field "${AID}" 'Tags.k1' || true)/$(api_field "${AID}" 'Tags.k2' || true)"
S_TAGS="$(stage_field "${AID}" 'Tags.k1' || true)/$(stage_field "${AID}" 'Tags.k2' || true)"
if [ "${A_TAGS}" != "v1/v2" ] || [ "${S_TAGS}" != "v1/v2" ]; then
  echo "FAIL: Phase 1 map-shaped Tags not sent on create (issue #5390): Api='${A_TAGS}' Stage='${S_TAGS}'" >&2
  exit 1
fi

# --- Phase 1 (issue #609): the WebSocket Route / Stage properties ------
# All four Route properties below are documented WebSocket-only, which is why
# they ride a second API rather than the HTTP one above.
WS_AID="$(ws_api_id)"
if [ -z "${WS_AID}" ] || [ "${WS_AID}" = "None" ]; then
  echo "FAIL: could not resolve ApiId for ${WS_API_NAME}" >&2; exit 1
fi
ws_route_id() { # ws_route_id <ROUTE_KEY>
  aws apigatewayv2 get-routes --api-id "${WS_AID}" --region "${REGION}" \
    --query "Items[?RouteKey=='$1'].RouteId | [0]" --output text 2>/dev/null
}
WS_CONNECT_ID="$(ws_route_id '$connect')"
WS_DEFAULT_ID="$(ws_route_id '$default')"
if [ -z "${WS_CONNECT_ID}" ] || [ "${WS_CONNECT_ID}" = "None" ] \
  || [ -z "${WS_DEFAULT_ID}" ] || [ "${WS_DEFAULT_ID}" = "None" ]; then
  echo "FAIL: could not resolve both WebSocket route ids (connect='${WS_CONNECT_ID}' default='${WS_DEFAULT_ID}')" >&2
  exit 1
fi

# Issue #609: the four MOCK-integration properties, which only a WebSocket API
# can carry — the reason they were unreachable while still silent-drop.
WS_MOCK_ID="$(int_id_by_type "${WS_AID}" MOCK)"
if [ -z "${WS_MOCK_ID}" ] || [ "${WS_MOCK_ID}" = "None" ]; then
  echo "FAIL: could not resolve the WebSocket MOCK integration id" >&2; exit 1
fi
if [ "$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'RequestTemplates."$default"')" != '{"statusCode":200}' ] \
  || [ "$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'TemplateSelectionExpression')" != '\$default' ] \
  || [ "$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'PassthroughBehavior')" != "WHEN_NO_MATCH" ] \
  || [ "$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'ContentHandlingStrategy')" != "CONVERT_TO_TEXT" ]; then
  echo "FAIL: Phase 1 WS MOCK Integration fields not live: RT='$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'RequestTemplates."$default"')' TSE='$(int_field "${WS_AID}" "${WS_MOCK_ID}" TemplateSelectionExpression)' PB='$(int_field "${WS_AID}" "${WS_MOCK_ID}" PassthroughBehavior)' CHS='$(int_field "${WS_AID}" "${WS_MOCK_ID}" ContentHandlingStrategy)'" >&2
  exit 1
fi

if [ "$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'ApiKeyRequired')" != "True" ]; then
  echo "FAIL: Phase 1 WS \$connect ApiKeyRequired not true (got '$(route_field "${WS_AID}" "${WS_CONNECT_ID}" ApiKeyRequired)')" >&2
  exit 1
fi
if [ "$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'RequestParameters."route.request.header.X-Cdkd".Required')" != "True" ]; then
  echo "FAIL: Phase 1 WS \$connect RequestParameters not set (got '$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'RequestParameters."route.request.header.X-Cdkd".Required')')" >&2
  exit 1
fi
if [ "$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" 'ModelSelectionExpression')" != '$request.body.action' ]; then
  echo "FAIL: Phase 1 WS \$default ModelSelectionExpression not set (got '$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" ModelSelectionExpression)')" >&2
  exit 1
fi
if [ "$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" 'RouteResponseSelectionExpression')" != '$default' ]; then
  echo "FAIL: Phase 1 WS \$default RouteResponseSelectionExpression not set (got '$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" RouteResponseSelectionExpression)')" >&2
  exit 1
fi
if [ "$(ws_stage_field "${WS_AID}" 'AccessLogSettings.Format')" != '$context.requestId $context.status' ]; then
  echo "FAIL: Phase 1 WS Stage AccessLogSettings.Format not set (got '$(ws_stage_field "${WS_AID}" 'AccessLogSettings.Format')')" >&2
  exit 1
fi
# The RouteSettings members are PascalCase in the template on purpose (the L1
# passes the map through verbatim) — a camelCase key would be dropped by the
# SDK serializer and this readback is what proves it was not.
if [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')" != "5.0" ] \
  && [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')" != "5" ]; then
  echo "FAIL: Phase 1 WS Stage RouteSettings throttle not 5 (got '$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')')" >&2
  exit 1
fi
# The $connect entry is the one phase 3 drops; $default is its retained sibling.
if [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$connect".ThrottlingRateLimit')" != "2.0" ] \
  && [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$connect".ThrottlingRateLimit')" != "2" ]; then
  echo "FAIL: Phase 1 WS Stage RouteSettings \$connect entry not live (got '$(ws_stage_field "${WS_AID}" 'RouteSettings."$connect".ThrottlingRateLimit')')" >&2
  exit 1
fi

# Issue #609 routing guard: moving properties out of `silentDrop` and into
# `handledProperties` is exactly what decides SDK-vs-Cloud-Control routing
# (the #614 auto-route). A backfill that accidentally left one property
# unhandled would route the whole type through Cloud Control, which forwards
# the full property map and so would still deploy green — with none of the
# provider code under test on the path. Pin the route.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
for LID in Integration EventsIntegration WsMockIntegration; do
  ROUTE="$(printf '%s' "${STATE_JSON}" | jq -r --arg l "${LID}" \
    '.resources[$l].provisionedBy // "sdk"')"
  if [ "${ROUTE}" != "sdk" ]; then
    echo "FAIL: ${LID} routed via '${ROUTE}', not the SDK provider this PR tests" >&2
    exit 1
  fi
done
echo "    all three integrations routed via the SDK provider"

echo "    all Phase 1 fields live"

# --- Phase 1b (issue #1602): drift must be CLEAN right after a deploy ----
# Run against the `properties` baseline for the #1602 resources (see
# strip_observed_for_drift): that is the ONLY baseline on which these phantom
# drifts fire, so with the observed snapshot in place this assertion would
# pass even with the fix reverted.
assert_no_drift() { # assert_no_drift "<phase label>"
  local label="$1" out rc
  strip_observed_for_drift
  set +e
  out="$(node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
  rc=$?
  set -e
  if [ "${rc}" -eq 1 ]; then
    echo "FAIL: ${label}: cdkd drift reported drift on an untouched stack (issue #1602):" >&2
    printf '%s\n' "${out}" >&2
    exit 1
  fi
  if [ "${rc}" -ne 0 ]; then
    # exit 2 = command error (throttle / auth / state) — NOT a drift verdict.
    echo "FAIL: ${label}: cdkd drift exited ${rc} (command error, not a drift verdict):" >&2
    printf '%s\n' "${out}" >&2
    exit 1
  fi
  case "${out}" in
    *"no drift detected"*) ;;
    *)
      echo "FAIL: ${label}: cdkd drift exited 0 without reporting 'no drift detected':" >&2
      printf '%s\n' "${out}" >&2
      exit 1
      ;;
  esac
  # A resource whose provider cannot read current state is reported as
  # `unsupported` and compared against NOTHING, so a run that is entirely
  # unsupported ALSO prints "no drift detected". ApiGatewayV2 implements
  # readCurrentState for every type in this stack, so a non-zero unsupported
  # count means the comparison silently stopped covering the resources under
  # test. Match the COUNT, not the word: the clean summary line itself reads
  # `(17 resources checked, 0 unsupported)`. The pattern is ANCHORED on the
  # whole trailer because a bare `0 unsupported` also matches `10 unsupported`
  # / `20 unsupported`, which would wave a real regression through.
  case "${out}" in
    *"checked, 0 unsupported)"*) ;;
    *unsupported*)
      echo "FAIL: ${label}: cdkd drift reported unsupported resource(s) — the #1602 resources may not have been compared at all:" >&2
      printf '%s\n' "${out}" >&2
      exit 1
      ;;
  esac
}

echo "==> Phase 1b: cdkd drift must report NO drift on the freshly-deployed stack"
assert_no_drift "Phase 1b"
echo "    drift clean (TlsConfig scoped drift-unknown, ResponseParameters round-trips both spellings)"

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
# Issue #5004 (real CloudFormation A/B): CloudFormation KEEPS Description,
# DisableExecuteApiEndpoint and IpAddressType when they are removed, so cdkd
# must leave the live values (the phase 1 assertion above proved they were set).
# CorsConfiguration is the one Api member CloudFormation RESETS.
if [ "${D}" != "before removal" ]; then echo "FAIL: Api Description not RETAINED (got '${D}')" >&2; exit 1; fi
if [ "${C}" != "None" ]; then echo "FAIL: Api CorsConfiguration not cleared (got '${C}'; empty = probe error)" >&2; exit 1; fi
if [ "${DE}" != "True" ]; then echo "FAIL: Api DisableExecuteApiEndpoint not RETAINED (got '${DE}')" >&2; exit 1; fi
if [ "${IP}" != "dualstack" ]; then echo "FAIL: Api IpAddressType not RETAINED (got '${IP}')" >&2; exit 1; fi

ID="$(int_field "${AID}" "${INT_ID}" 'Description')"
RP="$(int_field "${AID}" "${INT_ID}" 'RequestParameters."append:header.x-cdkd"')"
# #5004: CloudFormation KEEPS both on removal.
if [ "${ID}" != "before removal" ]; then echo "FAIL: Integration Description not RETAINED (got '${ID}')" >&2; exit 1; fi
if [ "${RP}" != "y" ]; then echo "FAIL: Integration RequestParameters not RETAINED (got '${RP}')" >&2; exit 1; fi

TTL="$(auth_field "${AID}" "${AUTH_ID}" 'AuthorizerResultTtlInSeconds')"
# #5004: CloudFormation KEEPS AuthorizerResultTtlInSeconds on removal.
if [ "${TTL}" != "300" ]; then echo "FAIL: Authorizer TTL not RETAINED at 300 (got '${TTL}')" >&2; exit 1; fi
# Issue #1160 (real CloudFormation A/B): CloudFormation CLEARS a removed
# IdentitySource, so cdkd sends `[]` and AWS reads back none (absent in the
# A/B; an empty list counts too). A pre-fix cdkd sent nothing and the header
# stayed. `0` only: an empty read is a probe error, never "cleared".
CLEAR_IS="$(auth_field "${AID}" "${CLEAR_AUTH_ID}" 'length(IdentitySource || `[]`)')"
if [ "${CLEAR_IS}" != "0" ]; then
  echo "FAIL: ClearAuthorizer IdentitySource not cleared on removal (got '${CLEAR_IS}'; issue #1160: CloudFormation clears it)" >&2
  exit 1
fi

# Issue #609 (::Integration backfill), phase 2. These CHANGE VALUE rather than
# being removed: the backfill wires delivery on create AND update, and the
# absent-field removal decision is deferred to the #1160 umbrella (each field
# needs its own live CFn A/B first), so a removal assertion here would be
# asserting behavior this PR deliberately does not implement.
RESP_H="$(int_field "${AID}" "${INT_ID}" 'ResponseParameters."404"."append:header.x-cdkd-resp"')"
RESP_S="$(int_field "${AID}" "${INT_ID}" 'ResponseParameters."404"."overwrite:statuscode"')"
if [ "${RESP_H}" != "updated" ] || [ "${RESP_S}" != "403" ]; then
  echo "FAIL: Integration ResponseParameters not updated (header='${RESP_H}' status='${RESP_S}')" >&2; exit 1
fi
# Issue #1602: the flat-spelled block must be UPDATED in place (same
# pass-through branch on the update path), and the drift check after it proves
# the updated baseline still round-trips.
FLAT_H="$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'ResponseParameters."404"."append:header.x-cdkd-flat"')"
FLAT_S="$(int_field "${FLAT_AID}" "${FLAT_INT_ID}" 'ResponseParameters."404"."overwrite:statuscode"')"
if [ "${FLAT_H}" != "flat-updated" ] || [ "${FLAT_S}" != "204" ]; then
  echo "FAIL: flat-spelled ResponseParameters not updated (header='${FLAT_H}' status='${FLAT_S}')" >&2; exit 1
fi
EV_DT="$(int_field "${AID}" "${EVENTS_INT_ID}" 'RequestParameters.DetailType')"
EV_ST="$(int_field "${AID}" "${EVENTS_INT_ID}" 'IntegrationSubtype')"
if [ "${EV_DT}" != "updated" ] || [ "${EV_ST}" != "EventBridge-PutEvents" ]; then
  echo "FAIL: service Integration not updated (DetailType='${EV_DT}' Subtype='${EV_ST}')" >&2; exit 1
fi
# RETENTION, not removal: these two are unchanged by phase 2 and must survive
# the partial UpdateIntegration. Without this the phase-2 assertion set is
# narrower than phase 1's, and "cdkd wiped a field it did not touch" — the
# failure mode the whole #1160 umbrella is about — would pass silently.
EV_CRED="$(int_field "${AID}" "${EVENTS_INT_ID}" 'CredentialsArn')"
if [ "${EV_CRED}" = "None" ]; then
  echo "FAIL: service Integration CredentialsArn lost across the update (got '${EV_CRED}')" >&2; exit 1
fi
WS_TSE="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'TemplateSelectionExpression')"
if [ "${WS_TSE}" != '\$default' ]; then
  echo "FAIL: WS MOCK TemplateSelectionExpression lost across the update (got '${WS_TSE}')" >&2; exit 1
fi
WS_RT="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'RequestTemplates."$default"')"
WS_PB="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'PassthroughBehavior')"
WS_CH="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'ContentHandlingStrategy')"
if [ "${WS_RT}" != '{"statusCode":202}' ] || [ "${WS_PB}" != "NEVER" ] \
  || [ "${WS_CH}" != "CONVERT_TO_BINARY" ]; then
  echo "FAIL: WS MOCK Integration not updated (RT='${WS_RT}' PB='${WS_PB}' CHS='${WS_CH}')" >&2; exit 1
fi

# Issue #609: ApiKeyRequired is REMOVED in phase 2 and must reset to the CFn
# default; the three expressions / the parameter map CHANGE value, and the two
# Stage blocks change too (UpdateStage merges them and AWS documents no
# whole-block reset, so cdkd passes them through — asserted, not assumed).
if [ "$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'ApiKeyRequired')" != "False" ]; then
  echo "FAIL: WS \$connect ApiKeyRequired not reset to false (got '$(route_field "${WS_AID}" "${WS_CONNECT_ID}" ApiKeyRequired)')" >&2
  exit 1
fi
if [ "$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'RequestParameters."route.request.header.X-Cdkd".Required')" != "False" ]; then
  echo "FAIL: WS \$connect RequestParameters not updated (got '$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'RequestParameters."route.request.header.X-Cdkd".Required')')" >&2
  exit 1
fi
if [ "$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" 'ModelSelectionExpression')" != '$request.body.updatedAction' ]; then
  echo "FAIL: WS \$default ModelSelectionExpression not updated (got '$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" ModelSelectionExpression)')" >&2
  exit 1
fi
if [ "$(ws_stage_field "${WS_AID}" 'AccessLogSettings.Format')" != '$context.requestId $context.status $context.routeKey' ]; then
  echo "FAIL: WS Stage AccessLogSettings.Format not updated (got '$(ws_stage_field "${WS_AID}" 'AccessLogSettings.Format')')" >&2
  exit 1
fi
if [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')" != "15.0" ] \
  && [ "$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')" != "15" ]; then
  echo "FAIL: WS Stage RouteSettings throttle not updated to 15 (got '$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')')" >&2
  exit 1
fi

ON="$(route_field "${AID}" "${ROUTE_ID}" 'OperationName')"
# #5004: CloudFormation KEEPS OperationName on removal.
if [ "${ON}" != "probeOp" ]; then echo "FAIL: Route OperationName not RETAINED (got '${ON}')" >&2; exit 1; fi

SV="$(stage_field "${AID}" 'StageVariables.foo')"
# #5004: CloudFormation KEEPS a dropped stage variable.
if [ "${SV}" != "bar" ]; then echo "FAIL: Stage StageVariables.foo not RETAINED (got '${SV}')" >&2; exit 1; fi
# Issue #5390 (real CloudFormation A/B): a changed tag value is re-tagged, a
# dropped key is untagged, and removing the whole Tags block untags every key.
# A pre-fix cdkd never called TagResource / UntagResource on update. `None` is
# an absent key; an empty read is a probe error, never "untagged".
A_TAGS="$(api_field "${AID}" 'Tags.k1' || true)/$(api_field "${AID}" 'Tags.k2' || true)"
S_TAGS="$(stage_field "${AID}" 'Tags.k1' || true)/$(stage_field "${AID}" 'Tags.k2' || true)"
if [ "${A_TAGS}" != "v1x/None" ] || [ "${S_TAGS}" != "None/None" ]; then
  echo "FAIL: Tags not updated / untagged (issue #5390): Api='${A_TAGS}' (want 'v1x/None') Stage='${S_TAGS}' (want 'None/None')" >&2
  exit 1
fi
echo "    CFn-KEPT fields retained (#5004); Cors cleared via DeleteCorsConfiguration"

# Issue #1602: drift must still be clean AFTER the update — the update path
# re-records both baselines, so a read side that stopped mirroring the declared
# spelling (or a drift-unknown scoping that only worked on the create-time
# baseline) surfaces here rather than in the next user's stack. (`drift` is
# state-driven and never synthesizes, so no CDKD_TEST_* env var is needed.)
echo "==> Phase 2b-pre: cdkd drift must still report NO drift after the update"
assert_no_drift "Phase 2b-pre"
echo "    drift still clean after the update"

# --- Phase 2b: REMOVAL (issue #609) -------------------------------------
# UpdateStage / UpdateRoute MERGE, so these three members can only be cleared
# through their dedicated Delete* APIs (live-probed 2026-08-11). Omitting them
# from the input is the silent no-op the #1160 umbrella tracks.
echo "==> Phase 2b: re-deploy with the delete-API-only members removed"
# Issue #1160: this deploy also changes ONLY the service integration's
# Description. A cdkd that sends the subtype without the full RequestParameters
# fails here with AWS's "requires enabling passthrough, or defining all of the
# following parameters" — named, so the red run says which arm it was.
set +e
P2B_OUT="$(CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P2B_RC=$?
set -e
printf '%s\n' "${P2B_OUT}"
if [ "${P2B_RC}" -ne 0 ]; then
  echo "FAIL: Phase 2b deploy failed (rc=${P2B_RC}); a Description-only change on the EventBridge service integration must carry the full RequestParameters beside the subtype (issue #1160)" >&2
  exit 1
fi

ALS="$(ws_stage_field "${WS_AID}" 'AccessLogSettings.Format')"
if [ "${ALS}" != "None" ]; then
  echo "FAIL: WS Stage AccessLogSettings not cleared (got '${ALS}'; access logging would keep billing)" >&2
  exit 1
fi
DROPPED_RS="$(ws_stage_field "${WS_AID}" 'RouteSettings."$connect".ThrottlingRateLimit')"
if [ "${DROPPED_RS}" != "None" ]; then
  echo "FAIL: WS Stage RouteSettings \$connect entry not deleted (got '${DROPPED_RS}')" >&2
  exit 1
fi
# ...and the RETAINED sibling proves the removal deleted one key, not the block.
KEPT_RS="$(ws_stage_field "${WS_AID}" 'RouteSettings."$default".ThrottlingRateLimit')"
if [ "${KEPT_RS}" != "15.0" ] && [ "${KEPT_RS}" != "15" ]; then
  echo "FAIL: WS Stage RouteSettings \$default sibling did not survive the removal (got '${KEPT_RS}')" >&2
  exit 1
fi
RP="$(route_field "${WS_AID}" "${WS_CONNECT_ID}" 'RequestParameters."route.request.header.X-Cdkd".Required')"
# #5004: CloudFormation KEEPS a dropped Route RequestParameters key, so it is
# NOT deleted: the phase 2 value (Required=false) must still be live.
if [ "${RP}" != "False" ]; then
  echo "FAIL: WS \$connect RequestParameters not RETAINED (got '${RP}')" >&2
  exit 1
fi
echo "    Phase 2b: AccessLogSettings/RouteSettings removals landed, retained sibling intact, RequestParameters retained"

EV_DESC="$(int_field "${AID}" "${EVENTS_INT_ID}" 'Description')"
EV_ST="$(int_field "${AID}" "${EVENTS_INT_ID}" 'IntegrationSubtype')"
EV_DT="$(int_field "${AID}" "${EVENTS_INT_ID}" 'RequestParameters.DetailType')"
if [ "${EV_DESC}" != "description-only change" ] || [ "${EV_ST}" != "EventBridge-PutEvents" ] \
  || [ "${EV_DT}" != "updated" ]; then
  echo "FAIL: Phase 2b service Integration Description-only change not applied intact (Desc='${EV_DESC}' Subtype='${EV_ST}' DetailType='${EV_DT}')" >&2
  exit 1
fi
# Issue #1160 (real CloudFormation A/B): CloudFormation KEEPS the removed MOCK
# integration fields and route selection expressions, so the phase 2 values stay.
WS_RT="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'RequestTemplates."$default"')"
WS_TSE="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'TemplateSelectionExpression')"
WS_PB="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'PassthroughBehavior')"
WS_CH="$(int_field "${WS_AID}" "${WS_MOCK_ID}" 'ContentHandlingStrategy')"
if [ "${WS_RT}" != '{"statusCode":202}' ] || [ "${WS_TSE}" != '\$default' ] \
  || [ "${WS_PB}" != "NEVER" ] || [ "${WS_CH}" != "CONVERT_TO_BINARY" ]; then
  echo "FAIL: Phase 2b WS MOCK Integration removed fields not RETAINED (RT='${WS_RT}' TSE='${WS_TSE}' PB='${WS_PB}' CHS='${WS_CH}')" >&2
  exit 1
fi
WS_MSE="$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" 'ModelSelectionExpression')"
WS_RRSE="$(route_field "${WS_AID}" "${WS_DEFAULT_ID}" 'RouteResponseSelectionExpression')"
if [ "${WS_MSE}" != '$request.body.updatedAction' ] || [ "${WS_RRSE}" != '$default' ]; then
  echo "FAIL: Phase 2b WS \$default route selection expressions not RETAINED (MSE='${WS_MSE}' RRSE='${WS_RRSE}')" >&2
  exit 1
fi
echo "    Phase 2b: Description-only service-integration change applied; removed #609 fields retained (#1160)"

# --- Phase 2c: IntegrationSubtype removal is REFUSED (issue #1160) -----------
# Real CloudFormation A/B: removing the subtype from a service integration
# fails the update ("Invalid integration URI specified"), so cdkd refuses the
# deploy before any call. A pre-fix cdkd sent nothing and reported success.
echo "==> Phase 2c: re-deploy without the service integration's IntegrationSubtype (must be refused)"
set +e
P2C_OUT="$(CDKD_TEST_SUBTYPE_REMOVED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
P2C_RC=$?
set -e
printf '%s\n' "${P2C_OUT}"
if [ "${P2C_RC}" -eq 0 ]; then
  echo "FAIL: Phase 2c deploy succeeded; removing IntegrationSubtype must be refused like CloudFormation (issue #1160)" >&2
  exit 1
fi
case "${P2C_OUT}" in
  *"the previous deploy recorded IntegrationSubtype and this template does not declare it. CloudFormation fails that update"*) ;;
  *)
    echo "FAIL: Phase 2c deploy failed (rc=${P2C_RC}) without the IntegrationSubtype refusal" >&2
    exit 1
    ;;
esac
EV_ST="$(int_field "${AID}" "${EVENTS_INT_ID}" 'IntegrationSubtype')"
if [ "${EV_ST}" != "EventBridge-PutEvents" ]; then
  echo "FAIL: Phase 2c service Integration subtype changed by a refused deploy (got '${EV_ST}')" >&2
  exit 1
fi
echo "    Phase 2c: IntegrationSubtype removal refused; subtype still live"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "API ${AID} still exists after destroy" aws apigatewayv2 get-api --api-id "${AID}" --region "${REGION}"
echo "    API deleted"

assert_gone "WebSocket API ${WS_AID} still exists after destroy" aws apigatewayv2 get-api --api-id "${WS_AID}" --region "${REGION}"
echo "    WebSocket API deleted"

assert_gone "flat-spelling API ${FLAT_AID} still exists after destroy" aws apigatewayv2 get-api --api-id "${FLAT_AID}" --region "${REGION}"
echo "    flat-spelling API deleted"
# The access-log group is STACK-OWNED (unlike the AWS-created Lambda one), so a
# destroy leak has to fail here. `describe-log-streams` 404s on a missing group,
# which is what gone_probe needs; `describe-log-groups` would return an empty
# list and read as "still there".
assert_gone "WS access log group /aws/apigatewayv2/${WS_API_NAME} still exists after destroy" \
  aws logs describe-log-streams --log-group-name "/aws/apigatewayv2/${WS_API_NAME}" --region "${REGION}"
assert_gone "authorizer Lambda ${AUTH_FN} still exists after destroy" aws lambda get-function --function-name "${AUTH_FN}" --region "${REGION}"
echo "    authorizer Lambda deleted"
assert_gone "service-integration role ${EVENTS_ROLE} still exists after destroy" aws iam get-role --role-name "${EVENTS_ROLE}"
echo "    service-integration role deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ApiGatewayV2 update-field removal reset (issue #1160), all 3 phases passed"
