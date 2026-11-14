#!/usr/bin/env bash
# verify.sh — cdkd auto-named SSM parameter read through grantRead (#6272).
#
# An `ssm.StringParameter` without `parameterName` was created by cdkd as
# `/<stack>-<logicalId>-<suffix>`, and Ref returned that name. CDK builds the
# grant's resource as `arn:...:parameter/` + Ref, so the function's role was
# granted `parameter//<name>` and its GetParameter was denied. CloudFormation
# names such a parameter without a leading slash, which CDK assumes.
#
# go-to-k/cdkd#6274: a record written before #6272 keeps `/<name>`; the next
# deploy re-spells it `<name>` (SSM stores a one-level `/x` as `x`, so it is
# the same parameter) and updates every dependent holding the old Ref.
#
# Phases:
#   0. Deploy with the previous release (@cdkd/cli@${OLD_CDKD_VERSION}), which
#      still generates `/<name>`: the pre-fix record.
#   1. Redeploy with this build. The record is re-spelled `<name>`, and the
#      function's PARAM_NAME and the Ref output follow it.
#   2. Functional: invoking the function reads the value (not AccessDenied),
#      and the parameter name has no leading slash.
#   3. Destroy + assert the parameter, the function and the state are gone.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdSsmGeneratedNameGrantExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPECTED_VALUE="cdkd-6272-value"
# The last release that generates `/<name>` (go-to-k/cdkd#6272 shipped after it).
OLD_CDKD_VERSION="0.350.2"
OLD_TMPDIR=""
DEPLOY_LOG=""

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

FUNCTION_NAME=""
PARAM_NAME=""
INVOKE_OUT="$(mktemp)"

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdSsmGeneratedNameGrant?*)
      # The generated name is known only after a deploy: sweep by the stack
      # prefix it starts with (either spelling, `/` included, reads as one name).
      for p in $(aws ssm describe-parameters --region "${REGION}" \
        --parameter-filters "Key=Name,Option=BeginsWith,Values=${STACK}-" \
        --query 'Parameters[].Name' --output text 2>/dev/null); do
        aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      sweep_log_groups
      ;;
    *) echo "    WARN: teardown sweep refused a stack scope outside CdkdSsmGeneratedNameGrant*: '${STACK:-<empty>}'" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${INVOKE_OUT}"
  if [ -n "${DEPLOY_LOG:-}" ]; then
    rm -f "${DEPLOY_LOG}"
  fi
  if [ -n "${OLD_TMPDIR:-}" ] && [ -d "${OLD_TMPDIR}" ]; then
    rm -rf "${OLD_TMPDIR}"
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
INVOKE_OUT="$(mktemp)"

echo "==> Installing the previous release (@cdkd/cli@${OLD_CDKD_VERSION})"
OLD_TMPDIR="$(mktemp -d)"
(cd "${OLD_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@cdkd/cli@${OLD_CDKD_VERSION}" >/dev/null)
OLD_BIN="${OLD_TMPDIR}/node_modules/@cdkd/cli/dist/cli.js"
if [ ! -f "${OLD_BIN}" ]; then
  echo "FAIL: the previous release was not installed at ${OLD_BIN}" >&2
  exit 1
fi
OLD_REPORTED="$(node "${OLD_BIN}" --version)"
case "${OLD_REPORTED}" in
  *"${OLD_CDKD_VERSION}"*) ;;
  *)
    echo "FAIL: the installed old binary reports '${OLD_REPORTED}', not ${OLD_CDKD_VERSION}" >&2
    exit 1
    ;;
esac

