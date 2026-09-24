#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API fallback transitions integ test
# (#634 items 3 + 4).
#
# Two stacks share the same deploy/destroy cycle to keep the AWS round-trip
# cost down. Both validate real-AWS behaviors that `cc-api-fallback`
# does not cover:
#
#   Stack CdkdCcApiOverride (item 3): deploy with
#     `--allow-unsupported-properties AWS::ApiGatewayV2::Api:Body`
#     → state stamps `provisionedBy: 'sdk'`, AWS does NOT receive `Body`
#     (silent drop accepted, warn-logged — the route declared only inside the
#     spec does not exist on the live API).
#
#   Stack CdkdCcApiTransition (item 4): two-phase deploy that exercises
#     the mid-life SDK→CC re-route path.
#       Phase 1: synth WITHOUT Body (env var unset) → deploy → state stamps
#         `provisionedBy: 'sdk'`, no route on AWS.
#       Phase 2: synth with Body ALONE (env var set) → re-deploy → the API is
#         REPLACED (dropping the create-only ProtocolType), the create half
#         routes to CC on Body, state flips to `'cc-api'` on a NEW ApiId, the
#         SDK-minted API is gone, and the spec's route exists on AWS. Why a
#         replacement and not an in-place update: lib/transitions-stack.ts.
#
# The trigger is `AWS::ApiGatewayV2::Api.Body`, an ARCHITECTURAL silent drop
# (issue #2648 — the rationale is in lib/transitions-stack.ts). Step 0 reds
# self-diagnosingly if it is ever backfilled.
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

REGION="${AWS_REGION:-us-east-1}"
OVERRIDE_STACK="CdkdCcApiOverride"
TRANSITION_STACK="CdkdCcApiTransition"
OVERRIDE_KEY="cdkd/${OVERRIDE_STACK}/${REGION}/state.json"
TRANSITION_KEY="cdkd/${TRANSITION_STACK}/${REGION}/state.json"
OVERRIDE_API_NAME="cdkd-cc-api-override-probe"
TRANSITION_API_NAME="cdkd-cc-api-transition-probe"
PROBE_ROUTE="GET /cdkd-2648-probe"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The HTTP API's field from the state record, looked up by resourceType (CDK
# appends a hash to the logical id).
api_record() { # usage: api_record "<state json>" <jq field>
  printf '%s' "$1" | jq -r --arg f "$2" '[.resources | to_entries[] | select(.value.resourceType == "AWS::ApiGatewayV2::Api") | .value[$f] // ""] | first // ""'
}

# The ids of the routes on an API whose key is PROBE_ROUTE — rows of a
# projection, not `length(...)`, which `--output text` applies per PAGE. Empty
# when the route does not exist. A failing probe (wrong id, throttle) aborts
# the run under `set -e` with the CLI's own stderr, never reads as "absent".
probe_route_ids() { # usage: probe_route_ids <api-id>
  aws apigatewayv2 get-routes --api-id "$1" --region "${REGION}" \
    --query "Items[?RouteKey=='${PROBE_ROUTE}'].RouteId" --output text
}

