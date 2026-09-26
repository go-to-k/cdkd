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
#   2b. a per-key EnvironmentVariables value the PUT cannot carry, beside an
#       UpdateGraphqlApi change — REFUSED before any write (issue #3781)
#   2c. the same value replayed by `cdkd rollback` from a doctored journal —
#       WARNED, the live map kept, state recording it (issue #3781)
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

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture declares an
# `appsync.CfnApiKey`, and for AppSync the key's ID *is* the usable credential:
# `AppSyncProvider.createApiKey` persists `response.apiKey.id` as the physical
# id, and `attributes` carries it again as `ApiKey` plus an `Arn` built from it
# (src/provisioning/providers/appsync-provider.ts:431-434). So a live `da2-...`
# key is in every state.json this fixture writes -- no `unsafePlainText`
# anywhere, the credential is service-generated. The state bucket is VERSIONED,
# so `aws s3 rm` only writes a delete marker and it stays readable.
#
# Measured 2026-08-20: of 557 surviving versions of this stack's state.json, the
# 12 NEWEST carried no key at all while 17 of versions 12..45 did. That sampling
# shape is the lesson, not a footnote -- a newest-N sample reads the most recent
# run, which is the most likely to be already-fixed or to have failed early, and
# it is what made a first pass call this fixture clean.
. ../s3-versions.sh

STACK="AppSyncStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
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
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1
    # The `aws s3 rm` above only wrote DELETE MARKERS. NONCURRENT-only here:
    # this also runs from the pre-run sweep and the failure traps, where a live
    # state.json may be the only record of resources still standing.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
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

# --- Assertion: Ref to each CHILD type is its real ARN (issue #1681) ---
# cdkd stores a compound physicalId for all three (`<apiId>|<name>`,
# `<apiId>|<typeName>|<fieldName>`, `<apiId>|<apiKeyId>`), while
# CloudFormation's `Ref` returns the resource ARN — which is no SEGMENT of
# that id, so it is recovered from the ARN attribute the provider records at
# create time. Pre-fix these outputs carried the raw compound id.
#
# The `:*:` check is the second half of the issue and is the part that would
# silently pass a weaker assertion: the attribute used to be string-built as
# `arn:aws:appsync:*:*:...`, so it WAS an `arn:`-prefixed value carrying the
# right resource path — only the region and account positions were literal
# `*`. Matching the real account id is what tells the fix from the bug.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
assert_child_ref_arn() { # $1 = output name, $2 = expected ARN infix
  local out_name="$1" expected_infix="$2" value
  value=$(echo "${STATE}" | jq -r ".outputs.${out_name} // empty")
  if [ -z "${value}" ]; then
    echo "FAIL: no ${out_name} output in state" >&2
    echo "${STATE}" | jq '.outputs' >&2
    exit 1
  fi
  case "${value}" in
    arn:*) ;;
    *)
      echo "FAIL: issue #1681 NOT closed — ${out_name} is not an ARN" >&2
      echo "  got: ${value} (looks like cdkd's compound physicalId)" >&2
      exit 1
      ;;
  esac
  case "${value}" in
    *":*:"*)
      echo "FAIL: issue #1681 NOT closed — ${out_name} carries a wildcard region/account" >&2
      echo "  got: ${value}" >&2
      exit 1
      ;;
  esac
  case "${value}" in
    *":${ACCOUNT_ID}:"*) ;;
    *)
      echo "FAIL: ${out_name} does not carry this account id" >&2
      echo "  got:      ${value}" >&2
      echo "  expected: an ARN containing :${ACCOUNT_ID}:" >&2
      exit 1
      ;;
  esac
  case "${value}" in
    *"${expected_infix}"*) ;;
    *)
      echo "FAIL: ${out_name} is not the expected resource ARN shape" >&2
      echo "  got:      ${value}" >&2
      echo "  expected: an ARN containing ${expected_infix}" >&2
      exit 1
      ;;
  esac
  echo "    OK: ${out_name} resolved to ${value}"
}
assert_child_ref_arn DataSourceRef "apis/${API_ID}/datasources/"
assert_child_ref_arn ResolverRef "apis/${API_ID}/types/"
# The segment is the SINGULAR `apikey` (docs-verified); cdkd wrote the plural
# `apikeys` before #1681, so this also fences that half.
assert_child_ref_arn ApiKeyRef "apis/${API_ID}/apikey/"

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

