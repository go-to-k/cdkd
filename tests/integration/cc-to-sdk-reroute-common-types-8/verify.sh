#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::ApiGatewayV2::Stage,
# ::Integration, ::Route and ::Authorizer, AWS::AppSync::GraphQLApi and
# AWS::S3Vectors::VectorBucket (issue 6490, batch 8).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. Every
# one of them is recorded under DIFFERENT ids by the two layers (a composite or
# an ARN on Cloud Control, the bare id or name on the SDK route), so each flip
# must land the bare id through the entry's normalizer. Every phase acts on all
# six resources at once. Phases: deploy on the SDK route -> force each resource
# onto Cloud Control (--recreate-via-cc-api) and see Cloud Control's form ->
# the plan announces each return -> --pin-cc-api declines them -> redeploy with
# a real change: each id in the SDK form, each record flipped to 'sdk', each
# update reached AWS on the same resource -> drift clean, then exactly the
# out-of-band changes -> the six leave the template and are deleted on the SDK
# route while their HTTP API stays -> destroy.

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

STACK="CdkdCcToSdkRerouteCommonTypes8Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STAGE_NAME="reroute"
VECTOR_BUCKET="cdkd-reroute-ct8-vb"
GQL_NAME="cdkd-reroute-ct8-gql"

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteStage
  RerouteIntegration
  RerouteRoute
  RerouteAuthorizer
  RerouteGraphQLApi
  RerouteVectorBucket
)

type_of() { # usage: type_of <logicalId>
  case "$1" in
    RerouteStage) printf 'AWS::ApiGatewayV2::Stage' ;;
    RerouteIntegration) printf 'AWS::ApiGatewayV2::Integration' ;;
    RerouteRoute) printf 'AWS::ApiGatewayV2::Route' ;;
    RerouteAuthorizer) printf 'AWS::ApiGatewayV2::Authorizer' ;;
    RerouteGraphQLApi) printf 'AWS::AppSync::GraphQLApi' ;;
    RerouteVectorBucket) printf 'AWS::S3Vectors::VectorBucket' ;;
    *) echo "FAIL: type_of has no arm for $1" >&2; return 1 ;;
  esac
}

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# The state record for one resource under test, read from the last load_state.
# A missing record would make every assertion below read `null` and pass
# vacuously, so an empty match hard-fails.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "$1" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource $1" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

output() { # usage: output <OutputKey>
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" '.outputs[$k]'
}

# Set after phase 1 from the stack's outputs; neither ever changes.
API_ID=""
VB_ARN=""

# The id form a layer records. `sdk`: the bare stage name, integration, route
# and authorizer id, GraphQL API id and vector bucket name. `cc` (measured
# us-east-1, 2026-11-17): `<apiId>|<id>` for the stage, integration and route,
# `<authorizerId>|<apiId>` for the authorizer, and the ARN for the other two.
form_ok() { # usage: form_ok <sdk|cc> <logicalId> <physicalId>
  case "$1:$2" in
    sdk:RerouteStage) [ "$3" = "${STAGE_NAME}" ] ;;
    cc:RerouteStage) [ "$3" = "${API_ID}|${STAGE_NAME}" ] ;;
    sdk:RerouteIntegration | sdk:RerouteRoute | sdk:RerouteAuthorizer) grep -qE '^[a-z0-9]+$' <<<"$3" ;;
    cc:RerouteIntegration | cc:RerouteRoute) grep -qE "^${API_ID}\\|[a-z0-9]+\$" <<<"$3" ;;
    cc:RerouteAuthorizer) grep -qE "^[a-z0-9]+\\|${API_ID}\$" <<<"$3" ;;
    sdk:RerouteGraphQLApi) grep -qE '^[a-z0-9]{26}$' <<<"$3" ;;
    cc:RerouteGraphQLApi) grep -qE "^arn:aws[-a-z]*:appsync:${REGION}:[0-9]{12}:apis/[a-z0-9]{26}\$" <<<"$3" ;;
    sdk:RerouteVectorBucket) [ "$3" = "${VECTOR_BUCKET}" ] ;;
    cc:RerouteVectorBucket) [ "$3" = "${VB_ARN}" ] ;;
    *) echo "FAIL: form_ok has no arm for $1:$2" >&2; return 1 ;;
  esac
}

