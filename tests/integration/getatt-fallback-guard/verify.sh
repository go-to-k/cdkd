#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt unknown-attribute ARN-shape guard (issue #1106).
# ERROR-PATH fixture: `Fn::GetAtt [Probe, BogusArn]` on AWS::SSM::Parameter
# reaches the resolver's final unknown-attribute fallback, where the
# physicalId (the parameter NAME) is not ARN-shaped — the deploy must FAIL
# with the actionable guard error instead of shipping the wrong value.
# The bogus GetAtt is a RESOURCE property (a second parameter's Value), not
# an Output, because output-resolution failures are warn-and-continue and
# would not make the deploy exit non-zero.
# Asserts: deploy non-zero + guard message, then destroy / direct-cleanup
# fallback, zero leftover parameters, state gone.

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

STACK="CdkdGetattFallbackGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM="${STACK}-param"
CONSUMER_PARAM="${STACK}-param-consumer"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
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

echo "==> Synth"
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null

echo "==> Deploy (EXPECTED to fail on the Fn::GetAtt ARN-shape guard)"
DEPLOY_RC=0
DEPLOY_OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || DEPLOY_RC=$?
printf '%s\n' "${DEPLOY_OUT}"
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: deploy exited 0 — the Fn::GetAtt ARN-shape guard did not fire" >&2
  exit 1
fi
for needle in 'Cannot resolve Fn::GetAtt' 'is not an ARN' 'https://github.com/go-to-k/cdkd/issues'; do
  if ! printf '%s' "${DEPLOY_OUT}" | grep -qF "${needle}"; then
    echo "FAIL: deploy output lacks guard message fragment: ${needle}" >&2
    exit 1
  fi
done
echo "    OK: deploy failed (rc=${DEPLOY_RC}) with the actionable guard error"

echo "==> Destroy"
# Primary path: cdkd destroy against whatever state the failed deploy left
# (the Probe parameter is created before the Consumer's resolution fails;
# with default rollback the deploy may already have deleted it and possibly
# the state file too).
DESTROY_RC=0
DESTROY_OUT="$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)" || DESTROY_RC=$?
printf '%s\n' "${DESTROY_OUT}"
if [ "${DESTROY_RC}" -ne 0 ] || printf '%s' "${DESTROY_OUT}" | grep -qi 'No state found'; then
  echo "    WARN: cdkd destroy had nothing to destroy (or failed); best-effort direct cleanup"
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
fi

assert_gone "SSM parameter ${PARAM} still exists after destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
echo "    OK: probe parameter gone"
assert_gone "SSM parameter ${CONSUMER_PARAM} exists (guard fired too late?)" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
echo "    OK: consumer parameter gone (was never created)"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "[verify] PASS — getatt-fallback-guard: deploy hard-failed on the knowably-wrong ARN fallback, cleanup clean"
