#!/usr/bin/env bash
# verify.sh — ALB integ + ListenerAttributes backfill assertion (#609)
#
# Deploys the ALB stack (VPC + ALB + TargetGroup + Listener), asserts the
# Listener's `routing.http.response.server.enabled` attribute the fixture sets
# via the L1 escape hatch actually reached AWS (cdkd applies it through a
# post-create ModifyListenerAttributes call), then destroys and verifies clean.
#
# Run via: /run-integ alb
#         or: bash tests/integration/alb/verify.sh

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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STACK="AlbStack"
STATE_KEY="cdkd/${STACK}/${AWS_REGION}/state.json"
EXPECTED_ATTR_KEY="routing.http.response.server.enabled"
EXPECTED_ATTR_VAL="false"

cleanup() {
  local rc=$?
  echo ""
  echo "==> Cleanup (errors tolerated)"
  ${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "==> Pre-flight orphan scan"
aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 && {
  echo "FAIL: state ${STATE_KEY} already exists — clean up first."
  exit 1
} || true

echo ""
echo "==> Deploy ${STACK}"
${CDKD} deploy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"

echo ""
echo "==> Assert ListenerAttributes reached AWS (#609 backfill)"
# Resolve the Listener ARN from cdkd state (the Listener physicalId IS its ARN).
STATE_BODY=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
LISTENER_ARN=$(echo "${STATE_BODY}" | python3 -c '
import sys, json
s = json.load(sys.stdin)
for v in s["resources"].values():
    if v["resourceType"] == "AWS::ElasticLoadBalancingV2::Listener":
        print(v["physicalId"]); break
')
if [[ -z "${LISTENER_ARN}" ]]; then
  echo "FAIL: could not find Listener ARN in cdkd state"
  exit 1
fi
echo "    listener: ${LISTENER_ARN}"

ATTR_VAL=$(aws elbv2 describe-listener-attributes --listener-arn "${LISTENER_ARN}" --region "${AWS_REGION}" \
  --query "Attributes[?Key=='${EXPECTED_ATTR_KEY}'].Value | [0]" --output text 2>/dev/null)
if [[ "${ATTR_VAL}" != "${EXPECTED_ATTR_VAL}" ]]; then
  echo "FAIL: listener attribute ${EXPECTED_ATTR_KEY} is '${ATTR_VAL}', expected '${EXPECTED_ATTR_VAL}'"
  echo "    (this is the #609 ListenerAttributes backfill — a wrong/missing value means the post-create ModifyListenerAttributes did not apply)"
  exit 1
fi
echo "    ${EXPECTED_ATTR_KEY}=${ATTR_VAL} reached AWS (✓)"

echo ""
echo "==> Destroy ${STACK}"
${CDKD} destroy ${STACK} --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "==> Final cleanup verification"
assert_gone "state ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed (✓)"

echo ""
echo "==> All alb checks passed (incl. #609 ListenerAttributes backfill assertion)"
trap - EXIT INT TERM
