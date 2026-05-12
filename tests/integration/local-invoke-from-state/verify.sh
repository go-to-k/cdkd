#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke --from-state`
# (PR 2 of #224).
#
# Why this exists: PR 1's integ (`tests/integration/local-invoke/`) was
# fully local — no AWS deploy. PR 2's `--from-state` reads cdkd's S3
# state for an actually-deployed stack and substitutes intrinsic-valued
# env vars with the deployed physical IDs. The only way to exercise
# that round-trip is to deploy + invoke + destroy against real AWS.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdkd deploy CdkdLocalInvokeFromStateFixture
#   3. PR 1 baseline: cdkd local invoke (no --from-state) — assert
#      BUCKET_NAME comes through as "unset" (env var dropped because
#      it's intrinsic-valued and PR 1 warns + drops).
#   4. PR 2: cdkd local invoke --from-state — assert BUCKET_NAME is the
#      actual deployed S3 bucket name, and STATIC_VALUE still passes
#      through unchanged.
#   5. cdkd destroy --force
#
# Run via `/run-integ local-invoke-from-state` (recommended) or directly:
#
#     bash tests/integration/local-invoke-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeFromStateFixture"
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-state"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

# Capture the deployed bucket name from cdkd state so the assert can match
# on the literal value. We use 'cdkd state resources' to avoid hard-coding
# any logical-id assumptions.
echo "[verify] step 2b: reading deployed bucket name from cdkd state"
DEPLOYED_BUCKET="$(${CLI} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::S3::Bucket"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed bucket: ${DEPLOYED_BUCKET}"
[ -n "${DEPLOYED_BUCKET}" ] || { echo "[verify] FAIL: could not read deployed bucket name"; exit 1; }

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable. When all
# 3 attempts fail, surface the last attempt's stderr so the user can
# triage. PR 1's RIE readiness window is the load-bearing fix; this
# retry is a cheap belt-and-suspenders for the integ.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  while [ $i -le $attempts ]; do
    if out=$(${CLI} local invoke "${args[@]}" 2>/dev/null | tail -1) && \
       echo "${out}" | grep -q '"bucketName":'; then
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed, retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed; last stderr below:" >&2
  ${CLI} local invoke "${args[@]}" 2>&1 | tail -10 >&2
  return 1
}

echo "[verify] step 3: cdkd local invoke (no --from-state) — expect BUCKET_NAME=unset"
RESULT_PR1=$(invoke_with_retry "${STACK}/EchoBucketHandler" --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_PR1}"
echo "${RESULT_PR1}" | grep -q '"bucketName":"unset"' || {
  echo "[verify] FAIL: expected BUCKET_NAME to be dropped (PR 1 warn-and-drop), got: ${RESULT_PR1}"
  exit 1
}
echo "${RESULT_PR1}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in response, got: ${RESULT_PR1}"
  exit 1
}

echo "[verify] step 4: cdkd local invoke --from-state — expect BUCKET_NAME=${DEPLOYED_BUCKET}"
RESULT_PR2=$(invoke_with_retry "${STACK}/EchoBucketHandler" --from-state --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_PR2}"
echo "${RESULT_PR2}" | grep -q "\"bucketName\":\"${DEPLOYED_BUCKET}\"" || {
  echo "[verify] FAIL: expected BUCKET_NAME=${DEPLOYED_BUCKET}, got: ${RESULT_PR2}"
  exit 1
}
echo "${RESULT_PR2}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-state, got: ${RESULT_PR2}"
  exit 1
}

echo "[verify] step 5: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo ""
echo "[verify] All checks passed: --from-state substituted BUCKET_NAME with the deployed bucket name."
