#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt unknown-attribute ARN-shape guard (issue #1106)
# + --strict-getatt / deploy-summary fallback line (issue #1111).
# ERROR-PATH fixture, three phases:
#   1. `Fn::GetAtt [Probe, BogusArn]` on AWS::SSM::Parameter reaches the
#      resolver's unknown-attribute fallback, where the physicalId (the
#      parameter NAME) is not ARN-shaped — the deploy must FAIL with the
#      actionable guard error instead of shipping the wrong value.
#   2. GUARD_PHASE=warn switches the bogus attribute to `BogusName` (a
#      non-Arn suffix that default mode warn-passes); with --strict-getatt
#      the deploy must FAIL on the promoted fallback error.
#   3. Same warn shape WITHOUT the flag: the deploy must SUCCEED, warn
#      "Unknown attribute BogusName", and print the one-line deploy-summary
#      fallback count pointing at --strict-getatt.
# The bogus GetAtt is a RESOURCE property (a second parameter's Value), not
# an Output, because output-resolution failures are warn-and-continue in
# default mode and would not make the deploy exit non-zero.
# Asserts: per-phase exit codes + messages, then destroy / direct-cleanup
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

# --- Phase 2 (issue #1111): --strict-getatt promotes a warn-path fallback ----
# GUARD_PHASE=warn switches the bogus attribute to `BogusName`, whose
# physicalId fallback default mode accepts with a warning; --strict-getatt
# must reject it and fail the deploy.
echo "==> Deploy --strict-getatt on the warn-shape attribute (EXPECTED to fail)"
STRICT_RC=0
STRICT_OUT="$(GUARD_PHASE=warn node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --strict-getatt --yes 2>&1)" || STRICT_RC=$?
printf '%s\n' "${STRICT_OUT}"
if [ "${STRICT_RC}" -eq 0 ]; then
  echo "FAIL: deploy --strict-getatt exited 0 — the strict fallback promotion did not fire" >&2
  exit 1
fi
for needle in 'Cannot resolve Fn::GetAtt' 'BogusName' '--strict-getatt'; do
  if ! printf '%s' "${STRICT_OUT}" | grep -qF -- "${needle}"; then
    echo "FAIL: strict deploy output lacks message fragment: ${needle}" >&2
    exit 1
  fi
done
echo "    OK: strict deploy failed (rc=${STRICT_RC}) with the promoted fallback error"

# Normalize whatever the failed strict deploy left behind (rollback usually
# removes the Probe + state, but do not rely on it).
STRICT_DESTROY_RC=0
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 || STRICT_DESTROY_RC=$?
if [ "${STRICT_DESTROY_RC}" -ne 0 ]; then
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CONSUMER_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
fi

# --- Phase 3 (issue #1111): default mode warn-passes + summary line ----------
echo "==> Deploy default mode on the warn-shape attribute (EXPECTED to succeed)"
WARN_RC=0
WARN_OUT="$(GUARD_PHASE=warn node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || WARN_RC=$?
printf '%s\n' "${WARN_OUT}"
if [ "${WARN_RC}" -ne 0 ]; then
  echo "FAIL: default-mode deploy of the warn-shape attribute exited ${WARN_RC} (expected success)" >&2
  exit 1
fi
for needle in 'Unknown attribute BogusName' 'fell back to the physical ID' '--strict-getatt'; do
  if ! printf '%s' "${WARN_OUT}" | grep -qF -- "${needle}"; then
    echo "FAIL: default-mode deploy output lacks fragment: ${needle}" >&2
    exit 1
  fi
done
if ! printf '%s' "${WARN_OUT}" | grep -qE '[1-9][0-9]* attribute resolution\(s\) fell back to the physical ID'; then
  echo "FAIL: deploy-summary fallback line missing its non-zero count" >&2
  exit 1
fi
echo "    OK: default deploy succeeded with the warn + deploy-summary fallback line"

echo "==> Destroy (phase 3)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SSM parameter ${PARAM} still exists after phase-3 destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "SSM parameter ${CONSUMER_PARAM} still exists after phase-3 destroy" aws ssm get-parameter --name "${CONSUMER_PARAM}" --region "${REGION}"
assert_gone "state remains after phase-3 destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: phase-3 resources + state gone"
echo ""
echo "[verify] PASS — getatt-fallback-guard: ARN-shape hard-fail, --strict-getatt promotion, and default-mode summary line all verified, cleanup clean"