# --- Phase 1d: DataSource NESTED config blobs (#1597) ------------------------
# The two nested silent drops the nested-key critic opt-in exposed. Both sit
# INSIDE a config block top-level property coverage already counted as
# handled, so a drop here is invisible to every other assertion in this
# fixture: the data source is created successfully, just unsigned /
# unversioned.
echo "==> Phase 1d: DataSource nested config blobs (#1597) reached AWS"
assert_eq "HTTP DS authorizationType" "AWS_IAM" \
  "$(datasource_query HttpDataSource 'dataSource.httpConfig.authorizationConfig.authorizationType')"
assert_eq "HTTP DS awsIamConfig.signingRegion" "${REGION}" \
  "$(datasource_query HttpDataSource 'dataSource.httpConfig.authorizationConfig.awsIamConfig.signingRegion')"
assert_eq "HTTP DS awsIamConfig.signingServiceName" "states" \
  "$(datasource_query HttpDataSource 'dataSource.httpConfig.authorizationConfig.awsIamConfig.signingServiceName')"
assert_eq "versioned DS versioned" "True" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.versioned')"
# The CFn->SDK TYPE divergence: CFn declares both TTLs as STRINGS, the SDK as
# longs. AWS echoes them back as numbers, so `--output text` renders the
# converted value — a verbatim string forward would have been dropped by the
# serializer and these would read empty.
assert_eq "versioned DS deltaSyncConfig.baseTableTTL" "43200" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.deltaSyncConfig.baseTableTTL')"
assert_eq "versioned DS deltaSyncConfig.deltaSyncTableTTL" "1440" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.deltaSyncConfig.deltaSyncTableTTL')"
DELTA_TABLE="$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.deltaSyncConfig.deltaSyncTableName')"
case "${DELTA_TABLE}" in
  *AppSyncDeltaSyncTable*)
    echo "    OK: deltaSyncConfig.deltaSyncTableName = ${DELTA_TABLE}" ;;
  *)
    echo "FAIL: deltaSyncConfig.deltaSyncTableName unexpected: '${DELTA_TABLE}'" >&2
    exit 1 ;;
esac

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

# #1597 update-phase: the nested blobs change through the SAME mapper the
# create path uses, so an update-only regression (a mapper wired on create and
# forgotten on update) is caught here rather than by the create assertions.
assert_eq "updated HTTP DS awsIamConfig.signingRegion" "us-west-2" \
  "$(datasource_query HttpDataSource 'dataSource.httpConfig.authorizationConfig.awsIamConfig.signingRegion')"
assert_eq "updated versioned DS deltaSyncConfig.baseTableTTL" "86400" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.deltaSyncConfig.baseTableTTL')"
assert_eq "updated versioned DS deltaSyncConfig.deltaSyncTableTTL" "2880" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.deltaSyncConfig.deltaSyncTableTTL')"

# --- Phase 2b: a malformed per-key env-var value on the template path (#3781) -
# `CdkdExtra` becomes an object, and ownerContact changes in the same deploy, so
# UpdateGraphqlApi would go out BEFORE the env-var PUT. Pre-#3781 that call
# landed and the PUT then threw, leaving the deploy failed with the ownerContact
# change applied. The deploy must now fail before any write.
echo "==> Phase 2b: a malformed EnvironmentVariables value must be REFUSED before any write"
set +e
PHASE2B_OUT="$(CDKD_TEST_UPDATE=true CDKD_TEST_ENV_MALFORMED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
PHASE2B_RC=$?
set -e
printf '%s\n' "${PHASE2B_OUT}"
PHASE2B_PLAIN="$(printf '%s' "${PHASE2B_OUT}" | sed 's/\x1b\[[0-9;]*m//g')"
if [ "${PHASE2B_RC}" -eq 0 ]; then
  echo "FAIL [phase 2b]: the malformed EnvironmentVariables value deployed (exit 0); issue #3781 refuses it" >&2
  exit 1
fi
# Two independent markers: the per-key sentence and the pre-flight's suffix.
if ! printf '%s' "${PHASE2B_PLAIN}" | grep -q 'EnvironmentVariables.CdkdExtra must be a string, got object' ||
   ! printf '%s' "${PHASE2B_PLAIN}" | grep -q 'fix the template value'; then
  echo "FAIL [phase 2b]: the deploy failed, but not with the #3781 template-path refusal" >&2
  exit 1
