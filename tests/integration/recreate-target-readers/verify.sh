#!/usr/bin/env bash
# verify.sh — cdkd --recreate-via-cc-api re-provisions the target's same-stack
# readers (issue #4383).
#
# The target is an HTTP API (`ApiId` is AWS-assigned), read by two SSM
# parameters: one through `Ref`, one through `Fn::GetAtt ApiId`. Phases:
# deploy on the SDK route -> premise: the template diffs to no changes ->
# recreate the API on Cloud Control from that UNCHANGED template -> the API
# came back under a NEW id, the old one is gone, and BOTH parameters hold the
# new id in AWS and in state -> destroy + gone-probes.
#
# Before the fix both parameters diffed NO_CHANGE (nothing in the template
# moved), were never re-provisioned, and kept the deleted API's id.

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

STACK="CdkdRecreateTargetReadersExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="${STACK}-api"
PARAM_REF="${STACK}-api-id-ref"
PARAM_GETATT="${STACK}-api-id-getatt"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Resolved from the synth template below: CDK appends a hash to a construct id
# only for L2s, but deriving it keeps the fixture honest either way, and
# --recreate-via-cc-api's pre-flight rejects an id the template does not hold.
API_LOGICAL_ID=""

# The state record of one resource, matched by logical-id PREFIX. Hard-fails on
# no match: a guessed key would make every assertion read `null` and pass
# vacuously.
record() { # usage: record <logical-id-prefix> <jq-expression-over-the-resource-object>
  local json key
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  key=$(printf '%s' "${json}" | jq -r --arg p "$1" \
    '.resources | keys[] | select(startswith($p))' | head -1)
  [ -n "${key}" ] || { echo "FAIL: no state resource whose logical id starts with $1" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "${key}" ".resources[\$k] | $2"
}

# The live value of an SSM parameter. A strict capture: a probe failure aborts
# under set -e rather than reading as an empty value.
param_value() { # usage: param_value <name>
  aws ssm get-parameter --name "$1" --region "${REGION}" \
    --query 'Parameter.Value' --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_REF}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PARAM_GETATT}" --region "${REGION}" >/dev/null 2>&1 || true
  # Every HTTP API carrying this fixture's exact name, which includes an old
  # one a failed recreate stranded. Scoped by the stack name: an empty name
  # would match nothing in the query, but the guard refuses it outright.
  case "${API_NAME}" in
    CdkdRecreateTargetReaders?*)
      for api_id in $(aws apigatewayv2 get-apis --region "${REGION}" \
        --query "Items[?Name=='${API_NAME}'].ApiId" --output text 2>/dev/null); do
        aws apigatewayv2 delete-api --api-id "${api_id}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *) echo "    WARN: teardown sweep refused an API name outside CdkdRecreateTargetReaders*: '${API_NAME:-<empty>}'" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
API_LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::ApiGatewayV2::Api") | .key' "${TEMPLATE}" | head -1)
[ -n "${API_LOGICAL_ID}" ] || { echo "FAIL: no AWS::ApiGatewayV2::Api in ${TEMPLATE}" >&2; exit 1; }
echo "==> Recreate target: ${API_LOGICAL_ID}"

echo "==> Phase 1: Deploy (SDK route)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

A0=$(record "${API_LOGICAL_ID}" '.physicalId')
[ -n "${A0}" ] && [ "${A0}" != "null" ] || { echo "FAIL: no physical id recorded for ${API_LOGICAL_ID}" >&2; exit 1; }
LAYER0=$(record "${API_LOGICAL_ID}" '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0} for the API, expected sdk" >&2; exit 1; }
for p in "${PARAM_REF}" "${PARAM_GETATT}"; do
  v=$(param_value "${p}")
  [ "${v}" = "${A0}" ] || { echo "FAIL: phase 1: ${p} holds '${v}', expected the API id ${A0}" >&2; exit 1; }
done
echo "    OK: API ${A0} on the SDK route; both parameters hold its id"

echo "==> Phase 2: premise -- the template diffs to no changes"
# If it diffed to a change, the readers could be re-provisioned for that reason
# and the arm below would pass on a binary without the fix. `--fail` exits 1 on
# a change, 0 on none; anything else is a failed run that proves nothing.
set +e
PREMISE_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
PREMISE_RC=$?
set -e
[ "${PREMISE_RC}" -eq 0 ] || {
  printf '%s\n' "${PREMISE_OUT}" >&2
  echo "FAIL: premise: cdkd diff --fail exited ${PREMISE_RC} (expected 0, no changes)" >&2
  exit 1
}
echo "    OK: no template change"

echo "==> Phase 3: THE ARM -- --recreate-via-cc-api on the API; its readers must follow"
RECREATE_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${API_LOGICAL_ID}" --yes 2>&1) || {
  printf '%s\n' "${RECREATE_OUT}" >&2
  echo "FAIL: the --recreate-via-cc-api deploy failed" >&2
  exit 1
}
printf '%s\n' "${RECREATE_OUT}"

A1=$(record "${API_LOGICAL_ID}" '.physicalId')
LAYER1=$(record "${API_LOGICAL_ID}" '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: the API record says provisionedBy=${LAYER1} after the recreate, expected cc-api" >&2; exit 1; }
# PREMISE of the arm: the recreate minted a NEW id. An unchanged id would make
# every reader assertion below pass on a binary without the fix.
[ -n "${A1}" ] && [ "${A1}" != "null" ] && [ "${A1}" != "${A0}" ] || {
  echo "FAIL: premise: the recreated API's id is '${A1}' (old ${A0}); an AWS-assigned id must change across a destroy + create, so nothing below would witness issue #4383" >&2
  exit 1
}
assert_gone "the old API ${A0} survived its recreate" \
  aws apigatewayv2 get-api --api-id "${A0}" --region "${REGION}"
aws apigatewayv2 get-api --api-id "${A1}" --region "${REGION}" >/dev/null

# The readers: in AWS, and in state.
for p in "${PARAM_REF}" "${PARAM_GETATT}"; do
  v=$(param_value "${p}")
  [ "${v}" = "${A1}" ] || { echo "FAIL: ${p} still holds '${v}' in AWS after the API was recreated as ${A1} -- its same-stack reader was not re-provisioned (issue #4383)" >&2; exit 1; }
done
for id in ApiIdByRef ApiIdByGetAtt; do
  v=$(record "${id}" '.properties.Value')
  [ "${v}" = "${A1}" ] || { echo "FAIL: the state record of ${id} holds '${v}', expected ${A1} (issue #4383)" >&2; exit 1; }
done
grep -q 'No changes detected' <<<"${RECREATE_OUT}" && {
  echo "FAIL: the deploy recreated the API but reported 'No changes detected'" >&2
  exit 1
}
echo "    OK: API recreated as ${A1} on Cloud Control; both readers re-provisioned with the new id"

echo "==> Phase 4: Destroy (API now Cloud Control-routed) + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "HTTP API ${A1} survived destroy" \
  aws apigatewayv2 get-api --api-id "${A1}" --region "${REGION}"
assert_gone "SSM parameter ${PARAM_REF} survived destroy" \
  aws ssm get-parameter --name "${PARAM_REF}" --region "${REGION}"
assert_gone "SSM parameter ${PARAM_GETATT} survived destroy" \
  aws ssm get-parameter --name "${PARAM_GETATT}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — recreate-target-readers (a recreated AWS-assigned-id target's readers follow its new id)"
