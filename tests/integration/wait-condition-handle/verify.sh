#!/usr/bin/env bash
# verify.sh — cdkd WaitConditionHandle no-op provider integ (issue #1020).
# A stack carrying a bare AWS::CloudFormation::WaitConditionHandle failed
# cdkd's pre-flight ("not supported by Cloud Control API and no SDK provider
# is registered") — the type is emitted by cdk-multi-region-stack as an
# empty-template placeholder. Phases: deploy (pre-flight must pass, handle
# gets a placeholder physical id, Ref resolves into the output) -> UPDATE
# (sibling SSM param changes; handle physical id must be stable) -> destroy.

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

STACK="CdkdWaitConditionHandleExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM="/${STACK}/param"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
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

echo "==> Phase 1: Deploy (bare WaitConditionHandle — the #1020 pre-flight path)"
env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VAL=$(aws ssm get-parameter --name "${PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
[ "${VAL}" = "base" ] || { echo "FAIL: SSM param is '${VAL}'" >&2; exit 1; }
echo "    OK: sibling SSM parameter deployed (${VAL})"

STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
HANDLE_ID=$(printf '%s' "${STATE_JSON}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    const r = Object.values(s.resources).find(
      (x) => x.resourceType === "AWS::CloudFormation::WaitConditionHandle"
    );
    process.stdout.write(r ? r.physicalId : "");
  });')
case "${HANDLE_ID}" in
  cdkd-wait-condition-handle-*) echo "    OK: handle in state with placeholder id (${HANDLE_ID})" ;;
  *) echo "FAIL: handle physical id is '${HANDLE_ID}'" >&2; exit 1 ;;
esac
OUTPUT_REF=$(printf '%s' "${STATE_JSON}" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    process.stdout.write(s.outputs?.HandleRef ?? "");
  });')
[ "${OUTPUT_REF}" = "${HANDLE_ID}" ] \
  || { echo "FAIL: HandleRef output is '${OUTPUT_REF}', expected '${HANDLE_ID}'" >&2; exit 1; }
echo "    OK: Ref on the handle resolved into the stack output"

echo "==> Phase 2: UPDATE (SSM param base -> updated; handle must be untouched)"
CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

VAL=$(aws ssm get-parameter --name "${PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
[ "${VAL}" = "updated" ] || { echo "FAIL: updated SSM param is '${VAL}'" >&2; exit 1; }
echo "    OK: sibling update deployed (${VAL})"

HANDLE_ID2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => {
    const s = JSON.parse(d);
    const r = Object.values(s.resources).find(
      (x) => x.resourceType === "AWS::CloudFormation::WaitConditionHandle"
    );
    process.stdout.write(r ? r.physicalId : "");
  });')
[ "${HANDLE_ID2}" = "${HANDLE_ID}" ] \
  || { echo "FAIL: handle physical id changed on update (${HANDLE_ID} -> ${HANDLE_ID2})" >&2; exit 1; }
echo "    OK: handle physical id stable across update"

echo "==> Phase 3: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "SSM param still exists after destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
echo "    OK: SSM param gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> wait-condition-handle test passed"
