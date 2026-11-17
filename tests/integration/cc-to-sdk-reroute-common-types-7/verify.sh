#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::ApiGateway::Authorizer,
# AWS::ApiGateway::Stage and AWS::ApiGateway::Method (issue 6490, batch 7).
#
# Admission evidence for each type's `'sdk-coverage'` sticky exemption. The
# Authorizer and the Stage are recorded under DIFFERENT ids by the two layers
# (`<restApiId>|<id>` on Cloud Control, the bare id on the SDK route), so their
# flip must land the bare id through the entry's normalizer; the Method's
# composite is the same in both. Every phase acts on all three resources at
# once. Phases: deploy on the SDK route -> force each resource onto Cloud
# Control (--recreate-via-cc-api) and see Cloud Control's form -> the plan
# announces each return -> --pin-cc-api declines them -> redeploy with a real
# change: each id in the SDK form, each record flipped to 'sdk', each update
# reached AWS on the same resource -> no drift -> the three leave the template
# and are deleted on the SDK route while their REST API stays -> destroy.

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

STACK="CdkdCcToSdkRerouteCommonTypes7Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STAGE_NAME="reroute"
# The status code of the method response verify.sh adds out of band as the
# Method's identity witness. The template declares only 200.
WITNESS_STATUS="418"

# The resources under test, by the logical ids the stack fixes with
# overrideLogicalId. Every per-type helper below has an arm for each.
SUBJECTS=(
  RerouteAuthorizer
  RerouteStage
  RerouteMethod
)

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

# Set after phase 1 from the stack's outputs; the parent API never changes.
API_ID=""
ROOT_ID=""

# The id form a layer records. `sdk`: the bare authorizer id and stage name,
# and the Method's `<restApiId>|<resourceId>|<httpMethod>`. `cc`: Cloud
# Control's `<restApiId>|<id>` for the first two (measured us-east-1,
# 2026-11-17) and the same Method composite.
form_ok() { # usage: form_ok <sdk|cc> <logicalId> <physicalId>
  case "$1:$2" in
    sdk:RerouteAuthorizer) grep -qE '^[a-z0-9]+$' <<<"$3" ;;
    cc:RerouteAuthorizer) grep -qE "^${API_ID}\\|[a-z0-9]+\$" <<<"$3" ;;
    sdk:RerouteStage) [ "$3" = "${STAGE_NAME}" ] ;;
    cc:RerouteStage) [ "$3" = "${API_ID}|${STAGE_NAME}" ] ;;
    sdk:RerouteMethod | cc:RerouteMethod) [ "$3" = "${API_ID}|${ROOT_ID}|GET" ] ;;
    *) echo "FAIL: form_ok has no arm for $1:$2" >&2; return 1 ;;
  esac
}

# The bare id API Gateway addresses the resource by, from either recorded form.
bare_id() { # usage: bare_id <physicalId>
  printf '%s' "${1##*|}"
}

# What the template declares for a resource in a phase whose value is <a|b>,
# in the shape live_value prints it.
expected() { # usage: expected <logicalId> <a|b>
  case "$1" in
    RerouteAuthorizer) if [ "$2" = a ]; then printf '300'; else printf '120'; fi ;;
    RerouteStage | RerouteMethod) printf 'phase-%s' "$2" ;;
    *) echo "FAIL: expected has no arm for $1" >&2; return 1 ;;
  esac
}

# The value AWS holds for that property, read through the recorded id.
live_value() { # usage: live_value <logicalId> <physicalId>
  case "$1" in
    RerouteAuthorizer)
      aws apigateway get-authorizer --rest-api-id "${API_ID}" --authorizer-id "$(bare_id "$2")" \
        --region "${REGION}" --query authorizerResultTtlInSeconds --output text ;;
    RerouteStage)
      aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name "$(bare_id "$2")" \
        --region "${REGION}" --query description --output text ;;
    RerouteMethod)
      aws apigateway get-method --rest-api-id "${API_ID}" --resource-id "${ROOT_ID}" --http-method GET \
        --region "${REGION}" --query operationName --output text ;;
    *) echo "FAIL: live_value has no arm for $1" >&2; return 1 ;;
  esac
}

