#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd import --migrate-from-cloudformation`
# records the `AWS::Lambda::Url` attributes (issue #3624).
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. `cdk deploy` the stack (the existing CloudFormation stack to migrate).
#   3. `cdkd import --migrate-from-cloudformation --yes`.
#   4. Assert: the import printed no "Failed to resolve intrinsics" warning; the
#      Url record carries FunctionUrl / FunctionArn equal to AWS's; UrlParam /
#      ArnParam records hold the resolved values, not the raw Fn::GetAtt.
#   5. `cdkd deploy` (no template change): assert no "Unknown attribute" line.
#   6. `cdkd destroy --force`; assert the function, its role, both parameters
#      and the state file are gone.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-lambda-url-attributes"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportLambdaUrlAttributes"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Captured after `cdk deploy`; empty until then so cleanup can read them under
# `set -u` when it fires earlier.
FN_NAME=""
ROLE_NAME=""
URL_PARAM_NAME=""
ARN_PARAM_NAME=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-lambda-url.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${STACK}"
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  # Retained resources survive a CFn delete after the import's Retain
  # injection, so reap them by the names captured after `cdk deploy`.
  for n in "${URL_PARAM_NAME}" "${ARN_PARAM_NAME}"; do
    [ -n "${n}" ] || continue
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null || true
  done
  if [ -n "${FN_NAME}" ]; then
    aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" 2>/dev/null || true
  fi
  if [ -n "${ROLE_NAME}" ]; then
    for p in $(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${ROLE_NAME}" --policy-arn "${p}" 2>/dev/null || true
    done
    aws iam delete-role --role-name "${ROLE_NAME}" 2>/dev/null || true
  fi
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
(cd "${TEST_DIR}" && { [ -x node_modules/.bin/cdk ] || npm install; })
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
CDK_RESOLVED="$(command -v cdk)"
CDK_VERSION="$(cdk --version)"
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION})"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${STATE_KEY} already exists — clean up first"
  exit 1
fi

echo "[verify] step 3: cdk deploy (the CloudFormation stack to migrate)"
(cd "${TEST_DIR}" && cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")

physical_of() {
  aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
    --query "StackResources[?LogicalResourceId==\`$1\`].PhysicalResourceId" --output text
}
FN_NAME="$(physical_of Fn9270CBC0)"
ROLE_NAME="$(physical_of FnServiceRoleB9001A96)"
URL_PARAM_NAME="$(physical_of UrlParam)"
ARN_PARAM_NAME="$(physical_of ArnParam)"
AWS_FUNCTION_URL="$(aws lambda get-function-url-config --function-name "${FN_NAME}" --region "${REGION}" --query FunctionUrl --output text)"
AWS_FUNCTION_ARN="$(aws lambda get-function-url-config --function-name "${FN_NAME}" --region "${REGION}" --query FunctionArn --output text)"
case "${AWS_FUNCTION_URL}" in
  https://*) ;;
  *) echo "[verify] FAIL: unexpected FunctionUrl from AWS: '${AWS_FUNCTION_URL}'"; exit 1 ;;
esac
echo "[verify] step 3 ok: fn=${FN_NAME} url=${AWS_FUNCTION_URL}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"
if grep -q 'Failed to resolve intrinsics' "${WORK}/import.log"; then
  echo "[verify] FAIL: import left an unresolved intrinsic (issue #3624)"
  exit 1
fi
if grep -q 'Unknown attribute' "${WORK}/import.log"; then
  echo "[verify] FAIL: import fell back to the physical id for a Url attribute (issue #3624)"
  exit 1
fi

echo "[verify] step 5: assert the imported records carry the resolved values"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
python3 - "${WORK}/state.json" "${AWS_FUNCTION_URL}" "${AWS_FUNCTION_ARN}" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
want_url, want_arn = sys.argv[2], sys.argv[3]
res = state["resources"]
checks = [
    ("Url.attributes.FunctionUrl", res["Url"].get("attributes", {}).get("FunctionUrl"), want_url),
    ("Url.attributes.FunctionArn", res["Url"].get("attributes", {}).get("FunctionArn"), want_arn),
    ("UrlParam.properties.Value", res["UrlParam"]["properties"].get("Value"), want_url),
    ("ArnParam.properties.Value", res["ArnParam"]["properties"].get("Value"), want_arn),
]
bad = [f"{name}: got {got!r}, want {want!r}" for name, got, want in checks if got != want]
if bad:
    print("[verify] FAIL:\n  " + "\n  ".join(bad))
    sys.exit(1)
print("[verify] step 5 ok: " + ", ".join(name for name, _, _ in checks))
PY

echo "[verify] step 6: cdkd deploy with an unchanged template"
(cd "${TEST_DIR}" && ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy.log"
if grep -q 'Unknown attribute' "${WORK}/deploy.log"; then
  echo "[verify] FAIL: deploy fell back to the physical id for a Url attribute (issue #3624)"
  exit 1
fi
echo "[verify] step 6 ok"

echo "[verify] step 7: cdkd destroy --force"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "parameter ${URL_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${URL_PARAM_NAME}" --region "${REGION}"
assert_gone "parameter ${ARN_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${ARN_PARAM_NAME}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 7 ok: resources and state gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
