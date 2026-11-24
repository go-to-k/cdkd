#!/usr/bin/env bash
# verify.sh -- cdkd Cloud Control route for nested members the SDK route
# cannot send (issue 6690) on AWS::Route53::HostedZone, and the SDK route for
# CloudFront OriginHttpVersion once the SDK models it (issue 6932).
#
# Phases: deploy plain on the SDK route -> add the members: the deploy says why
# the zone routes, it moves to Cloud Control on the SAME id; the distribution
# stays on the SDK provider, which sends and reads back OriginHttpVersion ->
# drift clean -> recreate the distribution on Cloud Control (the record an
# older cdkd left) -> its next change returns it to the SDK provider, same id,
# member kept -> remove the members: the zone stays on Cloud Control, which
# clears it; the SDK provider clears the distribution's -> a plain change
# returns the zone to the SDK provider, same id -> destroy + gone-probes.

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

STACK="CdkdSdkUnmodelledNestedRouteExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ZONE=NestedRouteZone
DIST=NestedRouteDistribution
AUTH=NestedRouteJwtAuthorizer
API=NestedRouteApi

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# A missing record would make every assertion read `null` and pass vacuously.
record() { # usage: record <logicalId> <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "$1" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource $1" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

assert_layer() { # usage: assert_layer <phase-label> <logicalId> <sdk|cc-api>
  local layer
  layer=$(record "$2" '.provisionedBy')
  [ "${layer}" = "$3" ] || { echo "FAIL: $1: $2 recorded provisionedBy=${layer}, expected $3" >&2; exit 1; }
}

assert_id() { # usage: assert_id <phase-label> <logicalId> <expected-physical-id>
  local pid
  pid=$(record "$2" '.physicalId')
  [ "${pid}" = "$3" ] || { echo "FAIL: $1: $2 PHYSICAL ID CHANGED: $3 -> ${pid} (the route move replaced it)" >&2; exit 1; }
}

# The AWS CLI's models lag these members too, so Cloud Control reads them.
cc_props() { # usage: cc_props <type> <identifier>
  aws cloudcontrol get-resource --region "${REGION}" --type-name "$1" --identifier "$2" \
    --query ResourceDescription.Properties --output text
}

live_guardrail() { # usage: live_guardrail <zone-id>
  local props
  props=$(cc_props AWS::Route53::HostedZone "$1") || return 1
  printf '%s' "${props}" | jq -r '[.HostedZoneFeatures.ChangeGuardrails[]?
    | select(.Name == "NS_OCCLUSION_CHECK") | .Status] | first // "absent"'
}

live_origin_http() { # usage: live_origin_http <distribution-id>
  local props
  props=$(cc_props AWS::CloudFront::Distribution "$1") || return 1
  printf '%s' "${props}" | jq -r '.DistributionConfig.Origins[0].CustomOriginConfig.OriginHttpVersion // "absent"'
}

# What the provider's own read-back (the snapshot drift compares against)
# recorded for the member. A record without the snapshot fails rather than
# reading "absent".
assert_observed_origin_http() { # usage: assert_observed_origin_http <phase-label> <http1.1|absent>
  local got
  [ "$(record "${DIST}" '.observedProperties | type')" = "object" ] ||
    { echo "FAIL: $1: ${DIST} has no observedProperties, so its read-back cannot be checked" >&2; exit 1; }
  got=$(record "${DIST}" '.observedProperties.DistributionConfig.Origins[0].CustomOriginConfig.OriginHttpVersion // "absent"')
  [ "${got}" = "$2" ] || { echo "FAIL: $1: ${DIST}'s read-back holds OriginHttpVersion '${got}', expected '$2'" >&2; exit 1; }
}

# The authorizer's first audience, read through Cloud Control (the AWS CLI's
# model may predate jwtConfiguration).
live_jwt_audience() { # usage: live_jwt_audience <rest-api-id> <authorizer-id>
  local props
  props=$(cc_props AWS::ApiGateway::Authorizer "$1|$2") || return 1
  printf '%s' "${props}" | jq -r '.JwtConfiguration.Issuers[0].Audiences[0] // "absent"'
}

