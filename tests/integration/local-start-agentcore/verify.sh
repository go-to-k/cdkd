#!/usr/bin/env bash
#
# verify.sh — local-start-agentcore integ test (issues #765 / #766)
#
# Real-Docker validation for `cdkd local start-agentcore` — the long-running
# serve that boots a Bedrock AgentCore Runtime container and fronts its /ws
# WebSocket endpoint with a host bridge so a header-less client (the browser
# path) can hold an interactive multi-frame session.
#
# Fully local — no AWS resources are deployed. The fixture's single
# HTTP-protocol Runtime (EchoAgent) is built from a local Dockerfile; the
# container serves GET /ping + a /ws REPL. The probe connects with the Node
# global WebSocket (no custom headers, exactly like a browser) and asserts:
#   - the bridge injects a session-id on the container /ws upgrade
#     (the header-less client never sent one)
#   - a second frame round-trips through the bridge (loop-echo:<text>)
# Then SIGTERM is sent and we assert no `cdkd-local-agentcore-*` container leaks.
#
# Run via `/run-integ local-start-agentcore` (recommended) or directly:
#
#     bash tests/integration/local-start-agentcore/verify.sh
#
# Requires Docker. The build pulls a small node base image the first time.

set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-start-agentcore"
CLI="node ${REPO_ROOT}/dist/cli.js"
STACK="CdkLocalStartAgentCoreFixture"
TARGET="${STACK}/EchoAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

CLI_PID=""
OUT_FILE="$(mktemp)"

stop_server() {
  if [ -n "${CLI_PID}" ] && kill -0 "${CLI_PID}" 2>/dev/null; then
    kill -TERM "${CLI_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "${CLI_PID}" 2>/dev/null || break; sleep 0.25; done
    kill -KILL "${CLI_PID}" 2>/dev/null || true
  fi
  CLI_PID=""
}

cleanup() {
  rc=$?
  stop_server
  rm -f "${OUT_FILE}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkd output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "[verify] step 1: install fixture deps"
[ -d node_modules ] || vp install --prefer-offline

echo "[verify] step 2: Docker available + base image present"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null

echo "[verify] step 3: boot \`cdkd local start-agentcore ${TARGET}\`"
: > "${OUT_FILE}"
${CLI} local start-agentcore "${TARGET}" --host 127.0.0.1 --port 0 > "${OUT_FILE}" 2>&1 &
CLI_PID=$!

WS_URL=""
for _ in $(seq 1 480); do
  # Ready line: "Server listening on ws://127.0.0.1:<port>/ws  (EchoAgent (AgentCore WebSocket))"
  line="$(grep -Eo 'Server listening on ws://[^ ]+/ws' "${OUT_FILE}" | head -1 || true)"
  if [ -n "${line}" ]; then WS_URL="${line#Server listening on }"; break; fi
  kill -0 "${CLI_PID}" 2>/dev/null || fail "start-agentcore exited before it was ready"
  sleep 0.5
done
[ -n "${WS_URL}" ] || fail "start-agentcore did not print its ws:// ready banner in time"
echo "[verify]   ready: ${WS_URL}"

echo "[verify] step 4: header-less WebSocket probe (browser path) round-trips through the bridge"
if ! node ws-probe.mjs "${WS_URL}"; then
  fail "WebSocket probe did not succeed"
fi

echo "[verify] step 5: SIGTERM tears the container down (no orphan)"
stop_server
# Give Docker a moment to reflect the removal.
sleep 1
ORPHANS="$(docker ps -a --filter name=cdkd-local-agentcore- --format '{{.Names}}' || true)"
[ -z "${ORPHANS}" ] || fail "leftover agent container(s) after shutdown: ${ORPHANS}"

echo "[verify] PASS: start-agentcore served /ws through the bridge (session-id injected, frame round-trip) and cleaned up its container"
