#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for AWS::ECS::Service (issue 5654).
#
# Admission evidence for the type's `'sdk-coverage'` sticky exemption, the
# first whose ids DIFFER between the layers: Cloud Control records
# `<serviceArn>|<cluster>`, the SDK provider the bare service ARN, and the
# entry's declared normalizer keeps the ARN part on the flip. Phases:
# deploy on the SDK route -> force the service onto Cloud Control
# (--recreate-via-cc-api) and see the composite id -> the plan announces the
# return -> --pin-cc-api declines it -> redeploy with a real change: the record
# flipped to 'sdk', its id is the composite's ARN part and the live ARN, the
# service was not replaced (createdAt kept), the update reached AWS -> no
# drift -> destroy.

set -euo pipefail
export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

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

STACK="CdkdCcToSdkRerouteEcsServiceExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOGICAL_ID=""
CLUSTER=""
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

# What AWS holds for the service: one JSON object, or a hard FAIL. A guessed
# cluster or a wrong id answers with `failures`, never a service.
describe_service() { # usage: describe_service <service-arn>
  local out
  # `|| return 1`: errexit is cleared inside the callers' `$( )`, and their
  # pipefail turns this status into the run's failure.
  out=$(aws ecs describe-services --cluster "${CLUSTER}" --services "$1" --region "${REGION}" --output json) || return 1
  printf '%s' "${out}" | jq -e '.services[0] | select(.status == "ACTIVE")' 2>/dev/null || {
    echo "FAIL: no ACTIVE service $1 in ${CLUSTER}: ${out}" >&2
    return 1
  }
}
assert_min_healthy() { # usage: assert_min_healthy <phase> <service-arn> <expected>
  local got
  got=$(describe_service "$2" | jq -r '.deploymentConfiguration.minimumHealthyPercent')
  [ "${got}" = "$3" ] || { echo "FAIL: ${1}: the service holds minimumHealthyPercent ${got}, expected $3" >&2; exit 1; }
}

# ECS answers a deleted service or cluster with rc 0 and an INACTIVE status or
# a MISSING failure, never a not-found error, so the canonical gone_probe
# cannot read it. Same contract: 0 gone, 1 present, hard FAIL undetermined.
ecs_gone_probe() { # usage: ecs_gone_probe service <cluster> <arn> | cluster <cluster>
  local out state rc
  if [ "$1" = "service" ]; then
    out=$(aws ecs describe-services --cluster "$2" --services "$3" --region "${REGION}" --output json 2>&1) && rc=0 || rc=$?
    if [ "${rc}" -ne 0 ]; then
      if grep -qiE 'ClusterNotFoundException' <<<"${out}"; then return 0; fi
      echo "FAIL: gone-probe undetermined (service $3): ${out}" >&2
      exit 1
    fi
    state=$(jq -r '.services[0].status // .failures[0].reason // "UNDETERMINED"' <<<"${out}")
  else
    out=$(aws ecs describe-clusters --clusters "$2" --region "${REGION}" --output json 2>&1) && rc=0 || rc=$?
    if [ "${rc}" -ne 0 ]; then
      echo "FAIL: gone-probe undetermined (cluster $2): ${out}" >&2
      exit 1
    fi
    state=$(jq -r '.clusters[0].status // .failures[0].reason // "UNDETERMINED"' <<<"${out}")
  fi
  case "${state}" in
    INACTIVE | MISSING) return 0 ;;
    ACTIVE | DRAINING | PROVISIONING | DEPROVISIONING) return 1 ;;
    *) echo "FAIL: gone-probe undetermined ($*): ${out}" >&2; exit 1 ;;
  esac
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
LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::ECS::Service") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::ECS::Service in ${TEMPLATE}" >&2; exit 1; }
echo "==> Resource under test: ${LOGICAL_ID}"

ARN_RE='^arn:aws[-a-z]*:ecs:[a-z0-9-]+:[0-9]{12}:service/[^|/]+/[^|/]+$'

echo "==> Phase 1: Deploy (SDK route by default -- Service has no SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P0=$(record '.physicalId')
LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk" >&2; exit 1; }
[[ "${P0}" =~ ${ARN_RE} ]] || { echo "FAIL: the SDK route recorded ${P0}, expected a bare long-format service ARN" >&2; exit 1; }
CLUSTER=$(output ClusterName)
[ -n "${CLUSTER}" ] && [ "${CLUSTER}" != "null" ] || { echo "FAIL: no ClusterName output" >&2; exit 1; }
assert_min_healthy "phase 1 (SDK create)" "${P0}" 100
echo "    OK: created on the SDK route (${P0})"