fi
# The value itself never reaches the output (a variable can hold a secret).
if printf '%s' "${PHASE2B_PLAIN}" | grep -q 'cdkd-integ-not-a-string'; then
  echo "FAIL [phase 2b]: the refusal quoted the environment-variable VALUE" >&2
  exit 1
fi
echo "    [phase 2b] the malformed value was REFUSED (exit ${PHASE2B_RC})"
assert_eq "phase 2b: ownerContact untouched (UpdateGraphqlApi never went out)" "cdkd-integ-updated" \
  "$(api_query 'graphqlApi.ownerContact')"
assert_eq "phase 2b: environmentVariables untouched" '{"CdkdExtra":"added","CdkdStage":"updated"}' \
  "$(env_vars_json | jq -cS '.')"

# --- Phase 2c: the same value on the REPLAY path (issue #3781) --------------
# A state record can carry such a value only if an older cdkd wrote it or it was
# hand-edited, so the journal is doctored: fail an ordinary env-var change (a
# queue AWS refuses, `--no-rollback`), set the journal's previous record to the
# malformed map, and `cdkd rollback`. The revert must WARN, send no PUT (it
# replaces the whole map, so the usable keys alone would delete `CdkdExtra`),
# and record the map AWS still holds.
echo "==> Phase 2c: a REVERT replaying a malformed EnvironmentVariables value must warn and keep the live map"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_ENV_REVERT=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback
PHASE2C_RC=$?
set -e
if [ "${PHASE2C_RC}" -eq 0 ]; then
  echo "FAIL [phase 2c]: the inject-fail deploy SUCCEEDED, so there is no journal to roll back" >&2
  exit 1
fi
# The env-var change must have LANDED, or the rollback has nothing to revert.
REVERTING_ENV='{"CdkdExtra":"added","CdkdStage":"reverting"}'
assert_eq "phase 2c: the failed deploy applied the env-var change" "${REVERTING_ENV}" \
  "$(env_vars_json | jq -cS '.')"
JOURNAL_FILE="$(mktemp)"
DOCTORED_FILE="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" "${JOURNAL_FILE}" >/dev/null
jq '(.segments[].operations[] | select(.logicalId == "GraphQLApi" and .changeType == "UPDATE")
  | .previousState.properties.EnvironmentVariables.CdkdExtra) = {"nested": "cdkd-integ-not-a-string"}' \
  "${JOURNAL_FILE}" > "${DOCTORED_FILE}"
DOCTORED_COUNT="$(jq '[.segments[].operations[] | select(.logicalId == "GraphQLApi" and .changeType == "UPDATE")
  | .previousState.properties.EnvironmentVariables.CdkdExtra | objects] | length' "${DOCTORED_FILE}")"
if [ "${DOCTORED_COUNT}" != "1" ]; then
  echo "FAIL [phase 2c]: expected exactly one GraphQLApi UPDATE op to doctor, got ${DOCTORED_COUNT}" >&2
  jq -c '[.segments[].operations[] | {logicalId, changeType}]' "${JOURNAL_FILE}" >&2
  exit 1
fi
aws s3 cp "${DOCTORED_FILE}" "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null
rm -f "${JOURNAL_FILE}" "${DOCTORED_FILE}"

set +e
PHASE2C_OUT="$(node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)"
PHASE2C_ROLLBACK_RC=$?
set -e
printf '%s\n' "${PHASE2C_OUT}"
if [ "${PHASE2C_ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL [phase 2c]: cdkd rollback exited ${PHASE2C_ROLLBACK_RC}" >&2
  exit 1
fi
PHASE2C_PLAIN="$(printf '%s' "${PHASE2C_OUT}" | sed 's/\x1b\[[0-9;]*m//g')"
# Two independent markers: the per-key sentence and the keep decision.
if ! printf '%s' "${PHASE2C_PLAIN}" | grep -q 'EnvironmentVariables.CdkdExtra must be a string, got object' ||
   ! printf '%s' "${PHASE2C_PLAIN}" | grep -q 'leaving the live environment variables untouched'; then
  echo "FAIL [phase 2c]: the revert did not warn and keep the live environment variables" >&2
  exit 1
fi
if printf '%s' "${PHASE2C_PLAIN}" | grep -q 'cdkd-integ-not-a-string'; then
  echo "FAIL [phase 2c]: the replay warning quoted the environment-variable VALUE" >&2
  exit 1
fi
echo "    [phase 2c] the revert WARNED and sent no env-var PUT"
assert_eq "phase 2c: the live map is kept whole" "${REVERTING_ENV}" "$(env_vars_json | jq -cS '.')"
STATE_ENV="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - |
  jq -cS '.resources.GraphQLApi.properties.EnvironmentVariables')" || { echo "FAIL [phase 2c]: state read failed" >&2; exit 1; }
