#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route parity integ for AWS::ApiGateway::RestApi (issue 6141).
#
# Admission evidence for the type's `'sdk-coverage'` sticky exemption. Phases:
# deploy on the SDK route -> force the API onto Cloud Control
# (--recreate-via-cc-api) -> the plan announces the return -> --pin-cc-api
# declines it for the named API while the unpinned definition-bodied API flips
# (keeping its out-of-definition child) -> redeploy with a real change: the id
# is unchanged, the record flipped to 'sdk', the update reached AWS -> no
# drift -> destroy.

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

STACK="CdkdCcToSdkRerouteRestApiExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOGICAL_ID=""
SPEC_ID=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The state record for the resource under test. A guessed key would make every
# assertion below read `null` and pass vacuously, so an empty match hard-fails.
record() { # usage: record <jq-expression-over-the-resource-object>
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}" | jq -e --arg k "${LOGICAL_ID}" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource ${LOGICAL_ID}" >&2
    exit 1
  }
  printf '%s' "${json}" | jq -r --arg k "${LOGICAL_ID}" ".resources[\$k] | $1"
}

record_spec() { # usage: record_spec <jq-expression>: record() on the definition-bodied API
  ( LOGICAL_ID="${SPEC_ID}"; record "$1" )
}

output() { # usage: output <OutputKey>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg k "$1" '.outputs[$k]'
}

live_comment() { # usage: live_comment <rest-api-id>
  aws apigateway get-rest-api --rest-api-id "$1" --region "${REGION}" --query 'description' --output text
}
live_path_id() { # usage: live_path_id <rest-api-id> <path>
  aws apigateway get-resources --rest-api-id "$1" --region "${REGION}" --query "items[?path=='$2'].id | [0]" --output text
}
live_name() { # usage: live_name <rest-api-id>
  aws apigateway get-rest-api --rest-api-id "$1" --region "${REGION}" --query 'name' --output text
}
live_root() { # usage: live_root <rest-api-id>
  aws apigateway get-resources --rest-api-id "$1" --region "${REGION}" --query "items[?path=='/'].id | [0]" --output text
}
# The API still serves its method: the GET method on the child resource exists.
assert_serves() { # usage: assert_serves <phase> <rest-api-id> <resource-id>
  [ "$(aws apigateway get-method --rest-api-id "$2" --resource-id "$3" --http-method GET --region "${REGION}" \
    --query 'httpMethod' --output text)" = "GET" ] || { echo "FAIL: $1: GET method missing on resource $3" >&2; exit 1; }
}

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
  # Sweep any REST API a failed run left behind, matched by the fixture's exact name.
  local rid
  for rid in $(aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='cdkd-reroute-rest-api' || name=='cdkd-reroute-spec-api'].id" --output text 2>/dev/null); do
    aws apigateway delete-rest-api --rest-api-id "${rid}" --region "${REGION}" >/dev/null 2>&1
  done
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

# `--recreate-via-cc-api` validates its argument against the template's own
# logical ids, so the id is read from the synth template, never guessed.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
# Each API is selected by what only it declares (a Name / an inline Body), never by position.
LOGICAL_ID=$(jq -r '[.Resources | to_entries[] | select(.value.Type == "AWS::ApiGateway::RestApi" and .value.Properties.Name != null and .value.Properties.Body == null) | .key] | if length == 1 then .[0] else empty end' "${TEMPLATE}")
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: not exactly one named AWS::ApiGateway::RestApi in ${TEMPLATE}" >&2; exit 1; }
SPEC_ID=$(jq -r '[.Resources | to_entries[] | select(.value.Type == "AWS::ApiGateway::RestApi" and .value.Properties.Body != null and .value.Properties.Name == null) | .key] | if length == 1 then .[0] else empty end' "${TEMPLATE}")
[ -n "${SPEC_ID}" ] || { echo "FAIL: not exactly one definition-bodied, unnamed AWS::ApiGateway::RestApi in ${TEMPLATE}" >&2; exit 1; }
echo "==> Resources under test: ${LOGICAL_ID} (named), ${SPEC_ID} (inline definition)"
SPEC_TITLE="cdkd-reroute-spec-api"

