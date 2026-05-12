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
# Three TaskDefs:
#   - NginxTaskDef   : Fn::Sub-shape Image (L1 CfnTaskDefinition)        → port 18082
#   - NginxTaskDefL2 : Fn::Join-shape Image (L2 fromEcrRepository)       → port 18083
#   - EnvTaskDef     : intrinsic env vars + Ref secret (busybox printer) → no port (echoes)
# The first two share the deployed ECR repository (single deploy + push);
# EnvTaskDef uses busybox to focus on the env/secret resolver path (#291).
TASK_PATH_SUB="${STACK}/NginxTaskDef"
TASK_PATH_JOIN="${STACK}/NginxTaskDefL2"
TASK_PATH_ENV="${STACK}/EnvTaskDef"
HOST_PORT_SUB=18082
HOST_PORT_JOIN=18083
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

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
docker pull "${BUSYBOX_IMAGE}"

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

# Helper: run-task + curl + per-task cleanup for one TaskDef path.
# Used twice — once for the Fn::Sub fixture (NginxTaskDef:18082), once
# for the Fn::Join fixture (NginxTaskDefL2:18083). Both share the same
# deployed ECR repository + pushed `:latest` image — only the resolver
# path differs.
run_and_curl_task() {
  local task_path="$1"
  local host_port="$2"
  local shape_label="$3"

  echo "[verify] cdkd local run-task --from-state ${task_path} (shape: ${shape_label})"
  ${CDKD} local run-task "${task_path}" \
    --from-state \
    --detach \
    --no-pull \
    --container-host 127.0.0.1 \
    --state-bucket "${STATE_BUCKET}"

  echo "[verify]   curl http://127.0.0.1:${host_port}/ (allow ~5s for nginx to listen)"
  sleep 5
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${host_port}/" || true)
  echo "[verify]   HTTP code: ${http_code}"
  if [ "${http_code}" != "200" ]; then
    echo "[verify] FAIL (${shape_label}): expected 200, got ${http_code}"
    exit 1
  fi

  # Tear down THIS task's containers + network before moving on so the
  # next task can claim the 169.254.170.0/24 subnet.
  echo "[verify]   tearing down ${shape_label} task containers + network"
  docker ps --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
}

echo "[verify] step 4a: Tier 2 via Fn::Sub shape (L1 CfnTaskDefinition)"
run_and_curl_task "${TASK_PATH_SUB}" "${HOST_PORT_SUB}" "Fn::Sub"

echo "[verify] step 4b: Tier 2 via Fn::Join shape (L2 ContainerImage.fromEcrRepository)"
run_and_curl_task "${TASK_PATH_JOIN}" "${HOST_PORT_JOIN}" "Fn::Join"

# ─── Issue #291: env vars + secret substitution via state ─────────────
#
# The EnvTaskDef container echoes 4 env vars + the length of the
# secret-derived DB_SECRET to stdout. cdkd's `--from-state` should:
#   - Substitute TABLE_NAME from the deployed DDB table's physicalId
#     (Ref against AWS::DynamoDB::Table = the table name).
#   - Substitute TABLE_ARN from state.attributes.Arn (Fn::GetAtt).
#   - Substitute ENDPOINT's Fn::Sub interpolation against the table name
#     and AWS::Region (pseudo parameter from sts:GetCallerIdentity).
#   - Substitute JOINED's Fn::Join over a Ref(MyTable) + literal.
#   - Resolve Secrets[].ValueFrom = `Ref: MySecret` to the deployed
#     secret ARN, then fetch the JSON value via SecretsManager and
#     inject the JSON blob as DB_SECRET (length > 0).
#
# We capture container output via `docker logs` (the EnvTaskDef
# container has no port; it prints + exits naturally). cdkd's local
# run-task waits for the essential container's exit, so a non-detach
# invocation blocks until the printer finishes.
echo "[verify] step 4c: Issue #291 — env vars + Ref secret via --from-state"
echo "[verify]   reading deployed DDB table name from cdkd state"
DEPLOYED_TABLE="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::DynamoDB::Table"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed table: ${DEPLOYED_TABLE}"
[ -n "${DEPLOYED_TABLE}" ] || { echo "[verify] FAIL: could not read deployed table name from state"; exit 1; }

# Run the env task in detached mode so the container ID is recorded for
# `docker logs` lookup; the printer exits within ~1s, then we read its
# captured stdout.
ENV_RUN_OUT="$(${CDKD} local run-task "${TASK_PATH_ENV}" \
  --from-state \
  --detach \
  --no-pull \
  --container-host 127.0.0.1 \
  --state-bucket "${STATE_BUCKET}" 2>&1)"
echo "${ENV_RUN_OUT}"

# Give the container time to print and exit (busybox echo + exit is
# basically instant, but the metadata sidecar may delay a beat).
sleep 3

ENV_CONTAINER_ID="$(docker ps -a --filter "name=cdkd-local-cdkd-local-run-task-from-state-env-fixture-printer-" --format '{{.ID}}' | head -n 1)"
[ -n "${ENV_CONTAINER_ID}" ] || { echo "[verify] FAIL: env-task container not found"; exit 1; }

ENV_LOGS="$(docker logs "${ENV_CONTAINER_ID}" 2>&1)"
echo "[verify]   env task container output:"
echo "${ENV_LOGS}" | sed 's/^/[verify]     /'

assert_in_logs() {
  local needle="$1"
  if ! echo "${ENV_LOGS}" | grep -qF "${needle}"; then
    echo "[verify] FAIL: expected '${needle}' in env-task container output"
    exit 1
  fi
}

assert_in_logs "TABLE_NAME=${DEPLOYED_TABLE}"
assert_in_logs "TABLE_ARN=arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DEPLOYED_TABLE}"
assert_in_logs "ENDPOINT=local-${REGION}-${DEPLOYED_TABLE}"
assert_in_logs "JOINED=${DEPLOYED_TABLE}|literal"
# The generated secret is JSON like {"user":"cdkd","password":"<16char>"}
# (~38-42 chars); assert a non-trivial DB_SECRET_LEN was injected. Cheap
# regex: at least two digits, i.e. >= 10 chars resolved.
if ! echo "${ENV_LOGS}" | grep -qE 'DB_SECRET_LEN=[0-9]{2,}'; then
  echo "[verify] FAIL: DB_SECRET was not resolved to a non-empty value"
  exit 1
fi

# Teardown the env task before moving on.
docker ps --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true

echo ""
echo "[verify] All checks passed: --from-state substituted ECR Repository ref (Fn::Sub + Fn::Join) AND env-var / Ref-secret intrinsics (issue #291) against deployed cdkd state."