# The bare id AWS addresses the resource by, from either recorded form.
bare_id() { # usage: bare_id <logicalId> <physicalId>
  case "$1" in
    RerouteStage | RerouteIntegration | RerouteRoute) printf '%s' "${2##*|}" ;;
    RerouteAuthorizer) printf '%s' "${2%%|*}" ;;
    RerouteGraphQLApi | RerouteVectorBucket) printf '%s' "${2##*/}" ;;
    *) echo "FAIL: bare_id has no arm for $1" >&2; return 1 ;;
  esac
}

# What the template declares for a resource in a phase whose value is <a|b>,
# in the shape live_value prints it.
expected() { # usage: expected <logicalId> <a|b>
  case "$1" in
    RerouteAuthorizer) if [ "$2" = a ]; then printf '300'; else printf '120'; fi ;;
    RerouteGraphQLApi) if [ "$2" = a ]; then printf 'False'; else printf 'True'; fi ;;
    RerouteStage | RerouteIntegration | RerouteRoute | RerouteVectorBucket) printf 'phase-%s' "$2" ;;
    *) echo "FAIL: expected has no arm for $1" >&2; return 1 ;;
  esac
}

# The value AWS holds for that property, read through the recorded id.
live_value() { # usage: live_value <logicalId> <physicalId>
  local bare
  bare=$(bare_id "$1" "$2") || return 1
  case "$1" in
    RerouteStage)
      aws apigatewayv2 get-stage --api-id "${API_ID}" --stage-name "${bare}" \
        --region "${REGION}" --query Description --output text ;;
    RerouteIntegration)
      aws apigatewayv2 get-integration --api-id "${API_ID}" --integration-id "${bare}" \
        --region "${REGION}" --query Description --output text ;;
    RerouteRoute)
      aws apigatewayv2 get-route --api-id "${API_ID}" --route-id "${bare}" \
        --region "${REGION}" --query OperationName --output text ;;
    RerouteAuthorizer)
      aws apigatewayv2 get-authorizer --api-id "${API_ID}" --authorizer-id "${bare}" \
        --region "${REGION}" --query AuthorizerResultTtlInSeconds --output text ;;
    RerouteGraphQLApi)
      aws appsync get-graphql-api --api-id "${bare}" \
        --region "${REGION}" --query graphqlApi.xrayEnabled --output text ;;
    RerouteVectorBucket)
      # The ARN of the bucket the record names, not the phase-1 constant.
      aws s3vectors list-tags-for-resource \
        --resource-arn "${VB_ARN%/*}/${bare}" --region "${REGION}" --query tags.phase --output text ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}

# IDENTITY WITNESS, AWS-minted, read back from AWS through the recorded id:
# the integration, route, authorizer and GraphQL API ids (a recreate mints
# others), and the createdDate / creationTime of the stage and the vector
# bucket (a recreated one keeps its name).
witness() { # usage: witness <logicalId> <physicalId>
  local bare
  bare=$(bare_id "$1" "$2") || return 1
  case "$1" in
    RerouteStage)
      aws apigatewayv2 get-stage --api-id "${API_ID}" --stage-name "${bare}" \
        --region "${REGION}" --query CreatedDate --output text ;;
    RerouteIntegration)
      aws apigatewayv2 get-integration --api-id "${API_ID}" --integration-id "${bare}" \
        --region "${REGION}" --query IntegrationId --output text ;;
    RerouteRoute)
      aws apigatewayv2 get-route --api-id "${API_ID}" --route-id "${bare}" \
        --region "${REGION}" --query RouteId --output text ;;
    RerouteAuthorizer)
      aws apigatewayv2 get-authorizer --api-id "${API_ID}" --authorizer-id "${bare}" \
        --region "${REGION}" --query AuthorizerId --output text ;;
    RerouteGraphQLApi)
      aws appsync get-graphql-api --api-id "${bare}" \
        --region "${REGION}" --query graphqlApi.apiId --output text ;;
    RerouteVectorBucket)
      aws s3vectors get-vector-bucket --vector-bucket-name "${bare}" \
        --region "${REGION}" --query vectorBucket.creationTime --output text ;;
    *) echo "FAIL: witness has no arm for $1" >&2; return 1 ;;
  esac
}

