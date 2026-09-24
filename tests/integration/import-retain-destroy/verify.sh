#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd destroy` run right after
# `cdkd import --migrate-from-cloudformation` keeps a `DeletionPolicy: Retain`
# resource (issue #3645).
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. `cdk deploy` the stack (the existing CloudFormation stack to migrate).
#   3. `cdkd import --migrate-from-cloudformation --yes`; assert the `Kept`
#      record carries `deletionPolicy: Retain`.
#   4. `cdkd destroy --force` with NO deploy in between.
#   5. Assert: `Kept` (Retain) is still in AWS, `Gone` is deleted, state gone.
#   6. Delete the retained parameter and assert it is gone.
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
TEST_DIR="${REPO_ROOT}/tests/integration/import-retain-destroy"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportRetainDestroy"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Captured after `cdk deploy`; empty until then so cleanup can read them under
# `set -u` when it fires earlier.
KEPT_NAME=""
GONE_NAME=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-retain-destroy.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

physical_of() {
  aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
    --query "StackResources[?LogicalResourceId==\`$1\`].PhysicalResourceId" --output text
}

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
    # A failure before the names were captured would leave `Kept` (Retain)
    # behind the delete-stack under a CFn-generated name nothing can find
    # later, so take the names now while the stack still lists them.
    [ -n "${KEPT_NAME}" ] || KEPT_NAME="$(physical_of Kept 2>/dev/null)"
    [ -n "${GONE_NAME}" ] || GONE_NAME="$(physical_of Gone 2>/dev/null)"
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  # Both parameters outlive a Retain-injected CFn delete, and `Kept` outlives
  # a correct cdkd destroy by design, so reap them by name.
  for n in "${KEPT_NAME}" "${GONE_NAME}"; do
    [ -n "${n}" ] || continue
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null || true
  done
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
KEPT_NAME="$(physical_of Kept)"
GONE_NAME="$(physical_of Gone)"
echo "[verify] step 3 ok: kept=${KEPT_NAME} gone=${GONE_NAME}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
KEPT_POLICY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["resources"]["Kept"].get("deletionPolicy"))' "${WORK}/state.json")"
# Recorded, not exited on: step 5 then shows what destroy does with the
# record, which is the user-visible consequence.
POLICY_FAILED=0
if [ "${KEPT_POLICY}" != "Retain" ]; then
  echo "[verify] FAIL: imported Kept record has deletionPolicy=${KEPT_POLICY}, want Retain (issue #3645)"
  POLICY_FAILED=1
else
  echo "[verify] step 4 ok: Kept.deletionPolicy=Retain"
fi

echo "[verify] step 5: cdkd destroy --force with no deploy in between"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
if gone_probe aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}"; then
  echo "[verify] FAIL: destroy deleted the DeletionPolicy: Retain parameter ${KEPT_NAME} (issue #3645)"
  exit 1
fi
assert_gone "parameter ${GONE_NAME} still exists after destroy" aws ssm get-parameter --name "${GONE_NAME}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 5 ok: Retain parameter kept, the other deleted, state gone"
[ "${POLICY_FAILED}" = 0 ] || exit 1

echo "[verify] step 6: delete the retained parameter"
aws ssm delete-parameter --name "${KEPT_NAME}" --region "${REGION}"
assert_gone "retained parameter ${KEPT_NAME} still exists after its delete" aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}"
echo "[verify] step 6 ok"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
