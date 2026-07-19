#!/usr/bin/env bash
#
# verify.sh — local-start-agentcore integ test (issues #765 / #766 / #775-#778)
#
# Real-Docker validation for `cdkd local start-agentcore` — the long-running
# serve that boots a Bedrock AgentCore Runtime container ONCE, keeps it WARM,
# and serves the runtime's native contract: HTTP / AGUI runtimes serve
# `POST /invocations` + `GET /ping` (proxied to the warm container) AND the
# bidirectional `/ws` WebSocket endpoint behind a host bridge, both on the same
# host port (cdk-local #454 slice 1, cdk-local#458; inherited by cdkd via the
# factory pass-through).
#
# Fully local — no AWS resources are deployed. The fixture's single
# HTTP-protocol Runtime (EchoAgent) is built from a local Dockerfile; the
# container serves GET /ping + POST /invocations + a /ws REPL, echoing the
# received session-id / Authorization / GREETING env var.
#
# The test boots the serve and asserts, against ONE warm container:
#   - the new `HTTP contract served on http://...` ready line is printed
#     (#775), alongside the verbatim `Server listening on ws://...` line
#   - GET /ping returns 200 unauthenticated (#775/#777)
#   - POST /invocations round-trips through the warm proxy, with a
#     bridge-injected session-id the curl client never sent (#775)
#   - a header-less Node global-WebSocket probe (the browser path) round-trips
#     through the /ws bridge (session-id injected, loop-echo frame) (#765)
# Then it reboots with --sigv4 and asserts the forwarded /invocations request
# carries an AWS4-HMAC-SHA256 Authorization header signed by the host (#777;
# the EchoAgent has no customJwtAuthorizer, so --sigv4 is the applicable inbound
# auth mode). Each boot ends with a SIGTERM + a no-`cdkd-local-agentcore-*`
# orphan-container assertion.
#
# Run via `/run-integ local-start-agentcore` (recommended) or directly:
#
#     bash tests/integration/local-start-agentcore/verify.sh
#
# Requires Docker (+ AWS credentials in the environment for the --sigv4 step).
# The build pulls a small node base image the first time.

set -euo pipefail

cd "$(dirname "$0")"

REPO_ROOT="$(git rev-parse --show-toplevel)"
CLI="node ${REPO_ROOT}/dist/cli.js"
STACK="CdkLocalStartAgentCoreFixture"
TARGET="${STACK}/EchoAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"

CLI_PID=""
OUT_FILE="$(mktemp)"
HTTP_URL=""
WS_URL=""

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
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- cdkd output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkd local start-agentcore` with any extra flags ($@), wait for BOTH
# the new `HTTP contract served on http://...` ready line and the verbatim
# `Server listening on ws://...` line, and set HTTP_URL / WS_URL.
boot_server() {
  : > "${OUT_FILE}"
  # shellcheck disable=SC2086
  ${CLI} local start-agentcore "${TARGET}" --host 127.0.0.1 --port 0 "$@" > "${OUT_FILE}" 2>&1 &
  CLI_PID=$!
  HTTP_URL=""
  WS_URL=""
  for _ in $(seq 1 480); do
    # Ready lines (HTTP / AGUI runtimes, both on the same port):
    #   "HTTP contract served on http://127.0.0.1:<port> — POST .../invocations, GET .../ping"
    #   "Server listening on ws://127.0.0.1:<port>/ws  (EchoAgent (AgentCore WebSocket))"
    http_line="$(grep -Eo 'HTTP contract served on http://[^ ]+' "${OUT_FILE}" | head -1 || true)"
    ws_line="$(grep -Eo 'Server listening on ws://[^ ]+/ws' "${OUT_FILE}" | head -1 || true)"
    [ -n "${http_line}" ] && HTTP_URL="${http_line#HTTP contract served on }"
    [ -n "${ws_line}" ] && WS_URL="${ws_line#Server listening on }"
    if [ -n "${HTTP_URL}" ] && [ -n "${WS_URL}" ]; then break; fi
    kill -0 "${CLI_PID}" 2>/dev/null || fail "start-agentcore exited before it was ready"
    sleep 0.5
  done
  [ -n "${HTTP_URL}" ] || fail "start-agentcore did not print its 'HTTP contract served on http://' ready banner in time"
  [ -n "${WS_URL}" ] || fail "start-agentcore did not print its ws:// ready banner in time"
}

assert_orphan_free() {
  # Give Docker a moment to reflect the removal.
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter name=cdkd-local-agentcore- --format '{{.Names}}' || true)"
  [ -z "${orphans}" ] || fail "leftover agent container(s) after shutdown: ${orphans}"
}

