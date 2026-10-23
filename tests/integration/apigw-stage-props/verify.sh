#!/usr/bin/env bash
# verify.sh — AWS::ApiGateway::Stage silent-drop property backfill integ
# (issue #609).
#
# Live coverage for the formerly silent-drop Stage properties the SDK
# provider now wires, including the #1160 absent-field-removal semantics:
#
# Phases:
#   1. Deploy: Stage with AccessLogSetting + CanarySetting (PercentTraffic,
#      DeploymentId, StageVariableOverrides, UseStageCache) +
#      ClientCertificateId. Assert each reached AWS via get-stage, and
#      `cdkd drift` reads back clean (exercises the new readCurrentState
#      fields).
#   2. UPDATE (CDKD_TEST_UPDATE=true): AccessLogSetting removed (whole-block
#      `remove /accessLogSettings`), ClientCertificateId removed (scalar
#      clear), CanarySetting kept with PercentTraffic 10 -> 25 and the
#      StageVariableOverrides key dropped (per-key remove). Assert each
#      removal/change reached AWS and drift is clean.
#   3. Destroy + assert the REST API, client certificate, and log group are
#      gone and the cdkd state file is removed.
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

STACK="CdkdApigwStagePropsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
API_NAME="cdkd-stage-props-api"
STAGE_NAME="live"
LOG_GROUP_NAME="cdkd-stage-props-logs"
CERT_DESCRIPTION="cdkd-stage-props-cert"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi

  local api_id
  api_id="$(aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?name=='${API_NAME}'].id | [0]" --output text 2>/dev/null)"
  if [ -n "${api_id}" ] && [ "${api_id}" != "None" ]; then
    aws apigateway delete-rest-api --region "${REGION}" --rest-api-id "${api_id}" >/dev/null 2>&1
  fi

  for cert_id in $(aws apigateway get-client-certificates --region "${REGION}" \
    --query "items[?description=='${CERT_DESCRIPTION}'].clientCertificateId" --output text 2>/dev/null); do
    aws apigateway delete-client-certificate --region "${REGION}" \
      --client-certificate-id "${cert_id}" >/dev/null 2>&1
  done

  aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP_NAME}" >/dev/null 2>&1

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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with all backfilled Stage props ------------------------
echo "==> Phase 1: deploy (AccessLogSetting + CanarySetting + ClientCertificateId)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

API_ID="$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "items[?name=='${API_NAME}'].id | [0]" --output text)"
if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
  echo "FAIL: could not resolve REST API id for '${API_NAME}'" >&2
  exit 1
fi

STAGE_JSON="$(aws apigateway get-stage --region "${REGION}" \
  --rest-api-id "${API_ID}" --stage-name "${STAGE_NAME}")"

ACCESS_ARN="$(printf '%s' "${STAGE_JSON}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.accessLogSettings&&j.accessLogSettings.destinationArn)||"")})')"
case "${ACCESS_ARN}" in
  *":log-group:${LOG_GROUP_NAME}")
    echo "    accessLogSettings.destinationArn delivered (${ACCESS_ARN})" ;;
  *)
    echo "FAIL: accessLogSettings.destinationArn expected ...:log-group:${LOG_GROUP_NAME}, got '${ACCESS_ARN}'" >&2
    exit 1
    ;;
esac
ACCESS_FORMAT="$(printf '%s' "${STAGE_JSON}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.accessLogSettings&&j.accessLogSettings.format)||"")})')"
case "${ACCESS_FORMAT}" in
  *'$context.requestId'*) echo "    accessLogSettings.format delivered" ;;
  *)
    echo "FAIL: accessLogSettings.format missing \$context.requestId: '${ACCESS_FORMAT}'" >&2
    exit 1
    ;;
esac

CANARY_PCT="$(printf '%s' "${STAGE_JSON}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String((j.canarySettings&&j.canarySettings.percentTraffic)??""))})')"
if [ "${CANARY_PCT}" != "10" ]; then
  echo "FAIL: canarySettings.percentTraffic expected 10, got '${CANARY_PCT}'" >&2
  exit 1
