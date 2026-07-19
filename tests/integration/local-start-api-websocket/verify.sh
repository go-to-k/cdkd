#!/usr/bin/env bash
# verify.sh — local-start-api WebSocket integ test (#462, #528)
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
#
# #528 expansion: each scenario is wrapped in a `stage_*` function so a
# failure surfaces which path broke. Stages:
#   stage_basic         — 1 client / sendMessage echo / broadcast /
#                         $default fallback / clean close
#   stage_multi_client  — M4: 2 clients, broadcast from A reaches B
#   stage_deny          — M5: $connect returns 403, client sees close 1008
#   stage_disconnect    — M6: $disconnect Lambda fires (server log marker)
#   stage_drain         — registry drops the entry on close (GET → 410)
#   stage_large_payload — 64KB frame survives the dispatch path
#   stage_sigterm_fast  — server exits within 7s of SIGTERM (no defensive
#                         timeout fires under a clean state)

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
SIGTERM_ELAPSED=""

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to server (pid ${SERVER_PID})"
    local t0
    t0=$(date +%s)
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${SERVER_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      echo "==> Server did not exit within 120s; SIGKILL"
      kill -KILL "${SERVER_PID}" 2>/dev/null || true
    fi
    SIGTERM_ELAPSED=$(( $(date +%s) - t0 ))
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
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Starting cdkd local start-api on port ${PORT}"
${CDKD} local start-api \
  --port "${PORT}" \
  --container-host "${CONTAINER_HOST}" \
  --no-pull \
  >"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

echo "==> Waiting for the WebSocket server to come up"
READY=0
for _ in $(seq 1 60); do
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

# The shared @connections HTTP endpoint URL (same host + port as the
# WebSocket; the mgmt-api pre-pass intercepts /<stage>/@connections/<id>).
HTTP_BASE="http${WS_URL#ws}"

# All client scripts go into a single file written into the fixture dir
# so `import 'ws'` resolves against the local node_modules (a /tmp path
# can't see our pnpm-installed deps).
CLIENT_SCRIPT="$(pwd)/.ws-client.mjs"
cat > "${CLIENT_SCRIPT}" <<'NODE'
import { WebSocket } from 'ws';

const url = process.argv[2];
const mode = process.argv[3] ?? 'basic';
if (!url) {
  console.error('Usage: client.mjs <ws-url> <mode>');
  process.exit(2);
}

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms waiting for ${label}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function openWs(targetUrl, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl);
    const messages = [];
    let closeInfo = null;
    let errorInfo = null;
    ws.on('message', (data) => {
      const text = data.toString('utf-8');
      console.log(`[${label}] GOT:`, text.slice(0, 200));
      messages.push(text);
    });
    ws.once('open', () => {
      console.log(`[${label}] CONNECTED`);
      resolve({ ws, messages, getClose: () => closeInfo, getError: () => errorInfo });
    });
    ws.once('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString('utf-8') };
      console.log(`[${label}] CLOSED code=${code} reason=${closeInfo.reason}`);
    });
    ws.once('error', (err) => {
      errorInfo = err;
      console.log(`[${label}] ERROR:`, err.message);
    });
    setTimeout(() => reject(new Error(`Timeout opening ${label}`)), 20_000);
  });
}

async function discoverConnectionId(client) {
  client.ws.send(JSON.stringify({ action: 'sendMessage', text: 'whoami' }));
  await withTimeout(
    new Promise((resolve) => {
      const check = () => {
        if (client.messages.some((m) => m.includes('"route":"sendMessage"'))) resolve();
        else setTimeout(check, 50);
      };
      check();
    }),
    30_000,
    'whoami echo'
  );
  for (const m of client.messages) {
    try {
      const parsed = JSON.parse(m);
      if (parsed.route === 'sendMessage' && typeof parsed.connectionId === 'string') {
        return parsed.connectionId;
      }
    } catch {
      /* skip non-JSON */
    }
  }
  throw new Error('connectionId not found in sendMessage echo');
}

function waitForMessage(client, predicate, label, ms = 60_000) {
  return withTimeout(
    new Promise((resolve) => {
      const check = () => {
        if (client.messages.some(predicate)) resolve();
        else setTimeout(check, 50);
      };
      check();
    }),
    ms,
    label
  );
}

