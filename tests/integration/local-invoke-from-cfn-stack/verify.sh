#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke --from-cfn-stack`
# (issue #606).
#
# Why this exists: the existing `local-invoke-from-state` integ exercises
# the cdkd-deployed path (cdkd deploy + cdkd state read). Issue #606 adds
# a parallel path for CDK apps deployed via the upstream CDK CLI (cdk
# deploy → CloudFormation). The only way to exercise that round-trip is
# to deploy the fixture via `cdk deploy` (NOT `cdkd deploy`) and then
# invoke locally with `--from-cfn-stack`, which reads physical IDs via
# `cloudformation:DescribeStackResources` instead of cdkd's S3 state.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdk deploy CdkdLocalInvokeFromCfnStackFixture (upstream CDK CLI)
#   3. baseline: cdkd local invoke (no --from-cfn-stack) — assert
#      TABLE_NAME comes through as "unset" (env var dropped because it's
#      intrinsic-valued and the default behavior warns + drops).
#   4. issue #606: cdkd local invoke --from-cfn-stack — assert TABLE_NAME
#      is the actual deployed DynamoDB table name, and STATIC_VALUE still
#      passes through unchanged.
#   5. issue #3240: the same invoke under a NO-permission --role-arn, with
#      the caller's credentials as a static env triple — assert TABLE_NAME
#      still resolves (the stack is read as the caller, not the role).
#   6. cdk destroy --force (NOT cdkd destroy — the fixture lives in CFn)
#
# Run via `/run-integ local-invoke-from-cfn-stack` (recommended) or directly:
#
#     bash tests/integration/local-invoke-from-cfn-stack/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account. The `cdk` (aws-cdk) CLI comes from this fixture's own
# devDependencies (node_modules/.bin is prepended to PATH below) so a
# stale global CLI can't hit a cloud-assembly schema-version mismatch
# against the freshly-installed aws-cdk-lib.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeFromCfnStackFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-cfn-stack"
CLI="node ${REPO_ROOT}/dist/cli.js"
# Vendored cdk CLI: install the fixture's deps when absent (node_modules is
# gitignored, and the repo-root pnpm install does NOT populate fixture dirs),
# otherwise the PATH prepend is inert and `cdk` falls through to a possibly
# stale global CLI.
[ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"

echo "[verify] region=${REGION} stack=${STACK} (CloudFormation-deployed)"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

# Gate the cleanup trap on a "we created the stack" sentinel. Without
# this guard, the EXIT trap would fire on the pre-flight orphan scan's
# `exit 1` (when a same-named stack pre-exists in the user's account)
# and run `cdk destroy` on a stack we did NOT create, silently deleting
# user resources. The sentinel is set only after `cdk deploy` succeeds.
WE_CREATED_STACK=0
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ] && [ "${WE_CREATED_STACK}" -eq 1 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cdk destroy to clean up"
    (cd "${TEST_DIR}" && cdk destroy "${STACK}" --force --region "${REGION}" \
      --no-version-reporting --no-asset-metadata --no-path-metadata) || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists in CloudFormation — clean up first via:"
  echo "          aws cloudformation delete-stack --stack-name ${STACK} --region ${REGION}"
  exit 1
fi

echo "[verify] step 3: cdk deploy (upstream CDK CLI, NOT cdkd)"
# The fixture deliberately uses upstream `cdk deploy` so the resulting
# stack is owned by CloudFormation, not cdkd. The cdk CLI is the fixture's
# own vendored devDependency (node_modules/.bin was prepended to PATH
# above) so it always matches the freshly-installed aws-cdk-lib.
# Set the sentinel BEFORE `cdk deploy` rather than after — pre-flight
# has already verified the namespace is clean, so once we issue the
# deploy command we OWN the namespace (cdk destroy is a no-op on
# stacks that never reached AWS, so this is safe even on early-failure
# paths). Mirrors the matching fix in
# `tests/integration/local-invoke-from-cfn-stack-multi-stack/verify.sh`.
WE_CREATED_STACK=1
cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}"
echo "[verify] step 3 ok: cdk deploy completed"

echo "[verify] step 4: read the deployed DynamoDB table name from CloudFormation"
DEPLOYED_TABLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK}" \
  --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::DynamoDB::Table`].PhysicalResourceId | [0]' \
  --output text)
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
if [ -z "${DEPLOYED_TABLE}" ] || [ "${DEPLOYED_TABLE}" = "None" ]; then
  echo "[verify] FAIL: could not read deployed table name from CloudFormation"
  exit 1
