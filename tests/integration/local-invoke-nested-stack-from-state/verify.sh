#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local ... --from-state` against
# resources inside CDK NestedStacks (cdk-local go-to-k/cdk-local#986).
#
# Stack: a parent (queue PQ, Lambda OuterFn) with NestedStack `Inner` (bucket B,
# InnerFn + a REST API on it, Fargate task `Task`) and NestedStack `Deeper`
# inside Inner (DeepFn). The values that matter reach the nested templates as
# nested-template PARAMETERS the parent passes in, so --from-state must read the
# PARENT's cdkd state. The nested stack's own record is `<Parent>~<NestedId>`.
#
# Steps:
#   1. build cdkd, install fixture deps, pull images
#   2. cdkd deploy; read the real bucket / queue through the aws CLI
#   3. local invoke <Stack>/Inner/InnerFn --from-state
#   4. local invoke <Stack>/Inner/Deeper/DeepFn --from-state (two hops)
#   5. local invoke <Stack>:<DeepFn logical id> --from-state
#   6. local start-api --from-state (no --stack): GET / returns the real values
#   7. local run-task <Stack>/Inner/Task --from-state --no-pull
#   8. cdkd destroy --force; state (parent + <Stack>~* children), bucket and
#      queue are gone
#
# Run via `/run-integ local-invoke-nested-stack-from-state` or directly:
#
#     bash tests/integration/local-invoke-nested-stack-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions.

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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeNestedStackFromStateExample"
IMAGE="public.ecr.aws/lambda/nodejs:20"
TASK_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
PORT=13987

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-nested-stack-from-state"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

[ -f "${REPO_ROOT}/dist/cli.js" ] || { echo "[verify] FAIL: dist/cli.js missing (run vp run build)"; exit 1; }

. "${REPO_ROOT}/tests/integration/cr-log-groups.sh"

SERVER_PID=""
SERVER_LOG=""

# Every state key under the parent's name and the `<Stack>~*` children's.
state_keys() {
  local out
  out="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "cdkd/${STACK}" \
    --query 'Contents[].Key' --output text)" || return 1
  printf '%s\n' "${out}" | tr '\t' '\n' \
    | grep -E "^cdkd/${STACK}(~[^/]*)*/${REGION}/(state|lock)\.json$" || true
}

cleanup() {
  rc=$?
  if [ -n "${SERVER_PID}" ]; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -f "${SERVER_LOG:-}"
  if [ "${rc}" -ne 0 ] || [ -n "$(state_keys)" ]; then
    echo "[verify] cleanup: destroying ${STACK}"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force || true
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}" || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, fixture deps, pull images"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi
docker version --format '{{.Server.Version}}' >/dev/null
docker pull "${IMAGE}"
docker pull "${TASK_IMAGE}"

echo "[verify] pre-run cleanup: no leftover state"
if [ -n "$(state_keys)" ]; then
  ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force || true
fi

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"

echo "[verify] step 2b: reading the real bucket / queue"
CHILD_KEYS="$(state_keys | grep -E '/state\.json$' | grep -v "^${STATE_KEY}\$" || true)"
echo "[verify]   child state records:"
echo "${CHILD_KEYS}" | sed 's/^/[verify]     /'
# Inner and Inner~Deeper: one record per nested stack, the second keyed by the chain.
CHILD_COUNT="$(printf '%s\n' "${CHILD_KEYS}" | grep -c '~' || true)"
[ "${CHILD_COUNT}" -eq 2 ] || { echo "[verify] FAIL: expected 2 <Stack>~* child state records, got ${CHILD_COUNT}"; exit 1; }
printf '%s\n' "${CHILD_KEYS}" | grep -qE '~[^/]+~[^/]+/' \
  || { echo "[verify] FAIL: no <Stack>~<Inner>~<Deeper> record for the 2-level nested stack"; exit 1; }

# physicalId of the first resource of a type, searching parent then children.
physical_of() { # usage: physical_of <resource type>
  local key name out
  for key in "${STATE_KEY}" ${CHILD_KEYS}; do
    out="$(aws s3 cp "s3://${STATE_BUCKET}/${key}" - --region "${REGION}" | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const j=JSON.parse(d);
        for(const r of Object.values(j.resources||{})){
          if(r.resourceType===process.argv[1]){console.log(r.physicalId);process.exit(0)}
        }
        process.exit(1)})' "$1" || true)"
    if [ -n "${out}" ]; then printf '%s' "${out}"; return 0; fi
  done
  return 1
}
BUCKET="$(physical_of AWS::S3::Bucket)"
QUEUE_PHYS="$(physical_of AWS::SQS::Queue)"
[ -n "${BUCKET}" ] && [ -n "${QUEUE_PHYS}" ] || { echo "[verify] FAIL: could not read bucket/queue from state"; exit 1; }
QUEUE_NAME="${QUEUE_PHYS##*/}"
aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
QUEUE_URL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text)"
QUEUE_ARN="$(aws sqs get-queue-attributes --queue-url "${QUEUE_URL}" --attribute-names QueueArn --region "${REGION}" --query Attributes.QueueArn --output text)"
echo "[verify]   bucket=${BUCKET}"
echo "[verify]   queue url=${QUEUE_URL}"
echo "[verify]   queue arn=${QUEUE_ARN}"