echo "==> Phase 1: Deploy (SDK route by default -- RestApi has no SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P0=$(record '.physicalId')
LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk" >&2; exit 1; }
S0=$(record_spec '.physicalId')
[ "$(record_spec '.provisionedBy')" = "sdk" ] || { echo "FAIL: fresh deploy recorded the definition-bodied API off the SDK route" >&2; exit 1; }
echo "    OK: created on the SDK route (${P0}, ${S0})"

echo "==> Phase 2: force the API onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${LOGICAL_ID}" --recreate-via-cc-api "${SPEC_ID}" --yes
P1=$(record '.physicalId')
LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: after --recreate-via-cc-api the record says provisionedBy=${LAYER1}, expected cc-api. Every assertion below would be vacuous." >&2; exit 1; }
# IDENTITY WITNESS. The API id is AWS-minted, so a recreate MUST change it.
# That is what lets "the id survived" in phase 5 mean "the API was never
# replaced": a fixed-name resource could not make the claim from its id alone.
[ "${P1}" != "${P0}" ] || { echo "FAIL: the recreate kept the API id (${P0}); it was not recreated, so the id cannot witness phase 5" >&2; exit 1; }
# The physicalIdForm claim: Cloud Control stores the bare REST API id, as the
# SDK provider does (it equals the id API Gateway answers with).
[ "$(aws apigateway get-rest-api --rest-api-id "${P1}" --region "${REGION}" --query id --output text)" = "${P1}" ] || { echo "FAIL: Cloud Control recorded ${P1}, which is not the live REST API id" >&2; exit 1; }
ROOT1=$(live_root "${P1}")
[ -n "${ROOT1}" ] && [ "${ROOT1}" != "None" ] || { echo "FAIL: no root resource on ${P1}" >&2; exit 1; }
RES1=$(output ResourceRef)
assert_serves "phase 2 (CC recreate)" "${P1}" "${RES1}"
S1=$(record_spec '.physicalId')
[ "$(record_spec '.provisionedBy')" = "cc-api" ] || { echo "FAIL: the definition-bodied API is not on cc-api after the recreate" >&2; exit 1; }
[ "${S1}" != "${S0}" ] || { echo "FAIL: the recreate kept the definition-bodied API id (${S0})" >&2; exit 1; }
SROOT1=$(live_root "${S1}")
FROM1=$(live_path_id "${S1}" "/from-spec")
EXTRA1=$(live_path_id "${S1}" "/extra")
[ -n "${SROOT1}" ] && [ "${SROOT1}" != "None" ] || { echo "FAIL: no root resource on ${S1}" >&2; exit 1; }
[ -n "${FROM1}" ] && [ "${FROM1}" != "None" ] || { echo "FAIL: /from-spec missing on ${S1}" >&2; exit 1; }
[ -n "${EXTRA1}" ] && [ "${EXTRA1}" != "None" ] || { echo "FAIL: /extra missing on ${S1}" >&2; exit 1; }
assert_serves "phase 2 (/from-spec)" "${S1}" "${FROM1}"
assert_serves "phase 2 (/extra)" "${S1}" "${EXTRA1}"
[ "$(live_name "${S1}")" = "${SPEC_TITLE}" ] || { echo "FAIL: the definition-bodied API is named $(live_name "${S1}"), expected the definition title ${SPEC_TITLE}" >&2; exit 1; }
[ "$(live_comment "${P1}")" = "seeded-on-cc" ] || { echo "FAIL: the CC recreate did not reach AWS" >&2; exit 1; }
# Two APIs can share a name, so the new one does not imply the old one left.
assert_gone "REST API ${P0} survived the recreate" \
  aws apigateway get-rest-api --rest-api-id "${P0}" --region "${REGION}"
assert_gone "REST API ${S0} survived the recreate" \
  aws apigateway get-rest-api --rest-api-id "${S0}" --region "${REGION}"
echo "    OK: pinned to Cloud Control, freshly minted id ${P1}"

