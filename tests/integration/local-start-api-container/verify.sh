#!/usr/bin/env bash
# verify.sh — local-start-api-container integ test (closes #453)
#
# Boots `cdkd local start-api` against a CDK app whose Lambdas are
# `lambda.DockerImageFunction`s (container Lambdas: one on the AWS base
# image, one on a non-AWS base, #6018), then curls their HTTP API v2 routes.
# Mirrors the structure of the local-invoke-container integ but exercises
# the long-running HTTP server
# + warm container pool path that closes #453 ("cdkd local start-api:
# container image Lambda (Code.ImageUri) support").
#
# Run via `/run-integ local-start-api-container` (recommended) or
# directly:
#
#     bash tests/integration/local-start-api-container/verify.sh
#
# Requires Docker. Deploys nothing.
#
# Robust cleanup: SIGTERM -> 120s grace -> SIGKILL on the server, plus a
# defense-in-depth `docker ps --filter name=cdkd-local-` sweep so a
# crashed test never leaves orphan containers behind.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3741
CONTAINER_HOST="127.0.0.1"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

LOG_FILE="$(mktemp)"
RIE_CACHE_HOME="$(mktemp -d)"
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
  # how the server cleaned up. Catches the case where the server
  # crashed before its dispose() ran.
  ORPHANS=$(docker ps --filter "name=cdkd-local-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
  rm -rf "${RIE_CACHE_HOME}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Starting cdkd local start-api on port ${PORT}"
# No --no-pull (go-to-k/cdkd#6018): cdkd pulls the AWS base image it copies
# the Lambda RIE out of, per function architecture. The fresh XDG_CACHE_HOME
# makes every run do that extraction for real instead of reusing a cached RIE.
XDG_CACHE_HOME="${RIE_CACHE_HOME}" ${CDKD} local start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Wait for the single HTTP API v2 server to come up. Container-Lambda
# server boot also runs `docker build` on the fixture's Dockerfile up
# front (one-time, ~10-30s on a cold cache); the readiness window is
# more generous than the ZIP-only integ.
echo "==> Waiting for HTTP API v2 server to come up (up to 120s — includes docker build)"
READY=0
for i in $(seq 1 240); do
  count=$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null) || count=0
  if [[ "${count}" -ge 1 ]]; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: server did not come up within 120s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -80 "${LOG_FILE}" | sed 's/^/    /'

# Extract the HTTP API v2 server's port. The fixture only declares one
# API so the first (and only) port mapping is what we want.
PORT_HTTP=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*HTTP API v2\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${PORT_HTTP}" ]]; then
  echo "FAIL: could not extract HTTP API v2 port. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    HTTP API v2: ${PORT_HTTP}"

# Assert the route table contains the GET / route.
echo "==> Asserting discovered route"
if ! grep -E 'GET[[:space:]]+/[[:space:]]+to[[:space:]]' "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include GET /. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

# Smoke-test via curl. Container Lambda cold-start can take 5-10s on
# the first request because the warm pool lazy-starts the container
# under the per-Lambda mutex.
curl_assert() {
  local label="$1"
  local url="$2"
  local needle="$3"
  shift 3
  local response=""
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if response=$(curl -sf "$@" "${url}" 2>&1); then
      if grep -q "${needle}" <<<"${response}"; then
        echo "    [${label}] OK  (${response})"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} did not match ${needle}. Last response: ${response}"
  cat "${LOG_FILE}"
  return 1
}

echo "==> Smoke-testing route via curl"
# fromContainer: true is the marker the app.js emits — verifies the
# request reached the container Lambda (NOT a 5xx surfaced by cdkd's
# own error handling), AND that the env-var GREETING=hello passed in
# via the CDK environment block reached the runtime.
curl_assert "GET / (container Lambda)" "http://127.0.0.1:${PORT_HTTP}/" '"fromContainer":true'
curl_assert "GET / env var" "http://127.0.0.1:${PORT_HTTP}/" '"greeting":"hello"'

# go-to-k/cdkd#6018: GET /non-aws is backed by a function on a NON-AWS base
# image with no Runtime Interface Emulator; with AWS_LAMBDA_RUNTIME_API unset
# it serves plain HTTP on :8080 answering 404. It answers here only when cdkd
# mounts an RIE and runs the image's own ENTRYPOINT + CMD under it (the args
# marker is the image CMD, which docker drops under --entrypoint).
curl_assert "GET /non-aws (non-AWS base image)" "http://127.0.0.1:${PORT_HTTP}/non-aws" '"fromNonAwsBase": true'
curl_assert "GET /non-aws image CMD" "http://127.0.0.1:${PORT_HTTP}/non-aws" '"args": \["from-image-cmd"\]'
curl_assert "GET /non-aws env var" "http://127.0.0.1:${PORT_HTTP}/non-aws" '"greeting": "from-non-aws-base"'

echo "==> All assertions passed"
