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
#      OptimizationStatus=On for version 1, and invoking the `live` alias
#      returns the v1 greeting.
#   2. Re-deploy with CDKD_TEST_UPDATE=true; assert version 2 exists with
#      SnapStart On, the alias points at 2, version 1 is DELETED, and the
#      alias invoke returns the v2 greeting. (Version numbers are monotonic
#      per function, so "the new version is 2, not 1" also proves the
#      function itself was updated in place, not replaced.)
#   3. Destroy + assert the function is gone, the auto-created log group is
#      swept, and the cdkd state is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail
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
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
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

# --- Phase 1: deploy baseline (version 1) --------------------------------
echo "==> Phase 1: deploy SnapStart function + version 1 + live alias"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

APPLY_ON="$(aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
  --query 'SnapStart.ApplyOn' --output text)"
if [ "${APPLY_ON}" != "PublishedVersions" ]; then
  echo "FAIL: expected SnapStart.ApplyOn=PublishedVersions, got '${APPLY_ON}'" >&2
  exit 1
fi
OPT_V1="$(aws lambda get-function-configuration --function-name "${FN}:1" --region "${REGION}" \
  --query 'SnapStart.OptimizationStatus' --output text)"
if [ "${OPT_V1}" != "On" ]; then
  echo "FAIL: expected version 1 SnapStart OptimizationStatus=On, got '${OPT_V1}'" >&2
  exit 1
fi
ALIAS_V_P1="$(aws lambda get-alias --function-name "${FN}" --name live --region "${REGION}" \
  --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V_P1}" != "1" ]; then
  echo "FAIL: expected alias live -> version 1, got '${ALIAS_V_P1}'" >&2
  exit 1
fi
BODY_P1="$(invoke_alias)"
if ! printf '%s' "${BODY_P1}" | grep -q 'hello-v1'; then
  echo "FAIL: alias invoke expected hello-v1, got: ${BODY_P1}" >&2
  exit 1
fi
echo "    SnapStart on, version 1 optimized, alias serves hello-v1"

# --- Phase 2: env change -> version rotation ------------------------------
echo "==> Phase 2: re-deploy with changed env (new version + alias retarget + old version delete)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

OPT_V2="$(aws lambda get-function-configuration --function-name "${FN}:2" --region "${REGION}" \
  --query 'SnapStart.OptimizationStatus' --output text)"
if [ "${OPT_V2}" != "On" ]; then
  echo "FAIL: expected version 2 SnapStart OptimizationStatus=On, got '${OPT_V2}'" >&2
  exit 1
fi
ALIAS_V_P2="$(aws lambda get-alias --function-name "${FN}" --name live --region "${REGION}" \
  --query 'FunctionVersion' --output text)"
if [ "${ALIAS_V_P2}" != "2" ]; then
  echo "FAIL: expected alias live -> version 2 after update, got '${ALIAS_V_P2}'" >&2
  exit 1
fi
if aws lambda get-function-configuration --function-name "${FN}:1" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: old version 1 still exists after update (should be deleted)" >&2
  exit 1
fi
BODY_P2="$(invoke_alias)"
if ! printf '%s' "${BODY_P2}" | grep -q 'hello-v2'; then
  echo "FAIL: alias invoke expected hello-v2 after update, got: ${BODY_P2}" >&2
  exit 1
fi
echo "    version 2 optimized, alias retargeted, old version deleted, alias serves hello-v2"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws lambda get-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: function ${FN} still exists after destroy" >&2
  exit 1
fi
echo "    function deleted"

# The invoke auto-created the log group; neither CFn nor cdkd deletes it.
aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
echo "    log group swept"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — Lambda SnapStart + Version/Alias rotation deploy/update/destroy, all 3 phases passed"