echo "==> Phase 3: the plan ANNOUNCES the return"
DIFF_OUT=$(env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
grep -q 'returning to SDK provider' <<<"${DIFF_OUT}" || {
  echo "FAIL: cdkd diff did not announce the routing change" >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
}
if grep -q 'via CC API: sticky' <<<"${DIFF_OUT}"; then
  echo "FAIL: cdkd diff still renders the sticky tag for a resource about to leave Cloud Control" >&2
  exit 1
fi
echo "    OK: plan says 'returning to SDK provider'"

echo "==> Phase 4: --pin-cc-api DECLINES the flip; the definition-bodied API flips"
# Only the named API is pinned. Cloud Control's own RestApi handler puts the
# Body again on EVERY update, a Description-only one included (CloudTrail: a
# PutRestApi from cloudformation.amazonaws.com), which deletes the stack's
# out-of-definition /extra -- CloudFormation's behavior too (cfn-lint W3660).
# A pinned update of the definition-bodied API would wipe /extra before the
# SDK provider ever saw it, so that API flips here, unpinned.
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --pin-cc-api "${LOGICAL_ID}" --yes
LAYER_PINNED=$(record '.provisionedBy')
[ "${LAYER_PINNED}" = "cc-api" ] || { echo "FAIL: --pin-cc-api did not hold the API on Cloud Control (provisionedBy=${LAYER_PINNED})" >&2; exit 1; }
[ "$(record '.physicalId')" = "${P1}" ] || { echo "FAIL: the pinned deploy changed the API id" >&2; exit 1; }
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
[ "$(live_comment "${P1}")" = "pinned-on-cc" ] || { echo "FAIL: the pinned deploy did not reach AWS" >&2; exit 1; }
# THE RISKY PATH: the definition-bodied API returns to the SDK provider, whose
# overwrite put would delete the out-of-definition child. A Description-only
# change must send no put: it keeps its id, its root, /extra and its title.
[ "$(record_spec '.provisionedBy')" = "sdk" ] || { echo "FAIL: the definition-bodied API did not flip back to sdk" >&2; exit 1; }
[ "$(record_spec '.physicalId')" = "${S1}" ] || { echo "FAIL: PHYSICAL ID CHURN on the definition-bodied API: ${S1} -> $(record_spec '.physicalId')" >&2; exit 1; }
[ "$(live_comment "${S1}")" = "pinned-on-cc" ] || { echo "FAIL: the flip did not reach the definition-bodied API" >&2; exit 1; }
[ "$(live_root "${S1}")" = "${SROOT1}" ] || { echo "FAIL: the definition-bodied API's root resource moved across the flip" >&2; exit 1; }
[ "$(record_spec '.attributes.RootResourceId')" = "${SROOT1}" ] || { echo "FAIL: the flipped record's RootResourceId for the definition-bodied API changed" >&2; exit 1; }
assert_serves "phase 4 flip (/from-spec)" "${S1}" "$(live_path_id "${S1}" "/from-spec")"
assert_serves "phase 4 flip (/extra, not in the definition)" "${S1}" "$(live_path_id "${S1}" "/extra")"
# The same ids: "serves GET" alone would also pass a child deleted and re-created.
[ "$(live_path_id "${S1}" "/from-spec")" = "${FROM1}" ] || { echo "FAIL: /from-spec was re-created across the flip" >&2; exit 1; }
[ "$(live_path_id "${S1}" "/extra")" = "${EXTRA1}" ] || { echo "FAIL: /extra was deleted and re-created across the flip" >&2; exit 1; }
[ "$(live_name "${S1}")" = "${SPEC_TITLE}" ] || { echo "FAIL: the definition-bodied API is named $(live_name "${S1}") after the flip, expected ${SPEC_TITLE}" >&2; exit 1; }
echo "    OK: named API still on Cloud Control, update applied via CC; definition-bodied ${S1} flipped to sdk keeping id, root, /extra and its title"

echo "==> Phase 5: THE ARM -- redeploy unpinned; the flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P2=$(record '.physicalId')
LAYER2=$(record '.provisionedBy')
[ "${LAYER2}" = "sdk" ] || { echo "FAIL: the record did not flip back (provisionedBy=${LAYER2}, expected sdk)" >&2; exit 1; }
[ "${P2}" = "${P1}" ] || { echo "FAIL: PHYSICAL ID CHURN across the flip: ${P1} -> ${P2}. This type must not carry an 'sdk-coverage' exemption." >&2; exit 1; }
[ "$(live_comment "${P2}")" = "after-reroute" ] || { echo "FAIL: the update did not reach AWS through the SDK provider" >&2; exit 1; }
# What a Cloud Control record carried must survive the SDK provider's rewrite:
# a stack reading the API through Ref / GetAtt sees the same values.
[ "$(record '.attributes.RootResourceId')" = "${ROOT1}" ] || { echo "FAIL: the flipped record's RootResourceId is $(record '.attributes.RootResourceId'), expected ${ROOT1}" >&2; exit 1; }
[ "$(live_root "${P2}")" = "${ROOT1}" ] || { echo "FAIL: the live root resource moved across the flip" >&2; exit 1; }
[ "$(output ApiRef)" = "${P2}" ] || { echo "FAIL: Ref resolved to $(output ApiRef) after the flip" >&2; exit 1; }
[ "$(output ApiRootResourceId)" = "${ROOT1}" ] || { echo "FAIL: GetAtt RootResourceId resolved to $(output ApiRootResourceId) after the flip, expected ${ROOT1}" >&2; exit 1; }
[ "$(output ResourceRef)" = "${RES1}" ] || { echo "FAIL: the child resource id moved across the flip" >&2; exit 1; }
assert_serves "phase 5 (SDK update)" "${P2}" "${RES1}"
# The definition-bodied API, already on the SDK route since phase 4, takes a
# plain SDK Description-only update: still no put, so the out-of-definition
# child and the definition title survive.
S2=$(record_spec '.physicalId')
[ "$(record_spec '.provisionedBy')" = "sdk" ] || { echo "FAIL: the definition-bodied API left the sdk route" >&2; exit 1; }
[ "${S2}" = "${S1}" ] || { echo "FAIL: PHYSICAL ID CHURN on the definition-bodied API: ${S1} -> ${S2}" >&2; exit 1; }
[ "$(live_comment "${S2}")" = "after-reroute" ] || { echo "FAIL: the update did not reach the definition-bodied API" >&2; exit 1; }
[ "$(live_root "${S2}")" = "${SROOT1}" ] || { echo "FAIL: the definition-bodied API's root resource moved across the flip" >&2; exit 1; }
[ "$(record_spec '.attributes.RootResourceId')" = "${SROOT1}" ] || { echo "FAIL: the flipped record's RootResourceId for the definition-bodied API changed" >&2; exit 1; }
assert_serves "phase 5 (/from-spec)" "${S2}" "$(live_path_id "${S2}" "/from-spec")"
assert_serves "phase 5 (/extra, not in the definition)" "${S2}" "$(live_path_id "${S2}" "/extra")"
[ "$(live_path_id "${S2}" "/extra")" = "${EXTRA1}" ] || { echo "FAIL: /extra was deleted and re-created by the SDK update" >&2; exit 1; }
[ "$(live_name "${S2}")" = "${SPEC_TITLE}" ] || { echo "FAIL: the definition-bodied API is named $(live_name "${S2}") after the flip, expected ${SPEC_TITLE}" >&2; exit 1; }
echo "    OK: same id ${P2}, record flipped to sdk, update applied in place, Ref / GetAtt intact; definition-bodied ${S2} kept id, root, /extra and its title"

echo "==> Phase 6: no drift on the flipped record"
# Both: rc 0 alone would also pass a read that missed the resource, so the
# report must place it in the clean bucket.
DRIFT_JSON=$(mktemp)
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null
DRIFT_RC=$?
set -e
DRIFT_BUCKET=$(jq -r --arg id "${LOGICAL_ID}" '[.. | objects | to_entries[]
  | select((.value | type) == "array") | .key as $bucket
  | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
  "${DRIFT_JSON}" 2>/dev/null || true)
SPEC_BUCKET=$(jq -r --arg id "${SPEC_ID}" '[.. | objects | to_entries[]
  | select((.value | type) == "array") | .key as $bucket
  | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
  "${DRIFT_JSON}" 2>/dev/null || true)
if [ "${DRIFT_RC}" -ne 0 ] || [ "${DRIFT_BUCKET}" != "clean" ] || [ "${SPEC_BUCKET}" != "clean" ]; then
  echo "FAIL: cdkd drift did not report ${LOGICAL_ID} clean after the flip (bucket '${DRIFT_BUCKET}', rc=${DRIFT_RC}):" >&2
  cat "${DRIFT_JSON}" >&2
  rm -f "${DRIFT_JSON}"
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    OK: cdkd drift reported ${LOGICAL_ID} clean (rc=0)"

echo "==> Phase 7: Destroy on the flipped record + gone-probe"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "REST API ${P2} survived destroy" \
  aws apigateway get-rest-api --rest-api-id "${P2}" --region "${REGION}"
assert_gone "REST API ${S2} survived destroy" \
  aws apigateway get-rest-api --rest-api-id "${S2}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-rest-api (physicalId parity observed on a live REST API)"