assert_jwt() { # usage: assert_jwt <phase-label> <a|b>
  local got
  assert_layer "$1" "${AUTH}" sdk
  assert_id "$1" "${AUTH}" "${AID}"
  got=$(live_jwt_audience "${APIID}" "${AID}") || { echo "FAIL: $1: cannot read authorizer ${AID} through Cloud Control" >&2; exit 1; }
  [ "${got}" = "cdkd-nested-route-$2" ] || { echo "FAIL: $1: JWT authorizer ${AID} holds audience '${got}', expected 'cdkd-nested-route-$2'" >&2; exit 1; }
}

assert_comments() { # usage: assert_comments <phase-label> <a|b>
  local zc dc want="cdkd-nested-route phase-$2"
  zc=$(aws route53 get-hosted-zone --id "${ZID}" --query 'HostedZone.Config.Comment' --output text) || return 1
  dc=$(aws cloudfront get-distribution --id "${DID}" --query 'Distribution.DistributionConfig.Comment' --output text) || return 1
  [ "${zc}" = "${want}" ] || { echo "FAIL: $1: zone ${ZID} holds comment '${zc}', expected '${want}'" >&2; exit 1; }
  [ "${dc}" = "${want}" ] || { echo "FAIL: $1: distribution ${DID} holds comment '${dc}', expected '${want}'" >&2; exit 1; }
}

deploy() { # usage: deploy <phase> <log-file>
  env CDKD_TEST_PHASE="$1" \
    node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "$2"
}

LOG_DIR=""
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
  local acct zone_name
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  zone_name="cdkd-nested-route-${acct}.internal"
  case "${zone_name}" in
    cdkd-nested-route-?*.internal)
      local zid aid
      for zid in $(aws route53 list-hosted-zones-by-name --dns-name "${zone_name}" \
        --query "HostedZones[?Name=='${zone_name}.'].Id" --output text 2>/dev/null); do
        aws route53 delete-hosted-zone --id "${zid}" >/dev/null 2>&1
      done
      for aid in $(aws apigateway get-rest-apis --region "${REGION}" \
        --query "items[?name=='${zone_name%.internal}'].id" --output text 2>/dev/null); do
        aws apigateway delete-rest-api --region "${REGION}" --rest-api-id "${aid}" >/dev/null 2>&1
      done
      ;;
    *)
      echo "WARN: teardown sweep refused: unexpected zone name ${zone_name}" >&2
      ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  [ -n "${LOG_DIR}" ] && rm -rf "${LOG_DIR}"
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
LOG_DIR=$(mktemp -d)

echo "==> Phase 1: Deploy plain (SDK route)"
deploy base "${LOG_DIR}/base.log"
load_state
assert_layer "phase 1" "${ZONE}" sdk
assert_layer "phase 1" "${DIST}" sdk
ZID=$(record "${ZONE}" '.physicalId')
DID=$(record "${DIST}" '.physicalId')
APIID=$(record "${API}" '.physicalId')
AID=$(record "${AUTH}" '.physicalId')
assert_comments "phase 1" a
assert_jwt "phase 1 (JWT authorizer created on the SDK route)" a
GR=$(live_guardrail "${ZID}") || { echo "FAIL: phase 1: cannot read zone ${ZID} through Cloud Control" >&2; exit 1; }
[ "${GR}" = "DISABLED" ] || { echo "FAIL: phase 1: zone ${ZID} starts with NS_OCCLUSION_CHECK ${GR}, not DISABLED" >&2; exit 1; }
HV=$(live_origin_http "${DID}") || { echo "FAIL: phase 1: cannot read distribution ${DID} through Cloud Control" >&2; exit 1; }
# The witness: an origin that never set it reads it ABSENT, so http1.1 later
# can only be the value cdkd sent.
[ "${HV}" = "absent" ] || { echo "FAIL: phase 1: distribution ${DID} starts with OriginHttpVersion '${HV}', so http1.1 could not witness the send" >&2; exit 1; }
echo "    OK: all on the SDK route (zone ${ZID}, distribution ${DID}, JWT authorizer ${AID})"

