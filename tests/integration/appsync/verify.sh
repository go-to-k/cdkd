#!/usr/bin/env bash
# verify.sh — AppSync GraphQLApi + Resolver + DataSource config-property
# backfill (issue #609).
#
# The properties this fixture asserts used to be SILENTLY DROPPED: cdkd's
# pre-flight rejected them, and once wired, a near-miss SDK spelling would be
# dropped by the AWS SDK v3 serializer with a perfectly green deploy. So every
# assertion below reads the value back OFF AWS rather than trusting the deploy
# summary. The Resolver/DataSource batch adds: resolver MetricsConfig
# (incl. its full-replace removal), the S3-sourced mapping templates
# (Request/ResponseMappingTemplateS3Location — cdkd fetches the S3 body and
# inlines it, mirroring CFn), and an EventBridge data source
# (EventBridgeConfig + MetricsConfig).
#
# Phases:
#   1. baseline deploy  — every property present, each read back from AWS
#   2. UPDATE           — every mutable property CHANGED, each re-read
#   3. REMOVAL          — the properties with an AWS reset sentinel are dropped
#                         from the template; each must be RESET on AWS, while
#                         EnhancedMetricsConfig stays RETAINED (so a blanket
#                         wipe cannot pass this phase)
#   4. destroy          — API / user pool / state all gone
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""

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

STACK="AppSyncStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="cdkd-appsync-example"
POOL_NAME="cdkd-appsync-example-pool"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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

# --- helpers ----------------------------------------------------------------
# Strict captures: a probe failure must abort under `set -e`, never degrade to
# an empty string that an assertion then reads as "absent" (issue #1120).
api_query() { # usage: api_query <jmespath>
  local out
  out="$(aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}" \
    --query "$1" --output text)" || return 1
  printf '%s' "${out}"
}

env_vars_json() {
  local out
  out="$(aws appsync get-graphql-api-environment-variables --api-id "${API_ID}" \
    --region "${REGION}" --query 'environmentVariables' --output json)" || return 1
  printf '%s' "${out}"
}

api_json() {
  local out
  out="$(aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}" \
    --query 'graphqlApi' --output json)" || return 1
  printf '%s' "${out}"
}

assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 = $2"
}

resolver_query() { # usage: resolver_query <field-name> <jmespath>
  local out
  out="$(aws appsync get-resolver --api-id "${API_ID}" --type-name Query \
    --field-name "$1" --region "${REGION}" --query "$2" --output text)" || return 1
  printf '%s' "${out}"
}

datasource_query() { # usage: datasource_query <name> <jmespath>
  local out
  out="$(aws appsync get-data-source --api-id "${API_ID}" --name "$1" \
    --region "${REGION}" --query "$2" --output text)" || return 1
  printf '%s' "${out}"
}

# Read a resolver mapping template VERBATIM (no --output text munging). The
# caller compares it against the local asset file; both sides go through
# $(...), which strips the trailing newline consistently.
resolver_template() { # usage: resolver_template <field-name> <requestMappingTemplate|responseMappingTemplate>
  local out
  out="$(aws appsync get-resolver --api-id "${API_ID}" --type-name Query \
    --field-name "$1" --region "${REGION}" \
    --query "resolver.$2" --output json | jq -r '.')" || return 1
  printf '%s' "${out}"
}

# --- Phase 1: baseline deploy ----------------------------------------------
echo "==> Phase 1: baseline deploy with the local binary"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

