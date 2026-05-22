#!/usr/bin/env bash
# verify.sh — cdkd local start-service Service Connect + Cloud Map integ
# test (Issue #460, no AWS deploy).
#
# Boots TWO ECS Services in a single `cdkd local start-service` call:
#   1. `orders` exposing a busybox netcat echo on port 80 / Service
#      Connect ClientAlias `orders`.
#   2. `frontend` consumer that should reach `orders` via the docker
#      `--add-host` overlay populated from cdkd's in-process Cloud Map
#      registry.
#
# Asserts:
#   - The boot banner reports both services running.
#   - The frontend container has `orders.cdkd-sc.local` AND the bare
#     `orders` alias mapped in its `/etc/hosts` (proves `--add-host`
#     flowed through from the resolver -> registry -> docker-runner).
#   - `wget http://orders/` from inside the frontend container returns
#     the orders server's `HELLO_ORDERS` payload (proves end-to-end
#     networking).
#   - SIGTERM tears down every container + network.
#
#     bash tests/integration/local-ecs-service-connect/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKD_PID:-}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Booting both services (one cdkd invocation, shared Cloud Map registry)"
${CDKD} local start-service \
  CdkdLocalEcsServiceConnectFixture:OrdersService \
  CdkdLocalEcsServiceConnectFixture:FrontendService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

echo "==> Waiting for boot banner (up to 120s)"
BOOTED=0
for i in $(seq 1 120); do
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
  echo "FAIL: services did not reach the boot banner within 120s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

# Locate the frontend container so we can docker-exec into it.
echo "==> Locating the frontend container"
FRONTEND_ID=""
for i in $(seq 1 30); do
  FRONTEND_ID=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-frontend-frontend-" --format '{{.ID}}' | head -1)
  if [[ -n "${FRONTEND_ID}" ]]; then break; fi
  sleep 1
done
if [[ -z "${FRONTEND_ID}" ]]; then
  echo "FAIL: frontend container did not appear in docker ps within 30s"
  docker ps -a --filter "name=cdkd-local-"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    frontend container: ${FRONTEND_ID}"

echo "==> Asserting docker --add-host overlay populated /etc/hosts in the frontend container"
HOSTS_OUTPUT=$(docker exec "${FRONTEND_ID}" cat /etc/hosts || true)
echo "----- /etc/hosts -----"
echo "${HOSTS_OUTPUT}"
echo "----------------------"
if ! grep -q "orders.cdkd-sc.local" <<<"${HOSTS_OUTPUT}"; then
  echo "FAIL: /etc/hosts does not contain orders.cdkd-sc.local (Cloud Map fqdn missing)"
  exit 1
fi
if ! grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders$" <<<"${HOSTS_OUTPUT}"; then
  echo "FAIL: /etc/hosts does not contain a bare 'orders' alias (ClientAlias short-form missing)"
  exit 1
fi
echo "    OK: orders.cdkd-sc.local + bare 'orders' alias both present"

echo "==> Asserting end-to-end HTTP connectivity from frontend → orders"
RESPONSE=""
for i in $(seq 1 30); do
  RESPONSE=$(docker exec "${FRONTEND_ID}" wget -qO- --timeout=3 http://orders/ 2>/dev/null || true)
  if grep -q "HELLO_ORDERS" <<<"${RESPONSE}"; then
    break
  fi
  sleep 1
done
if ! grep -q "HELLO_ORDERS" <<<"${RESPONSE}"; then
  echo "FAIL: wget http://orders/ from frontend did not return HELLO_ORDERS"
  echo "----- last response -----"
  echo "${RESPONSE}"
  echo "-------------------------"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: frontend reached orders via the docker --add-host overlay"

echo "==> Sending SIGTERM to cdkd ($(echo $CDKD_PID))"
kill -TERM "${CDKD_PID}"

echo "==> Waiting for cdkd to exit (up to 60s)"
EXITED=0
for i in $(seq 1 60); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdkd did not exit within 60s after SIGTERM"
  cat "${OUT_FILE}"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKD_PID}" 2>/dev/null || true
CDKD_PID=""

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after SIGTERM"
  docker ps -a --filter "name=cdkd-local-"
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after SIGTERM"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi

echo ""
echo "==> local-ecs-service-connect test passed (Cloud Map + Service Connect end-to-end OK)"
