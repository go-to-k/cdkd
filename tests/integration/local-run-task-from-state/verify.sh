#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local run-task --from-state`
# Tier 2 ECR Repository resolution (PR #267, closes #264).
#
# Why this exists: the existing `tests/integration/local-run-task/` and
# `local-run-task-multi-container/` integs only use public images
# (`public.ecr.aws/nginx/nginx:alpine` etc.), so the `--from-state` path
# is unit-tested but never exercised against real AWS. This integ closes
# that gap by deploying a same-stack `AWS::ECR::Repository`, pushing a
# tiny image to it, and running the task whose `Image` is a `Fn::Sub`
# reference to that repository's deployed physical id.
#
# Critical design decision (see lib/local-run-task-from-state-stack.ts):
# the synthesized `Image` is shaped as the 1-arg `Fn::Sub` form, NOT
# `Fn::Join`. CDK 2.x's `ContainerImage.fromEcrRepository(repo)`
# synthesizes a `Fn::Join` with nested `Fn::Select` / `Fn::Split` /
# `Fn::GetAtt`, which the Tier 2 resolver does NOT yet handle (issue
# #271). The fixture uses `CfnTaskDefinition` directly with an explicit
# `cdk.Fn.sub(...)` so the round-trip exercises the actually-supported
# `Fn::Sub` path.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdkd deploy CdkdLocalRunTaskFromStateFixture (creates the ECR
#      repository)
#   3. push a tiny nginx image to the deployed repository
#   4. cdkd local run-task --from-state — verify Tier 2 substituted the
#      `${MyRepo}` placeholder with the deployed physical name, the
#      container started against the pushed image, and the host port is
#      reachable
#   5. clean up: docker rm + docker network rm via trap; aws ecr
#      batch-delete-image to empty the repo (cdkd destroy fails if a repo
#      has images); cdkd destroy --force
#
# Run via `/run-integ local-run-task-from-state` (recommended) or directly:
#
#     bash tests/integration/local-run-task-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalRunTaskFromStateFixture"
TASK_PATH="${STACK}/NginxTaskDef"
HOST_PORT=18082
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-run-task-from-state"
CDKD="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1a: install + build cdkd"
pnpm --dir "${REPO_ROOT}" install
pnpm --dir "${REPO_ROOT}" run build

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NGINX_IMAGE}"

# Cleanup trap: empty ECR repo (cdkd destroy fails if it has images),
# cdkd destroy, then docker rm orphan containers + networks. Runs on
# every exit path (including SIGINT and FAIL).
DEPLOYED_REPO=""
cleanup() {
  rc=$?
  set +e
  echo "[verify] cleanup (exit ${rc}) — emptying repo + destroying stack + tearing down docker"

  # Sweep local docker containers + networks first (cheap, low-risk).
  docker ps --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true

  # Empty the ECR repository so cdkd destroy can remove it. If we never
  # resolved the deployed repo name (stack failed before step 2b), best
  # effort: pull it from state.
  if [ -z "${DEPLOYED_REPO}" ]; then
    DEPLOYED_REPO="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::ECR::Repository"){console.log(r.physicalId);process.exit(0)}}}catch(e){}process.exit(1)})' 2>/dev/null)"
  fi
  if [ -n "${DEPLOYED_REPO}" ]; then
    IMAGE_IDS_JSON="$(aws ecr list-images --repository-name "${DEPLOYED_REPO}" --region "${REGION}" --query 'imageIds' --output json 2>/dev/null || echo '[]')"
    if [ "${IMAGE_IDS_JSON}" != "[]" ] && [ -n "${IMAGE_IDS_JSON}" ]; then
      aws ecr batch-delete-image --repository-name "${DEPLOYED_REPO}" --region "${REGION}" --image-ids "${IMAGE_IDS_JSON}" >/dev/null 2>&1 || true
    fi
  fi

  ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1 | tail -5 || true

  exit "${rc}"
}
trap cleanup EXIT

echo "[verify] step 2: cdkd deploy ${STACK}"
${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 2b: reading deployed ECR repository name from cdkd state"
DEPLOYED_REPO="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::ECR::Repository"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed repo: ${DEPLOYED_REPO}"
[ -n "${DEPLOYED_REPO}" ] || { echo "[verify] FAIL: could not read deployed repo name from state"; exit 1; }

REPO_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${DEPLOYED_REPO}"

echo "[verify] step 3: tag + push nginx into ${REPO_URI}:latest"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null
docker tag "${NGINX_IMAGE}" "${REPO_URI}:latest"
docker push "${REPO_URI}:latest"

echo "[verify] step 4: cdkd local run-task --from-state ${TASK_PATH}"
${CDKD} local run-task "${TASK_PATH}" \
  --from-state \
  --detach \
  --no-pull \
  --container-host 127.0.0.1 \
  --state-bucket "${STATE_BUCKET}"

echo "[verify] step 4b: curl http://127.0.0.1:${HOST_PORT}/ (allow ~5s for nginx to listen)"
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/" || true)
echo "[verify]   HTTP code: ${HTTP_CODE}"
if [ "${HTTP_CODE}" != "200" ]; then
  echo "[verify] FAIL: expected 200, got ${HTTP_CODE}"
  exit 1
fi

echo ""
echo "[verify] All checks passed: --from-state substituted \${MyRepo} with the deployed ECR repository ${DEPLOYED_REPO}."