API_ROW=$(echo "${STATE}" | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::AppSync::GraphQLApi") | .value')
API_ID=$(echo "${API_ROW}" | jq -r '.physicalId')
API_ROUTE=$(echo "${API_ROW}" | jq -r '.provisionedBy // "sdk"')
if [ -z "${API_ID}" ] || [ "${API_ID}" = "null" ]; then
  echo "FAIL: no AWS::AppSync::GraphQLApi row in state" >&2
  exit 1
fi
# Routing guard: the whole point of the backfill is that these properties are
# handled by the SDK provider. A cc-api route would mean the pre-flight still
# considers one of them unhandled and #614 silently redirected the resource.
assert_eq "GraphQLApi provisionedBy" "sdk" "${API_ROUTE}"
# Same guard for every Resolver / DataSource row (#609 Resolver+DataSource
# batch): a property slipping back out of handledProperties would re-route
# the row to Cloud Control.
NON_SDK_ROWS=$(echo "${STATE}" | jq -r '[.resources[]
  | select(.resourceType == "AWS::AppSync::Resolver" or .resourceType == "AWS::AppSync::DataSource")
  | .provisionedBy // "sdk"] | map(select(. != "sdk")) | length')
assert_eq "non-sdk Resolver/DataSource rows" "0" "${NON_SDK_ROWS}"
echo "    Resolved AppSync API id: ${API_ID}"

echo "==> Phase 1 assertions: every config property reached AWS"
# apiType / visibility are asserted at their AWS DEFAULTS: the non-default
# values need infra this fixture cannot carry (MERGED needs a merged-API
# source set, PRIVATE needs a VPC endpoint). They are therefore weak here by
# construction — the create-input pinning for both lives in
# tests/unit/provisioning/appsync-graphqlapi-config-props.test.ts, and their
# create-only-ness is pinned by the ReplacementRulesRegistry test.
assert_eq "apiType" "GRAPHQL" "$(api_query 'graphqlApi.apiType')"
assert_eq "visibility" "GLOBAL" "$(api_query 'graphqlApi.visibility')"
assert_eq "introspectionConfig" "DISABLED" "$(api_query 'graphqlApi.introspectionConfig')"
assert_eq "queryDepthLimit" "5" "$(api_query 'graphqlApi.queryDepthLimit')"
assert_eq "resolverCountLimit" "100" "$(api_query 'graphqlApi.resolverCountLimit')"
assert_eq "ownerContact" "cdkd-integ" "$(api_query 'graphqlApi.ownerContact')"
assert_eq "enhancedMetricsConfig.resolverLevelMetricsBehavior" "PER_RESOLVER_METRICS" \
  "$(api_query 'graphqlApi.enhancedMetricsConfig.resolverLevelMetricsBehavior')"
assert_eq "enhancedMetricsConfig.dataSourceLevelMetricsBehavior" "PER_DATA_SOURCE_METRICS" \
  "$(api_query 'graphqlApi.enhancedMetricsConfig.dataSourceLevelMetricsBehavior')"
assert_eq "enhancedMetricsConfig.operationLevelMetricsConfig" "DISABLED" \
  "$(api_query 'graphqlApi.enhancedMetricsConfig.operationLevelMetricsConfig')"

# Drift-layer parity: the read side lags the write side on a freshly-wired
# property (feedback_hunt_diff_layer_parity), and every property below is now
# in readCurrentState's reverse map. A no-op `diff --fail` right after the
# deploy is what proves the two agree — a mismatch here is the phantom drift
# `cdkd drift --revert` would then act on.
echo "==> Phase 1b: no-op diff must report no changes (read/write parity)"
node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --fail
echo "    OK: re-synth diff is clean (the new properties round-trip)"

API_JSON="$(api_json)"
# Sorted: AWS does not promise the submitted order of a list-valued member.
AUTH_TYPES="$(echo "${API_JSON}" | jq -r '[.additionalAuthenticationProviders[].authenticationType] | sort | join(",")')"
assert_eq "additionalAuthenticationProviders types" \
  "AMAZON_COGNITO_USER_POOLS,AWS_IAM,AWS_LAMBDA,OPENID_CONNECT" "${AUTH_TYPES}"

# The irregular spellings: `openIDConnectConfig` / `iatTTL` / `authTTL`. A
# mechanical case flip produces `openIdConnectConfig` / `iatTtl` / `authTtl`,
# which the serializer drops — so these four reads are the live proof the
# hand-written mapper is right.
OIDC="$(echo "${API_JSON}" | jq -r '.additionalAuthenticationProviders[] | select(.authenticationType == "OPENID_CONNECT") | .openIDConnectConfig')"
assert_eq "OIDC issuer" "https://accounts.google.com" "$(echo "${OIDC}" | jq -r '.issuer')"
assert_eq "OIDC clientId" "cdkd-client" "$(echo "${OIDC}" | jq -r '.clientId')"
assert_eq "OIDC iatTTL" "60000" "$(echo "${OIDC}" | jq -r '.iatTTL')"
assert_eq "OIDC authTTL" "120000" "$(echo "${OIDC}" | jq -r '.authTTL')"

POOL_CFG="$(echo "${API_JSON}" | jq -r '.additionalAuthenticationProviders[] | select(.authenticationType == "AMAZON_COGNITO_USER_POOLS") | .userPoolConfig')"
POOL_ID="$(echo "${POOL_CFG}" | jq -r '.userPoolId')"
if [ -z "${POOL_ID}" ] || [ "${POOL_ID}" = "null" ]; then
  echo "FAIL: additional Cognito provider carries no userPoolId" >&2
  exit 1
fi
assert_eq "Cognito provider awsRegion" "${REGION}" "$(echo "${POOL_CFG}" | jq -r '.awsRegion')"

LAMBDA_CFG="$(echo "${API_JSON}" | jq -r '.additionalAuthenticationProviders[] | select(.authenticationType == "AWS_LAMBDA") | .lambdaAuthorizerConfig')"
assert_eq "Lambda authorizer TTL" "30" "$(echo "${LAMBDA_CFG}" | jq -r '.authorizerResultTtlInSeconds')"

assert_eq "environmentVariables" '{"CdkdStage":"baseline"}' \
  "$(env_vars_json | jq -cS '.')"

# --- Phase 1c: Resolver + DataSource #609 properties -------------------------
# CachingConfig / SyncConfig / MaxBatchSize / OpenSearchServiceConfig /
# ElasticsearchConfig / RelationalDatabaseConfig are unit-only (a real ApiCache
# / VERSIONED delta-sync store / Lambda BATCH_INVOKE setup / OpenSearch domain
# / Aurora cluster are out of this fixture's budget) — the create/update input
# pinning for each lives in
# tests/unit/provisioning/appsync-resolver-datasource-props.test.ts. What IS
# live here: Resolver MetricsConfig (+ its removal), the two mapping-template
# S3Locations (fetch-and-inline + URL-change re-fetch), and the EventBridge
# data source (EventBridgeConfig + MetricsConfig + description update).
echo "==> Phase 1c: Resolver + DataSource #609 properties reached AWS"
assert_eq "resolver metricsConfig" "ENABLED" "$(resolver_query getItem 'resolver.metricsConfig')"
assert_eq "EventBridge DS description" "cdkd-integ" \
  "$(datasource_query EventBridgeDataSource 'dataSource.description')"
assert_eq "EventBridge DS metricsConfig" "ENABLED" \
  "$(datasource_query EventBridgeDataSource 'dataSource.metricsConfig')"
EB_ARN="$(datasource_query EventBridgeDataSource 'dataSource.eventBridgeConfig.eventBusArn')"
case "${EB_ARN}" in
  *:event-bus/cdkd-appsync-example-bus)
    echo "    OK: eventBridgeConfig.eventBusArn = ${EB_ARN}" ;;
  *)
    echo "FAIL: eventBridgeConfig.eventBusArn unexpected: '${EB_ARN}'" >&2
    exit 1 ;;
