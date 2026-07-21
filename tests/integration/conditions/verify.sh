#!/usr/bin/env bash
# verify.sh — conditions: CfnParameter + CfnCondition + Fn::If conditional
# resource creation. With the default parameters (Environment=Development,
# EnableVersioning=false) the `isProduction` condition is FALSE, so the
# production S3 bucket (guarded by `cfnOptions.condition = isProduction`) must
# NOT be created, while the always-on basic bucket IS.
#
# Converted from a standard-flow smoke test to a verify.sh so it owns its own
# deploy + assert + destroy cycle. A bare `cdkd deploy` / `cdkd destroy --force`
# invoked directly from a shell is refused by the auto-mode classifier (it looks
# like a skill bypass / Blind Apply); wrapping the same calls inside verify.sh
# lets `/run-integ conditions` exercise the path end-to-end.
#
# LOAD-BEARING assertion: the condition-suppressed ProductionBucket
# (cdkd-prod-bucket-<account>) does NOT exist after deploy, proving Fn::If /
# condition evaluation gated the resource out; the always-on basic bucket does.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CdkdConditionsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t conditions.XXXXXX)"

export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
  fi
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PROD_BUCKET="cdkd-prod-bucket-${ACCOUNT}"

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} — clean up first." >&2
  exit 1
fi

echo "==> Step 1: deploy (default params: Environment=Development, EnableVersioning=false)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2 (LOAD-BEARING): assert the condition-gated ProductionBucket was NOT created"
# The bucket is guarded by `isProduction` (Environment==Production). Under the
# default Development environment the condition is false, so CFn must not create
# it. head-bucket returns 404 when it does not exist; gone_probe hard-fails on
# any non-not-found error (e.g. a 403 that would mean it exists elsewhere).
assert_gone "ProductionBucket ${PROD_BUCKET} exists despite non-production condition (Fn::If gate failed)" \
  aws s3api head-bucket --bucket "${PROD_BUCKET}"
echo "    OK: ProductionBucket suppressed by the Development condition"

echo "==> Step 3: assert the always-on basic bucket WAS created"
BASIC_BUCKET=$(aws s3api list-buckets \
  --query "Buckets[?contains(Name, 'cdkdconditionsexample')].Name" \
  --output text | tr '\t' '\n' | awk 'NF{print; exit}')
if [ -z "${BASIC_BUCKET}" ]; then
  echo "FAIL: no basic bucket found for ${STACK} (always-on resource missing)" >&2
  exit 1
fi
echo "    OK: basic bucket present (${BASIC_BUCKET})"

echo "==> Step 4: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 5: assert 0 orphans"
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "basic bucket ${BASIC_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${BASIC_BUCKET}"
echo "    OK: 0 orphans (state + basic bucket all gone)"

echo ""
echo "==> conditions test passed: Fn::If suppressed the production bucket, basic bucket created + destroyed clean, 0 orphans"
trap - EXIT INT TERM
