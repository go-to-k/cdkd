#!/usr/bin/env bash
# verify.sh — cdkd local start-service Phase 2 integ test (no AWS deploy)
#
# Boots a 2-replica ECS Service emulator backed by busybox heartbeat
# containers. Asserts both replicas reach docker, then SIGTERMs cdkd and
# asserts clean teardown (no leftover containers / networks / sidecars).
#
#     bash tests/integration/local-start-service/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

# Orphan sweep — always runs even if the service was already killed.
cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKD_PID:-}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    # Give cdkd up to 30s to clean up gracefully.
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
${CDKD} synth >/dev/null

# Capture the service output so we can grep for the boot banner.
OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Booting service (DesiredCount=2)"
${CDKD} local start-service CdkdLocalStartServiceFixture:WebService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

# Wait for the service boot banner. The runner prints
# "Service '...' running with N active replica(s)" once startEcsService
# returns; that's the deterministic ready marker.
echo "==> Waiting for boot banner (up to 60s)"
BOOTED=0
for i in $(seq 1 60); do
  if grep -q "running with .* active replica" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  # If cdkd exited early, fail fast.
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
  echo "FAIL: service did not reach the boot banner within 60s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting 2 replicas (4 containers: 2 web + 2 metadata sidecars)"
# Each replica gets its own docker network + sidecar, plus 1 web container.
# We assert at least 2 'web'-image containers running under the cdkd-local
# prefix; the sidecar count is incidental.
WEB_COUNT=$(docker ps --filter "ancestor=${BUSYBOX_IMAGE}" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${WEB_COUNT}" -lt 2 ]]; then
  echo "FAIL: expected at least 2 busybox 'web' containers running, found ${WEB_COUNT}"
  docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: ${WEB_COUNT} busybox web containers running"

echo "==> Asserting per-replica docker networks (2 networks expected)"
NET_COUNT=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${NET_COUNT}" -lt 2 ]]; then
  echo "FAIL: expected at least 2 cdkd-local-* docker networks, found ${NET_COUNT}"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi
echo "    OK: ${NET_COUNT} per-replica networks present"

echo "==> Asserting per-replica subnet isolation (each network has a distinct /24 in 169.254.170-253)"
# Regression guard for the per-replica subnet allocator in
# ecs-service-runner.ts (`170 + (index % 84)`). The pre-PR assertion
# only counted networks, so a collapsed allocator that put every
# replica on the same /24 would still pass. Walk every network's
# IPAM.Config[0].Subnet and assert (a) they are all distinct AND (b)
# each is in the expected 169.254.<170-253>.0/24 range that
# `buildReplicaSubnet(index)` allocates.
NET_IDS=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}')
declare -a SUBNETS=()
for net_id in ${NET_IDS}; do
  SUBNET=$(docker network inspect "${net_id}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || echo "")
  if [[ -z "${SUBNET}" ]]; then
    echo "FAIL: docker network ${net_id} has no IPAM.Config[0].Subnet"
    docker network inspect "${net_id}"
    exit 1
  fi
  echo "    network ${net_id}: subnet=${SUBNET}"
  # Assert the subnet falls inside the allocator's range. The allocator
  # emits `169.254.<170 + (index % 84)>.0/24` so the third octet must
  # be in 170..253 inclusive.
  if [[ ! "${SUBNET}" =~ ^169\.254\.([0-9]+)\.0/24$ ]]; then
    echo "FAIL: subnet ${SUBNET} for network ${net_id} is not in the expected 169.254.X.0/24 shape"
    exit 1
  fi
  OCTET="${BASH_REMATCH[1]}"
  if (( OCTET < 170 || OCTET > 253 )); then
    echo "FAIL: subnet ${SUBNET} third octet ${OCTET} is outside the allocator range 170..253"
    exit 1
  fi
  SUBNETS+=("${SUBNET}")
done

# Assert every subnet is distinct (no duplicates). Sort + uniq + count.
UNIQUE_SUBNET_COUNT=$(printf '%s\n' "${SUBNETS[@]}" | sort -u | wc -l | tr -d ' ')
if [[ "${UNIQUE_SUBNET_COUNT}" -ne "${#SUBNETS[@]}" ]]; then
  echo "FAIL: detected duplicate subnets across replicas — subnet allocator regression"
  printf '    %s\n' "${SUBNETS[@]}"
  exit 1
fi
echo "    OK: ${UNIQUE_SUBNET_COUNT} distinct subnets across ${#SUBNETS[@]} networks"

echo "==> Sending SIGTERM to cdkd ($(echo $CDKD_PID))"
kill -TERM "${CDKD_PID}"

# Wait for cdkd to exit cleanly.
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
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
# Reap the exit status so wait/kill -0 doesn't keep firing during the
# cleanup trap.
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

echo ""
echo "==> local-start-service test passed (2 replicas booted, both cleaned up on SIGTERM)"