esac
# S3-location fetch-and-inline: the live template must equal the local asset
# file byte-for-byte (both sides ride $(...), which strips the trailing
# newline consistently). This is the live proof that cdkd fetched the S3
# object body and passed it as the inline member, mirroring CloudFormation.
assert_eq "getItemV2 requestMappingTemplate (S3-fetched)" \
  "$(cat lib/templates/get-item-request-v1.vtl)" \
  "$(resolver_template getItemV2 requestMappingTemplate)"
assert_eq "getItemV2 responseMappingTemplate (S3-fetched)" \
  "$(cat lib/templates/get-item-response.vtl)" \
  "$(resolver_template getItemV2 responseMappingTemplate)"

# --- Phase 2: UPDATE --------------------------------------------------------
echo "==> Phase 2: UPDATE (every mutable property changed)"
UPDATE_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)"
echo "${UPDATE_OUT}"

# An in-place update must NOT wipe the create-time attributes: the deploy
# engine treats a returned attributes object as authoritative, so a provider
# returning `{}` degrades every later Fn::GetAtt to the physical-id fallback.
# The stack's GraphQLApiUrl output is that Fn::GetAtt, so a URL here is the
# live proof it survived the update.
if ! echo "${UPDATE_OUT}" | grep -qE 'GraphQLApiUrl = https://'; then
  echo "FAIL: GraphQLApiUrl output did not resolve after the update — the update path wiped the create-time attributes" >&2
  echo "${UPDATE_OUT}" | grep -iE 'GraphQLApiUrl|Cannot resolve' >&2
  exit 1