echo "==> Phase 2: add the members -- the zone moves to Cloud Control; the distribution stays on the SDK provider"
deploy route "${LOG_DIR}/route.log"
# The user is told why. Sentinel: the route line must also carry the reason,
# so a reworded reason fails here instead of passing on the route line alone.
line=$(grep -F "${ZONE} (" "${LOG_DIR}/route.log" | grep -F 'routing via Cloud Control API' || true)
[ -n "${line}" ] || { echo "FAIL: phase 2: the deploy never said ${ZONE} routes via Cloud Control" >&2; exit 1; }
reason="ChangeGuardrails is not sent by cdkd's SDK provider"
grep -qF "${reason}" <<<"${line}" || { echo "FAIL: phase 2: ${ZONE}'s route line lacks its reason '${reason}': ${line}" >&2; exit 1; }
if grep -F "${DIST} (" "${LOG_DIR}/route.log" | grep -qF 'routing via Cloud Control API'; then
  echo "FAIL: phase 2: the deploy routed ${DIST} via Cloud Control for a member the SDK provider sends (issue 6932)" >&2
  exit 1
fi
load_state
assert_layer "phase 2" "${ZONE}" cc-api
assert_layer "phase 2" "${DIST}" sdk
assert_id "phase 2" "${ZONE}" "${ZID}"
assert_id "phase 2" "${DIST}" "${DID}"
GR=$(live_guardrail "${ZID}") || { echo "FAIL: phase 2: cannot read zone ${ZID} through Cloud Control" >&2; exit 1; }
[ "${GR}" = "ENABLED" ] || { echo "FAIL: phase 2: NS_OCCLUSION_CHECK is ${GR} on ${ZID}; the member never reached AWS" >&2; exit 1; }
HV=$(live_origin_http "${DID}") || { echo "FAIL: phase 2: cannot read distribution ${DID} through Cloud Control" >&2; exit 1; }
[ "${HV}" = "http1.1" ] || { echo "FAIL: phase 2: OriginHttpVersion is ${HV} on ${DID}; the SDK provider never sent it" >&2; exit 1; }
assert_observed_origin_http "phase 2 (SDK read-back)" http1.1
assert_comments "phase 2" a
echo "    OK: zone on Cloud Control (same id, NS_OCCLUSION_CHECK ENABLED); distribution on the SDK route holding OriginHttpVersion http1.1"

