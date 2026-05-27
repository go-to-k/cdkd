#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API fallback transitions integ test
# (#634 items 3 + 4).
#
# Two stacks share the same deploy/destroy cycle to keep the AWS round-trip
# cost down. Both validate real-AWS behaviors that `cc-api-fallback`
# does not cover:
#
#   Stack CdkdCcApiOverride (item 3): deploy with
#     `--allow-unsupported-properties AWS::Lambda::Function:LoggingConfig`
#     → state stamps `provisionedBy: 'sdk'`, AWS does NOT receive
#     `LoggingConfig` (silent drop accepted, warn-logged).
#
#   Stack CdkdCcApiTransition (item 4): two-phase deploy that exercises
#     the mid-life SDK→CC re-route path.
#       Phase 1: synth WITHOUT LoggingConfig (env var unset) → deploy →
#         state stamps `provisionedBy: 'sdk'`.
#       Phase 2: synth WITH LoggingConfig (env var set) → re-deploy →
#         `getProviderFor` returns CC, state flips to `'cc-api'`, AWS
#         now has `LoggingConfig`.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
OVERRIDE_STACK="CdkdCcApiOverride"
TRANSITION_STACK="CdkdCcApiTransition"
OVERRIDE_KEY="cdkd/${OVERRIDE_STACK}/${REGION}/state.json"
TRANSITION_KEY="cdkd/${TRANSITION_STACK}/${REGION}/state.json"
OVERRIDE_FN="cdkd-cc-api-override-probe"
TRANSITION_FN="cdkd-cc-api-transition-probe"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${OVERRIDE_STACK}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${TRANSITION_STACK}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${OVERRIDE_FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "${TRANSITION_FN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${OVERRIDE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${TRANSITION_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${OVERRIDE_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${TRANSITION_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # IAM roles: only the auto-named stack-prefixed ones remain after a
  # cdkd `state destroy` (which skips AWS deletion). `starts_with` (not
  # `contains`) so we never match an unrelated user-created role whose
  # name happens to embed the stack id substring on a shared AWS
  # account. Best-effort detach the AWSLambdaBasicExecutionRole managed
  # policy + delete; ignore failures (the verify.sh may have already
  # destroyed cleanly).
  for stack in "${OVERRIDE_STACK}" "${TRANSITION_STACK}"; do
    for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${stack}\`)].RoleName" --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${role}" \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
      aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
    done
  done
  set -eu
}

trap cleanup EXIT

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
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1A: deploy OverrideStack with --allow-unsupported-properties ---
#
# Item 3: the template emits `LoggingConfig` but the CLI flag forces the
# SDK route. Expect: state stamps `provisionedBy: 'sdk'`, AWS does NOT
# receive the logging config.
echo "==> Phase 1A: deploy ${OVERRIDE_STACK} with --allow-unsupported-properties (item 3 override path)"
node "${LOCAL_DIST}" deploy "${OVERRIDE_STACK}" \
  --allow-unsupported-properties "AWS::Lambda::Function:LoggingConfig" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

OVERRIDE_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${OVERRIDE_KEY}" - 2>/dev/null)
if [ -z "${OVERRIDE_STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${OVERRIDE_KEY} after override deploy" >&2
  exit 1
fi

# Item 3 assertion 1: state.provisionedBy on the Lambda is 'sdk' (override
# kept it on SDK path, NOT auto-routed via CC).
OVERRIDE_PROVISIONED=$(echo "${OVERRIDE_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${OVERRIDE_PROVISIONED}" != "sdk" ]; then
  echo "FAIL: OverrideStack Lambda has provisionedBy='${OVERRIDE_PROVISIONED}', expected 'sdk' (--allow-unsupported-properties should keep it on SDK)" >&2
  echo "${OVERRIDE_STATE}" | jq .
  exit 1
fi
echo "    OK: OverrideStack Lambda provisionedBy == 'sdk' (override forced SDK path)"

# Item 3 assertion 2: AWS does NOT have LoggingConfig — the silent drop
# actually dropped. The SDK provider doesn't wire LoggingConfig, so
# Lambda's GetFunctionConfiguration returns null for LoggingConfig (or a
# default-shaped {LogFormat: "Text"} object — verify by checking that
# LogFormat is NOT "JSON" and ApplicationLogLevel is NOT "INFO").
OVERRIDE_LOG_CONFIG=$(aws lambda get-function-configuration \
  --function-name "${OVERRIDE_FN}" --region "${REGION}" \
  --query 'LoggingConfig' --output json 2>/dev/null)
OVERRIDE_LOG_FORMAT=$(echo "${OVERRIDE_LOG_CONFIG}" | jq -r '.LogFormat // ""')
OVERRIDE_APP_LEVEL=$(echo "${OVERRIDE_LOG_CONFIG}" | jq -r '.ApplicationLogLevel // ""')
# Either field reaching AWS's expected post-CC values is enough to know
# the silent drop did NOT happen. `||` (not `&&`) so a partial forward
# — `LogFormat=JSON` alone, or `ApplicationLogLevel=INFO` alone — still
# fails the assertion. The override path stamps `provisionedBy: 'sdk'`
# AND the SDK provider does not wire LoggingConfig at all, so neither
# field should be reachable through this path.
if [ "${OVERRIDE_LOG_FORMAT}" = "JSON" ] || [ "${OVERRIDE_APP_LEVEL}" = "INFO" ]; then
  echo "FAIL: OverrideStack Lambda received some LoggingConfig (LogFormat='${OVERRIDE_LOG_FORMAT}', ApplicationLogLevel='${OVERRIDE_APP_LEVEL}') — override should have silent-dropped both" >&2
  echo "    AWS LoggingConfig: ${OVERRIDE_LOG_CONFIG}"
  exit 1
fi
echo "    OK: OverrideStack Lambda did NOT receive LoggingConfig (AWS LogFormat='${OVERRIDE_LOG_FORMAT}', ApplicationLogLevel='${OVERRIDE_APP_LEVEL}' — silent drop honored)"

# --- Phase 1B: deploy TransitionStack baseline (NO LoggingConfig) ----------
#
# Item 4 stage 1: template has no LoggingConfig → SDK route → state stamps
# `provisionedBy: 'sdk'`.
echo "==> Phase 1B: deploy ${TRANSITION_STACK} WITHOUT LoggingConfig (item 4 baseline → SDK route)"
unset CDKD_INTEG_USE_LOGGING_CONFIG
node "${LOCAL_DIST}" deploy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

TRANSITION_STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${TRANSITION_KEY}" - 2>/dev/null)
TRANSITION_PROVISIONED_1=$(echo "${TRANSITION_STATE_1}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${TRANSITION_PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: TransitionStack Lambda has provisionedBy='${TRANSITION_PROVISIONED_1}' after baseline deploy, expected 'sdk' (no silent-drop in template → SDK route)" >&2
  echo "${TRANSITION_STATE_1}" | jq .
  exit 1
fi
echo "    OK: TransitionStack Lambda provisionedBy == 'sdk' (baseline, no silent-drop property in template)"

# Item 4 baseline AWS check: LoggingConfig should NOT be set yet.
TRANSITION_LOG_CONFIG_1=$(aws lambda get-function-configuration \
  --function-name "${TRANSITION_FN}" --region "${REGION}" \
  --query 'LoggingConfig' --output json 2>/dev/null)
TRANSITION_LOG_FORMAT_1=$(echo "${TRANSITION_LOG_CONFIG_1}" | jq -r '.LogFormat // ""')
if [ "${TRANSITION_LOG_FORMAT_1}" = "JSON" ]; then
  echo "FAIL: TransitionStack Lambda has LogFormat=JSON after baseline deploy — fixture forgot to omit LoggingConfig" >&2
  exit 1
fi
echo "    OK: TransitionStack Lambda has no JSON LoggingConfig on AWS yet (baseline)"

# --- Phase 2: re-deploy TransitionStack WITH LoggingConfig (mid-life flip) -
#
# Item 4 stage 2: env var flips synth to emit LoggingConfig → diff sees
# the new property → routing returns CC → state flips from 'sdk' to
# 'cc-api' → AWS now has LoggingConfig.
echo "==> Phase 2: re-deploy ${TRANSITION_STACK} WITH LoggingConfig (item 4 mid-life SDK→CC flip)"
export CDKD_INTEG_USE_LOGGING_CONFIG=true
node "${LOCAL_DIST}" deploy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
unset CDKD_INTEG_USE_LOGGING_CONFIG

TRANSITION_STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${TRANSITION_KEY}" - 2>/dev/null)
TRANSITION_PROVISIONED_2=$(echo "${TRANSITION_STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${TRANSITION_PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: TransitionStack Lambda has provisionedBy='${TRANSITION_PROVISIONED_2}' after LoggingConfig added, expected 'cc-api' (mid-life SDK→CC re-route)" >&2
  echo "${TRANSITION_STATE_2}" | jq .
  exit 1
fi
echo "    OK: TransitionStack Lambda provisionedBy flipped 'sdk' → 'cc-api' (mid-life re-route fired)"

# Item 4 post-flip AWS check: LoggingConfig should now be set (CC forwarded it).
TRANSITION_LOG_CONFIG_2=$(aws lambda get-function-configuration \
  --function-name "${TRANSITION_FN}" --region "${REGION}" \
  --query 'LoggingConfig' --output json 2>/dev/null)
TRANSITION_LOG_FORMAT_2=$(echo "${TRANSITION_LOG_CONFIG_2}" | jq -r '.LogFormat // ""')
TRANSITION_APP_LEVEL_2=$(echo "${TRANSITION_LOG_CONFIG_2}" | jq -r '.ApplicationLogLevel // ""')
if [ "${TRANSITION_LOG_FORMAT_2}" != "JSON" ]; then
  echo "FAIL: TransitionStack Lambda has LogFormat='${TRANSITION_LOG_FORMAT_2}' after CC re-route, expected 'JSON' (CC should have forwarded LoggingConfig)" >&2
  exit 1
fi
if [ "${TRANSITION_APP_LEVEL_2}" != "INFO" ]; then
  echo "FAIL: TransitionStack Lambda has ApplicationLogLevel='${TRANSITION_APP_LEVEL_2}' after CC re-route, expected 'INFO'" >&2
  exit 1
fi
echo "    OK: TransitionStack Lambda LoggingConfig reached AWS via CC API (LogFormat=JSON, ApplicationLogLevel=INFO)"

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

if aws lambda get-function --function-name "${OVERRIDE_FN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${OVERRIDE_FN} still exists after destroy" >&2
  exit 1
fi
if aws lambda get-function --function-name "${TRANSITION_FN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${TRANSITION_FN} still exists after destroy" >&2
  exit 1
fi
echo "    OK: both Lambda probes are gone"

if aws s3 ls "s3://${STATE_BUCKET}/${OVERRIDE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: OverrideStack state file still exists after destroy" >&2
  exit 1
fi
if aws s3 ls "s3://${STATE_BUCKET}/${TRANSITION_KEY}" >/dev/null 2>&1; then
  echo "FAIL: TransitionStack state file still exists after destroy" >&2
  exit 1
fi
echo "    OK: both state files are gone"

echo ""
echo "==> cc-api-fallback-transitions test passed (#634 items 3 + 4 verified end-to-end)"