fi
echo "    OK: GraphQLApiUrl output still resolves after an in-place update"

assert_eq "updated introspectionConfig" "ENABLED" "$(api_query 'graphqlApi.introspectionConfig')"
assert_eq "updated queryDepthLimit" "8" "$(api_query 'graphqlApi.queryDepthLimit')"
assert_eq "updated resolverCountLimit" "200" "$(api_query 'graphqlApi.resolverCountLimit')"
assert_eq "updated ownerContact" "cdkd-integ-updated" "$(api_query 'graphqlApi.ownerContact')"

API_JSON="$(api_json)"
assert_eq "updated OIDC clientId" "cdkd-updated-client" \
  "$(echo "${API_JSON}" | jq -r '.additionalAuthenticationProviders[] | select(.authenticationType == "OPENID_CONNECT") | .openIDConnectConfig.clientId')"
assert_eq "updated Lambda authorizer TTL" "60" \
  "$(echo "${API_JSON}" | jq -r '.additionalAuthenticationProviders[] | select(.authenticationType == "AWS_LAMBDA") | .lambdaAuthorizerConfig.authorizerResultTtlInSeconds')"
assert_eq "updated environmentVariables" '{"CdkdExtra":"added","CdkdStage":"updated"}' \
  "$(env_vars_json | jq -cS '.')"

# Resolver + DataSource #609 update-phase assertions: the request template's
# asset switched to v2 (a NEW S3 key), so cdkd must re-fetch and re-upload the
# body; the EventBridge data source's description changed, and UpdateDataSource
# is a full-replace write, so the unchanged EventBridgeConfig / MetricsConfig
# must ride along un-clobbered.
assert_eq "updated getItemV2 requestMappingTemplate (S3 URL change re-fetched)" \
  "$(cat lib/templates/get-item-request-v2.vtl)" \
  "$(resolver_template getItemV2 requestMappingTemplate)"
assert_eq "updated EventBridge DS description" "cdkd-integ-updated" \
  "$(datasource_query EventBridgeDataSource 'dataSource.description')"
assert_eq "EventBridge DS metricsConfig survives the update" "ENABLED" \
  "$(datasource_query EventBridgeDataSource 'dataSource.metricsConfig')"
assert_eq "resolver metricsConfig survives the update" "ENABLED" \
  "$(resolver_query getItem 'resolver.metricsConfig')"