# IDENTITY WITNESS for the two resources that carry one AWS mints: the
# authorizer's id (a recreate mints another) read back from AWS, and the
# stage's createdDate (a recreated stage keeps its name). The Method has
# neither; its witness is the out-of-band method response below.
witness() { # usage: witness <logicalId> <physicalId>
  case "$1" in
    RerouteAuthorizer)
      aws apigateway get-authorizer --rest-api-id "${API_ID}" --authorizer-id "$(bare_id "$2")" \
        --region "${REGION}" --query id --output text ;;
    RerouteStage)
      aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name "$(bare_id "$2")" \
        --region "${REGION}" --query createdDate --output text ;;
    *) echo "FAIL: witness has no arm for $1" >&2; return 1 ;;
  esac
}
WITNESSED=(RerouteAuthorizer RerouteStage)

# The Method's witness: a method response cdkd does not manage. A recreate
# deletes the method with every response it holds; an in-place update leaves an
# undeclared one alone.
add_method_witness() {
  aws apigateway put-method-response --rest-api-id "${API_ID}" --resource-id "${ROOT_ID}" \
    --http-method GET --status-code "${WITNESS_STATUS}" --region "${REGION}" >/dev/null
}
# 0 present, 1 absent, hard FAIL undetermined.
method_witness_present() {
  local out rc
  out=$(aws apigateway get-method-response --rest-api-id "${API_ID}" --resource-id "${ROOT_ID}" \
    --http-method GET --status-code "${WITNESS_STATUS}" --region "${REGION}" 2>&1) && rc=0 || rc=$?
  [ "${rc}" -eq 0 ] && return 0
  if grep -qiE 'NotFoundException' <<<"${out}"; then return 1; fi
  echo "FAIL: method witness probe undetermined: ${out}" >&2
  exit 1
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

# The Refs of the two normalized types are the bare ids on either layer
# (cdkd's Ref takes the segment after the pipe of a Cloud Control id).
assert_refs() { # usage: assert_refs <phase-label>
  local auth
  auth=$(bare_id "$(record RerouteAuthorizer '.physicalId')")
  [ "$(output StageRef)" = "${STAGE_NAME}" ] || { echo "FAIL: $1: Ref of the stage resolved to '$(output StageRef)'" >&2; exit 1; }
  [ "$(output AuthorizerRef)" = "${auth}" ] || { echo "FAIL: $1: Ref of the authorizer resolved to '$(output AuthorizerRef)', expected ${auth}" >&2; exit 1; }
}

# The per-resource routing flags, one per resource under test.
RECREATE_FLAGS=()
PIN_FLAGS=()
for id in "${SUBJECTS[@]}"; do
  RECREATE_FLAGS+=(--recreate-via-cc-api "${id}")
  PIN_FLAGS+=(--pin-cc-api "${id}")
done

witness_ok() { # usage: witness_ok <witness>
  [ -n "$1" ] && [ "$1" != "None" ]
}

# Per-phase ids and witnesses, indexed like WITNESSED (bash 3.2 has no
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
  jq -e --arg k "${id}" '.Resources[$k]' "${TEMPLATE}" >/dev/null || { echo "FAIL: ${TEMPLATE} declares no ${id}" >&2; exit 1; }
done

echo "==> Phase 1: Deploy (SDK route by default -- no type under test has SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
API_ID=$(output RestApiId)
ROOT_ID=$(output RootResourceId)
grep -qE '^[a-z0-9]+$' <<<"${API_ID}" || { echo "FAIL: no RestApiId output (got '${API_ID}')" >&2; exit 1; }
grep -qE '^[a-z0-9]+$' <<<"${ROOT_ID}" || { echo "FAIL: no RootResourceId output (got '${ROOT_ID}')" >&2; exit 1; }
assert_layers "phase 1 (fresh deploy)" sdk
assert_forms "phase 1 (fresh deploy)" sdk
for i in "${!WITNESSED[@]}"; do
  id=${WITNESSED[$i]}
  W0[$i]=$(witness "${id}" "$(record "${id}" '.physicalId')")
  witness_ok "${W0[$i]}" || { echo "FAIL: no identity witness for ${id}" >&2; exit 1; }
done
add_method_witness
method_witness_present || { echo "FAIL: the out-of-band method response was not added" >&2; exit 1; }
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
# THE MEASURED FORMS. Were the Authorizer's or the Stage's the bare id, the
# type would need no normalizer and phase 5 would not exercise it.
assert_forms "phase 2 (after --recreate-via-cc-api)" cc
for i in "${!WITNESSED[@]}"; do
  id=${WITNESSED[$i]}
  P1[$i]=$(record "${id}" '.physicalId')
  W1[$i]=$(witness "${id}" "${P1[$i]}")
  witness_ok "${W1[$i]}" || { echo "FAIL: no identity witness for ${id} after the recreate" >&2; exit 1; }
  [ "${W1[$i]}" != "${W0[$i]}" ] || {
    echo "FAIL: the recreate kept ${id}'s witness (${W0[$i]}); it was not recreated, so the witness cannot prove phase 5" >&2
    exit 1
  }
done
if method_witness_present; then
  echo "FAIL: the out-of-band method response survived the Method's recreate; it was not recreated, so the witness cannot prove phase 5" >&2
  exit 1
fi
METHOD_P1=$(record RerouteMethod '.physicalId')
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
for i in "${!WITNESSED[@]}"; do
  id=${WITNESSED[$i]}
  [ "$(record "${id}" '.physicalId')" = "${P1[$i]}" ] || { echo "FAIL: the pinned deploy changed ${id}'s id" >&2; exit 1; }
  [ "$(witness "${id}" "${P1[$i]}")" = "${W1[$i]}" ] || {
    echo "FAIL: the pinned Cloud Control update replaced ${id} (its witness changed)" >&2
    exit 1
  }
done
[ "$(record RerouteMethod '.physicalId')" = "${METHOD_P1}" ] || { echo "FAIL: the pinned deploy changed RerouteMethod's id" >&2; exit 1; }
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_live_values "phase 4 (CC update)" a
# The Method's witness goes on only now: what Cloud Control's own update does
# to an undeclared response is not this fixture's claim.
add_method_witness
method_witness_present || { echo "FAIL: the out-of-band method response was not added" >&2; exit 1; }
echo "    OK: all ${#SUBJECTS[@]} still on Cloud Control, updates applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; each flip must be churn-free"
FLIP_OUT=$(mktemp)
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${FLIP_OUT}"
# The two normalized types announce the id moving to the SDK form; the Method
# keeps its id. Each line names its logical id.
# Each id's lines captured first, then matched with a here-string: under
# pipefail a `grep -q` closing the pipe early can SIGPIPE the grep feeding it.
for id in RerouteAuthorizer RerouteStage; do
  lines=$(grep -F "${id} (AWS::" "${FLIP_OUT}" || true)
  grep -qF "takes the SDK provider's form" <<<"${lines}" || {
    echo "FAIL: the flip did not announce ${id}'s id moving to the SDK form" >&2
    rm -f "${FLIP_OUT}"
    exit 1
  }
done
lines=$(grep -F "RerouteMethod (AWS::" "${FLIP_OUT}" || true)
grep -qF 'The physical id is preserved' <<<"${lines}" || {
  echo "FAIL: the flip did not announce RerouteMethod returning with its id preserved" >&2
  rm -f "${FLIP_OUT}"
  exit 1
}
rm -f "${FLIP_OUT}"
load_state
assert_layers "phase 5 (flip)" sdk
assert_forms "phase 5 (flip)" sdk
for i in "${!WITNESSED[@]}"; do
  id=${WITNESSED[$i]}
  p2=$(record "${id}" '.physicalId')
  [ "${p2}" = "$(bare_id "${P1[$i]}")" ] || {
    echo "FAIL: ${id}'s flipped id is ${p2}, expected the bare part of Cloud Control's ${P1[$i]}" >&2
    exit 1
  }
  w2=$(witness "${id}" "${p2}")
  [ "${w2}" = "${W1[$i]}" ] || {
    echo "FAIL: ${id}'s witness changed across the flip (${W1[$i]} -> ${w2}); the SDK provider replaced it" >&2
    exit 1
  }
done
[ "$(record RerouteMethod '.physicalId')" = "${METHOD_P1}" ] || {
  echo "FAIL: PHYSICAL ID CHURN across RerouteMethod's flip: ${METHOD_P1} -> $(record RerouteMethod '.physicalId')" >&2
  exit 1
}
method_witness_present || { echo "FAIL: the out-of-band method response is gone after the flip; the SDK provider replaced the Method" >&2; exit 1; }
# The update reached AWS through the id the flip recorded.
assert_live_values "phase 5 (SDK update)" b
assert_refs "phase 5"
echo "    OK: SDK-form ids, same witnesses, all ${#SUBJECTS[@]} records flipped to sdk, updates applied in place"

echo "==> Phase 6: no drift on the flipped records"
# The witness response is undeclared, so drift would rightly report it.
aws apigateway delete-method-response --rest-api-id "${API_ID}" --resource-id "${ROOT_ID}" \
  --http-method GET --status-code "${WITNESS_STATUS}" --region "${REGION}"
# Both: rc 0 alone would also pass a read that missed a resource, so the
# report must place each one in the clean bucket.
DRIFT_JSON=$(mktemp)
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null
DRIFT_RC=$?
set -e
for id in "${SUBJECTS[@]}"; do
  bucket=$(jq -r --arg id "${id}" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    "${DRIFT_JSON}" 2>/dev/null || true)
  if [ "${DRIFT_RC}" -ne 0 ] || [ "${bucket}" != "clean" ]; then
    echo "FAIL: cdkd drift did not report ${id} clean after the flip (bucket '${bucket}', rc=${DRIFT_RC}):" >&2
    cat "${DRIFT_JSON}" >&2
    rm -f "${DRIFT_JSON}"
    exit 1
  fi
done
rm -f "${DRIFT_JSON}"
echo "    OK: cdkd drift reported all ${#SUBJECTS[@]} clean (rc=0)"

echo "==> Phase 7: remove the three from the template; each SDK delete must address the flipped id"
# The REST API stays, so a delete sent to a wrong id leaves its target alive
# and readable here. After a destroy the API's own delete would take every
# child with it and pass the gone-probes for any id.
AUTHORIZER_ID=$(record RerouteAuthorizer '.physicalId')
REMOVE_LOG=$(mktemp)
env CDKD_TEST_PHASE=removed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${REMOVE_LOG}"
REMOVE_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' "${REMOVE_LOG}")
rm -f "${REMOVE_LOG}"
load_state
for id in "${SUBJECTS[@]}"; do
  # Spelled out: cdk.out now holds the removed phase's template, which no
  # longer declares the three.
  case "${id}" in
    RerouteAuthorizer) type=AWS::ApiGateway::Authorizer ;;
    RerouteStage) type=AWS::ApiGateway::Stage ;;
    RerouteMethod) type=AWS::ApiGateway::Method ;;
    *) echo "FAIL: phase 7 has no type for ${id}" >&2; exit 1 ;;
  esac
  grep -qF "${id} (${type}) deleted" <<<"${REMOVE_PLAIN}" || {
    echo "FAIL: the removal deploy printed no delete line for ${id} (${type})" >&2
    exit 1
  }
  if printf '%s' "${STATE_JSON}" | jq -e --arg k "${id}" '.resources[$k]' >/dev/null; then
    echo "FAIL: ${id} is still in state after the removal deploy" >&2
    exit 1
  fi
done
aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}" >/dev/null || {
  echo "FAIL: REST API ${API_ID} is not readable after the removal deploy; the gone-probes below would prove nothing" >&2
  exit 1
}
assert_gone "authorizer ${AUTHORIZER_ID} survived its delete under the flipped id" \
  aws apigateway get-authorizer --rest-api-id "${API_ID}" --authorizer-id "${AUTHORIZER_ID}" --region "${REGION}"
assert_gone "stage ${STAGE_NAME} survived its delete under the flipped id" \
  aws apigateway get-stage --rest-api-id "${API_ID}" --stage-name "${STAGE_NAME}" --region "${REGION}"
assert_gone "method GET on ${ROOT_ID} survived its delete" \
  aws apigateway get-method --rest-api-id "${API_ID}" --resource-id "${ROOT_ID}" --http-method GET --region "${REGION}"
echo "    OK: all ${#SUBJECTS[@]} deleted by cdkd with their REST API still alive"

echo "==> Phase 8: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "REST API ${API_ID} survived destroy" \
  aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-common-types-7 (normalized ids observed equal to the live Authorizer and Stage, Method parity)"
