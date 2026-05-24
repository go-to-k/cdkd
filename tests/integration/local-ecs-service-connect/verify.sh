#!/usr/bin/env bash
# verify.sh — cdkd local start-service Service Connect + Cloud Map integ
# test (Issue #460, no AWS deploy).
#
# Boots two ECS Services in a single `cdkd local start-service` call:
#   1. `orders` (desiredCount: 1) — busybox netcat echo on port 80.
#      Single replica registers in the in-process Cloud Map registry:
#        - Service Connect ClientAlias `orders`.
#        - Cloud Map `orders-discovery` (#579 item (2)) via the
#          ServiceRegistries[] branch of `publishReplicaToCloudMap`.
#      Producer-side multi-replica (the original #579 item (1) ask) is
#      blocked on cdkd source work — OrdersTask publishes an explicit
#      hostPort: 8081 and cdkd's docker-runner always passes
#      `-p host:container`, so 2 replicas would collide on host port
#      8081. Tracked as a follow-up to #579.
#   2. `frontend` consumer at desiredCount: 1 — frontend's
#      portMappings omit `hostPort` but cdkd's docker-runner defaults
#      it to `containerPort` (=8080), so 2 replicas would collide on
#      host port 8080 the same way orders would on 8081. #579 item (1)
#      (desiredCount: 2 on EITHER service) is therefore fully blocked
#      on cdkd source work (per-replica host port allocation OR a
#      `-p`-skip opt-out), tracked as a follow-up.
#      The integ asserts the frontend container can reach `orders` via
#      the docker `--add-host` overlay populated from cdkd's shared
#      registry.
#
# Asserts:
#   - The boot banner reports both services running.
#   - Exactly 1 `orders-*` container AND 1 `frontend-*` container
#     are visible in `docker ps` (2 task containers + 1 metadata
#     sidecar; #579 item (1)).
#   - The frontend container has `orders.cdkd-sc.local` AND the bare
#     `orders` alias mapped in its `/etc/hosts` (proves the Service
#     Connect branch of `--add-host` flowed through).
#   - The same frontend container ALSO has
#     `orders-discovery.cdkd-sc.local` mapped to an orders-container
#     IP (proves the ServiceRegistries[] branch is wired end-to-end;
#     #579 item (2)).
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

# #579 item (2): assert the expected container count. orders + frontend
# both stay at desiredCount: 1 (item (1) deferred — see header for the
# cdkd source bug that blocks multi-replica). We wait for the count to
# settle since boot is sequential per service.
echo "==> Asserting container count — exactly 1 orders + 1 frontend container"
ORDERS_COUNT=0
FRONTEND_COUNT=0
for _ in $(seq 1 60); do
  ORDERS_COUNT=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-orders-orders-" --format '{{.ID}}' | wc -l | tr -d ' ')
  FRONTEND_COUNT=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-frontend-frontend-" --format '{{.ID}}' | wc -l | tr -d ' ')
  if [[ "${ORDERS_COUNT}" -eq 1 && "${FRONTEND_COUNT}" -eq 1 ]]; then break; fi
  sleep 1
done
if [[ "${ORDERS_COUNT}" -ne 1 || "${FRONTEND_COUNT}" -ne 1 ]]; then
  echo "FAIL: expected 1 orders + 1 frontend container, got orders=${ORDERS_COUNT} frontend=${FRONTEND_COUNT}"
  docker ps -a --filter "name=cdkd-local-"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: 1 orders + 1 frontend replica running"

# Locate ONE frontend container so we can docker-exec into it. The
# alias resolution should be identical across both replicas since the
# registry snapshot is shared, so picking the first is sufficient.
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

# Collect the orders container's docker network IP so the
# `orders-discovery.cdkd-sc.local` resolution can be cross-checked
# against it. The loop is N-agnostic (works for 1 or N>=2 containers)
# so a future producer-side-multi-replica follow-up to #579 won't
# need to rewrite this block.
echo "==> Collecting orders container IPs (shared svc network)"
SHARED_NET=$(docker network ls --filter "name=cdkd-local-svc-" --format '{{.Name}}' | head -1)
if [[ -z "${SHARED_NET}" ]]; then
  echo "FAIL: shared svc network (cdkd-local-svc-*) not found"
  docker network ls
  exit 1
fi
ORDERS_IDS=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-orders-orders-" --format '{{.ID}}')
ORDERS_IPS=""
for cid in ${ORDERS_IDS}; do
  ip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"${SHARED_NET}\").IPAddress}}" "${cid}" 2>/dev/null || true)
  if [[ -n "${ip}" && "${ip}" != "<no value>" ]]; then
    ORDERS_IPS+="${ip} "
  fi
done
echo "    orders IPs on ${SHARED_NET}: ${ORDERS_IPS}"
if [[ -z "${ORDERS_IPS}" ]]; then
  echo "FAIL: could not discover any orders container IP on ${SHARED_NET}"
  exit 1
fi

echo "==> Asserting docker --add-host overlay populated /etc/hosts in the frontend container"
HOSTS_OUTPUT=$(docker exec "${FRONTEND_ID}" cat /etc/hosts || true)
echo "----- /etc/hosts -----"
echo "${HOSTS_OUTPUT}"
echo "----------------------"
if ! grep -q "orders.cdkd-sc.local" <<<"${HOSTS_OUTPUT}"; then
  echo "FAIL: /etc/hosts does not contain orders.cdkd-sc.local (Service Connect fqdn missing)"
  exit 1
fi
if ! grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders$" <<<"${HOSTS_OUTPUT}"; then
  echo "FAIL: /etc/hosts does not contain a bare 'orders' alias (ClientAlias short-form missing)"
  exit 1
fi
echo "    OK: orders.cdkd-sc.local + bare 'orders' alias both present (Service Connect branch)"

# #579 item (2): the ServiceRegistries[] branch of
# `publishReplicaToCloudMap` registers `orders-discovery.cdkd-sc.local`
# (= `<discoveryName>.<namespaceName>` from the
# `AWS::ServiceDiscovery::Service` resource) against an orders replica
# IP. Distinct from the Service Connect branch above — proves the
# second Cloud Map mechanism is wired end-to-end.
echo "==> Asserting Cloud Map ServiceRegistries[] entry (orders-discovery.cdkd-sc.local) in /etc/hosts"
if ! grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders-discovery\.cdkd-sc\.local$" <<<"${HOSTS_OUTPUT}"; then
  echo "FAIL: /etc/hosts does not contain orders-discovery.cdkd-sc.local (ServiceRegistries[] branch missing)"
  exit 1
fi
DISCOVERY_IP=$(grep -oE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders-discovery\.cdkd-sc\.local$" <<<"${HOSTS_OUTPUT}" | awk '{print $1}' | head -1)
if [[ -z "${DISCOVERY_IP}" ]]; then
  echo "FAIL: could not extract IP for orders-discovery.cdkd-sc.local from /etc/hosts"
  exit 1
fi
MATCHED=0
for ip in ${ORDERS_IPS}; do
  if [[ "${ip}" == "${DISCOVERY_IP}" ]]; then MATCHED=1; break; fi
done
if [[ "${MATCHED}" -ne 1 ]]; then
  echo "FAIL: orders-discovery.cdkd-sc.local resolves to ${DISCOVERY_IP} which is not any orders container IP (${ORDERS_IPS})"
  exit 1
fi
echo "    OK: orders-discovery.cdkd-sc.local -> ${DISCOVERY_IP} (matches an orders container; ServiceRegistries[] branch verified)"

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
