#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control update inside an object holding a nested
# create-only path (go-to-k/cdkd#6294).
#
# AWS::Route53::HealthCheck goes through Cloud Control. Its
# HealthCheckConfig.MeasureLatency is create-only and undeclared, so AWS
# defaults it to false. A pre-fix cdkd sent `replace /HealthCheckConfig` with
# the template's object on any change inside it, dropping MeasureLatency, and
# Cloud Control refused the whole update as a create-only change.
#
# Phases:
#   1. Deploy Port 8443 / FailureThreshold 5; assert both live, MeasureLatency
#      false, and the record routed through Cloud Control.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (Port 443 / FailureThreshold 4).
#      Assert the deploy succeeds IN PLACE (same health check id) and both
#      values reached AWS (a pre-fix run fails this deploy).
#   3. Destroy; assert the health check and the state file are gone.
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

STACK="CdkdCcNestedCreateOnlyUpdate"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
HC_ID=""

# The recorded health check record's field $1 (physicalId / provisionedBy).
state_field() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).resources.Hc;if(!r||r[process.argv[1]]===undefined)process.exit(1);console.log(r[process.argv[1]])})' "$1"
}

hc_config() { # usage: hc_config <JMESPath under HealthCheckConfig>
  aws route53 get-health-check --health-check-id "${HC_ID}" \
    --query "HealthCheck.HealthCheckConfig.$1" --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -z "${HC_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    HC_ID="$(state_field physicalId 2>/dev/null)"
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${HC_ID}" ]; then
    aws route53 delete-health-check --health-check-id "${HC_ID}" >/dev/null 2>&1
  fi
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
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup
HC_ID=""

# --- Phase 1: deploy Port 8443 / FailureThreshold 5 -------------------------
echo "==> Phase 1: deploy Port 8443 / FailureThreshold 5"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

HC_ID="$(state_field physicalId)"
ROUTE="$(state_field provisionedBy)"
if [ "${ROUTE}" != "cc-api" ]; then
  echo "FAIL: expected the health check routed through Cloud Control (provisionedBy cc-api), got '${ROUTE}' — the fixture no longer exercises the Cloud Control patch" >&2
  exit 1
fi
P1="$(hc_config Port)"
F1="$(hc_config FailureThreshold)"
M1="$(hc_config MeasureLatency)"
if [ "${P1}" != "8443" ] || [ "${F1}" != "5" ] || [ "${M1}" != "False" ]; then
  echo "FAIL: expected Port=8443 FailureThreshold=5 MeasureLatency=False after Phase 1, got Port=${P1} FailureThreshold=${F1} MeasureLatency=${M1}" >&2
  exit 1
fi
echo "    health check ${HC_ID} live via Cloud Control, MeasureLatency defaulted to false"

# --- Phase 2: change Port / FailureThreshold in place -----------------------
echo "==> Phase 2: re-deploy Port 443 / FailureThreshold 4 (must update in place)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

HC_ID2="$(state_field physicalId)"
if [ "${HC_ID2}" != "${HC_ID}" ]; then
  echo "FAIL: health check was REPLACED (${HC_ID} -> ${HC_ID2}); expected an in-place update" >&2
  HC_ID="${HC_ID2}"
  exit 1
fi
P2="$(hc_config Port)"
F2="$(hc_config FailureThreshold)"
M2="$(hc_config MeasureLatency)"
if [ "${P2}" != "443" ] || [ "${F2}" != "4" ] || [ "${M2}" != "False" ]; then
  echo "FAIL: expected Port=443 FailureThreshold=4 MeasureLatency=False after Phase 2, got Port=${P2} FailureThreshold=${F2} MeasureLatency=${M2}" >&2
  exit 1
fi
echo "    updated in place: Port=443 FailureThreshold=4, MeasureLatency kept"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "health check ${HC_ID} still exists after destroy" aws route53 get-health-check --health-check-id "${HC_ID}"
echo "    health check deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

trap - EXIT INT TERM
echo "[verify] PASS — Cloud Control nested create-only update (Route53 HealthCheck), all 3 phases passed"
