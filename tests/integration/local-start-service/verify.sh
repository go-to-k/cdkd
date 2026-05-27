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

# Pre-test orphan sweep — a failed previous run can leak cdkd-local-*
# containers / networks, and the new per-replica subnet-isolation assertion
# below counts every cdkd-local-* network, so a stranded network from the
# previous run would either inflate NET_COUNT or surface a duplicate-subnet
# false positive. Run cleanup() once at boot to guarantee a clean baseline;
# the function is idempotent (xargs -r over empty input, kill -0 short-circuit
# on the unset CDKD_PID) so it's safe to invoke without any state populated.
echo "==> Pre-test orphan sweep"
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
${CDKD} synth >/dev/null

# Capture the service output so we can grep for the boot banner.
OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Booting service (DesiredCount=2)"
${CDKD} local start-service CdkdLocalStartServiceFixture:WebService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

# Wait for the service boot banner. The CLI prints
# "Service(s) running: <Name> (N replica(s)). Press ^C to shut down."
# once every target's controller has been started — that's the
# deterministic ready marker.
echo "==> Waiting for boot banner (up to 60s)"
BOOTED=0
for i in $(seq 1 60); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
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

echo "==> Asserting one shared docker network (design § 5 Option A, PR #522)"
# Post-#522 every replica in a single CLI invocation joins ONE shared
# `cdkd-local-svc-<rand>` network so peers can reach each other by IP
# / network alias without `docker network connect` choreography. The
# pre-#522 per-replica-network shape (with the `170 + (index % 84)`
# subnet allocator + per-replica subnet isolation assertion) is gone.
NET_COUNT=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${NET_COUNT}" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 shared cdkd-local-* docker network, found ${NET_COUNT}"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi
NET_ID=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}')
SUBNET=$(docker network inspect "${NET_ID}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || echo "")
echo "    network ${NET_ID}: subnet=${SUBNET}"
# Subnet must be the shared-service `169.254.171.0/24` (SHARED_SVC_SUBNET_OCTET).
if [[ "${SUBNET}" != "169.254.171.0/24" ]]; then
  echo "FAIL: expected shared subnet 169.254.171.0/24 (SHARED_SVC_SUBNET_OCTET), got ${SUBNET}"
  exit 1
fi
echo "    OK: 1 shared network on 169.254.171.0/24"

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
