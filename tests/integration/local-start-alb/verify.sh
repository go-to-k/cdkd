#!/usr/bin/env bash
# verify.sh — cdkd local start-alb pure-local integ test (Issue #86 v1)
#
# Boots the local ALB front-door over a 1-service / 1-target-group /
# 1-listener fixture, asserts the front-door routes an inbound HTTP
# request to the backing ECS service's container, and SIGTERMs cdkd to
# assert clean teardown.
#
# No AWS resources are deployed — the fixture's CFn template is read
# locally by `cdkd local start-alb` to plan the front-door + boot the
# backing container via docker. The listener port (80) is remapped to
# host port 8080 via `--lb-port 80=8080` so the bind succeeds without
# root on macOS / non-privileged Linux.
#
# Run via `/run-integ local-start-alb` (recommended) or directly:
#
#     bash tests/integration/local-start-alb/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
TARGET="CdkdLocalStartAlbFixture:Alb"
HOST_PORT=8080
EXPECTED_BANNER="OK from cdkd-local-start-alb-fixture"

# Orphan sweep — always runs even if the service was already killed.
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
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Capture the service output so we can grep for boot banners.
OUT_FILE=$(mktemp)
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT

echo "==> Booting cdkd local start-alb (listener 80 -> host ${HOST_PORT})"
${CDKD} local start-alb "${TARGET}" \
  --lb-port "80=${HOST_PORT}" \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

# Wait for the service boot banner. The CLI prints
# "Service(s) running: <Name> (N replica(s))." once every target's
# controller has been started — that's the deterministic ready marker.
echo "==> Waiting for boot banner (up to 90s)"
BOOTED=0
for _ in $(seq 1 90); do
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
  echo "FAIL: service did not reach the boot banner within 90s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

# Assert the front-door listening banner names the remapped host port.
if ! grep -qE "ALB front-door: https?://[^[:space:]]+:${HOST_PORT} " "${OUT_FILE}"; then
  echo "FAIL: expected an 'ALB front-door' banner on host port ${HOST_PORT}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Sending HTTP request to local front-door at http://127.0.0.1:${HOST_PORT}/"
# The local front-door routes the request to the backing busybox
# container, which serves a fixed banner. Retry-with-backoff because
# the front-door may flip to ready a beat before the busybox httpd
# inside the container finishes binding port 80.
RESPONSE=""
HTTP_OK=0
for attempt in $(seq 1 30); do
  if RESPONSE=$(curl --silent --show-error --max-time 5 \
        "http://127.0.0.1:${HOST_PORT}/" 2>&1); then
    if echo "${RESPONSE}" | grep -qF "${EXPECTED_BANNER}"; then
      HTTP_OK=1
      break
    fi
  fi
  sleep 1
done

if [[ "${HTTP_OK}" -ne 1 ]]; then
  echo "FAIL: front-door did not return the expected banner '${EXPECTED_BANNER}' within 30s"
  echo "    last response: ${RESPONSE}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: front-door returned the backing service's banner"

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
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
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

echo ""
echo "==> local-start-alb test passed (front-door routed inbound request to backing service; clean teardown on SIGTERM)"