witness_ok() { # usage: witness_ok <witness>
  [ -n "$1" ] && [ "$1" != "None" ]
}

# Every resource's live value must be the phase's.
assert_live_values() { # usage: assert_live_values <phase-label> <a|b>
  local id pid got want
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    got=$(live_value "${id}" "${pid}")
    want=$(expected "${id}" "$2")
    [ "${got}" = "${want}" ] || { echo "FAIL: $1: ${id} (${pid}) holds '${got}', expected '${want}'" >&2; exit 1; }
  done
}

assert_layers() { # usage: assert_layers <phase-label> <sdk|cc-api>
  local id layer
  for id in "${SUBJECTS[@]}"; do
    layer=$(record "${id}" '.provisionedBy')
    [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${id} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
  done
}

assert_forms() { # usage: assert_forms <phase-label> <sdk|cc>
  local id pid
  for id in "${SUBJECTS[@]}"; do
    pid=$(record "${id}" '.physicalId')
    form_ok "$2" "${id}" "${pid}" || { echo "FAIL: $1: ${id} recorded '${pid}', not the $2 form" >&2; exit 1; }
  done
}

# Each Ref the stack outputs must be what CloudFormation returns, on either
# layer: the bare id for the four v2 children (cdkd takes the right segment of
# a Cloud Control composite), the ARN for the GraphQL API and the vector bucket
# (the Cloud Control id itself, then the `Arn` / `VectorBucketArn` attribute
# the flip carries over). The ARNs are read back from AWS.
assert_refs() { # usage: assert_refs <phase-label>
  local id key got want gql_arn vb_arn
  for id in RerouteStage RerouteIntegration RerouteRoute RerouteAuthorizer; do
    key="${id#Reroute}Ref"
    got=$(output "${key}")
    want=$(bare_id "${id}" "$(record "${id}" '.physicalId')")
    [ "${got}" = "${want}" ] || { echo "FAIL: $1: Ref of ${id} resolved to '${got}', expected ${want}" >&2; exit 1; }
  done
  gql_arn=$(aws appsync get-graphql-api --api-id "$(bare_id RerouteGraphQLApi "$(record RerouteGraphQLApi '.physicalId')")" \
    --region "${REGION}" --query graphqlApi.arn --output text) || return 1
  [ "$(output GraphQLApiRef)" = "${gql_arn}" ] || {
    echo "FAIL: $1: Ref of RerouteGraphQLApi resolved to '$(output GraphQLApiRef)', expected its ARN ${gql_arn}" >&2
    exit 1
  }
  [ "$(output GraphQLApiId)" = "${gql_arn##*/}" ] || {
    echo "FAIL: $1: GetAtt RerouteGraphQLApi.ApiId resolved to '$(output GraphQLApiId)', expected ${gql_arn##*/}" >&2
    exit 1
  }
  vb_arn=$(aws s3vectors get-vector-bucket --vector-bucket-name "${VECTOR_BUCKET}" \
    --region "${REGION}" --query vectorBucket.vectorBucketArn --output text) || return 1
  [ "$(output VectorBucketRef)" = "${vb_arn}" ] || {
    echo "FAIL: $1: Ref of RerouteVectorBucket resolved to '$(output VectorBucketRef)', expected its ARN ${vb_arn}" >&2
    exit 1
  }
}

# The per-resource routing flags, one per resource under test.
RECREATE_FLAGS=()
PIN_FLAGS=()
for id in "${SUBJECTS[@]}"; do
  RECREATE_FLAGS+=(--recreate-via-cc-api "${id}")
  PIN_FLAGS+=(--pin-cc-api "${id}")
done

# Per-phase ids and witnesses, indexed like SUBJECTS (bash 3.2 has no
# associative arrays).
W0=()
W1=()
P1=()

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
    destroy_rc=$?
    # No state is the normal pre-run and post-destroy answer, not a failed teardown.
    if [ "${destroy_rc}" -ne 0 ] && ! grep -q 'No state found' <<<"${destroy_out}"; then
      echo "WARN: cdkd state destroy exited ${destroy_rc}; state was kept, so check the account for leftovers" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# `--recreate-via-cc-api` validates its arguments against the template's own
# logical ids, so a SUBJECTS entry the stack does not declare fails here, not as
# a confusing refusal mid-run.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
for id in "${SUBJECTS[@]}"; do
  jq -e --arg k "${id}" --arg t "$(type_of "${id}")" '.Resources[$k].Type == $t' "${TEMPLATE}" >/dev/null ||
    { echo "FAIL: ${TEMPLATE} declares no ${id} of type $(type_of "${id}")" >&2; exit 1; }
done

echo "==> Phase 1: Deploy (SDK route by default -- no type under test has SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
API_ID=$(output HttpApiId)
VB_ARN=$(output VectorBucketRef)
grep -qE '^[a-z0-9]+$' <<<"${API_ID}" || { echo "FAIL: no HttpApiId output (got '${API_ID}')" >&2; exit 1; }
grep -qE "^arn:aws[-a-z]*:s3vectors:${REGION}:[0-9]{12}:bucket/${VECTOR_BUCKET}\$" <<<"${VB_ARN}" ||
  { echo "FAIL: Ref of RerouteVectorBucket is not its ARN after the SDK create (got '${VB_ARN}')" >&2; exit 1; }
assert_layers "phase 1 (fresh deploy)" sdk
assert_forms "phase 1 (fresh deploy)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  W0[$i]=$(witness "${id}" "$(record "${id}" '.physicalId')")
  witness_ok "${W0[$i]}" || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
assert_live_values "phase 1 (SDK create)" a
assert_refs "phase 1"
echo "    OK: all ${#SUBJECTS[@]} created on the SDK route"

echo "==> Phase 2: force each resource onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${RECREATE_FLAGS[@]}" --yes
load_state
# Without this every assertion below would be vacuous.
assert_layers "phase 2 (after --recreate-via-cc-api)" cc-api
# THE MEASURED FORMS. Were any of them the bare id, the type would need no
# normalizer and phase 5 would not exercise it.
assert_forms "phase 2 (after --recreate-via-cc-api)" cc
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  P1[$i]=$(record "${id}" '.physicalId')
  W1[$i]=$(witness "${id}" "${P1[$i]}")
  witness_ok "${W1[$i]}" || { echo "FAIL: no identity witness for ${id} after the recreate" >&2; exit 1; }
  [ "${W1[$i]}" != "${W0[$i]}" ] || {
    echo "FAIL: the recreate kept ${id}'s witness (${W0[$i]}); it was not recreated, so the witness cannot prove phase 5" >&2
    exit 1
  }
done
assert_live_values "phase 2 (CC recreate)" b
assert_refs "phase 2"
echo "    OK: all ${#SUBJECTS[@]} pinned to Cloud Control under its own id form, with fresh witnesses"

echo "==> Phase 3: the plan ANNOUNCES each return"
# `pinned`, not `flip`: the seed already declares flip's values, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
for id in "${SUBJECTS[@]}"; do
  # The change row names the logical id and its type; the token rides on it.
  # A row without the token is the routing annotation missing or reworded.
  row=$(grep -F "] ${id} (AWS::" <<<"${DIFF_OUT}" || true)
  [ -n "${row}" ] || { echo "FAIL: cdkd diff shows no change row for ${id}" >&2; printf '%s\n' "${DIFF_OUT}" >&2; exit 1; }
  grep -qF '[returning to SDK provider]' <<<"${row}" || {
    echo "FAIL: cdkd diff did not announce ${id}'s return: ${row}" >&2
    exit 1
  }
done
if grep -q 'via CC API: sticky' <<<"${DIFF_OUT}"; then
  echo "FAIL: cdkd diff still renders the sticky tag for a resource about to leave Cloud Control" >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
fi
echo "    OK: plan says 'returning to SDK provider' for all ${#SUBJECTS[@]}"

echo "==> Phase 4: --pin-cc-api DECLINES each flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    "${PIN_FLAGS[@]}" --yes
load_state
assert_layers "phase 4 (--pin-cc-api)" cc-api
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  [ "$(record "${id}" '.physicalId')" = "${P1[$i]}" ] || { echo "FAIL: the pinned deploy changed ${id}'s id" >&2; exit 1; }
  [ "$(witness "${id}" "${P1[$i]}")" = "${W1[$i]}" ] || {
    echo "FAIL: the pinned Cloud Control update replaced ${id} (its witness changed)" >&2
    exit 1
  }
done
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_live_values "phase 4 (CC update)" a
echo "    OK: all ${#SUBJECTS[@]} still on Cloud Control, updates applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
FLIP_OUT=$(env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee /dev/stderr)
# Each type announces its id moving to the SDK form; each line names its
# logical id. Each id's lines captured first, then matched with a here-string:
# under pipefail a `grep -q` closing the pipe early can SIGPIPE the grep
# feeding it.
for id in "${SUBJECTS[@]}"; do
  lines=$(grep -F "${id} (AWS::" <<<"${FLIP_OUT}" || true)
  grep -qF "takes the SDK provider's form" <<<"${lines}" || {
    echo "FAIL: the flip did not announce ${id}'s id moving to the SDK form" >&2
    exit 1
  }
done
load_state
assert_layers "phase 5 (flip)" sdk
assert_forms "phase 5 (flip)" sdk
for i in "${!SUBJECTS[@]}"; do
  id=${SUBJECTS[$i]}
  p2=$(record "${id}" '.physicalId')
  [ "${p2}" = "$(bare_id "${id}" "${P1[$i]}")" ] || {
    echo "FAIL: ${id}'s flipped id is ${p2}, expected the bare part of Cloud Control's ${P1[$i]}" >&2
    exit 1
  }
  w2=$(witness "${id}" "${p2}")
  [ "${w2}" = "${W1[$i]}" ] || {
    echo "FAIL: ${id}'s witness changed across the flip (${W1[$i]} -> ${w2}); the SDK provider replaced it" >&2
    exit 1
  }
done
# The update reached AWS through the id the flip recorded.
assert_live_values "phase 5 (SDK update)" b
assert_refs "phase 5"
echo "    OK: SDK-form ids, same witnesses, all ${#SUBJECTS[@]} records flipped to sdk, updates applied in place"

echo "==> Phase 6: drift on the flipped records"
# cdkd drift compares AWS with the snapshot each deploy reads back
# (observedProperties). 6a: nothing changed since the flip, so all must be
# clean: each flipped record's snapshot matches what AWS holds. 6b: with the
# mutable property of each changed out of band, each must drift by that
# property alone and the HTTP API not at all, which proves drift reads every
# live resource through its flipped record rather than skipping it.
DRIFT_OUT=""
DRIFT_RC=0
run_drift() {
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --stack-region "${REGION}" --json 2>/dev/null)
  DRIFT_RC=$?
  set -e
}
# The report bucket(s) a logical id lands in, comma-joined.
drift_bucket() { # usage: drift_bucket <logicalId>
  jq -r --arg id "$1" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    <<<"${DRIFT_OUT}" 2>/dev/null || true
}
drift_fail() { # usage: drift_fail <message>
  echo "FAIL: $1" >&2
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
}