assert_eq "phase 2c: state records the map AWS holds" "${REVERTING_ENV}" "${STATE_ENV}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after the phase 2c rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"

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

# #1597 removal: UpdateDataSource is a full-replace write, so dropping a
# nested blob from the template clears it server-side with no reset sentinel.
# Each removal is paired with a RETAINED sibling INSIDE the same config block,
# so a reset that wiped the whole block cannot pass: `HttpConfig.Endpoint`
# survives the AuthorizationConfig removal, and `DynamoDBConfig.Versioned`
# survives the DeltaSyncConfig removal.
HTTP_AUTH="$(aws appsync get-data-source --api-id "${API_ID}" --name HttpDataSource \
  --region "${REGION}" --query 'dataSource.httpConfig.authorizationConfig' --output json | jq -r '. // "NONE"')"
assert_eq "removed HTTP DS authorizationConfig cleared" "NONE" "${HTTP_AUTH}"
assert_eq "retained HTTP DS endpoint" "https://states.${REGION}.amazonaws.com" \
  "$(datasource_query HttpDataSource 'dataSource.httpConfig.endpoint')"
DELTA_CFG="$(aws appsync get-data-source --api-id "${API_ID}" --name VersionedItemsDataSource \
  --region "${REGION}" --query 'dataSource.dynamodbConfig.deltaSyncConfig' --output json | jq -r '. // "NONE"')"
assert_eq "removed versioned DS deltaSyncConfig cleared" "NONE" "${DELTA_CFG}"
assert_eq "retained versioned DS versioned" "True" \
  "$(datasource_query VersionedItemsDataSource 'dataSource.dynamodbConfig.versioned')"

# --- Phase 3b: cdkd export --dry-run identifier resolution (issue #3414) ------
# AWS re-declared the AppSync identifiers in September 2026 (GraphQLApi:
# `ApiId` -> `Arn`; ApiKey: `ApiKeyId` -> `[ApiId, ApiKeyId]`, plus the read
# handler that takes the key past the IMPORT pre-flight for the first time),
# and `cdkd export` had no resolution for either. This stack cannot be
# exported end to end — `AWS::AppSync::GraphQLSchema` still has no read
# handler and is NON_PROVISIONABLE, and CloudFormation REFUSES
# `AWS::AppSync::GraphQLApi` for IMPORT although its registry declares a read
# handler (measured 2026-09-18 by the `export` fixture; cdkd blocks it from a
# measured list) — but the plan builder resolves every OTHER resource's
# identifier before it reports the blockers, and a resolution failure is
# reported as a blocker of its own ("could not resolve resource identifier").
# So the assertion is on the blocked list: exactly those two, and no
# DataSource / Resolver / ApiKey line among them — the key's composite
# `[ApiId, ApiKeyId]` resolution is what would have thrown before #3414.
# `block migration` is the sentinel that proves the parse is live; if it ever
# stops appearing (AWS makes both importable), the command exits 0 and the
# plan lines are asserted directly instead.
echo "==> Phase 3b: cdkd export --dry-run resolves every AppSync identifier"
set +e
EXPORT_OUT="$(node "${LOCAL_DIST}" export "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" \
  --dry-run \
  --yes 2>&1)"
EXPORT_RC=$?
set -e
# cdkd's logger colors every line unconditionally (not TTY-gated), so a
# captured line reads `\e[31m  - GraphQLApi (...)...\e[0m` and any
# line-ANCHORED grep below would silently never match (review of #3414 proved
# the first cut's `^\s+- ` exclusion inert this way). Strip the escapes once
# and run every assertion in this block against the plain text.
EXPORT_OUT="$(printf '%s\n' "${EXPORT_OUT}" | sed $'s/\x1b\\[[0-9;]*m//g')"
if [ "${EXPORT_RC}" -eq 0 ]; then
  if ! printf '%s\n' "${EXPORT_OUT}" | grep -qE 'Import plan for CloudFormation stack'; then
    echo "FAIL: export --dry-run exited 0 without printing an import plan" >&2
    printf '%s\n' "${EXPORT_OUT}" | sed 's/^/  /' >&2
    exit 1
  fi
  printf '%s\n' "${EXPORT_OUT}" | grep -qE '\(AWS::AppSync::GraphQLApi\).*Arn=arn:aws:appsync:' \
    || { echo "FAIL: export plan did not resolve the GraphQLApi identifier from the recorded Arn" >&2; exit 1; }
  printf '%s\n' "${EXPORT_OUT}" | grep -qE "\(AWS::AppSync::ApiKey\).*ApiId=${API_ID}, ApiKeyId=da2-" \
    || { echo "FAIL: export plan did not resolve the ApiKey composite identifier" >&2; exit 1; }
