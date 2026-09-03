#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API greenfield fallback integ test
# (issue #614).
#
# Asserts that an HTTP API whose template uses a silent-drop property
# (`Body`, an inline OpenAPI spec — an ARCHITECTURAL exclusion, see
# issue #2473 and the rationale in lib/cc-api-fallback-stack.ts) is
# auto-routed via Cloud Control API and that the spec's route reaches
# AWS — the silent-drop bug is closed by default. Also asserts the
# destroy path works through CC API. Step 0 reds self-diagnosingly if
# the trigger is ever backfilled.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdCcApiFallback"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_TITLE="cdkd-cc-api-fallback-probe"
PROBE_ROUTE="GET /cdkd-2473-probe"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for api_id in $(aws apigatewayv2 get-apis --region "${REGION}" \
      --query "Items[?Name=='${API_TITLE:-cdkd-cc-api-fallback-probe}'].ApiId" --output text 2>/dev/null); do
    aws apigatewayv2 delete-api --api-id "${api_id}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Step 0: self-diagnosing trigger guard (issue #2473) --------------------
# This fixture's premise is that `Body` is a silent-drop for
# AWS::ApiGatewayV2::Api. Every previous trigger died when the backfill
# campaign wired it (LoggingConfig -> RecursiveLoop -> RuntimeManagementConfig),
# each time as a mysterious permanent deploy-time red that cost a root-cause
# session. This guard turns that death into a one-line red naming its own fix.
echo "==> Step 0: trigger premise guard"
if ! (cd "${PWD}/../../.." && node --input-type=module -e "
const mod = await import('./src/provisioning/property-coverage.generated.ts');
const table = Object.values(mod).find((v) => v instanceof Map);
const cov = table && table.get('AWS::ApiGatewayV2::Api');
if (!cov || !cov.silentDrop || !cov.silentDrop.has('Body')) process.exit(1);
"); then
  echo "FAIL: AWS::ApiGatewayV2::Api.Body is no longer a silent-drop — the trigger" >&2
  echo "      was backfilled and this fixture's premise is dead. Do NOT debug the" >&2
  echo "      deploy: pick the next durable silent-drop trigger per the selection" >&2
  echo "      rule in lib/cc-api-fallback-stack.ts (issue 2473)." >&2
  exit 1
fi
echo "    OK: Body is still a silent-drop (premise holds)"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion 1: state.provisionedBy on the HTTP API is 'cc-api' -----
# Lookup by resourceType (CDK appends a hash to the logical id; the
# bare `SilentDropApi` key does not exist — it's e.g.
# `SilentDropApiXXXXXXXX`).
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.provisionedBy // ""] | first')
API_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value.physicalId // ""] | first')
if [ "${PROVISIONED}" != "cc-api" ]; then
  echo "FAIL: HTTP API resource has provisionedBy='${PROVISIONED}', expected 'cc-api' (auto-route should have fired on Body)" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: HTTP API resource provisionedBy == 'cc-api' (auto-route fired)"

# --- Assertion 2: state.provisionedBy on the IAM Role is 'sdk' (heterogeneous) ---
ROLE_PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .value.provisionedBy // ""] | first')
if [ "${ROLE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: IAM Role resource has provisionedBy='${ROLE_PROVISIONED}', expected 'sdk'" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    OK: IAM Role resource provisionedBy == 'sdk' (heterogeneous routing in one stack)"

# --- Assertion 3: the OpenAPI Body actually reached AWS -----------------------
# The `GET /cdkd-2473-probe` route is declared ONLY inside `Body`, so its
# presence on the live API proves the CC route imported the spec; the SDK
# path would have silently dropped it, leaving an API with no routes.
case "${API_ID}" in
  '' | null)
    echo "FAIL: no ApiGatewayV2::Api physicalId in state" >&2
    exit 1
    ;;
esac
ROUTE_COUNT=$(aws apigatewayv2 get-routes --api-id "${API_ID}" --region "${REGION}" \
  --query "length(Items[?RouteKey=='${PROBE_ROUTE}'])" --output text)
case "${ROUTE_COUNT}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the route count (got '${ROUTE_COUNT}')" >&2
    exit 1
    ;;
esac
if [ "${ROUTE_COUNT}" -lt 1 ]; then
  echo "FAIL: route '${PROBE_ROUTE}' not found on API ${API_ID} (Body silent-drop NOT closed by CC route)" >&2
  exit 1
fi
echo "    OK: route '${PROBE_ROUTE}' exists on AWS (silent-drop CLOSED by #614)"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy via CC delete path"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "HTTP API ${API_ID} still exists after destroy" aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}"
echo "    OK: HTTP API is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> cc-api-fallback test passed (silent-drop closed by CC auto-route + clean destroy)"