# An API id read from state must be non-empty before it is probed.
require_api_id() { # usage: require_api_id <label> <api-id>
  case "$2" in
    '' | null)
      echo "FAIL: no AWS::ApiGatewayV2::Api physicalId in the $1 state record" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${OVERRIDE_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${TRANSITION_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # By exact NAME, never a prefix: API names are not unique, and an exact
  # literal cannot widen to an unrelated API the way an empty prefix would.
  for api_name in "${OVERRIDE_API_NAME}" "${TRANSITION_API_NAME}"; do
    for api_id in $(aws apigatewayv2 get-apis --region "${REGION}" \
        --query "Items[?Name=='${api_name}'].ApiId" --output text 2>/dev/null); do
      aws apigatewayv2 delete-api --api-id "${api_id}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${OVERRIDE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${TRANSITION_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${OVERRIDE_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${TRANSITION_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

# --- Step 0: self-diagnosing trigger guard (issues #2473, #2648) -------------
# Both arms rest on `Body` being a silent-drop for AWS::ApiGatewayV2::Api. This
# fixture's previous trigger (Lambda RuntimeManagementConfig) died when #1621
# wired it, and surfaced as an item-3 assertion failure months later. This
# guard turns the next such death into a one-line red naming its own fix.
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
  echo "      rule in ../cc-api-fallback/lib/cc-api-fallback-stack.ts (issue 2473)," >&2
  echo "      and move this fixture with it (issue 2648)." >&2
  exit 1
fi
echo "    OK: Body is still a silent-drop (premise holds)"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1A: deploy OverrideStack with --allow-unsupported-properties ---
#
# DELIBERATELY the DEPRECATED spelling (issue
# https://github.com/go-to-k/cdkd/issues/3000). The successor
# `--prefer-sdk-route` is exercised by `sdk-to-cc-autoroute`; this fixture keeps
# the alias so the COMPATIBILITY surface has live real-AWS coverage too. An
# alias nothing runs is an alias that breaks silently, which is the one failure
# the deprecation shape exists to prevent.
#
# Item 3: the template emits `Body` but the CLI flag keeps the SDK route.
# Expect: state stamps `provisionedBy: 'sdk'`, AWS does NOT receive the spec
# (the probe route is absent).
echo "==> Phase 1A: deploy ${OVERRIDE_STACK} with --allow-unsupported-properties (item 3 override path)"
node "${LOCAL_DIST}" deploy "${OVERRIDE_STACK}" \
  --allow-unsupported-properties "AWS::ApiGatewayV2::Api:Body" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

OVERRIDE_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${OVERRIDE_KEY}" - 2>/dev/null)
if [ -z "${OVERRIDE_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${OVERRIDE_KEY} after override deploy" >&2
  exit 1
fi

# Item 3 assertion 1: state.provisionedBy on the API is 'sdk' (override kept
# it on the SDK path, NOT auto-routed via CC).
OVERRIDE_PROVISIONED=$(api_record "${OVERRIDE_STATE}" provisionedBy)
if [ "${OVERRIDE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: OverrideStack HTTP API has provisionedBy='${OVERRIDE_PROVISIONED}', expected 'sdk' (--allow-unsupported-properties should keep it on SDK)" >&2
  echo "${OVERRIDE_STATE}" | jq .
  exit 1
fi
echo "    OK: OverrideStack HTTP API provisionedBy == 'sdk' (override forced SDK path)"

# Item 3 assertion 2: the probe route is ABSENT — the silent drop actually
# dropped. The SDK provider's CreateApi carries no spec, so the API exists with
# no routes. Phase 2 below is the positive control: the same spec (bar its
# title), forwarded, does create the route, so absence here is the drop and not a malformed spec.
OVERRIDE_API_ID=$(api_record "${OVERRIDE_STATE}" physicalId)
require_api_id OverrideStack "${OVERRIDE_API_ID}"
OVERRIDE_ROUTES=$(probe_route_ids "${OVERRIDE_API_ID}")
if [ -n "${OVERRIDE_ROUTES}" ]; then
  echo "FAIL: OverrideStack HTTP API ${OVERRIDE_API_ID} has route '${PROBE_ROUTE}' (${OVERRIDE_ROUTES}) — the override should have silent-dropped Body, so no route should exist" >&2
  exit 1
fi
echo "    OK: OverrideStack HTTP API ${OVERRIDE_API_ID} has no '${PROBE_ROUTE}' route (Body silent drop honored)"

# --- Phase 1B: deploy TransitionStack baseline (NO Body) -----------------
#
# Item 4 stage 1: template has no Body → SDK route → state stamps
# `provisionedBy: 'sdk'`.
echo "==> Phase 1B: deploy ${TRANSITION_STACK} WITHOUT Body (item 4 baseline → SDK route)"
unset CDKD_INTEG_USE_SILENT_DROP
node "${LOCAL_DIST}" deploy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

TRANSITION_STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${TRANSITION_KEY}" - 2>/dev/null)
TRANSITION_PROVISIONED_1=$(api_record "${TRANSITION_STATE_1}" provisionedBy)
if [ "${TRANSITION_PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: TransitionStack HTTP API has provisionedBy='${TRANSITION_PROVISIONED_1}' after baseline deploy, expected 'sdk' (no silent-drop in template → SDK route)" >&2
  echo "${TRANSITION_STATE_1}" | jq .
  exit 1
fi
echo "    OK: TransitionStack HTTP API provisionedBy == 'sdk' (baseline, no silent-drop property in template)"

TRANSITION_API_ID_1=$(api_record "${TRANSITION_STATE_1}" physicalId)
require_api_id "TransitionStack baseline" "${TRANSITION_API_ID_1}"
TRANSITION_ROUTES_1=$(probe_route_ids "${TRANSITION_API_ID_1}")
if [ -n "${TRANSITION_ROUTES_1}" ]; then
  echo "FAIL: TransitionStack HTTP API has route '${PROBE_ROUTE}' after baseline deploy — fixture forgot to omit Body" >&2
  exit 1
fi
echo "    OK: TransitionStack HTTP API ${TRANSITION_API_ID_1} has no '${PROBE_ROUTE}' route yet (baseline)"

# --- Phase 2: re-deploy TransitionStack defined by Body (mid-life flip) ----
#
# Item 4 stage 2: env var flips synth to a Body-only API → the diff replaces it
# (ProtocolType, create-only, left the template) → the create half routes to CC
# on Body, the delete half runs on the old 'sdk' record → state flips from
# 'sdk' to 'cc-api' → the spec's route exists on the new API.
echo "==> Phase 2: re-deploy ${TRANSITION_STACK} defined by Body (item 4 mid-life SDK→CC flip)"
export CDKD_INTEG_USE_SILENT_DROP=true
node "${LOCAL_DIST}" deploy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
unset CDKD_INTEG_USE_SILENT_DROP

TRANSITION_STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${TRANSITION_KEY}" - 2>/dev/null)
TRANSITION_PROVISIONED_2=$(api_record "${TRANSITION_STATE_2}" provisionedBy)
if [ "${TRANSITION_PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: TransitionStack HTTP API has provisionedBy='${TRANSITION_PROVISIONED_2}' after the template moved onto Body, expected 'cc-api' (mid-life SDK→CC re-route)" >&2
  echo "${TRANSITION_STATE_2}" | jq .
  exit 1
fi
echo "    OK: TransitionStack HTTP API provisionedBy flipped 'sdk' → 'cc-api' (mid-life re-route fired)"

# A replacement: a NEW physical id, and the SDK-minted API deleted — by the
# SDK provider, on the old record's provisionedBy.
TRANSITION_API_ID_2=$(api_record "${TRANSITION_STATE_2}" physicalId)
require_api_id "TransitionStack post-flip" "${TRANSITION_API_ID_2}"
if [ "${TRANSITION_API_ID_2}" = "${TRANSITION_API_ID_1}" ]; then
  echo "FAIL: TransitionStack HTTP API kept physicalId '${TRANSITION_API_ID_1}' across the flip, expected a replacement (ProtocolType is create-only and left the template)" >&2
  exit 1
fi
assert_gone "TransitionStack SDK-minted HTTP API ${TRANSITION_API_ID_1} still exists after the replacement" aws apigatewayv2 get-api --api-id "${TRANSITION_API_ID_1}" --region "${REGION}"
echo "    OK: TransitionStack HTTP API replaced ${TRANSITION_API_ID_1} → ${TRANSITION_API_ID_2}, the SDK-minted one is gone"

# Item 4 post-flip AWS check: the route declared only inside Body exists.
TRANSITION_ROUTES_2=$(probe_route_ids "${TRANSITION_API_ID_2}")
if [ -z "${TRANSITION_ROUTES_2}" ]; then
  echo "FAIL: TransitionStack HTTP API ${TRANSITION_API_ID_2} has no '${PROBE_ROUTE}' route after the CC re-route (CC should have forwarded Body)" >&2
  exit 1
fi
echo "    OK: TransitionStack Body reached AWS via CC API (route '${PROBE_ROUTE}' = ${TRANSITION_ROUTES_2})"

# --- Phase 3: destroy both stacks -------------------------------------
echo "==> Phase 3: destroy both stacks"
node "${LOCAL_DIST}" destroy "${OVERRIDE_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force
node "${LOCAL_DIST}" destroy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "OverrideStack HTTP API ${OVERRIDE_API_ID} still exists after destroy" aws apigatewayv2 get-api --api-id "${OVERRIDE_API_ID}" --region "${REGION}"
assert_gone "TransitionStack HTTP API ${TRANSITION_API_ID_2} still exists after destroy" aws apigatewayv2 get-api --api-id "${TRANSITION_API_ID_2}" --region "${REGION}"
echo "    OK: both HTTP API probes are gone"

assert_gone "OverrideStack state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${OVERRIDE_KEY}"
assert_gone "TransitionStack state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${TRANSITION_KEY}"
echo "    OK: both state files are gone"

echo ""
echo "==> cc-api-fallback-transitions test passed (#634 items 3 + 4 verified end-to-end)"
