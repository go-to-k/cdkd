#!/usr/bin/env bash
# verify.sh — cdkd Cloud Control API fallback transitions integ test
# (#634 items 3 + 4).
#
# Two stacks share the same deploy/destroy cycle to keep the AWS round-trip
# cost down. Both validate real-AWS behaviors that `cc-api-fallback`
# does not cover:
#
#   Stack CdkdCcApiOverride (item 3): deploy with
#     `--allow-unsupported-properties AWS::Lambda::Function:RecursiveLoop`
#     → state stamps `provisionedBy: 'sdk'`, AWS does NOT receive
#     `RecursiveLoop` (silent drop accepted, warn-logged — stays at the
#     `Terminate` default).
#
#   Stack CdkdCcApiTransition (item 4): two-phase deploy that exercises
#     the mid-life SDK→CC re-route path.
#       Phase 1: synth WITHOUT RecursiveLoop (env var unset) → deploy →
#         state stamps `provisionedBy: 'sdk'`.
#       Phase 2: synth WITH RecursiveLoop (env var set) → re-deploy →
#         `getProviderFor` returns CC, state flips to `'cc-api'`, AWS
#         now has `RecursiveLoop=Allow`.
#
# RecursiveLoop is the canonical silent-drop CC-API-fallback example as of
# the #609 LoggingConfig backfill. Default is `Terminate`; the fixtures set
# `Allow` so the read-back is unambiguous.
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

# Read the AWS-side RecursiveLoop setting for a function. Returns the value
# ('Allow' / 'Terminate') or empty when the function is gone. RecursiveLoop
# lives on its own control-plane API (get-function-recursion-config), not on
# get-function-configuration.
recursion_loop() {
  aws lambda get-function-recursion-config \
    --function-name "$1" --region "${REGION}" \
    --query 'RecursiveLoop' --output text 2>/dev/null
}

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
# Item 3: the template emits `RecursiveLoop` but the CLI flag forces the
# SDK route. Expect: state stamps `provisionedBy: 'sdk'`, AWS does NOT
# receive the recursive-loop config (stays at the Terminate default).
echo "==> Phase 1A: deploy ${OVERRIDE_STACK} with --allow-unsupported-properties (item 3 override path)"
node "${LOCAL_DIST}" deploy "${OVERRIDE_STACK}" \
  --allow-unsupported-properties "AWS::Lambda::Function:RecursiveLoop" \
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

# Item 3 assertion 2: AWS does NOT have RecursiveLoop=Allow — the silent
# drop actually dropped. The SDK provider doesn't wire RecursiveLoop, so the
# function stays at the AWS default 'Terminate'.
OVERRIDE_RECURSIVE_LOOP=$(recursion_loop "${OVERRIDE_FN}")
if [ "${OVERRIDE_RECURSIVE_LOOP}" = "Allow" ]; then
  echo "FAIL: OverrideStack Lambda received RecursiveLoop='Allow' — override should have silent-dropped it (expected the 'Terminate' default)" >&2
  exit 1
fi
echo "    OK: OverrideStack Lambda did NOT receive RecursiveLoop=Allow (AWS RecursiveLoop='${OVERRIDE_RECURSIVE_LOOP}' — silent drop honored)"

# --- Phase 1B: deploy TransitionStack baseline (NO RecursiveLoop) ----------
#
# Item 4 stage 1: template has no RecursiveLoop → SDK route → state stamps
# `provisionedBy: 'sdk'`.
echo "==> Phase 1B: deploy ${TRANSITION_STACK} WITHOUT RecursiveLoop (item 4 baseline → SDK route)"
unset CDKD_INTEG_USE_SILENT_DROP
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

# Item 4 baseline AWS check: RecursiveLoop should NOT be Allow yet.
TRANSITION_RECURSIVE_LOOP_1=$(recursion_loop "${TRANSITION_FN}")
if [ "${TRANSITION_RECURSIVE_LOOP_1}" = "Allow" ]; then
  echo "FAIL: TransitionStack Lambda has RecursiveLoop=Allow after baseline deploy — fixture forgot to omit RecursiveLoop" >&2
  exit 1
fi
echo "    OK: TransitionStack Lambda has no RecursiveLoop=Allow on AWS yet (baseline RecursiveLoop='${TRANSITION_RECURSIVE_LOOP_1}')"

# --- Phase 2: re-deploy TransitionStack WITH RecursiveLoop (mid-life flip) -
#
# Item 4 stage 2: env var flips synth to emit RecursiveLoop → diff sees
# the new property → routing returns CC → state flips from 'sdk' to
# 'cc-api' → AWS now has RecursiveLoop=Allow.
echo "==> Phase 2: re-deploy ${TRANSITION_STACK} WITH RecursiveLoop (item 4 mid-life SDK→CC flip)"
export CDKD_INTEG_USE_SILENT_DROP=true
node "${LOCAL_DIST}" deploy "${TRANSITION_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
unset CDKD_INTEG_USE_SILENT_DROP

TRANSITION_STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${TRANSITION_KEY}" - 2>/dev/null)
TRANSITION_PROVISIONED_2=$(echo "${TRANSITION_STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${TRANSITION_PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: TransitionStack Lambda has provisionedBy='${TRANSITION_PROVISIONED_2}' after RecursiveLoop added, expected 'cc-api' (mid-life SDK→CC re-route)" >&2
  echo "${TRANSITION_STATE_2}" | jq .
  exit 1
fi
echo "    OK: TransitionStack Lambda provisionedBy flipped 'sdk' → 'cc-api' (mid-life re-route fired)"

# Item 4 post-flip AWS check: RecursiveLoop should now be Allow (CC forwarded it).
TRANSITION_RECURSIVE_LOOP_2=$(recursion_loop "${TRANSITION_FN}")
if [ "${TRANSITION_RECURSIVE_LOOP_2}" != "Allow" ]; then
  echo "FAIL: TransitionStack Lambda has RecursiveLoop='${TRANSITION_RECURSIVE_LOOP_2}' after CC re-route, expected 'Allow' (CC should have forwarded RecursiveLoop)" >&2
  exit 1
fi
echo "    OK: TransitionStack Lambda RecursiveLoop reached AWS via CC API (RecursiveLoop=Allow)"

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
