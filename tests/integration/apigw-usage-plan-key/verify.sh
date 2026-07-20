#!/usr/bin/env bash
# verify.sh — cdkd API Gateway UsagePlan + ApiKey + UsagePlanKey integ.
# Asserts the usage plan, api key, and their linkage (compound-id UsagePlanKey)
# reach AWS, then destroys clean. Confirmed-clean /hunt-bugs pattern; the
# UsagePlanKey compound CC id (`<UsagePlanId>|<KeyId>`) + ApiKey Ref make this
# the regression guard for resolveRefValue compound-id handling.

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

STACK="CdkdApigwUsagePlanKeyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="${STACK}-api"
KEY_NAME="${STACK}-key"
PLAN_NAME="${STACK}-plan"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

api_id() {
  aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='${API_NAME}'].id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  for pid in $(aws apigateway get-usage-plans --region "${REGION}" --query "items[?name=='${PLAN_NAME}'].id" --output text 2>/dev/null); do
    aws apigateway delete-usage-plan --usage-plan-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for kid in $(aws apigateway get-api-keys --name-query "${KEY_NAME}" --region "${REGION}" --query 'items[].id' --output text 2>/dev/null); do
    aws apigateway delete-api-key --api-key "${kid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  local aid; aid=$(api_id)
  [ -n "${aid}" ] && [ "${aid}" != "None" ] && aws apigateway delete-rest-api --rest-api-id "${aid}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PLAN_ID=$(aws apigateway get-usage-plans --region "${REGION}" --query "items[?name=='${PLAN_NAME}'].id | [0]" --output text 2>/dev/null)
[ -z "${PLAN_ID}" ] || [ "${PLAN_ID}" = "None" ] && { echo "FAIL: usage plan '${PLAN_NAME}' not found" >&2; exit 1; }
echo "    OK: usage plan reached AWS (id: ${PLAN_ID})"

KEY_ID=$(aws apigateway get-api-keys --name-query "${KEY_NAME}" --region "${REGION}" --query 'items[0].id' --output text 2>/dev/null)
[ -z "${KEY_ID}" ] || [ "${KEY_ID}" = "None" ] && { echo "FAIL: api key '${KEY_NAME}' not found" >&2; exit 1; }
echo "    OK: api key reached AWS (id: ${KEY_ID})"

# UsagePlanKey linkage: the key must be attached to the plan (the compound
# UsagePlanKey resource). A leaked compound id would have failed the deploy.
LINKED=$(aws apigateway get-usage-plan-keys --usage-plan-id "${PLAN_ID}" --region "${REGION}" \
  --query "items[?id=='${KEY_ID}'].id | [0]" --output text 2>/dev/null)
[ "${LINKED}" != "${KEY_ID}" ] && { echo "FAIL: api key ${KEY_ID} not linked to usage plan ${PLAN_ID} (UsagePlanKey)" >&2; exit 1; }
echo "    OK: UsagePlanKey links key ${KEY_ID} to plan ${PLAN_ID}"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

REMAIN=$(api_id)
[ -n "${REMAIN}" ] && [ "${REMAIN}" != "None" ] && { echo "FAIL: rest api '${API_NAME}' still exists after destroy" >&2; exit 1; }
echo "    OK: rest api gone"
PLAN_REMAIN=$(aws apigateway get-usage-plans --region "${REGION}" --query "items[?name=='${PLAN_NAME}'].id | [0]" --output text 2>/dev/null)
[ -n "${PLAN_REMAIN}" ] && [ "${PLAN_REMAIN}" != "None" ] && { echo "FAIL: usage plan still exists after destroy" >&2; exit 1; }
echo "    OK: usage plan gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> apigw-usage-plan-key test passed"
