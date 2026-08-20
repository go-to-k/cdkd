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

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture calls
# `api.addApiKey(...)`, and `AWS::ApiGateway::ApiKey` has NO SDK provider -- it
# takes the generic Cloud Control readback, whose resource model includes
# `Value`. So the live 40-character key lands in `attributes.Value` without any
# provider code naming it: measured 2026-08-20, 2 of this stack's 16 surviving
# state.json versions carry one. The state bucket is VERSIONED, so `aws s3 rm`
# only writes a delete marker and it stays readable.
#
# Both halves of that measurement matter. A newest-N sample missed it (the key
# sits in versions 7 and 8 of 16), and grepping the PROVIDER sources for a
# credential would have missed it too, because no provider handles this type.
. ../s3-versions.sh

STACK="CdkdApigwUsagePlanKeyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
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
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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
    # The `aws s3 rm` above only wrote DELETE MARKERS. NONCURRENT-only here:
    # this also runs from the pre-run sweep and the failure traps, where a live
    # state.json may be the only record of resources still standing.
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

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object only looks at the CURRENT object; the bucket is VERSIONED, so the
# Cloud-Control-readback api key `Value` survives in prior versions without this
# (issue #2096). On the success path, not only in `cleanup`, and asserted.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "apigw-usage-plan-key state teardown"

echo ""
echo "==> apigw-usage-plan-key test passed"