async function runBasic() {
  const c = await openWs(url, 'basic');
  c.ws.send(JSON.stringify({ action: 'sendMessage', text: 'hello-from-client' }));
  await waitForMessage(c, (m) => m.includes('"echo":"hello-from-client"'), 'sendMessage echo');
  console.log('PASS: sendMessage echo received');

  c.ws.send(JSON.stringify({ action: 'broadcast' }));
  await waitForMessage(c, (m) => m.includes('"route":"broadcast"'), 'broadcast response');
  console.log('PASS: broadcast self-reply received (no recipients = sender-only)');

  c.ws.send(JSON.stringify({ action: 'unknown-route', foo: 'bar' }));
  await waitForMessage(c, (m) => m.includes('"route":"$default"'), '$default fallback');
  console.log('PASS: $default fallback received');

  c.ws.close(1000, 'test-complete');
  await withTimeout(
    new Promise((resolve) => {
      const check = () => (c.getClose() ? resolve() : setTimeout(check, 50));
      check();
    }),
    5_000,
    'clean close'
  );
  console.log('PASS: socket closed cleanly');
}

// M4: multi-client broadcast — A broadcasts to B.
async function runMultiClient() {
  const a = await openWs(url, 'A');
  const b = await openWs(url, 'B');

  const idA = await discoverConnectionId(a);
  const idB = await discoverConnectionId(b);
  console.log(`PASS: discovered connection ids A=${idA} B=${idB}`);
  if (idA === idB) throw new Error(`A and B got the same connectionId ${idA}`);

  // Count B's broadcast messages before — A's whoami / B's whoami
  // are NOT broadcast frames, so the count should be 0.
  const before = b.messages.filter((m) => m.includes('"route":"broadcast"')).length;
  if (before !== 0) throw new Error(`B already has broadcast messages: ${before}`);

  // A broadcasts to [B] only.
  a.ws.send(JSON.stringify({ action: 'broadcast', recipients: [idB] }));
  await waitForMessage(
    b,
    (m) => m.includes('"route":"broadcast"') && m.includes(`"from":"${idA}"`),
    'B receives broadcast from A'
  );
  console.log('PASS: B received broadcast from A');

  // A should NOT receive its own broadcast when only B is in recipients.
  await new Promise((r) => setTimeout(r, 300));
  const aReceived = a.messages.filter((m) => m.includes('"route":"broadcast"')).length;
  if (aReceived !== 0) throw new Error(`A unexpectedly received broadcast (${aReceived})`);
  console.log('PASS: A did not receive its own targeted broadcast');

  a.ws.close(1000, 'A-done');
  b.ws.close(1000, 'B-done');
  await new Promise((r) => setTimeout(r, 200));
}

// M5: $connect deny path — handshake completes but cdkd closes with 1008.
async function runDeny() {
  const denyUrl = `${url}?reject=true`;
  const ws = new WebSocket(denyUrl);
  let closeCode = -1;
  let errFired = false;
  await new Promise((resolve) => {
    ws.once('close', (code) => {
      closeCode = code;
      resolve();
    });
    ws.once('error', () => {
      errFired = true;
    });
    setTimeout(resolve, 15_000);
  });
  if (closeCode !== 1008) {
    throw new Error(`Expected close code 1008 (policy violation) on deny, got ${closeCode}`);
  }
  console.log(`PASS: $connect deny produced close 1008 (errFired=${errFired})`);
}

// Large payload — 64KB body sent through the dispatch path.
async function runLargePayload() {
  const c = await openWs(url, 'large');
  const payloadText = 'x'.repeat(64 * 1024);
  c.ws.send(JSON.stringify({ action: 'unknown-large', text: payloadText }));
  await waitForMessage(
    c,
    (m) => m.includes('"route":"$default"') && m.length >= 64 * 1024,
    '$default echo of 64KB payload'
  );
  console.log(`PASS: 64KB payload echoed via $default (largest message=${c.messages.reduce((max, m) => Math.max(max, m.length), 0)} bytes)`);
  c.ws.close(1000);
  await new Promise((r) => setTimeout(r, 200));
}

