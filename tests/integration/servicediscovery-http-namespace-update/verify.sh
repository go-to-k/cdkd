#!/usr/bin/env bash
# verify.sh -- a Cloud Map service in an HTTP namespace keeps deploying when
# its Description changes (issue 6484).
#
# AWS refuses UpdateService for such a service, and CloudFormation reports the
# update as applied while changing nothing. Phases: deploy -> change only the
# Description: the deploy succeeds and warns, AWS keeps the old value, and the
# state record says the old value -> no drift -> destroy.

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

STACK="CdkdServiceDiscoveryHttpNamespaceUpdate"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_description() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -er '.resources.HttpService.properties.Description'
}
service_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -er '.resources.HttpService.physicalId'
}
live_description() { # usage: live_description <service-id>
  aws servicediscovery get-service --id "$1" --region "${REGION}" --query 'Service.Description' --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
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

echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
SERVICE_ID=$(service_id)
NAMESPACE_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -er '.outputs.NamespaceId')
[ "$(live_description "${SERVICE_ID}")" = "description-a" ] || { echo "FAIL: phase 1: the service does not hold description-a" >&2; exit 1; }
echo "    OK: ${SERVICE_ID} created with description-a"

echo "==> Phase 2: change only the Description (AWS refuses UpdateService here)"
set +e
UPDATE_OUT=$(env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
UPDATE_RC=$?
set -e
printf '%s\n' "${UPDATE_OUT}"
[ "${UPDATE_RC}" -eq 0 ] || { echo "FAIL: the Description-only deploy exited ${UPDATE_RC}; it must go on as in CloudFormation" >&2; exit 1; }
# The warning names the service on the same line as cdkd's own wording; the
# sentinel catches a reworded warning that still names the service.
WARN_LINE=$(grep -F 'Cloud Map cannot update service HttpService' <<<"${UPDATE_OUT}" || true)
if ! grep -qF 'HTTP (API-only) namespace' <<<"${WARN_LINE}"; then
  echo "FAIL: the deploy did not warn that the HTTP-namespace service could not be updated" >&2
  exit 1
fi
[ "$(live_description "${SERVICE_ID}")" = "description-a" ] || { echo "FAIL: phase 2: AWS's description changed although UpdateService is refused here" >&2; exit 1; }
[ "$(state_description)" = "description-a" ] || {
  echo "FAIL: phase 2: the state record says '$(state_description)', not the description-a AWS holds" >&2
  exit 1
}
[ "$(service_id)" = "${SERVICE_ID}" ] || { echo "FAIL: phase 2 replaced the service" >&2; exit 1; }
echo "    OK: deploy went on with the warning; AWS and the record both keep description-a"

echo "==> Phase 2b: the same template again -- the next deploy also goes on (it failed every time before)"
set +e
AGAIN_OUT=$(env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
AGAIN_RC=$?
set -e
[ "${AGAIN_RC}" -eq 0 ] || { printf '%s\n' "${AGAIN_OUT}" >&2; echo "FAIL: the second Description-only deploy exited ${AGAIN_RC}" >&2; exit 1; }
grep -F 'Cloud Map cannot update service HttpService' <<<"${AGAIN_OUT}" | grep -qF 'HTTP (API-only) namespace' || {
  printf '%s\n' "${AGAIN_OUT}" >&2
  echo "FAIL: the second deploy did not warn again" >&2
  exit 1
}
[ "$(service_id)" = "${SERVICE_ID}" ] || { echo "FAIL: the second deploy replaced the service" >&2; exit 1; }
[ "$(state_description)" = "description-a" ] || { echo "FAIL: the second deploy recorded '$(state_description)'" >&2; exit 1; }
echo "    OK: the next deploy goes on too, warning again, same service, record unchanged"

echo "==> Phase 3: no drift"
DRIFT_JSON=$(mktemp)
set +e
env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --stack-region "${REGION}" --json >"${DRIFT_JSON}" 2>/dev/null
DRIFT_RC=$?
set -e
BUCKET=$(jq -r '[.. | objects | to_entries[]
  | select((.value | type) == "array") | .key as $bucket
  | .value[]? | objects | select(.logicalId == "HttpService") | $bucket] | join(",")' \
  "${DRIFT_JSON}" 2>/dev/null || true)
if [ "${DRIFT_RC}" -ne 0 ] || [ "${BUCKET}" != "clean" ]; then
  echo "FAIL: cdkd drift did not report HttpService clean (bucket '${BUCKET}', rc=${DRIFT_RC}):" >&2
  cat "${DRIFT_JSON}" >&2
  rm -f "${DRIFT_JSON}"
  exit 1
fi
rm -f "${DRIFT_JSON}"
echo "    OK: cdkd drift reported HttpService clean"

echo "==> Phase 4: destroy + gone-probes"
env CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "service ${SERVICE_ID} survived destroy" \
  aws servicediscovery get-service --id "${SERVICE_ID}" --region "${REGION}"
# Cloud Map deletes a namespace asynchronously; each poll goes through
# gone_probe, so a throttle or auth error hard-fails instead of reading as gone.
NS_GONE=0
for _ in $(seq 1 24); do
  if gone_probe aws servicediscovery get-namespace --id "${NAMESPACE_ID}" --region "${REGION}"; then
    NS_GONE=1
    break
  fi
  sleep 5
done
[ "${NS_GONE}" = 1 ] || { echo "FAIL: namespace ${NAMESPACE_ID} still readable 120s after destroy" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- servicediscovery-http-namespace-update"