fi
CANARY_OVERRIDE="$(printf '%s' "${STAGE_JSON}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.canarySettings&&j.canarySettings.stageVariableOverrides&&j.canarySettings.stageVariableOverrides.flag)||"")})')"
if [ "${CANARY_OVERRIDE}" != "canary" ]; then
  echo "FAIL: canarySettings.stageVariableOverrides.flag expected 'canary', got '${CANARY_OVERRIDE}'" >&2
  exit 1
fi
echo "    canarySettings delivered (percentTraffic=10, override flag=canary)"

CERT_ID_LIVE="$(printf '%s' "${STAGE_JSON}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.clientCertificateId||"")})')"
if [ -z "${CERT_ID_LIVE}" ]; then
  echo "FAIL: clientCertificateId not attached to the stage" >&2
  exit 1
fi
echo "    clientCertificateId delivered (${CERT_ID_LIVE})"

echo "==> Phase 1: drift read-back (expect no drift)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    drift clean after deploy"

# --- Phase 2: removal semantics (#1160 class, live) --------------------------
echo "==> Phase 2: re-deploy removing AccessLogSetting + ClientCertificateId, canary 10 -> 25, override key dropped"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STAGE_JSON_P2="$(aws apigateway get-stage --region "${REGION}" \
  --rest-api-id "${API_ID}" --stage-name "${STAGE_NAME}")"

ACCESS_P2="$(printf '%s' "${STAGE_JSON_P2}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.accessLogSettings?JSON.stringify(j.accessLogSettings):"")})')"
if [ -n "${ACCESS_P2}" ]; then
  echo "FAIL: accessLogSettings still present after removal: ${ACCESS_P2}" >&2
  exit 1
fi
echo "    accessLogSettings removed (whole-block remove delivered)"

CERT_P2="$(printf '%s' "${STAGE_JSON_P2}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.clientCertificateId||"")})')"
if [ -n "${CERT_P2}" ]; then
  echo "FAIL: clientCertificateId still attached after removal: ${CERT_P2}" >&2
  exit 1
fi
echo "    clientCertificateId detached (scalar clear delivered)"

CANARY_PCT_P2="$(printf '%s' "${STAGE_JSON_P2}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String((j.canarySettings&&j.canarySettings.percentTraffic)??""))})')"
if [ "${CANARY_PCT_P2}" != "25" ]; then
  echo "FAIL: canarySettings.percentTraffic expected 25 after update, got '${CANARY_PCT_P2}'" >&2
  exit 1
fi
CANARY_OVERRIDE_P2="$(printf '%s' "${STAGE_JSON_P2}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.canarySettings&&j.canarySettings.stageVariableOverrides&&j.canarySettings.stageVariableOverrides.flag)||"")})')"
if [ -n "${CANARY_OVERRIDE_P2}" ]; then
  echo "FAIL: canary stageVariableOverrides.flag still present after per-key remove: '${CANARY_OVERRIDE_P2}'" >&2
  exit 1
fi
echo "    canary updated in place (percentTraffic=25, override key removed)"

echo "==> Phase 2: drift read-back (expect no drift)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    drift clean after update"

# --- Phase 3: destroy ---------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

API_LEFT="$(aws apigateway get-rest-apis --region "${REGION}" \
  --query "length(items[?name=='${API_NAME}'])" --output text)"
if [ "${API_LEFT}" != "0" ]; then
  echo "FAIL: REST API still present after destroy (count=${API_LEFT})" >&2
  exit 1
fi
CERT_LEFT="$(aws apigateway get-client-certificates --region "${REGION}" \
  --query "length(items[?description=='${CERT_DESCRIPTION}'])" --output text)"
if [ "${CERT_LEFT}" != "0" ]; then
  echo "FAIL: client certificate still present after destroy (count=${CERT_LEFT})" >&2
  exit 1
fi
LG_LEFT="$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "${LOG_GROUP_NAME}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP_NAME}'])" --output text)"
if [ "${LG_LEFT}" != "0" ]; then
  echo "FAIL: log group still present after destroy (count=${LG_LEFT})" >&2
  exit 1
fi
echo "    REST API, client certificate, and log group all gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — ApiGateway Stage backfilled props: create delivery, removal semantics (block remove + scalar clear + per-key remove), drift read-back, and destroy all verified"
