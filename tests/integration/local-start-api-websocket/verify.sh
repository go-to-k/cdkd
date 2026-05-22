#!/usr/bin/env bash
# verify.sh — local-start-api WebSocket integ test (#462)
#
# Exercises `cdkd local start-api`'s WebSocket support end-to-end against
# Docker + the AWS Lambda Node.js base image (which bundles RIE AND the
# @aws-sdk/client-apigatewaymanagementapi client). No AWS deploy.
#
# Run via `/run-integ local-start-api-websocket` (recommended) or directly:
#
#     bash tests/integration/local-start-api-websocket/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"
PORT=3838

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  pnpm install --ignore-workspace --prefer-offline
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
  # Defense-in-depth: kill every cdkd-local-* container that survived
  # the graceful shutdown.
  ORPHANS=$(docker ps --filter "name=cdkd-local-" --format "{{.ID}}" 2>/dev/null || true)
  if [[ -n "${ORPHANS}" ]]; then
    echo "==> Cleaning up orphan containers"
    echo "${ORPHANS}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
  rm -f "$(pwd)/.ws-client.mjs"
}
trap cleanup EXIT INT TERM

echo "==> Starting cdkd local start-api on port ${PORT}"
${CDKD} local start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for the WebSocket server to come up"
READY=0
for i in $(seq 1 60); do
  if grep -q "Server listening on ws" "${LOG_FILE}" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: WebSocket server did not come up within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -80 "${LOG_FILE}" | sed 's/^/    /'

# Extract the ws:// URL from the listening banner.
WS_URL=$(grep -E "^Server listening on ws" "${LOG_FILE}" | head -1 | sed -E 's/^Server listening on (ws[s]?:\/\/[^[:space:]]+).*/\1/')
if [[ -z "${WS_URL}" ]]; then
  echo "FAIL: could not parse ws:// URL from listening banner"
  cat "${LOG_FILE}"
  exit 1
fi
echo "==> WebSocket URL: ${WS_URL}"

# Use Node + the `ws` client (already in node_modules) to drive the
# WebSocket handshake + message round-trips. Written into the fixture
# dir so `import 'ws'` resolves against the local node_modules (a
# /tmp path can't see our pnpm-installed deps).
CLIENT_SCRIPT="$(pwd)/.ws-client.mjs"
cat > "${CLIENT_SCRIPT}" <<'NODE'
import { WebSocket } from 'ws';

const url = process.argv[2];
if (!url) {
  console.error('Usage: client.mjs <ws-url>');
  process.exit(2);
}

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const messages = [];

const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
console.log('CONNECTED');

ws.on('message', (data) => {
  const text = data.toString('utf-8');
  console.log('GOT:', text);
  messages.push(text);
});

// Test 1: sendMessage route — server should reply via PostToConnection.
ws.send(JSON.stringify({ action: 'sendMessage', text: 'hello-from-client' }));
await withTimeout(
  new Promise((resolve) => {
    const check = () => {
      if (messages.some((m) => m.includes('"echo":"hello-from-client"'))) resolve();
      else setTimeout(check, 100);
    };
    check();
  }),
  60_000,
  'sendMessage echo'
);
console.log('PASS: sendMessage echo received');

// Test 2: broadcast route — server should push back via PostToConnection.
ws.send(JSON.stringify({ action: 'broadcast' }));
await withTimeout(
  new Promise((resolve) => {
    const check = () => {
      if (messages.some((m) => m.includes('"route":"broadcast"'))) resolve();
      else setTimeout(check, 100);
    };
    check();
  }),
  60_000,
  'broadcast response'
);
console.log('PASS: broadcast response received');

// Test 3: unknown action → should fall through to $default which
// also replies via PostToConnection.
ws.send(JSON.stringify({ action: 'unknown-route', foo: 'bar' }));
await withTimeout(
  new Promise((resolve) => {
    const check = () => {
      if (messages.some((m) => m.includes('"route":"$default"'))) resolve();
      else setTimeout(check, 100);
    };
    check();
  }),
  60_000,
  '$default fallback'
);
console.log('PASS: $default fallback received');

// Clean close
ws.close(1000, 'test-complete');
await new Promise((resolve) => ws.once('close', resolve));
console.log('PASS: socket closed cleanly');
NODE

echo "==> Running WebSocket client tests"
if ! node "${CLIENT_SCRIPT}" "${WS_URL}"; then
  echo "FAIL: client test failed. Full server log:"
  echo "----- SERVER LOG -----"
  cat "${LOG_FILE}"
  echo "----- END LOG -----"
  exit 1
fi
rm -f "${CLIENT_SCRIPT}"

echo ""
echo "==> All WebSocket assertions passed"