run_drift
for id in "${SUBJECTS[@]}"; do
  bucket=$(drift_bucket "${id}")
  [ "${bucket}" = "clean" ] || drift_fail "6a: cdkd drift put ${id} in bucket '${bucket}', expected clean"
done
# The HTTP API too: nothing in the stack drifted.
jq -e '[.[].drifted[]] | length == 0' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6a: cdkd drift reports a drifted resource beside the subjects"
# rc after the buckets, so a non-zero rc names its own cause.
[ "${DRIFT_RC}" -eq 0 ] || drift_fail "6a: cdkd drift exited ${DRIFT_RC} although every subject is clean"
echo "    OK (6a): cdkd drift reported all ${#SUBJECTS[@]} clean (rc=0)"

# The out-of-band change for each subject, and the property path it drifts.
oob_change() { # usage: oob_change <logicalId> <bareId>
  case "$1" in
    RerouteStage)
      aws apigatewayv2 update-stage --api-id "${API_ID}" --stage-name "$2" --description oob \
        --region "${REGION}" >/dev/null ;;
    RerouteIntegration)
      aws apigatewayv2 update-integration --api-id "${API_ID}" --integration-id "$2" --description oob \
        --region "${REGION}" >/dev/null ;;
    RerouteRoute)
      aws apigatewayv2 update-route --api-id "${API_ID}" --route-id "$2" --operation-name oob \
        --region "${REGION}" >/dev/null ;;
    RerouteAuthorizer)
      aws apigatewayv2 update-authorizer --api-id "${API_ID}" --authorizer-id "$2" \
        --authorizer-result-ttl-in-seconds 60 --region "${REGION}" >/dev/null ;;
    RerouteGraphQLApi)
      # UpdateGraphqlApi takes the name and authentication type every time; both
      # are sent unchanged.
      aws appsync update-graphql-api --api-id "$2" --name "${GQL_NAME}" --authentication-type API_KEY \
        --no-xray-enabled --region "${REGION}" >/dev/null ;;
    RerouteVectorBucket)
      aws s3vectors tag-resource --resource-arn "${VB_ARN}" --tags phase=oob --region "${REGION}" >/dev/null ;;
    *) echo "FAIL: oob_change has no arm for $1" >&2; return 1 ;;
  esac
}
oob_path() { # usage: oob_path <logicalId>
  case "$1" in
    RerouteStage | RerouteIntegration) printf 'Description' ;;
    RerouteRoute) printf 'OperationName' ;;
    RerouteAuthorizer) printf 'AuthorizerResultTtlInSeconds' ;;
    RerouteGraphQLApi) printf 'XrayEnabled' ;;
    RerouteVectorBucket) printf 'Tags' ;;
    *) echo "FAIL: oob_path has no arm for $1" >&2; return 1 ;;
  esac
}

