#!/usr/bin/env bash
# verify.sh — local-start-api-rest-v1-non-proxy integ test (#457)
#
# Exercises `cdkd local start-api`'s REST v1 non-AWS_PROXY integration
# support end-to-end against Docker + the AWS Lambda Node.js base image
# (which bundles RIE).
#
# Routes covered:
#   - GET /mock-200  -> MOCK integration with request-template-driven
#                       statusCode + response-template VTL.
#   - GET /mock-404  -> same, asserts 404 selection.
#   - GET /http-proxy -> HTTP_PROXY to httpbin.org (tolerant of network
#                       isolation — accepts 200 OR 502).
#   - POST /aws-lambda -> AWS Lambda non-proxy integration with
#                         request-side AND response-side VTL.
#
# Run via `/run-integ local-start-api-rest-v1-non-proxy` (recommended)
# or directly:
#
#     bash tests/integration/local-start-api-rest-v1-non-proxy/verify.sh
#
# Requires Docker. No AWS deploy.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3738

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

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
  # Defense-in-depth: kill any cdkd-local-* container the server didn't
  # clean up on its own (the existing local-start-api integ uses the
  # same sweep).
  echo "==> Sweeping any orphan cdkd-local-* docker containers"
  docker ps --filter name=cdkd-local- -q | xargs -r docker rm -f >/dev/null 2>&1 || true

  if [[ -f "${LOG_FILE}" ]]; then
    echo "==> Server log (${LOG_FILE}):"
    cat "${LOG_FILE}" || true
    rm -f "${LOG_FILE}"
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Booting cdkd local start-api on ${CONTAINER_HOST}:${PORT}"
${CDKD} local start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Wait for the listening banner.
echo "==> Waiting for server to listen"
for i in $(seq 1 60); do
  if grep -q "Server listening on http://${CONTAINER_HOST}:${PORT}" "${LOG_FILE}" 2>/dev/null; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Server exited unexpectedly"
    exit 1
  fi
  sleep 1
done

if ! grep -q "Server listening" "${LOG_FILE}"; then
  echo "==> Server did not produce listening banner within 60s"
  exit 1
fi

BASE_URL="http://${CONTAINER_HOST}:${PORT}"

assert_status() {
  local url="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  local extra_headers=("${@:4}")
  if [[ "${method}" == "GET" ]]; then
    curl -sS -o /tmp/resp.body -w "%{http_code}\n%{content_type}\n" "${url}"
  else
    curl -sS -o /tmp/resp.body -w "%{http_code}\n%{content_type}\n" \
      -X "${method}" -H 'Content-Type: application/json' -d "${body}" "${url}"
  fi
}

echo "==> Curl GET ${BASE_URL}/mock-200"
OUT="$(assert_status "${BASE_URL}/mock-200")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 from /mock-200, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
if ! echo "${BODY}" | grep -q '"source":"mock"'; then
  echo "FAIL: /mock-200 body does not contain source=mock; body was: ${BODY}"
  exit 1
fi

echo "==> Curl GET ${BASE_URL}/mock-404"
OUT="$(assert_status "${BASE_URL}/mock-404")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "404" ]]; then
  echo "FAIL: expected 404 from /mock-404 (driven by request-template statusCode), got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
if ! echo "${BODY}" | grep -q 'not found'; then
  echo "FAIL: /mock-404 body does not contain the 404 response template content; body was: ${BODY}"
  exit 1
fi

echo "==> Curl GET ${BASE_URL}/http-proxy (tolerates network isolation)"
OUT="$(assert_status "${BASE_URL}/http-proxy")"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" && "${STATUS}" != "502" ]]; then
  echo "FAIL: expected 200 (network reachable) or 502 (network isolated) from /http-proxy, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi

echo "==> Curl POST ${BASE_URL}/aws-lambda"
OUT="$(assert_status "${BASE_URL}/aws-lambda" POST '{"action":"greet","name":"Alice"}')"
STATUS="$(echo "${OUT}" | sed -n '1p')"
echo "    status=${STATUS}"
if [[ "${STATUS}" != "200" ]]; then
  echo "FAIL: expected 200 from /aws-lambda, got ${STATUS}"
  cat /tmp/resp.body
  exit 1
fi
BODY="$(cat /tmp/resp.body)"
echo "    body=${BODY}"
# Response template wraps the Lambda's `greeting` into {"data": <value>}.
# Verifies request-side VTL extracted `name` AND response-side VTL ran.
if ! echo "${BODY}" | grep -q 'Hello, Alice'; then
  echo "FAIL: /aws-lambda body does not show the round-tripped greeting; body was: ${BODY}"
  exit 1
fi
if ! echo "${BODY}" | grep -q '"data"'; then
  echo "FAIL: /aws-lambda body does not show the response-template wrapping; body was: ${BODY}"
  exit 1
fi

echo "==> All REST v1 non-AWS_PROXY integration assertions passed (#457)"