// Registry drain — after close, GET /@connections/<id> returns 410.
async function runRegistryDrain() {
  const c = await openWs(url, 'drain');
  const id = await discoverConnectionId(c);
  console.log(`PASS: discovered connection id for drain test: ${id}`);
  c.ws.close(1000);
  await new Promise((r) => setTimeout(r, 500));
  const httpBase = process.argv[4];
  if (!httpBase) throw new Error('http base URL not provided as argv[4]');
  const res = await fetch(`${httpBase}/@connections/${id}`);
  if (res.status !== 410) {
    throw new Error(`Expected 410 on drained connection, got ${res.status}`);
  }
  console.log('PASS: drained connection returns 410');
}

switch (mode) {
  case 'basic':
    await runBasic();
    break;
  case 'multi-client':
    await runMultiClient();
    break;
  case 'deny':
    await runDeny();
    break;
  case 'large-payload':
    await runLargePayload();
    break;
  case 'registry-drain':
    await runRegistryDrain();
    break;
  default:
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}
NODE

run_client() {
  local stage="$1"
  local mode="$2"
  echo ""
  echo "==> Stage: ${stage}"
  if ! node "${CLIENT_SCRIPT}" "${WS_URL}" "${mode}" "${HTTP_BASE}"; then
    echo "FAIL: ${stage} stage failed. Full server log:"
    echo "----- SERVER LOG -----"
    cat "${LOG_FILE}"
    echo "----- END LOG -----"
    exit 1
  fi
}

# stage_basic — preserves the existing 1-client smoke test.
run_client "stage_basic" basic

# M4: stage_multi_client
run_client "stage_multi_client" multi-client

# M5: stage_deny
run_client "stage_deny" deny

# Large payload
run_client "stage_large_payload" large-payload

# Registry drain
run_client "stage_registry_drain" registry-drain

# M6: stage_disconnect — assert lambda-disconnect actually fired during
# at least one of the above clean-close paths. The server log captures
# every container stdout line via `docker logs -f`; lambda-disconnect's
# `console.log('$disconnect:', ...)` lands in LOG_FILE.
echo ""
echo "==> Stage: stage_disconnect"
DISCONNECT_COUNT=$(grep -c '[$]disconnect:' "${LOG_FILE}" || true)
if [[ "${DISCONNECT_COUNT}" -lt 1 ]]; then
  echo "FAIL: lambda-disconnect handler never fired (looked for '\$disconnect:' marker in server log)."
  echo "----- SERVER LOG -----"
  cat "${LOG_FILE}"
  echo "----- END LOG -----"
  exit 1
fi
echo "PASS: lambda-disconnect fired ${DISCONNECT_COUNT} time(s) across the stages"

rm -f "${CLIENT_SCRIPT}"

echo ""
echo "==> All WebSocket assertions passed"

# stage_sigterm_fast — the cleanup trap will SIGTERM the server when the
# script exits. The trap captures SIGTERM_ELAPSED; we verify it is <7s
# (M3 sets SHUTDOWN_DRAIN_MS=5s, plus a 2s buffer for the close-frame
# round-trip + wss.close cleanup). A wedged shutdown that hits the
# 120s SIGKILL would pass verify.sh silently pre-PR; this assertion
# fires post-cleanup to catch that regression.
cleanup_and_assert_sigterm_fast() {
  cleanup
  if [[ -n "${SIGTERM_ELAPSED}" ]]; then
    echo "==> Stage: stage_sigterm_fast (elapsed=${SIGTERM_ELAPSED}s)"
    if [[ "${SIGTERM_ELAPSED}" -ge 7 ]]; then
      echo "FAIL: stage_sigterm_fast — server took ${SIGTERM_ELAPSED}s to exit (expected <7s, $(($SIGTERM_ELAPSED - 5))s past the 5s drain ceiling)."
      exit 1
    fi
    echo "PASS: stage_sigterm_fast — server exited within ${SIGTERM_ELAPSED}s"
  fi
}
trap cleanup_and_assert_sigterm_fast EXIT
trap '(exit 130); cleanup_and_assert_sigterm_fast; exit 130' INT
trap '(exit 143); cleanup_and_assert_sigterm_fast; exit 143' TERM