for id in "${SUBJECTS[@]}"; do
  oob_change "${id}" "$(record "${id}" '.physicalId')"
done
run_drift
for id in "${SUBJECTS[@]}"; do
  bucket=$(drift_bucket "${id}")
  [ "${bucket}" = "drifted" ] || drift_fail "6b: cdkd drift put ${id} in bucket '${bucket}', expected drifted by its out-of-band $(oob_path "${id}") change"
  want=$(oob_path "${id}")
  paths=$(jq -c --arg id "${id}" '[.[].drifted[] | select(.logicalId == $id) | .changes[].path]' <<<"${DRIFT_OUT}")
  # `Tags` may be reported per key (`Tags.phase`), so a path is the property
  # or a member of it; at least one is required.
  jq -e --arg p "${want}" 'length > 0 and all(. == $p or startswith($p + ".") or startswith($p + "["))' \
    <<<"${paths}" >/dev/null || drift_fail "6b: ${id} drifted by ${paths}, expected only ${want}"
done
jq -e --argjson n "${#SUBJECTS[@]}" '[.[].drifted[]] | length == $n' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6b: cdkd drift reports a drifted resource other than the ${#SUBJECTS[@]} subjects"
[ "${DRIFT_RC}" -ne 0 ] || drift_fail "6b: cdkd drift exited 0 although it reports every subject drifted"
echo "    OK (6b): each subject drifted by its out-of-band change alone, the HTTP API not at all (rc=${DRIFT_RC})"

echo "==> Phase 7: remove the six from the template; each SDK delete must address the flipped id"
# The HTTP API stays, so a v2 delete sent to a wrong id leaves its target alive
# and readable here. After a destroy the API's own delete would take every
# child with it and pass the gone-probes for any id.
FLIPPED=()
for i in "${!SUBJECTS[@]}"; do
  FLIPPED[$i]=$(record "${SUBJECTS[$i]}" '.physicalId')
done
# Captured in a variable, not a temp file a failed deploy would leave behind;
# `tee /dev/stderr` still shows the run.
REMOVE_OUT=$(env CDKD_TEST_PHASE=removed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee /dev/stderr)
REMOVE_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' <<<"${REMOVE_OUT}")
load_state
for id in "${SUBJECTS[@]}"; do
  type=$(type_of "${id}")
  grep -qF "${id} (${type}) deleted" <<<"${REMOVE_PLAIN}" || {
    echo "FAIL: the removal deploy printed no delete line for ${id} (${type})" >&2
    exit 1
  }
  if printf '%s' "${STATE_JSON}" | jq -e --arg k "${id}" '.resources[$k]' >/dev/null; then
    echo "FAIL: ${id} is still in state after the removal deploy" >&2
    exit 1
  fi
done
aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}" >/dev/null || {
  echo "FAIL: HTTP API ${API_ID} is not readable after the removal deploy; the gone-probes below would prove nothing" >&2
  exit 1
}
assert_gone "stage ${FLIPPED[0]} survived its delete under the flipped id" \
  aws apigatewayv2 get-stage --api-id "${API_ID}" --stage-name "${FLIPPED[0]}" --region "${REGION}"
