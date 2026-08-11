#!/usr/bin/env bash
# verify.sh — cdkd Lambda SnapStart + Version/Alias rotation integ.
#
# First SnapStart coverage in the integ suite. Asserts the SnapStart config
# reaches AWS (snapshot actually optimized on the published version), then
# re-deploys with a changed env var — which rotates the `fn.currentVersion`
# Version logical id, exercising the function-update -> publish-new-version ->
# alias-retarget -> delete-old-version dependency dance. Confirmed-clean
# /hunt-bugs pattern; regression guard.
#
# Phases:
#   1. Deploy; assert SnapStart ApplyOn=PublishedVersions on the function,
#      OptimizationStatus=On for the published version the `live` alias
#      targets (version N), and invoking the alias returns the v1 greeting.
#      N is read from the alias, NEVER hardcoded: the function name is fixed,
#      and Lambda version counters are monotonic per function NAME and never
#      reset — after any prior run of this fixture the first publish is not
#      ":1" anymore.
#   2. Re-deploy with CDKD_TEST_UPDATE=true; assert the alias now points at
#      version N+1 with SnapStart On, version N is DELETED, and the alias
#      invoke returns the v2 greeting. (The exact +1 increment proves the
#      function was updated in place — a replace would still increment, but
#      the create would have failed on the existing fixed name.)
#   3. Destroy + assert the function is gone, the auto-created log group is
#      swept, and the cdkd state is removed.
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

STACK="CdkdLambdaSnapstartExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="cdkd-integ-snapstart-fn"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, '${STACK}')].RoleName" --output text 2>/dev/null); do
    for parn in $(aws iam list-attached-role-policies --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${role}" --policy-arn "${parn}" >/dev/null 2>&1 || true
    done
    for pname in $(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames[]' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${role}" --policy-name "${pname}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
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

invoke_alias() {
  local out
  out="$(mktemp)"
  aws lambda invoke --function-name "${FN}:live" --region "${REGION}" "${out}" >/dev/null
  cat "${out}"
  rm -f "${out}"
}

# --- Phase 1: deploy baseline (publishes version N) ------------------------
# Lambda version counters are monotonic per function NAME and never reset, so
# the baseline version is whatever the alias says it is — never hardcode ":1"
# (a prior run of this fixture leaves the counter above 1 forever).
echo "==> Phase 1: deploy SnapStart function + published version + live alias"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

APPLY_ON="$(aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
  --query 'SnapStart.ApplyOn' --output text)"
if [ "${APPLY_ON}" != "PublishedVersions" ]; then
  echo "FAIL: expected SnapStart.ApplyOn=PublishedVersions, got '${APPLY_ON}'" >&2
  exit 1
fi
ALIAS_V_P1="$(aws lambda get-alias --function-name "${FN}" --name live --region "${REGION}" \
  --query 'FunctionVersion' --output text)"
case "${ALIAS_V_P1}" in
  ''|*[!0-9]*)
    echo "FAIL: expected alias live -> a numeric published version, got '${ALIAS_V_P1}'" >&2
    exit 1
    ;;
esac
OPT_V1="$(aws lambda get-function-configuration --function-name "${FN}:${ALIAS_V_P1}" --region "${REGION}" \
  --query 'SnapStart.OptimizationStatus' --output text)"
if [ "${OPT_V1}" != "On" ]; then
  echo "FAIL: expected version ${ALIAS_V_P1} SnapStart OptimizationStatus=On, got '${OPT_V1}'" >&2
  exit 1
fi
BODY_P1="$(invoke_alias)"
if ! printf '%s' "${BODY_P1}" | grep -q 'hello-v1'; then
  echo "FAIL: alias invoke expected hello-v1, got: ${BODY_P1}" >&2
  exit 1
fi
echo "    SnapStart on, version ${ALIAS_V_P1} optimized, alias serves hello-v1"

# --- Phase 2: env change -> version rotation ------------------------------
echo "==> Phase 2: re-deploy with changed env (new version + alias retarget + old version delete)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ALIAS_V_P2="$(aws lambda get-alias --function-name "${FN}" --name live --region "${REGION}" \
  --query 'FunctionVersion' --output text)"
EXPECTED_V2="$((ALIAS_V_P1 + 1))"
if [ "${ALIAS_V_P2}" != "${EXPECTED_V2}" ]; then
  echo "FAIL: expected alias live -> version ${EXPECTED_V2} after update, got '${ALIAS_V_P2}'" >&2
  exit 1
fi
OPT_V2="$(aws lambda get-function-configuration --function-name "${FN}:${ALIAS_V_P2}" --region "${REGION}" \
  --query 'SnapStart.OptimizationStatus' --output text)"
if [ "${OPT_V2}" != "On" ]; then
  echo "FAIL: expected version ${ALIAS_V_P2} SnapStart OptimizationStatus=On, got '${OPT_V2}'" >&2
  exit 1
fi
assert_gone "old version ${ALIAS_V_P1} still exists after update (should be deleted)" aws lambda get-function-configuration --function-name "${FN}:${ALIAS_V_P1}" --region "${REGION}"
BODY_P2="$(invoke_alias)"
if ! printf '%s' "${BODY_P2}" | grep -q 'hello-v2'; then
  echo "FAIL: alias invoke expected hello-v2 after update, got: ${BODY_P2}" >&2
  exit 1
fi
echo "    version ${ALIAS_V_P2} optimized, alias retargeted, old version ${ALIAS_V_P1} deleted, alias serves hello-v2"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
echo "    function deleted"

# The invoke auto-created the log group; neither CFn nor cdkd deletes it.
aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
echo "    log group swept"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Lambda SnapStart + Version/Alias rotation deploy/update/destroy, all 3 phases passed"
