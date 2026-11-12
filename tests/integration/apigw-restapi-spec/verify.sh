#!/usr/bin/env bash
# verify.sh -- cdkd AWS::ApiGateway::RestApi SDK provider integ (go-to-k/cdkd#6139).
# Phase 1 creates three REST APIs on the SDK path: an inline OpenAPI Body with
# no Name (ImportRestApi names it from the title), a BodyS3Location asset
# (REGIONAL), and a plain RestApi. Phase 2 checks the CloudFormation update
# semantics measured by a CFn A/B: an overwrite put deletes a dropped path, a
# rename keeps the id, a removed BinaryMediaTypes is cleared, a removed
# Description is kept, and the endpoint type switches in place.

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

cd "$(dirname "$0")"
. ../s3-versions.sh

STACK="CdkdApigwRestApiSpec"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
INLINE_NAME="${STACK}-inline"
ASSET_NAME="${STACK}-asset"
PLAIN_NAME="${STACK}-plain"
PLAIN_RENAMED="${STACK}-plain-renamed"
POLICY_KEPT_NAME="${STACK}-policykept"
CLONE_NAME="${STACK}-clone"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

api_ids_named() { # every id of an API with this name (names are not unique)
  aws apigateway get-rest-apis --region "${REGION}" --limit 500 \
    --query "items[?name=='$1'].id" --output text 2>/dev/null
}
one_api_id() {
  local id; id="$(aws apigateway get-rest-apis --region "${REGION}" --limit 500 \
    --query "items[?name=='$1'].id | [0]" --output text)"
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    echo "FAIL: no REST API named '$1'" >&2; exit 1
  fi
  printf '%s' "${id}"
}
paths_of() { aws apigateway get-resources --rest-api-id "$1" --region "${REGION}" --query 'items[].path' --output text | tr '\t' '\n' | sort | tr '\n' ' '; }
api_field() { # api_field <id> <js expression over j>
  aws apigateway get-rest-api --rest-api-id "$1" --region "${REGION}" --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$2"');process.stdout.write(v===undefined||v===null?"":String(v))})'
}
expect_eq() { # expect_eq <description> <actual> <expected>
  if [ "$2" != "$3" ]; then echo "FAIL: $1: expected '$3', got '$2'" >&2; exit 1; fi
  echo "    OK: $1 = '$3'"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  local n id
  for n in "${INLINE_NAME}" "${ASSET_NAME}" "${CLONE_NAME}" "${PLAIN_NAME}" "${PLAIN_RENAMED}" "${POLICY_KEPT_NAME}"; do
    for id in $(api_ids_named "${n}"); do
      # DeleteRestApi allows one call per 30 s per account.
      aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1 \
        || { sleep 31; aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1; }
    done
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Every RestApi took the SDK path, not Cloud Control.
PROVISIONED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resources;process.stdout.write(Object.values(r).filter(x=>x.resourceType==="AWS::ApiGateway::RestApi").map(x=>x.provisionedBy??"sdk").sort().join(","))})')"
expect_eq "RestApi provisionedBy" "${PROVISIONED}" "sdk,sdk,sdk,sdk,sdk"