fi

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  local err
  err="$(mktemp)"
  while [ $i -le $attempts ]; do
    if out=$(${CLI} local invoke "${args[@]}" 2>"${err}" | tail -1) && \
       echo "${out}" | grep -q '"tableName":'; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed (last stdout line: ${out}); stderr tail:" >&2
      tail -5 "${err}" >&2
      echo "[verify]   retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed (last stdout line: ${out}); last attempt's stderr below:" >&2
  tail -20 "${err}" >&2
  rm -f "${err}"
  return 1
}

echo "[verify] step 5: cdkd local invoke (no --from-cfn-stack) — expect TABLE_NAME=unset"
RESULT_BASELINE=$(invoke_with_retry "${STACK}/EchoTableHandler" --no-pull)
echo "[verify]   response: ${RESULT_BASELINE}"
echo "${RESULT_BASELINE}" | grep -q '"tableName":"unset"' || {
  echo "[verify] FAIL: expected TABLE_NAME to be dropped (default warn-and-drop), got: ${RESULT_BASELINE}"
  exit 1
}
echo "${RESULT_BASELINE}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in baseline response, got: ${RESULT_BASELINE}"
  exit 1
}

echo "[verify] step 6: cdkd local invoke --from-cfn-stack — expect TABLE_NAME=${DEPLOYED_TABLE}"
# Bare --from-cfn-stack uses the cdkd stack name verbatim as the CFn
# stack name — which matches here because the CDK app exports the same
# name to both.
RESULT_FROM_CFN=$(invoke_with_retry "${STACK}/EchoTableHandler" --from-cfn-stack --no-pull)
echo "[verify]   response: ${RESULT_FROM_CFN}"
echo "${RESULT_FROM_CFN}" | grep -q "\"tableName\":\"${DEPLOYED_TABLE}\"" || {
  echo "[verify] FAIL: expected TABLE_NAME=${DEPLOYED_TABLE}, got: ${RESULT_FROM_CFN}"
  exit 1
}
echo "${RESULT_FROM_CFN}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-cfn-stack, got: ${RESULT_FROM_CFN}"
  exit 1
}

