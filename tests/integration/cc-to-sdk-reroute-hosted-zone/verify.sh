#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route parity integ for AWS::Route53::HostedZone (issue 5641).
#
# Admission evidence for the type's `'sdk-coverage'` sticky exemption. Phases:
# deploy on the SDK route -> force the zone onto Cloud Control
# (--recreate-via-cc-api) -> the plan announces the return -> --pin-cc-api
# declines it -> redeploy with a real change: the id is unchanged, the record
# flipped to 'sdk', the update reached AWS -> no drift -> destroy.

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

STACK="CdkdCcToSdkRerouteHostedZoneExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOGICAL_ID=""
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

output() { # usage: output <OutputKey>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg k "$1" '.outputs[$k]'
}

live_comment() { # usage: live_comment <zone-id>
  aws route53 get-hosted-zone --id "$1" --query 'HostedZone.Config.Comment' --output text
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
  local acct zone_name
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  zone_name="cdkd-reroute-hosted-zone-${acct}.internal"
  case "${zone_name}" in
    cdkd-reroute-hosted-zone-?*.internal)
      local zid
      for zid in $(aws route53 list-hosted-zones-by-name --dns-name "${zone_name}" \
        --query "HostedZones[?Name=='${zone_name}.'].Id" --output text 2>/dev/null); do
        aws route53 delete-hosted-zone --id "${zid}" >/dev/null 2>&1
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
LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::Route53::HostedZone") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::Route53::HostedZone in ${TEMPLATE}" >&2; exit 1; }
echo "==> Resource under test: ${LOGICAL_ID}"

echo "==> Phase 1: Deploy (SDK route by default -- HostedZone has no SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P0=$(record '.physicalId')
LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk" >&2; exit 1; }
echo "    OK: created on the SDK route (${P0})"

echo "==> Phase 2: force the zone onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${LOGICAL_ID}" --yes
P1=$(record '.physicalId')
LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: after --recreate-via-cc-api the record says provisionedBy=${LAYER1}, expected cc-api. Every assertion below would be vacuous." >&2; exit 1; }
# IDENTITY WITNESS. The zone id is AWS-minted, so a recreate MUST change it.
# That is what lets "the id survived" in phase 5 mean "the zone was never
# replaced": a fixed-name resource could not make the claim from its id alone.
[ "${P1}" != "${P0}" ] || { echo "FAIL: the recreate kept the zone id (${P0}); it was not recreated, so the id cannot witness phase 5" >&2; exit 1; }
# The physicalIdForm claim: Cloud Control stores the bare id, as the SDK
# provider does, not Route 53's own /hostedzone/ spelling.
case "${P1}" in
  Z*) ;;
  *) echo "FAIL: Cloud Control recorded ${P1}, expected the bare Z... id the SDK provider records" >&2; exit 1 ;;
esac
[ "$(live_comment "${P1}")" = "seeded-on-cc" ] || { echo "FAIL: the CC recreate did not reach AWS" >&2; exit 1; }
# Two zones can share a name, so the new one does not imply the old one left.
assert_gone "hosted zone ${P0} survived the recreate" \
  aws route53 get-hosted-zone --id "${P0}"
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

echo "==> Phase 4: --pin-cc-api DECLINES the flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --pin-cc-api "${LOGICAL_ID}" --yes
LAYER_PINNED=$(record '.provisionedBy')
[ "${LAYER_PINNED}" = "cc-api" ] || { echo "FAIL: --pin-cc-api did not hold the zone on Cloud Control (provisionedBy=${LAYER_PINNED})" >&2; exit 1; }
[ "$(record '.physicalId')" = "${P1}" ] || { echo "FAIL: the pinned deploy changed the zone id" >&2; exit 1; }
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
[ "$(live_comment "${P1}")" = "pinned-on-cc" ] || { echo "FAIL: the pinned deploy did not reach AWS" >&2; exit 1; }
echo "    OK: still on Cloud Control, update applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; the flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P2=$(record '.physicalId')
LAYER2=$(record '.provisionedBy')
[ "${LAYER2}" = "sdk" ] || { echo "FAIL: the record did not flip back (provisionedBy=${LAYER2}, expected sdk)" >&2; exit 1; }
[ "${P2}" = "${P1}" ] || { echo "FAIL: PHYSICAL ID CHURN across the flip: ${P1} -> ${P2}. This type must not carry an 'sdk-coverage' exemption." >&2; exit 1; }
[ "$(live_comment "${P2}")" = "after-reroute" ] || { echo "FAIL: the update did not reach AWS through the SDK provider" >&2; exit 1; }
# What a Cloud Control record carried must survive the SDK provider's rewrite:
# a stack reading the zone through Ref / GetAtt sees the same values.
[ "$(record '.attributes.Id')" = "${P2}" ] || { echo "FAIL: the flipped record's Id attribute is $(record '.attributes.Id'), expected ${P2}" >&2; exit 1; }
[ "$(output ZoneRef)" = "${P2}" ] || { echo "FAIL: Ref resolved to $(output ZoneRef) after the flip" >&2; exit 1; }
[ "$(output ZoneGetAttId)" = "${P2}" ] || { echo "FAIL: GetAtt Id resolved to $(output ZoneGetAttId) after the flip" >&2; exit 1; }
NS_LIVE=$(aws route53 get-hosted-zone --id "${P2}" --query 'DelegationSet.NameServers' --output json | jq -r 'sort | join(",")')
NS_OUTPUT=$(output NameServers | tr ',' '\n' | sort | paste -sd, -)
[ -n "${NS_LIVE}" ] && [ "${NS_OUTPUT}" = "${NS_LIVE}" ] || { echo "FAIL: NameServers output ${NS_OUTPUT} differs from the live ${NS_LIVE}" >&2; exit 1; }
echo "    OK: same id ${P2}, record flipped to sdk, update applied in place, Ref / GetAtt intact"

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
if [ "${DRIFT_RC}" -ne 0 ] || [ "${DRIFT_BUCKET}" != "clean" ]; then
  echo "FAIL: cdkd drift did not report ${LOGICAL_ID} clean after the flip (bucket '${DRIFT_BUCKET}', rc=${DRIFT_RC}):" >&2
  cat "${DRIFT_JSON}" >&2
  rm -f "${DRIFT_JSON}"
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    OK: cdkd drift reported ${LOGICAL_ID} clean (rc=0)"

echo "==> Phase 7: Destroy on the flipped record + gone-probe"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "hosted zone ${P2} survived destroy" \
  aws route53 get-hosted-zone --id "${P2}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-hosted-zone (physicalId parity observed on a live zone)"