DEEP_LOGICAL_ID="$(node -e '
  const fs=require("fs");
  for(const f of fs.readdirSync("cdk.out")){
    if(!f.endsWith(".nested.template.json"))continue;
    const t=JSON.parse(fs.readFileSync("cdk.out/"+f,"utf8"));
    for(const [id,r] of Object.entries(t.Resources||{})){
      if(r.Type==="AWS::Lambda::Function"&&/^DeepFn[0-9A-F]{8}$/.test(id)){console.log(id);process.exit(0)}
    }
  }
  process.exit(1)')"
echo "[verify]   DeepFn logical id=${DEEP_LOGICAL_ID}"

# Retried: the RIE's TCP probe can pass before its HTTP listener is wired up.
invoke_with_retry() {
  local err out i=1
  err="$(mktemp)"
  while [ "${i}" -le 3 ]; do
    if out="$(${CLI} local invoke "$@" 2>"${err}" | tail -1)" && grep -q '"BUCKET"' <<<"${out}"; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    echo "[verify]   invoke attempt ${i} failed (stdout: ${out}); stderr tail:" >&2
    tail -5 "${err}" >&2
    i=$((i + 1))
    sleep 2
  done
  echo "[verify]   all invoke attempts failed; last stderr:" >&2
  tail -20 "${err}" >&2
  rm -f "${err}"
  return 1
}

expect() { # usage: expect "<label>" "<response>" '"KEY":"value"' ...
  local label="$1" resp="$2"
  shift 2
  local needle
  for needle in "$@"; do
    grep -qF -- "${needle}" <<<"${resp}" || {
      echo "[verify] FAIL (${label}): expected ${needle}, got: ${resp}"
      exit 1
    }
  done
}

echo "[verify] step 3: invoke ${STACK}/Inner/InnerFn --from-state"
R3="$(invoke_with_retry "${STACK}/Inner/InnerFn" --from-state --no-pull --state-bucket "${STATE_BUCKET}")"
echo "[verify]   response: ${R3}"
expect "InnerFn" "${R3}" "\"BUCKET\":\"${BUCKET}\"" "\"QUEUE_URL\":\"${QUEUE_URL}\"" "\"QUEUE_ARN\":\"${QUEUE_ARN}\""

echo "[verify] step 4: invoke ${STACK}/Inner/Deeper/DeepFn --from-state (two hops)"
R4="$(invoke_with_retry "${STACK}/Inner/Deeper/DeepFn" --from-state --no-pull --state-bucket "${STATE_BUCKET}")"
echo "[verify]   response: ${R4}"
expect "DeepFn path" "${R4}" "\"PARENT_BUCKET\":\"${BUCKET}\"" "\"ROOT_QUEUE\":\"${QUEUE_URL}\""

echo "[verify] step 5: invoke ${STACK}:${DEEP_LOGICAL_ID} --from-state"
R5="$(invoke_with_retry "${STACK}:${DEEP_LOGICAL_ID}" --from-state --no-pull --state-bucket "${STATE_BUCKET}")"
echo "[verify]   response: ${R5}"
expect "DeepFn logical id" "${R5}" "\"PARENT_BUCKET\":\"${BUCKET}\"" "\"ROOT_QUEUE\":\"${QUEUE_URL}\""

echo "[verify] step 6: start-api --from-state (no --stack), GET /"
SERVER_LOG="$(mktemp)"
${CLI} local start-api --from-state --no-pull --port "${PORT}" --state-bucket "${STATE_BUCKET}" \
  </dev/null >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
BODY=""
for _ in $(seq 1 120); do
  kill -0 "${SERVER_PID}" 2>/dev/null || { echo "[verify] FAIL: start-api exited early. Log:"; cat "${SERVER_LOG}"; exit 1; }
  if BODY="$(curl -s --max-time 60 "http://127.0.0.1:${PORT}/")" && grep -q '"BUCKET"' <<<"${BODY}"; then
    break
  fi
  sleep 1
done
echo "[verify]   GET / body: ${BODY}"
if ! grep -q '"BUCKET"' <<<"${BODY}"; then
  echo "[verify] FAIL (start-api): no usable response. Log:"
  cat "${SERVER_LOG}"
  exit 1
fi
expect "start-api" "${BODY}" "\"BUCKET\":\"${BUCKET}\"" "\"QUEUE_URL\":\"${QUEUE_URL}\""
kill -TERM "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true
SERVER_PID=""

echo "[verify] step 7: run-task ${STACK}/Inner/Task --from-state --no-pull"
RUN_OUT="$(${CLI} local run-task "${STACK}/Inner/Task" --from-state --no-pull \
  --container-host 127.0.0.1 --state-bucket "${STATE_BUCKET}" 2>&1)" || {
  echo "[verify] FAIL (run-task) exited non-zero:"
  echo "${RUN_OUT}"
  exit 1
}
echo "${RUN_OUT}" | tail -8 | sed 's/^/[verify]   /'
expect "run-task" "${RUN_OUT}" "NESTED_TASK QUEUE_URL=${QUEUE_URL} BUCKET=${BUCKET}"

echo "[verify] step 8: cdkd destroy --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for key in ${CHILD_KEYS}; do
  assert_gone "child state ${key} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done
LEFT="$(state_keys)"
[ -z "${LEFT}" ] || { echo "[verify] FAIL: state keys remain: ${LEFT}"; exit 1; }
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"

echo "[verify] PASS — nested-stack targets resolved from parent state (invoke x3, start-api, run-task), destroy clean"