# --- Phase 3: REMOVAL -------------------------------------------------------
# AppSync treats an OMITTED UpdateGraphqlApi member as "no change", so a
# removal that merely leaves the member off the input silently keeps the old
# value (the #1160 absent-field class). Each property below therefore has to
# be reset to its documented AWS default.
echo "==> Phase 3: REMOVAL (properties dropped from the template must be reset)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

API_JSON="$(api_json)"
assert_eq "reset queryDepthLimit" "0" "$(echo "${API_JSON}" | jq -r '.queryDepthLimit // 0')"
assert_eq "reset resolverCountLimit" "0" "$(echo "${API_JSON}" | jq -r '.resolverCountLimit // 0')"
assert_eq "reset ownerContact" "" "$(echo "${API_JSON}" | jq -r '.ownerContact // ""')"
assert_eq "reset introspectionConfig" "ENABLED" "$(echo "${API_JSON}" | jq -r '.introspectionConfig')"
assert_eq "reset additionalAuthenticationProviders" "0" \
  "$(echo "${API_JSON}" | jq -r '[.additionalAuthenticationProviders // [] | .[]] | length')"
# AWS renders a cleared environment-variable map as an ABSENT member, so
# assert the key COUNT rather than a literal `{}`. The baseline / update
# phases above already proved the map was populated, so a zero count here is
# a real clearing, not a vacuous pass.
assert_eq "reset environmentVariables key count" "0" "$(env_vars_json | jq -r '(. // {}) | length')"

# ...and the RETAINED sibling: without this, a reset that wiped the whole
# config would pass every assertion above.
assert_eq "retained enhancedMetricsConfig.resolverLevelMetricsBehavior" "PER_RESOLVER_METRICS" \
  "$(echo "${API_JSON}" | jq -r '.enhancedMetricsConfig.resolverLevelMetricsBehavior')"

# Resolver #609 removal: the template dropped the resolver's MetricsConfig.
# UNLIKE UpdateGraphqlApi, UpdateResolver is a FULL-REPLACE write — cdkd
# omits the member and AppSync must clear it server-side (no reset sentinel).
# This assertion is the LIVE pin of that removal story; the baseline phase
# asserted ENABLED, so DISABLED here is a real clearing, not a vacuous pass.
# AWS may render the cleared flag as DISABLED or omit the member; both read
# as DISABLED.
RESOLVER_METRICS="$(aws appsync get-resolver --api-id "${API_ID}" --type-name Query \
  --field-name getItem --region "${REGION}" \
  --query 'resolver.metricsConfig' --output json | jq -r '. // "DISABLED"')"
assert_eq "removed resolver metricsConfig cleared" "DISABLED" "${RESOLVER_METRICS}"
# ...and the retained DataSource sibling: a blanket metrics wipe cannot pass.
assert_eq "retained EventBridge DS metricsConfig" "ENABLED" \
  "$(datasource_query EventBridgeDataSource 'dataSource.metricsConfig')"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "AppSync API ${API_ID} still exists after destroy" \
  aws appsync get-graphql-api --api-id "${API_ID}" --region "${REGION}"
echo "    OK: AppSync API is gone"

assert_gone "EventBus cdkd-appsync-example-bus still exists after destroy" \
  aws events describe-event-bus --name cdkd-appsync-example-bus --region "${REGION}"
echo "    OK: EventBridge bus is gone"

REMAINING_APIS="$(aws appsync list-graphql-apis --region "${REGION}" \
  --query "length(graphqlApis[?name=='${API_NAME}'])" --output text)"
assert_eq "leftover '${API_NAME}' APIs" "0" "${REMAINING_APIS}"

REMAINING_POOLS="$(aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
  --query "length(UserPools[?Name=='${POOL_NAME}'])" --output text)"
assert_eq "leftover '${POOL_NAME}' user pools" "0" "${REMAINING_POOLS}"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> appsync test passed (#609 GraphQLApi + Resolver + DataSource config properties reach AWS on create / update / removal + clean destroy)"