assert_gone "integration ${FLIPPED[1]} survived its delete under the flipped id" \
  aws apigatewayv2 get-integration --api-id "${API_ID}" --integration-id "${FLIPPED[1]}" --region "${REGION}"
assert_gone "route ${FLIPPED[2]} survived its delete under the flipped id" \
  aws apigatewayv2 get-route --api-id "${API_ID}" --route-id "${FLIPPED[2]}" --region "${REGION}"
assert_gone "authorizer ${FLIPPED[3]} survived its delete under the flipped id" \
  aws apigatewayv2 get-authorizer --api-id "${API_ID}" --authorizer-id "${FLIPPED[3]}" --region "${REGION}"
assert_gone "GraphQL API ${FLIPPED[4]} survived its delete under the flipped id" \
  aws appsync get-graphql-api --api-id "${FLIPPED[4]}" --region "${REGION}"
assert_gone "vector bucket ${FLIPPED[5]} survived its delete under the flipped id" \
  aws s3vectors get-vector-bucket --vector-bucket-name "${FLIPPED[5]}" --region "${REGION}"
echo "    OK: all ${#SUBJECTS[@]} deleted by cdkd, the v2 children with their HTTP API still alive"

echo "==> Phase 8: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "HTTP API ${API_ID} survived destroy" \
  aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-8 (normalized ids observed equal to the live v2 Stage, Integration, Route and Authorizer, GraphQL API and vector bucket)"
