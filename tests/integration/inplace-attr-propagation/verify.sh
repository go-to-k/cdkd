#!/usr/bin/env bash
# verify.sh — cdkd in-place upstream-attribute propagation integ.
#
# `Derived`'s value embeds `Fn::GetAtt[Base, Value]`. When `Base` is updated IN
# PLACE (its Value changes, same physical id), CloudFormation re-evaluates and
# updates `Derived`. cdkd previously resolved the GetAtt against the CURRENT state
# at diff time, so `Derived` compared equal (NO_CHANGE) and never re-provisioned
# -> it kept the STALE upstream value. This test proves cdkd now propagates the
# change to the dependent in the SAME deploy.
#
# Phases:
#   1. Deploy Base=world; assert Derived = "hello-world".
#   2. Re-deploy with CDKD_TEST_UPDATE=true (Base=world2). Assert Derived becomes
#      "hello-world2" (a pre-fix run leaves it "hello-world").
#   3. Destroy; assert both params are gone and the state file is removed.
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

STACK="CdkdInplaceAttrPropagationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
BASE="/${STACK}/base"
DERIVED="/${STACK}/derived"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

param() {
  aws ssm get-parameter --name "$1" --region "${REGION}" --query 'Parameter.Value' --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${BASE}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${DERIVED}" --region "${REGION}" >/dev/null 2>&1
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

# --- Phase 1: deploy Base=world ---------------------------------------
echo "==> Phase 1: deploy Base=world"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

D1="$(param "${DERIVED}")"
if [ "${D1}" != "hello-world" ]; then
  echo "FAIL: expected Derived=hello-world after Phase 1, got '${D1}'" >&2; exit 1
fi
echo "    Derived = ${D1}"

# --- Phase 2: in-place Base change -> Derived must propagate ----------
echo "==> Phase 2: re-deploy Base=world2 (Derived must propagate to hello-world2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

B2="$(param "${BASE}")"
D2="$(param "${DERIVED}")"
if [ "${B2}" != "world2" ]; then
  echo "FAIL: expected Base=world2 after Phase 2, got '${B2}'" >&2; exit 1
fi
if [ "${D2}" != "hello-world2" ]; then
  echo "FAIL: expected Derived=hello-world2 after Phase 2, got '${D2}' (in-place upstream change not propagated)" >&2
  exit 1
fi
echo "    Base = ${B2}, Derived = ${D2} (propagation confirmed)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "${BASE} still exists after destroy" aws ssm get-parameter --name "${BASE}" --region "${REGION}"
assert_gone "${DERIVED} still exists after destroy" aws ssm get-parameter --name "${DERIVED}" --region "${REGION}"
echo "    both parameters deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — in-place upstream-attribute propagation, all 3 phases passed"
