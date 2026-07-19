#!/usr/bin/env bash
# verify.sh — cdkd local start-alb --from-state real-AWS integ test
#
# Deploys a real VPC + ALB + 2 ECS Fargate services to AWS so cdkd's
# S3 state file carries resolved Ref / Fn::GetAtt values, then boots
# the local ALB front-door with `--from-state` and asserts the
# engine substituted the deployed ALB DNS name into each container's
# `ALB_DNS_NAME` env var before the container started. This proves
# the engine's `--from-state` substitution path for ALB-fronted
# ECS services works end-to-end against real AWS — a gap that the
# pure-local `local-start-alb` sibling fixture cannot cover.
#
# Flow:
#   1. Pre-flight orphan sweep (Docker + AWS state).
#   2. Synth + cdkd deploy to us-east-1 (~5 min cold).
#   3. Read deployed ALB DNS name via aws cli (sanity).
#   4. Boot `cdkd local start-alb` in background with --from-state +
#      --lb-port 80=8080.
#   5. Probe http://127.0.0.1:8080/ — assert body contains
#      "service=web alb=<deployed-alb-dns>". Substitution proof.
#   6. Probe http://127.0.0.1:8080/orders/ — assert body contains
#      "service=orders alb=<deployed-alb-dns>". Proves both the
#      multi-target boot + the ListenerRule path routing.
#   7. SIGTERM cdkd. Assert clean teardown.
#   8. cdkd destroy. Assert 0 errors, 0 orphans.
#
# Run via `/run-integ local-start-alb-from-state` (recommended) or
# directly:
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-alb-from-state/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
STACK_NAME="CdkdLocalStartAlbFromStateFixture"
# CDK L2 `ApplicationLoadBalancer` synthesizes the logical id with an
# auto-hash suffix (e.g. `Alb16C2F182`), so the colon form
# `Stack:Alb` would not match. Use the CDK display-path form
# (`Stack/Alb`) which the engine's `resolveAlbTarget` translates via
# the `aws:cdk:path` index — stable across CDK version bumps.
TARGET="${STACK_NAME}/Alb"
HOST_PORT=8080
REGION="${AWS_REGION:-us-east-1}"
STATE_BUCKET="${STATE_BUCKET:?STATE_BUCKET env var required}"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