INLINE_ID="$(one_api_id "${INLINE_NAME}")"
ASSET_ID="$(one_api_id "${ASSET_NAME}")"
PLAIN_ID="$(one_api_id "${PLAIN_NAME}")"
expect_eq "inline Body paths" "$(paths_of "${INLINE_ID}")" "/ /a /b "
expect_eq "BodyS3Location paths" "$(paths_of "${ASSET_ID}")" "/ /x "
expect_eq "BodyS3Location endpoint type" "$(api_field "${ASSET_ID}" 'j.endpointConfiguration.types.join(",")')" "REGIONAL"
expect_eq "plain description" "$(api_field "${PLAIN_ID}" 'j.description')" "kept-on-removal"
expect_eq "plain binaryMediaTypes" "$(api_field "${PLAIN_ID}" '(j.binaryMediaTypes||[]).join(",")')" "image/gif"
POLICY_KEPT_ID="$(one_api_id "${POLICY_KEPT_NAME}")"
CLONE_ID="$(one_api_id "${CLONE_NAME}")"
expect_eq "plain resources" "$(paths_of "${PLAIN_ID}")" "/ /items "
# The root GET is a Method on the RootResourceId attribute the create recorded.
PLAIN_ROOT="$(aws apigateway get-resources --rest-api-id "${PLAIN_ID}" --region "${REGION}" --query "items[?path=='/'].id | [0]" --output text)"
expect_eq "plain root GET (RootResourceId resolved)" "$(aws apigateway get-method --rest-api-id "${PLAIN_ID}" --resource-id "${PLAIN_ROOT}" --http-method GET --region "${REGION}" --query httpMethod --output text)" "GET"
expect_eq "plain tags" "$(api_field "${PLAIN_ID}" 'Object.entries(j.tags||{}).filter(([k])=>!k.startsWith("aws:")).sort().map(([k,v])=>k+"="+v).join(",")')" "drop=me,keep=original"
expect_eq "plain apiKeySource" "$(api_field "${PLAIN_ID}" 'j.apiKeySource')" "HEADER"
expect_eq "plain disableExecuteApiEndpoint" "$(api_field "${PLAIN_ID}" 'j.disableExecuteApiEndpoint')" "false"
expect_eq "plain policy resource" "$(api_field "${PLAIN_ID}" 'JSON.parse(j.policy.replace(/\\(["\\/])/g,"$1")).Statement[0].Resource')" "arn:aws:execute-api:${REGION}:$(aws sts get-caller-identity --query Account --output text):${PLAIN_ID}/*"
expect_eq "policykept has a policy" "$(api_field "${POLICY_KEPT_ID}" 'j.policy ? "yes" : "no"')" "yes"
expect_eq "clone copied the source's resources" "$(paths_of "${CLONE_ID}")" "/ /items "
for id in "${PLAIN_ID}" "${POLICY_KEPT_ID}" "${CLONE_ID}" "${INLINE_ID}"; do
  expect_eq "${id} endpoint type before phase 2" "$(api_field "${id}" 'j.endpointConfiguration.types.join(",")')" "EDGE"
done

echo "==> Phase 1: drift (expect none; Body / BodyS3Location are write-only)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"

echo "==> Phase 2: update"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

expect_eq "inline Body overwrite (dropped path deleted)" "$(paths_of "${INLINE_ID}")" "/ /a /c "
expect_eq "inline binaryMediaTypes re-applied after the put" "$(api_field "${INLINE_ID}" '(j.binaryMediaTypes||[]).join(",")')" "image/png"
expect_eq "inline name (definition title)" "$(api_field "${INLINE_ID}" 'j.name')" "${INLINE_NAME}"
expect_eq "BodyS3Location replaced asset, Mode merge keeps /x" "$(paths_of "${ASSET_ID}")" "/ /x /y "
expect_eq "plain renamed in place (same id)" "$(api_field "${PLAIN_ID}" 'j.name')" "${PLAIN_RENAMED}"
expect_eq "removed Description kept (CloudFormation keeps it)" "$(api_field "${PLAIN_ID}" 'j.description')" "kept-on-removal"
expect_eq "removed BinaryMediaTypes cleared" "$(api_field "${PLAIN_ID}" '(j.binaryMediaTypes||[]).join(",")')" ""
expect_eq "endpoint type switched in place" "$(api_field "${PLAIN_ID}" 'j.endpointConfiguration.types.join(",")')" "REGIONAL"
expect_eq "plain tags changed / removed / added" "$(api_field "${PLAIN_ID}" 'Object.entries(j.tags||{}).filter(([k])=>!k.startsWith("aws:")).sort().map(([k,v])=>k+"="+v).join(",")')" "added=new,keep=changed"
expect_eq "plain apiKeySource changed" "$(api_field "${PLAIN_ID}" 'j.apiKeySource')" "AUTHORIZER"
expect_eq "plain disableExecuteApiEndpoint changed" "$(api_field "${PLAIN_ID}" 'j.disableExecuteApiEndpoint')" "true"
expect_eq "plain policy changed" "$(api_field "${PLAIN_ID}" 'JSON.parse(j.policy.replace(/\\(["\\/])/g,"$1")).Statement[0].Resource.endsWith("/*/GET/*")')" "true"
expect_eq "removed Policy kept (CloudFormation keeps it)" "$(api_field "${POLICY_KEPT_ID}" 'j.policy ? "yes" : "no"')" "yes"

echo "==> Phase 2: drift (expect none)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for id in "${INLINE_ID}" "${ASSET_ID}" "${PLAIN_ID}" "${POLICY_KEPT_ID}" "${CLONE_ID}"; do
  assert_gone "REST API ${id} still exists after destroy" aws apigateway get-rest-api --rest-api-id "${id}" --region "${REGION}"
done
echo "    OK: REST APIs gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "apigw-restapi-spec state teardown"

echo ""
echo "==> apigw-restapi-spec test passed"