echo "==> Phase 2: force the service onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${LOGICAL_ID}" --yes
P1=$(record '.physicalId')
LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: after --recreate-via-cc-api the record says provisionedBy=${LAYER1}, expected cc-api. Every assertion below would be vacuous." >&2; exit 1; }
# THE MEASURED FORM: Cloud Control records `<serviceArn>|<cluster>`. Were it
# the bare ARN, this type would need no normalizer and the arm below would
# not exercise it.
P1_ARN="${P1%%|*}"
P1_CLUSTER="${P1#*|}"
[ "${P1_ARN}" != "${P1}" ] || { echo "FAIL: Cloud Control recorded ${P1}, expected the <serviceArn>|<cluster> composite" >&2; exit 1; }
[[ "${P1_ARN}" =~ ${ARN_RE} ]] || { echo "FAIL: the composite's first segment ${P1_ARN} is not a long-format service ARN" >&2; exit 1; }
[ "${P1_CLUSTER}" = "${CLUSTER}" ] || { echo "FAIL: the composite's cluster segment is ${P1_CLUSTER}, expected ${CLUSTER}" >&2; exit 1; }
# IDENTITY WITNESS. A recreate mints a new service, so its ARN must change.
[ "${P1_ARN}" != "${P0}" ] || { echo "FAIL: the recreate kept the ARN (${P0}); it was not recreated" >&2; exit 1; }
LIVE_ARN=$(describe_service "${P1_ARN}" | jq -r '.serviceArn')
[ "${LIVE_ARN}" = "${P1_ARN}" ] || { echo "FAIL: the live service ARN is ${LIVE_ARN}, the composite names ${P1_ARN}" >&2; exit 1; }
assert_min_healthy "phase 2 (CC recreate)" "${P1_ARN}" 50
echo "    OK: pinned to Cloud Control under the composite ${P1}"

echo "==> Phase 3: the plan ANNOUNCES the return"
# `pinned`, not `flip`: the seed already declares flip's value, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=pinned \
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
[ "${LAYER_PINNED}" = "cc-api" ] || { echo "FAIL: --pin-cc-api did not hold the service on Cloud Control (provisionedBy=${LAYER_PINNED})" >&2; exit 1; }
[ "$(record '.physicalId')" = "${P1}" ] || { echo "FAIL: the pinned deploy changed the id" >&2; exit 1; }
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_min_healthy "phase 4 (CC update)" "${P1_ARN}" 100
CREATED1=$(describe_service "${P1_ARN}" | jq -r '.createdAt')
[ -n "${CREATED1}" ] && [ "${CREATED1}" != "null" ] || { echo "FAIL: no createdAt on ${P1_ARN}" >&2; exit 1; }
echo "    OK: still on Cloud Control, update applied via CC (createdAt ${CREATED1})"

echo "==> Phase 5: THE ARM -- redeploy unpinned; the flip normalizes the id, in place"
FLIP_OUT=$(mktemp)
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${FLIP_OUT}"
grep -q "takes the SDK provider's form" "${FLIP_OUT}" || {
  echo "FAIL: the flip did not announce the id moving to the SDK form" >&2
  rm -f "${FLIP_OUT}"
  exit 1
}
rm -f "${FLIP_OUT}"
P2=$(record '.physicalId')
LAYER2=$(record '.provisionedBy')
[ "${LAYER2}" = "sdk" ] || { echo "FAIL: the record did not flip back (provisionedBy=${LAYER2}, expected sdk)" >&2; exit 1; }
[ "${P2}" = "${P1_ARN}" ] || { echo "FAIL: the flipped id is ${P2}, expected the composite's ARN part ${P1_ARN}" >&2; exit 1; }
LIVE2=$(describe_service "${P2}")
[ "$(jq -r '.serviceArn' <<<"${LIVE2}")" = "${P2}" ] || { echo "FAIL: the flipped id ${P2} is not the live service ARN" >&2; exit 1; }
[ "$(jq -r '.createdAt' <<<"${LIVE2}")" = "${CREATED1}" ] || { echo "FAIL: createdAt moved across the flip: the service was REPLACED" >&2; exit 1; }
assert_min_healthy "phase 5 (SDK update)" "${P2}" 50
[ "$(output ServiceRef)" = "${P2}" ] || { echo "FAIL: Ref resolved to $(output ServiceRef) after the flip, expected ${P2}" >&2; exit 1; }
[ "$(output ServiceNameAttr)" = "$(jq -r '.serviceName' <<<"${LIVE2}")" ] || { echo "FAIL: GetAtt Name resolved to $(output ServiceNameAttr) after the flip" >&2; exit 1; }
echo "    OK: id ${P2} (the SDK form), record flipped to sdk, updated in place, Ref / GetAtt intact"

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

echo "==> Phase 7: Destroy on the flipped record + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
ecs_gone_probe service "${CLUSTER}" "${P2}" || { echo "FAIL: service ${P2} survived destroy" >&2; exit 1; }
ecs_gone_probe cluster "${CLUSTER}" || { echo "FAIL: cluster ${CLUSTER} survived destroy" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-ecs-service (the normalized id observed equal to the live service ARN)"