else
  if ! printf '%s\n' "${EXPORT_OUT}" | grep -q 'block migration'; then
    echo "FAIL: export --dry-run failed for a reason other than blocked resources (rc=${EXPORT_RC})" >&2
    printf '%s\n' "${EXPORT_OUT}" | sed 's/^/  /' >&2
    exit 1
  fi
  for blocker in 'GraphQLSchema (AWS::AppSync::GraphQLSchema)' 'GraphQLApi (AWS::AppSync::GraphQLApi)'; do
    if ! printf '%s\n' "${EXPORT_OUT}" | grep -qF -- "- ${blocker}"; then
      echo "FAIL: the blocked list does not name ${blocker} (an expected blocker)" >&2
      printf '%s\n' "${EXPORT_OUT}" | sed 's/^/  /' >&2
      exit 1
    fi
  done
  # "exactly those two" is a COUNT, not the absence of a few strings: the
  # thrown message carries the number of blocked resources, so pin it at two
  # — a third blocker with any wording the loop below does not know (a masked
  # id, a row missing from state) would otherwise pass silently.
  if ! printf '%s\n' "${EXPORT_OUT}" | grep -q '2 resource(s) block migration'; then
    echo "FAIL: unexpected blocker count (expected exactly GraphQLSchema + GraphQLApi):" >&2
    printf '%s\n' "${EXPORT_OUT}" | grep -E 'block migration|^\s+- ' | sed 's/^/  /' >&2
    exit 1
  fi
  # Blocked lines render as `  - <logicalId> (<type>): <reason>`; drop the two
  # expected blockers BY LOGICAL ID so a genuine ApiKey / DataSource /
  # Resolver failure cannot hide behind a type name quoted in their reasons.
  # Break-test: the exclusion must actually REMOVE the two lines (it did not,
  # before the ANSI strip above), or the loop below is comparing the whole
  # output and the comment two lines up is a lie.
  OTHER_LINES="$(printf '%s\n' "${EXPORT_OUT}" | grep -vE '^\s+- (GraphQLSchema|GraphQLApi) \(')"
  if printf '%s\n' "${OTHER_LINES}" | grep -qE '^\s+- (GraphQLSchema|GraphQLApi) \('; then
    echo "FAIL: the blocked-line exclusion did not remove the expected blockers (ANSI or format drift)" >&2
    exit 1
  fi
  if [ "$(printf '%s\n' "${EXPORT_OUT}" | grep -cE '^\s+- (GraphQLSchema|GraphQLApi) \(')" != "2" ]; then
    echo "FAIL: expected exactly two anchored blocker lines in the plain output (format drift?)" >&2
    printf '%s\n' "${EXPORT_OUT}" | grep -E -- '- ' | sed 's/^/  /' >&2
    exit 1
  fi
  for unresolved in 'could not resolve resource identifier' 'COMPOSITE_ID_SPLITTERS' \
    'AWS::AppSync::ApiKey' 'AWS::AppSync::DataSource' 'AWS::AppSync::Resolver'; do
    if printf '%s\n' "${OTHER_LINES}" | grep -qF -- "${unresolved}"; then
      echo "FAIL: export --dry-run reports an unresolved identifier (${unresolved}):" >&2
      printf '%s\n' "${OTHER_LINES}" | grep -F -- "${unresolved}" | sed 's/^/  /' >&2
      exit 1
    fi
  done
  echo "==> Phase 3b: only GraphQLSchema + GraphQLApi block the export (ApiKey / DataSource / Resolver identifiers resolved)"
fi

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

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object only looks at the CURRENT object; the bucket is VERSIONED, so the
# AppSync api key survives in prior versions without this (issue #2096). On the
# success path, not only in `cleanup`, and asserted rather than assumed.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "appsync state teardown"

echo ""
echo "==> appsync test passed (#609 GraphQLApi + Resolver + DataSource config properties reach AWS on create / update / removal + clean destroy)"