echo "[verify] step 1: install fixture deps"
# --ignore-workspace: the cdkd repo root declares a pnpm-workspace.yaml, so a
# plain `vp install` here hoists the fixture's aws-cdk-lib resolution to the
# repo-root's pinned version (2.244.0, which carries only the L1
# `aws-bedrockagentcore` constructs) instead of the fixture's declared
# `^2.257.0` (which carries the L2 `Runtime` / `AgentRuntimeArtifact` this
# fixture uses). Install standalone so the fixture floats to its own aws-cdk-lib.
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "[verify] step 2: Docker available + base image present"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null

echo "[verify] step 3: boot \`cdkd local start-agentcore ${TARGET}\` (warm serve)"
boot_server
echo "[verify]   ready: ${HTTP_URL} (HTTP contract) / ${WS_URL} (ws bridge)"

echo "[verify] step 4: warm HTTP contract — GET /ping (unauthenticated) returns 200"
PING_CODE="$(curl -fsS -o /dev/null -w '%{http_code}' "${HTTP_URL}/ping" || true)"
[ "${PING_CODE}" = "200" ] || fail "GET /ping returned '${PING_CODE}', expected 200"

echo "[verify] step 5: warm HTTP contract — POST /invocations round-trips through the warm proxy"
INVOKE_RESP="$(curl -fsS -X POST "${HTTP_URL}/invocations" \
  -H 'Content-Type: application/json' -d '{"hello":"http-contract"}' || true)"
echo "${INVOKE_RESP}" | grep -q 'http-contract' \
  || fail "POST /invocations did not echo the request body: ${INVOKE_RESP}"
echo "${INVOKE_RESP}" | grep -q '"greeting":"hello-from-agent"' \
  || fail "POST /invocations did not surface the GREETING env var: ${INVOKE_RESP}"
# The curl client sent no session-id header; the warm serve must inject one.
if echo "${INVOKE_RESP}" | grep -q '"sessionId":null'; then
  fail "warm serve did not inject a session-id on the forwarded request: ${INVOKE_RESP}"
fi
echo "${INVOKE_RESP}" | grep -Eq '"sessionId":"[^"]+"' \
  || fail "warm serve did not inject a session-id on the forwarded request: ${INVOKE_RESP}"

echo "[verify] step 6: header-less WebSocket probe (browser path) round-trips through the bridge"
node ws-probe.mjs "${WS_URL}" || fail "WebSocket probe did not succeed"

echo "[verify] step 7: SIGTERM tears the container down (no orphan)"
stop_server
assert_orphan_free

echo "[verify] step 8: reboot with --sigv4 — the forwarded request is SigV4-signed (#777)"
# cdk-local's --sigv4 signer reads env credentials (or --profile / --assume-role),
# not the bare default profile. CI exports AWS_ACCESS_KEY_ID directly; for a
# local profile-based setup, materialize the resolved profile's creds into the
# env via `aws configure export-credentials` (portable across env / shared /
# SSO / process profiles). Skip the assertion only when no creds resolve at all.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && command -v aws >/dev/null 2>&1; then
  CREDS_ENV="$(aws configure export-credentials --format env 2>/dev/null || true)"
  [ -n "${CREDS_ENV}" ] && eval "${CREDS_ENV}"
fi
if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  # In CI we expect creds to be present, so a silent skip there would quietly
  # drop --sigv4 coverage; fail loudly. Locally (no CI), skip is fine.
  [ -n "${CI:-}" ] && fail "no AWS credentials available to exercise --sigv4 signing (CI is set, expected creds)"
  echo "[verify]   SKIP step 8/9: no AWS credentials available to exercise --sigv4 signing"
else
  boot_server --sigv4
  echo "[verify]   ready (sigv4): ${HTTP_URL}"
  SIGV4_RESP="$(curl -fsS -X POST "${HTTP_URL}/invocations" \
    -H 'Content-Type: application/json' -d '{"hello":"sigv4"}' || true)"
  echo "${SIGV4_RESP}" | grep -q 'AWS4-HMAC-SHA256' \
    || fail "--sigv4 did not sign the forwarded request's Authorization header: ${SIGV4_RESP}"

  echo "[verify] step 9: SIGTERM tears the --sigv4 container down (no orphan)"
  stop_server
  assert_orphan_free
fi

echo "[verify] PASS: start-agentcore served the warm HTTP contract (ping + invocations with injected session-id), the /ws bridge, and --sigv4-signed forwarding, and cleaned up its container on each shutdown"