echo "==> Phase 3: no drift on the routed records"
DRIFT_JSON="${LOG_DIR}/drift.json"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json >"${DRIFT_JSON}" 2>"${LOG_DIR}/drift.err"
DRIFT_RC=$?
set -e
for id in "${ZONE}" "${DIST}" "${AUTH}"; do
  bucket=$(jq -r --arg id "${id}" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' "${DRIFT_JSON}" 2>/dev/null || true)
  if [ "${DRIFT_RC}" -ne 0 ] || [ "${bucket}" != "clean" ]; then
    echo "FAIL: phase 3: cdkd drift did not report ${id} clean (bucket '${bucket}', rc=${DRIFT_RC}):" >&2
    cat "${DRIFT_JSON}" "${LOG_DIR}/drift.err" >&2
    exit 1
  fi
done
echo "    OK: zone, distribution and JWT authorizer clean (rc=0)"

echo "==> Phase 4: recreate the distribution on Cloud Control -- the record a cdkd before issue 6932 left"
# CloudFront::Distribution is in STATEFUL_TYPES, so cdkd refuses to recreate it
# without --force-stateful-recreation. It holds no data here.
SDK_DID="${DID}"
env CDKD_TEST_PHASE=route \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${DIST}" --force-stateful-recreation --yes 2>&1 | tee "${LOG_DIR}/recreate.log"
load_state
# Without this every assertion of phase 5 would be vacuous.
assert_layer "phase 4" "${DIST}" cc-api
DID=$(record "${DIST}" '.physicalId')
[ "${DID}" != "${SDK_DID}" ] || { echo "FAIL: phase 4: the recreate kept ${DIST}'s id ${SDK_DID}" >&2; exit 1; }
assert_gone "phase 4: the SDK-created distribution ${SDK_DID} survived its recreate" \
  aws cloudfront get-distribution --id "${SDK_DID}"
assert_layer "phase 4" "${ZONE}" cc-api
assert_id "phase 4" "${ZONE}" "${ZID}"
HV=$(live_origin_http "${DID}") || { echo "FAIL: phase 4: cannot read distribution ${DID} through Cloud Control" >&2; exit 1; }
[ "${HV}" = "http1.1" ] || { echo "FAIL: phase 4: OriginHttpVersion is ${HV} on the Cloud Control distribution ${DID}" >&2; exit 1; }
echo "    OK: distribution ${DID} recorded on Cloud Control holding OriginHttpVersion http1.1"

echo "==> Phase 5: THE 6932 ARM -- its next change returns the distribution to the SDK provider, same id, member kept"
deploy return "${LOG_DIR}/return.log"
load_state
assert_layer "phase 5" "${DIST}" sdk
assert_id "phase 5" "${DIST}" "${DID}"
# Still declaring ChangeGuardrails, the zone stays on Cloud Control for its
# comment change.
assert_layer "phase 5" "${ZONE}" cc-api
assert_id "phase 5" "${ZONE}" "${ZID}"
assert_comments "phase 5" c
HV=$(live_origin_http "${DID}") || { echo "FAIL: phase 5: cannot read distribution ${DID} through Cloud Control" >&2; exit 1; }
[ "${HV}" = "http1.1" ] || { echo "FAIL: phase 5: the SDK provider's update left OriginHttpVersion '${HV}' on ${DID}" >&2; exit 1; }
assert_observed_origin_http "phase 5 (SDK read-back after the return)" http1.1
echo "    OK: distribution back on the SDK route, same id, OriginHttpVersion http1.1 kept"

echo "==> Phase 6: remove the members -- the zone's Cloud Control and the distribution's SDK provider clear them"
deploy removal "${LOG_DIR}/removal.log"
load_state
# The SDK provider cannot unset what it cannot send: the zone's removal
# deploy is Cloud Control's.
assert_layer "phase 6" "${ZONE}" cc-api
assert_layer "phase 6" "${DIST}" sdk
assert_id "phase 6" "${ZONE}" "${ZID}"
assert_id "phase 6" "${DIST}" "${DID}"
GR=$(live_guardrail "${ZID}") || { echo "FAIL: phase 6: cannot read zone ${ZID} through Cloud Control" >&2; exit 1; }
[ "${GR}" = "DISABLED" ] || { echo "FAIL: phase 6: NS_OCCLUSION_CHECK is ${GR} on ${ZID} after its removal" >&2; exit 1; }
HV=$(live_origin_http "${DID}") || { echo "FAIL: phase 6: cannot read distribution ${DID} through Cloud Control" >&2; exit 1; }
[ "${HV}" = "absent" ] || { echo "FAIL: phase 6: OriginHttpVersion is '${HV}' on ${DID} after its removal" >&2; exit 1; }
assert_observed_origin_http "phase 6 (SDK read-back after the removal)" absent
echo "    OK: members cleared (guardrail DISABLED on Cloud Control, OriginHttpVersion ${HV} on the SDK route)"

echo "==> Phase 7: a plain change returns the zone to the SDK provider, same ids"
deploy back "${LOG_DIR}/back.log"
load_state
assert_layer "phase 7" "${ZONE}" sdk
assert_layer "phase 7" "${DIST}" sdk
assert_id "phase 7" "${ZONE}" "${ZID}"
assert_id "phase 7" "${DIST}" "${DID}"
assert_comments "phase 7" b
assert_jwt "phase 7 (JWT authorizer updated on the SDK route)" b
echo "    OK: both on the SDK route, update applied in place; JWT audience updated in place"

echo "==> Phase 8: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "hosted zone ${ZID} survived destroy" \
  aws route53 get-hosted-zone --id "${ZID}"
assert_gone "distribution ${DID} survived destroy" \
  aws cloudfront get-distribution --id "${DID}"
assert_gone "REST API ${APIID} survived destroy" \
  aws apigateway get-rest-api --rest-api-id "${APIID}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- sdk-unmodelled-nested-route (zone routed through Cloud Control for its nested members; OriginHttpVersion on the SDK route)"
