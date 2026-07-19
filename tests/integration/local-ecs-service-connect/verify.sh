#!/usr/bin/env bash
# verify.sh — cdkd local start-service Service Connect + Cloud Map integ
# test (Issue #460, no AWS deploy).
#
# Boots two ECS Services in a single `cdkd local start-service` call,
# each at `desiredCount: 2` (#579 item (1), unblocked by the #585
# multi-replica host-port-skip fix):
#   1. `orders` (desiredCount: 2) — busybox netcat echo on port 80.
#      Both replicas register in the in-process Cloud Map registry:
#        - Service Connect ClientAlias `orders`.
#        - Cloud Map `orders-discovery` (#579 item (2)) via the
#          ServiceRegistries[] branch of `publishReplicaToCloudMap`.
#      OrdersTask publishes an EXPLICIT hostPort: 8081, so this proves
#      the #585 fix skips the `-p` host-port publish for a multi-replica
#      service even with an explicit host port — pre-fix the 2nd replica
#      collided on host port 8081.
#   2. `frontend` consumer at desiredCount: 2 — frontend's portMappings
#      OMIT `hostPort` (cdkd would otherwise default it to
#      `containerPort` 8080 and collide on the 2nd replica). Both
#      replicas reach `orders` via the docker `--add-host` overlay
#      populated from cdkd's shared registry.
#
# Asserts:
#   - The boot banner reports both services running.
#   - Exactly 2 `orders-*` containers AND 2 `frontend-*` containers
#     are visible in `docker ps` (proves the #585 multi-replica
#     host-port-skip fix — pre-fix the 2nd replica failed to boot with
#     "port is already allocated"; #579 item (1)).
#   - EACH frontend container has `orders.cdkd-sc.local` AND the bare
#     `orders` alias mapped in its `/etc/hosts` (proves the Service
#     Connect branch of `--add-host` flowed through to every consumer
#     replica).
#   - EACH frontend container ALSO has `orders-discovery.cdkd-sc.local`
#     mapped to an orders-container IP (proves the ServiceRegistries[]
#     branch is wired end-to-end; #579 item (2)).
#   - First-replica-wins alias resolution: BOTH frontend replicas
#     resolve `orders` / `orders.cdkd-sc.local` /
#     `orders-discovery.cdkd-sc.local` to the SAME orders replica IP
#     (the first-registered one), since both consumers inherit the same
#     shared Cloud Map registry snapshot (#579 item (1)).
#   - `wget http://orders/` from inside a frontend container returns
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
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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
trap 'rm -f "${OUT_FILE}"; cleanup; exit 130' INT
trap 'rm -f "${OUT_FILE}"; cleanup; exit 143' TERM

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

# #579 item (1): assert the expected container count. orders + frontend
# both run desiredCount: 2 (unblocked by the #585 host-port-skip fix).
# Pre-fix the 2nd replica of each service failed to boot with "port is
# already allocated"; seeing 2 of each proves the fix. We wait for the
# count to settle since boot is sequential per service.
echo "==> Asserting container count — exactly 2 orders + 2 frontend containers"
ORDERS_COUNT=0
FRONTEND_COUNT=0
for _ in $(seq 1 60); do
  ORDERS_COUNT=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-orders-orders-" --format '{{.ID}}' | wc -l | tr -d ' ')
  FRONTEND_COUNT=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-frontend-frontend-" --format '{{.ID}}' | wc -l | tr -d ' ')
  if [[ "${ORDERS_COUNT}" -eq 2 && "${FRONTEND_COUNT}" -eq 2 ]]; then break; fi
  sleep 1
done
if [[ "${ORDERS_COUNT}" -ne 2 || "${FRONTEND_COUNT}" -ne 2 ]]; then
  echo "FAIL: expected 2 orders + 2 frontend containers, got orders=${ORDERS_COUNT} frontend=${FRONTEND_COUNT}"
  docker ps -a --filter "name=cdkd-local-"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: 2 orders + 2 frontend replicas running (multi-replica host-port skip verified)"

# Collect BOTH frontend container IDs. The Service Connect / Cloud Map
# alias resolution must be identical across both replicas (both inherit
# the same shared registry snapshot — first-replica-wins), which the
# per-replica /etc/hosts assertions below verify. The first ID also
# drives the single-container wget connectivity check.
echo "==> Locating the frontend containers"
FRONTEND_IDS=""
for i in $(seq 1 30); do
  FRONTEND_IDS=$(docker ps --filter "name=cdkd-local-cdkd-local-ecs-sc-frontend-frontend-" --format '{{.ID}}')
  if [[ "$(echo "${FRONTEND_IDS}" | wc -l | tr -d ' ')" -eq 2 ]]; then break; fi
  sleep 1
done
FRONTEND_ID=$(echo "${FRONTEND_IDS}" | head -1)
if [[ -z "${FRONTEND_ID}" ]]; then
  echo "FAIL: frontend containers did not appear in docker ps within 30s"
  docker ps -a --filter "name=cdkd-local-"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    frontend containers: $(tr '\n' ' ' <<<"${FRONTEND_IDS}")"

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

