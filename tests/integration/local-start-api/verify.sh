#!/usr/bin/env bash
# verify.sh — local-start-api integ test
#
# Like local-invoke, this integ deploys nothing — it exercises
# `cdkd local start-api` end-to-end against Docker + the AWS Lambda
# Node.js base image (which bundles RIE).
#
# Run via `/run-integ local-start-api` (recommended) or directly:
#
#     bash tests/integration/local-start-api/verify.sh
#
# Requires Docker.
#
# Robust cleanup: SIGTERM -> 120s grace -> SIGKILL on the server, plus a
# defense-in-depth `docker ps --filter name=cdkd-local-` sweep so a
# crashed test never leaves orphan containers behind.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3737

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Container-host on Linux is 'host.docker.internal' but only resolves
# automatically on Docker Desktop. The server defaults to that, but
# Linux CI hosts (or any docker daemon without the magic alias) need
# the explicit `--add-host` plumbing — out of scope for v1, so we use
# 127.0.0.1 here. This matches what the local-invoke integ does.
CONTAINER_HOST="127.0.0.1"

LOG_FILE="$(mktemp)"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to server (pid ${SERVER_PID})"
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for i in $(seq 1 120); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "==> Server did not exit within 120s; SIGKILL"
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
  fi
  # Defense-in-depth: kill every cdkd-local-* container regardless of
  # how the server cleaned up. This catches the case where the server
  # crashed before its dispose() ran.
  ORPHANS=$(docker ps --filter "name=cdkd-local-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT INT TERM

echo "==> Starting cdkd local start-api on port ${PORT}"
${CDKD} local start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Wait for the "Server listening" line — D8.4 marker.
echo "==> Waiting for server to come up"
READY=0
for i in $(seq 1 60); do
  if grep -q "Server listening" "${LOG_FILE}"; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: server did not print 'Server listening' within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -30 "${LOG_FILE}" | sed 's/^/    /'

# Verify the route table contains every route. Use plain `grep -F` so
# the `{proxy+}` curly-braces and slashes don't need to be escaped.
echo "==> Asserting discovered routes"
EXPECTED_ROUTES=(
  "GET     /items"
  "POST    /items"
  "GET     /items/{id}"
  "ANY     /v1/{proxy+}"
  "ANY     /{proxy+}"
)
for line in "${EXPECTED_ROUTES[@]}"; do
  if ! grep -F "${line}" "${LOG_FILE}" >/dev/null; then
    echo "FAIL: missing route in route table: ${line}"
    cat "${LOG_FILE}"
    exit 1
  fi
done

# Smoke-test the routes via curl. The Items handler returns a small JSON
# body; greedy proxy returns a constant; FunctionURL returns a constant.
# Each curl is wrapped in a retry loop because RIE container boot from
# cold can be slow (~3-5s) on the first request.
curl_assert() {
  local label="$1"
  local url="$2"
  local needle="$3"
  shift 3
  local response=""
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if response=$(curl -sf "$@" "${url}" 2>&1); then
      if echo "${response}" | grep -q "${needle}"; then
        echo "    [${label}] OK"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} did not match ${needle}. Last response: ${response}"
  cat "${LOG_FILE}"
  return 1
}

echo "==> Smoke-testing routes via curl"
curl_assert "GET /items/42" "http://127.0.0.1:${PORT}/items/42" '"id":"42"'
curl_assert "POST /items" "http://127.0.0.1:${PORT}/items" '"x":1' \
  -X POST -H 'Content-Type: application/json' -d '{"x":1}'
curl_assert "ANY /v1/anything" "http://127.0.0.1:${PORT}/v1/anything" '"routedVia":"rest-v1"'
# Function URL is mounted at /{proxy+} so any other path lands there.
# After the literal /v1 prefix has been claimed by the REST route, the
# proxy fallback only fires on paths that don't match REST — try a
# distinct prefix.
curl_assert "Function URL fallback" "http://127.0.0.1:${PORT}/url-only/ping" '"functionUrl":true'

echo ""
echo "==> All local-start-api smoke tests passed"