# --- Phase 0: the pre-fix record ---------------------------------------
echo "==> Phase 0: deploy with @cdkd/cli@${OLD_CDKD_VERSION} (generates /<name>)"
node "${OLD_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
OLD_PARAM_NAME="$(jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SSM::Parameter") | .value.physicalId // empty' <<<"${STATE}")"
case "${OLD_PARAM_NAME}" in
  /*/*|"")
    echo "FAIL: premise: the previous release recorded '${OLD_PARAM_NAME}', not a one-level /<name>" >&2
    exit 1
    ;;
  /*) echo "    OK: premise: the previous release recorded ${OLD_PARAM_NAME}" ;;
  *)
    echo "FAIL: premise: the previous release recorded '${OLD_PARAM_NAME}' without a leading slash" >&2
    exit 1
    ;;
esac
OLD_FUNCTION_NAME="$(jq -r '.outputs.FunctionName // empty' <<<"${STATE}")"
OLD_ENV="$(aws lambda get-function-configuration --function-name "${OLD_FUNCTION_NAME}" --region "${REGION}" \
  --query 'Environment.Variables.PARAM_NAME' --output text)"
if [ "${OLD_ENV}" != "${OLD_PARAM_NAME}" ]; then
  echo "FAIL: premise: the function's PARAM_NAME '${OLD_ENV}' is not the recorded '${OLD_PARAM_NAME}'" >&2
  exit 1
fi
# The #6272 symptom itself: the grant's recorded policy names parameter//<name>.
grant_names_double_slash() {
  jq -e '[.resources[] | select(.resourceType == "AWS::IAM::Policy") | .properties.PolicyDocument | tostring | contains("parameter//")] | any' <<<"$1" >/dev/null
}
if ! grant_names_double_slash "${STATE}"; then
  echo "FAIL: premise: the previous release's grant policy does not name parameter//<name>" >&2
  exit 1
fi
echo "    OK: premise: the previous release's grant names parameter//<name>"

# --- Phase 1: redeploy with this build ---------------------------------
echo "==> Phase 1: redeploy with this build (re-spells the record, #6274)"
DEPLOY_LOG="$(mktemp)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
if ! grep -q 'go-to-k/cdkd#6274' "${DEPLOY_LOG}"; then
  echo "FAIL: the redeploy did not report re-spelling ${OLD_PARAM_NAME} (#6274)" >&2
  exit 1
fi

STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
FUNCTION_NAME="$(jq -r '.outputs.FunctionName // empty' <<<"${STATE}")"
PARAM_NAME="$(jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SSM::Parameter") | .value.physicalId // empty' <<<"${STATE}")"
if [ -z "${FUNCTION_NAME}" ] || [ -z "${PARAM_NAME}" ]; then
  echo "FAIL: could not resolve the function name / parameter physical id after deploy" >&2
  exit 1
fi
echo "    function:  ${FUNCTION_NAME}"
echo "    parameter: ${PARAM_NAME}"
if [ "${PARAM_NAME}" != "${OLD_PARAM_NAME#/}" ]; then
  echo "FAIL: the record holds '${PARAM_NAME}', not ${OLD_PARAM_NAME} re-spelled without its slash (#6274)" >&2
  exit 1
fi
ENV_NAME="$(aws lambda get-function-configuration --function-name "${FUNCTION_NAME}" --region "${REGION}" \
  --query 'Environment.Variables.PARAM_NAME' --output text)"
if [ "${ENV_NAME}" != "${PARAM_NAME}" ]; then
  echo "FAIL: the function's PARAM_NAME '${ENV_NAME}' did not follow the re-spelled Ref '${PARAM_NAME}' (#6274)" >&2
  exit 1
fi
if grant_names_double_slash "${STATE}"; then
  echo "FAIL: the grant policy still names parameter//<name> after the redeploy (#6274)" >&2
  exit 1
fi
echo "    OK: the record, the grant policy and the function's PARAM_NAME now read ${PARAM_NAME}"

echo "==> Phase 1b: redeploy again: the record is settled, nothing to re-spell"
: > "${DEPLOY_LOG}"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
if grep -q 'go-to-k/cdkd#6274' "${DEPLOY_LOG}"; then
  echo "FAIL: the settled record was re-spelled again (#6274)" >&2
  exit 1
fi
if ! grep -q 'No changes detected' "${DEPLOY_LOG}"; then
  echo "FAIL: the redeploy after the re-spelling still changed something" >&2
  exit 1
fi
echo "    OK: no change on the next deploy"

# --- Phase 2: functional ----------------------------------------------
echo "==> Phase 2: the function reads its auto-named parameter through grantRead"
OUTPUT_NAME="$(jq -r '.outputs.ParameterName // empty' <<<"${STATE}")"
if [ "${OUTPUT_NAME}" != "${PARAM_NAME}" ]; then
  echo "FAIL: the ParameterName output (Ref) '${OUTPUT_NAME}' is not the physical id '${PARAM_NAME}'" >&2
  exit 1
fi

# A new role's inline policy can take a few seconds to apply: retry an
# AccessDenied for about a minute before calling it the #6272 grant.
BODY=""
for attempt in 1 2 3 4 5 6 7; do
  STATUS="$(aws lambda invoke --function-name "${FUNCTION_NAME}" --region "${REGION}" \
    --cli-binary-format raw-in-base64-out "${INVOKE_OUT}" --query 'StatusCode' --output text)" \
    || { echo "FAIL: aws lambda invoke ${FUNCTION_NAME} failed" >&2; exit 1; }
  if [ "${STATUS}" != "200" ]; then
    echo "FAIL: invoke returned StatusCode ${STATUS}, expected 200" >&2
    exit 1
  fi
  BODY="$(cat "${INVOKE_OUT}")"
  if ! grep -q 'AccessDenied' <<<"${BODY}"; then
    break
  fi
  echo "    attempt ${attempt}: AccessDenied, retrying in 10s"
  sleep 10
done
if [ "$(jq -r '.ok // empty' <<<"${BODY}")" != "${EXPECTED_VALUE}" ]; then
  echo "FAIL: the function did not read its parameter through grantRead (#6272); got: ${BODY}" >&2
  exit 1
fi
echo "    OK: the function read '${EXPECTED_VALUE}'"
case "${PARAM_NAME}" in
  /*)
    echo "FAIL: the generated parameter name '${PARAM_NAME}' starts with '/' (#6272): CDK grants parameter//<name>" >&2
    exit 1
    ;;
esac
echo "    OK: the generated name has no leading slash"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
echo "    OK: parameter is gone"

assert_gone "function ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
echo "    OK: function is gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cdkd state removed"

sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS — an auto-named SSM parameter the previous release named /<name> is re-spelled <name> on redeploy, and its grantRead lets the function read it, all 4 phases passed"