echo "[verify] step 7: --from-cfn-stack under a no-permission --role-arn reads the stack as the CALLER (issue #3240)"
# The role has no permissions. Before #3240 the --from-cfn-stack reader ran as
# it, ListStackResources failed with AccessDenied and TABLE_NAME was dropped;
# now the reader uses the caller's own credentials. The caller's identity is
# handed over as a STATIC env triple with AWS_PROFILE unset, because an
# exported AWS_PROFILE made the pre-fix reader resolve the caller too and the
# step would pass on both trees. Credentials live only in shell variables and
# in the environment of the subshell that runs cdkd: nothing is written to a
# file and nothing is echoed.
ROLE_ARN=$(aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='NoPermissionRoleArn'].OutputValue | [0]" --output text)
echo "[verify]   no-permission role: ${ROLE_ARN}"
case "${ROLE_ARN}" in
  arn:aws*:iam::*:role/*) ;;
  *) echo "[verify] FAIL: could not read the NoPermissionRoleArn output (got '${ROLE_ARN}')"; exit 1 ;;
esac

CALLER_ENV=$(aws configure export-credentials --format env-no-export) || {
  echo "[verify] FAIL: aws configure export-credentials failed (AWS CLI v2.9+ and resolvable credentials are required)"
  exit 1
}
CALLER_AKID=$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_ACCESS_KEY_ID"{print substr($0,length($1)+2)}')
CALLER_SECRET=$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_SECRET_ACCESS_KEY"{print substr($0,length($1)+2)}')
CALLER_TOKEN=$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_SESSION_TOKEN"{print substr($0,length($1)+2)}')
unset CALLER_ENV
if [ -z "${CALLER_AKID}" ] || [ -z "${CALLER_SECRET}" ]; then
  echo "[verify] FAIL: aws configure export-credentials returned no static credentials for the caller"
  exit 1
fi

# Run a command as the caller's static identity, in a subshell so nothing
# leaks into this shell's environment.
run_as_caller() {
  (
    unset AWS_PROFILE
    export AWS_ACCESS_KEY_ID="${CALLER_AKID}" AWS_SECRET_ACCESS_KEY="${CALLER_SECRET}"
    if [ -n "${CALLER_TOKEN}" ]; then export AWS_SESSION_TOKEN="${CALLER_TOKEN}"; else unset AWS_SESSION_TOKEN; fi
    "$@"
  )
}

# Premise guard: the role must really be unable to read the stack, or a green
# below proves nothing. IAM propagation can lag the deploy, so the assume is
# retried; the denial itself must be a measured AccessDenied.
ROLE_CREDS=""
for _ in $(seq 1 12); do
  ROLE_CREDS=$(run_as_caller aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkd-integ-3240 \
    --region "${REGION}" \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null) && break
  ROLE_CREDS=""
  sleep 5
done
if [ -z "${ROLE_CREDS}" ]; then
  echo "[verify] FAIL: could not assume ${ROLE_ARN} within 60s"
  exit 1
fi
# Exported inside a subshell rather than passed through `env`, whose argv would
# show the keys to `ps`; split with `set --` rather than a here-string, which
# bash 3.2 backs with a temp file.
DENIED=$(
  # shellcheck disable=SC2086 # split the three tab-separated fields on purpose
  set -- ${ROLE_CREDS}
  unset AWS_PROFILE
  export AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3"
  aws cloudformation list-stack-resources --stack-name "${STACK}" --region "${REGION}" 2>&1 >/dev/null || true
)
unset ROLE_CREDS
echo "${DENIED}" | grep -q 'AccessDenied' || {
  echo "[verify] FAIL: premise broken: the no-permission role was not denied ListStackResources (got: ${DENIED})"
  exit 1
}
echo "[verify]   premise ok: the role is denied ListStackResources"

ROLE_ERR="$(mktemp)"
RESULT_ROLE=""
for attempt in 1 2 3; do
  # shellcheck disable=SC2086 # CLI is "node <path>", split on purpose
  RESULT_ROLE=$(run_as_caller ${CLI} local invoke "${STACK}/EchoTableHandler" \
    --from-cfn-stack --no-pull --role-arn "${ROLE_ARN}" 2>"${ROLE_ERR}" | tail -1) || true
  echo "${RESULT_ROLE}" | grep -q '"tableName":' && break
  echo "[verify]   invoke attempt ${attempt} returned no payload; stderr tail:" >&2
  tail -5 "${ROLE_ERR}" >&2
  sleep 2
done
unset CALLER_AKID CALLER_SECRET CALLER_TOKEN
echo "[verify]   response: ${RESULT_ROLE}"
if ! echo "${RESULT_ROLE}" | grep -q "\"tableName\":\"${DEPLOYED_TABLE}\""; then
  if grep -q 'ListStackResources.*AccessDenied\|AccessDenied.*ListStackResources' "${ROLE_ERR}"; then
    echo "[verify] FAIL (#3240): --from-cfn-stack read the stack AS THE --role-arn ROLE (ListStackResources AccessDenied); expected the caller's identity"
  else
    echo "[verify] FAIL: expected TABLE_NAME=${DEPLOYED_TABLE} under --role-arn, got: ${RESULT_ROLE}"
  fi
  tail -20 "${ROLE_ERR}"
  rm -f "${ROLE_ERR}"
  exit 1
fi
# Guard against a vacuous pass: if `--role-arn` were silently ignored, the
# stack would also read as the caller and TABLE_NAME would match on BOTH trees.
# cdkd prints this line only after its own AssumeRole succeeded.
if ! awk -v arn="${ROLE_ARN}" 'index($0, "Assumed role ") && index($0, arn) { found = 1 } END { exit !found }' "${ROLE_ERR}"; then
  echo "[verify] FAIL: cdkd did not report assuming ${ROLE_ARN}; --role-arn may have been ignored"
  tail -20 "${ROLE_ERR}"
  rm -f "${ROLE_ERR}"
  exit 1
fi
rm -f "${ROLE_ERR}"
echo "[verify] step 7 ok: the stack was read as the caller under a no-permission --role-arn"

echo "[verify] step 8: cdk destroy --force"
cdk destroy "${STACK}" --force --region "${REGION}" \
  --no-version-reporting --no-asset-metadata --no-path-metadata

echo ""
echo "[verify] All checks passed: --from-cfn-stack substituted TABLE_NAME with the deployed table name."