# Per-replica /etc/hosts assertions across BOTH frontend replicas. Each
# consumer must carry the Service Connect alias (`orders` short-form +
# `orders.cdkd-sc.local` fqdn) AND the Cloud Map ServiceRegistries[]
# alias (`orders-discovery.cdkd-sc.local`, #579 item (2)) — proving the
# `--add-host` overlay flowed to EVERY consumer replica, not just one.
echo "==> Asserting --add-host overlay in EACH frontend replica + first-replica-wins"
ORDERS_ALIAS_IPS=""
DISCOVERY_ALIAS_IPS=""
for fid in ${FRONTEND_IDS}; do
  HOSTS_OUTPUT=$(docker exec "${fid}" cat /etc/hosts || true)
  echo "----- /etc/hosts (${fid}) -----"
  echo "${HOSTS_OUTPUT}"
  echo "-------------------------------"
  if ! grep -q "orders.cdkd-sc.local" <<<"${HOSTS_OUTPUT}"; then
    echo "FAIL: frontend ${fid} /etc/hosts missing orders.cdkd-sc.local (Service Connect fqdn)"
    exit 1
  fi
  if ! grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders$" <<<"${HOSTS_OUTPUT}"; then
    echo "FAIL: frontend ${fid} /etc/hosts missing bare 'orders' alias (ClientAlias short-form)"
    exit 1
  fi
  if ! grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders-discovery\.cdkd-sc\.local$" <<<"${HOSTS_OUTPUT}"; then
    echo "FAIL: frontend ${fid} /etc/hosts missing orders-discovery.cdkd-sc.local (ServiceRegistries[] branch)"
    exit 1
  fi
  orders_ip=$(grep -oE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders$" <<<"${HOSTS_OUTPUT}" | awk '{print $1}' | head -1)
  discovery_ip=$(grep -oE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+orders-discovery\.cdkd-sc\.local$" <<<"${HOSTS_OUTPUT}" | awk '{print $1}' | head -1)
  if [[ -z "${orders_ip}" || -z "${discovery_ip}" ]]; then
    echo "FAIL: frontend ${fid} — could not extract orders / orders-discovery IP from /etc/hosts"
    exit 1
  fi
  ORDERS_ALIAS_IPS+="${orders_ip} "
  DISCOVERY_ALIAS_IPS+="${discovery_ip} "
done
echo "    OK: every frontend replica carries orders / orders.cdkd-sc.local / orders-discovery.cdkd-sc.local"

# First-replica-wins: both consumers inherit the same shared Cloud Map
# registry snapshot, so every frontend replica must resolve `orders`
# AND `orders-discovery.cdkd-sc.local` to the SAME (first-registered)
# orders replica IP. Collapsing the collected IPs with `sort -u` must
# yield exactly one IP per alias.
UNIQ_ORDERS_IPS=$(tr ' ' '\n' <<<"${ORDERS_ALIAS_IPS}" | grep -v '^$' | sort -u)
UNIQ_DISCOVERY_IPS=$(tr ' ' '\n' <<<"${DISCOVERY_ALIAS_IPS}" | grep -v '^$' | sort -u)
if [[ "$(wc -l <<<"${UNIQ_ORDERS_IPS}" | tr -d ' ')" -ne 1 ]]; then
  echo "FAIL: frontend replicas disagree on the 'orders' alias IP (expected one first-wins IP): ${ORDERS_ALIAS_IPS}"
  exit 1
fi
if [[ "$(wc -l <<<"${UNIQ_DISCOVERY_IPS}" | tr -d ' ')" -ne 1 ]]; then
  echo "FAIL: frontend replicas disagree on the 'orders-discovery.cdkd-sc.local' alias IP: ${DISCOVERY_ALIAS_IPS}"
  exit 1
fi
# The winning alias IP must be a REAL orders container IP, and both
# aliases (Service Connect + Cloud Map) must point at the same replica.
WIN_IP="${UNIQ_ORDERS_IPS}"
MATCHED=0
for ip in ${ORDERS_IPS}; do
  if [[ "${ip}" == "${WIN_IP}" ]]; then MATCHED=1; break; fi
done
if [[ "${MATCHED}" -ne 1 ]]; then
  echo "FAIL: winning 'orders' alias IP ${WIN_IP} is not any orders container IP (${ORDERS_IPS})"
  exit 1
fi
if [[ "${UNIQ_DISCOVERY_IPS}" != "${WIN_IP}" ]]; then
  echo "FAIL: orders-discovery alias IP (${UNIQ_DISCOVERY_IPS}) != orders alias IP (${WIN_IP}); both should point at the first-registered orders replica"
  exit 1
fi
echo "    OK: every frontend replica resolves orders + orders-discovery to the same orders replica IP ${WIN_IP} (first-replica-wins verified)"

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
