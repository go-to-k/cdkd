#!/usr/bin/env bash
# verify.sh — issue #2548: replacing a nested stack must require
# --force-stateful-recreation.
#
# A nested stack's `StackName` is createOnly in the registry schema, and the
# silent-drop narrowing keeps createOnly drops, so adding one (accepted with
# `--prefer-sdk-route AWS::CloudFormation::Stack:StackName`) diffs as a
# REPLACEMENT of the `AWS::CloudFormation::Stack` row. `NestedStackProvider`
# answers a create with the same physical id, and under `--replace` the
# delete-first fallback then destroys EVERY resource in the child stack. The
# deploy must instead refuse before anything is touched.
#
# Phase 1: deploy; record the child parameter's LastModifiedDate.
# Phase 2: add StackName, deploy with the drop accepted AND `--replace`;
#          assert the property-driven stateful refusal, a non-zero exit, and
#          the child parameter untouched.
# Phase 3: destroy; assert the parameter and both state files are gone.

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

STACK="CdkdNestedStackReplaceGuardExample"
CHILD_STACK="${STACK}~Child"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PARAM="/cdkd-integ/nested-stack-replace-guard/param"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  (
    set +eu
    echo "==> Cleanup"
    [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      for s in "${STACK}" "${CHILD_STACK}"; do
        aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/state.json" >/dev/null 2>&1
        aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/lock.json" >/dev/null 2>&1
      done
    fi
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# --- Phase 1: baseline ------------------------------------------------------
echo "==> Phase 1: deploy (no StackName)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BEFORE=$(aws ssm get-parameter --name "${PARAM}" --region "${REGION}" \
  --query 'Parameter.[Value,Version,LastModifiedDate]' --output text)
[ -n "${BEFORE}" ] || { echo "FAIL: child parameter ${PARAM} not readable after deploy" >&2; exit 1; }
echo "    child parameter: ${BEFORE}"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" >/dev/null
echo "    OK: child state ${CHILD_STATE_KEY} exists"

# --- Phase 2: the StackName edit must be refused ----------------------------
echo "==> Phase 2: add StackName, deploy with the drop accepted and --replace; must refuse"
set +e
OUT=$(CDKD_TEST_UPDATE=stackname node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --prefer-sdk-route AWS::CloudFormation::Stack:StackName --replace 2>&1)
RC=$?
set -e
echo "${OUT}"

# Premise sentinels first, so a failure that never reached the guard is
# reported as itself rather than as an issue #2548 regression.
if printf '%s\n' "${OUT}" | grep -q 'uses properties cdkd'; then
  echo "FAIL: premise -- the StackName drop was not accepted, so the diff never ran." >&2
  exit 1
fi
if ! printf '%s\n' "${OUT}" | grep -q 'Deploying stack:'; then
  echo "FAIL: the deploy never reached the stack -- this is NOT a guard result." >&2
  exit 1
fi

# ONE line, from the PROPERTY-DRIVEN guard: the type and `StackName` also
# appear in ordinary plan output, so whole-output greps prove nothing.
GUARD_LINE=$(printf '%s\n' "${OUT}" \
  | grep -m1 'requires replacement (immutable property changed:' || true)
if [ -z "${GUARD_LINE}" ]; then
  if printf '%s\n' "${OUT}" | grep -q 'name-idempotent'; then
    echo "FAIL: the replacement reached the create and the idempotent-create path (issue #2548 regression)" >&2
  elif printf '%s\n' "${OUT}" | grep -q 'but it is a stateful resource'; then
    echo "FAIL: a stateful refusal fired but not the property-driven one this fixture parses" >&2
  else
    echo "FAIL: no property-driven stateful refusal in the output (issue #2548 regression)" >&2
  fi
  exit 1
fi
for NEEDLE in 'Child (AWS::CloudFormation::Stack)' 'StackName' 'but it is a stateful resource' \
              'destroy loses all data in the resource' 'force-stateful-recreation'; do
  case "${GUARD_LINE}" in
    *"${NEEDLE}"*) ;;
    *)
      echo "FAIL: the refusal line does not carry '${NEEDLE}': ${GUARD_LINE}" >&2
      exit 1
      ;;
  esac
done
if [ "${RC}" = "0" ]; then
  echo "FAIL: the refused deploy exited 0 -- the guard printed but did not block" >&2
  exit 1
fi
echo "    OK: refused with rc=${RC}: ${GUARD_LINE}"

AFTER=$(aws ssm get-parameter --name "${PARAM}" --region "${REGION}" \
  --query 'Parameter.[Value,Version,LastModifiedDate]' --output text)
if [ "${AFTER}" != "${BEFORE}" ]; then
  echo "FAIL: the child parameter changed across the refused deploy ('${BEFORE}' -> '${AFTER}') -- the child stack was touched" >&2
  exit 1
fi
echo "    OK: child parameter untouched"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}" >/dev/null
echo "    OK: child state still exists"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "child parameter ${PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "child state file ${CHILD_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
echo "    OK: parameter and both state files gone"

trap - EXIT INT TERM
echo "[verify] PASS — nested-stack replacement refused without --force-stateful-recreation"