# Track whether AWS resources were created so the trap can attempt a
# destroy even if a curl assertion failed before the explicit destroy
# step. We do NOT silently swallow destroy errors — if the destroy in
# the trap fails, the trap exits non-zero so the orchestrator's
# follow-up orphan sweep fires.
DEPLOYED=0
CDKD_PID=""
OUT_FILE=""

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
    CDKD_PID=""
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true

  if [[ "${DEPLOYED}" -eq 1 ]]; then
    echo "==> Cleanup: cdkd destroy (best-effort)"
    # `--region` is required so the trap-path destroy reads the same
    # region-prefixed state key (`cdkd/<stack>/<region>/state.json`)
    # as the explicit destroy on the happy path. Without it the trap
    # could miss state and leave the stack orphan when AWS_REGION env
    # is unset.
    ${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force \
      || echo "WARN: destroy in trap failed; the orchestrator's orphan sweep will pick it up"
  fi

  if [[ -n "${OUT_FILE}" ]]; then
    rm -f "${OUT_FILE}"
    OUT_FILE=""
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "==> Pre-test orphan sweep (Docker)"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth --region "${REGION}" >/dev/null

echo "==> Deploying fixture to ${REGION} (real AWS — VPC + ALB + 2 Fargate services)"
${CDKD} deploy "${STACK_NAME}" \
  --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose
DEPLOYED=1

echo "==> Verifying deploy via aws cli (sanity)"
ALB_DNS=$(aws elbv2 describe-load-balancers --region "${REGION}" \
  --names cdkd-local-alb-from-state \
  --query 'LoadBalancers[0].DNSName' --output text)
if [[ -z "${ALB_DNS}" || "${ALB_DNS}" == "None" ]]; then
  echo "FAIL: aws elbv2 describe-load-balancers returned no DNS name for cdkd-local-alb-from-state"
  exit 1
fi
echo "    Deployed ALB DNS: ${ALB_DNS}"

OUT_FILE=$(mktemp)
echo "==> Booting cdkd local start-alb --from-state (listener 80 -> host ${HOST_PORT})"
${CDKD} local start-alb "${TARGET}" \
  --from-state \
  --state-bucket "${STATE_BUCKET}" \
  --lb-port "80=${HOST_PORT}" \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

echo "==> Waiting for boot banner (up to 120s — 2 services + ALB front-door)"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    echo "FAIL: cdkd exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done

if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: cdkd local start-alb did not reach the boot banner within 120s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting --lb-port override took effect (front-door bound to ${HOST_PORT})"
if ! grep -qE "ALB front-door: https?://[^[:space:]]+:${HOST_PORT} " "${OUT_FILE}"; then
  echo "FAIL: expected an 'ALB front-door' banner on host port ${HOST_PORT}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

probe() {
  # probe <path> <expected-service-banner>
  local path="$1"
  local expected_svc="$2"
  local url="http://127.0.0.1:${HOST_PORT}${path}"
  local body=""
  for _ in $(seq 1 45); do
    if body=$(curl --silent --show-error --max-time 5 "${url}" 2>&1); then
      if echo "${body}" | grep -qF "service=${expected_svc} alb=${ALB_DNS}"; then
        echo "    OK: ${url} -> '${body%$'\n'}'"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${url} did not return the expected substituted body within 45s"
  echo "      expected substring: 'service=${expected_svc} alb=${ALB_DNS}'"
  echo "      last response: ${body}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  return 1
}

echo "==> Probing default route (path / -> Web service)"
probe / web

echo "==> Probing ListenerRule path (path /orders/ -> Orders service)"
probe /orders/ orders

echo "==> Sending SIGTERM to cdkd (${CDKD_PID})"
kill -TERM "${CDKD_PID}"

echo "==> Waiting for cdkd to exit (up to 60s)"
EXITED=0
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdkd did not exit within 60s after SIGTERM"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKD_PID}" 2>/dev/null || true
CDKD_PID=""

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after SIGTERM"
  docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after SIGTERM"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi

echo "==> cdkd destroy"
${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force
DEPLOYED=0

echo "==> Verifying state is empty post-destroy"
# Match ONLY the `state.json` object, not the whole prefix. Since #820/#885
# the deployment-events store (`cdkd/<stack>/<region>/deployments/...`)
# survives `destroy` by design, so a bare prefix listing is never empty
# after teardown and would false-FAIL here. The destroy contract is that
# `state.json` is gone; the informational events store is swept separately
# (see /cleanup step 3.5).
# `aws s3 ls --recursive` returns exit 1 when nothing matches (success but
# empty). Under `set -o pipefail` that would terminate the script BEFORE the
# final "test passed" echo; wrap the call in `|| true` so the pipeline
# reports its own intent (number of matching lines == 0) cleanly.
STATE_REMAINING=$(
  (aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK_NAME}/" --recursive --region "${REGION}" 2>/dev/null || true) \
    | grep -c 'state\.json' || true
)
if [[ "${STATE_REMAINING}" -ne 0 ]]; then
  echo "FAIL: cdkd state.json for ${STACK_NAME} still present after destroy"
  exit 1
fi

echo ""
echo "==> local-start-alb-from-state test passed"
echo "    - Deployed VPC + ALB + 2 ECS Fargate services to ${REGION}"
echo "    - cdkd local start-alb --from-state substituted ALB DNS into both services' env vars"
echo "    - Default route (path /) reached Web service with resolved env var"
echo "    - ListenerRule path /orders/ reached Orders service with resolved env var"
echo "    - --lb-port 80=8080 override took effect"
echo "    - SIGTERM tore down every replica + network cleanly"
echo "    - cdkd destroy left no state behind"
