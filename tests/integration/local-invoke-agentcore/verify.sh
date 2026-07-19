#!/usr/bin/env bash
# verify.sh — local-invoke-agentcore integ test (issue #87 v1)
#
# Fully local — no AWS resources are deployed. We synthesize a CDK app
# whose only resource is an AWS::BedrockAgentCore::Runtime backed by a
# local Dockerfile asset, and exercise the local-build path of
# `cdkd local invoke-agentcore` end-to-end: build the agent container, run it on
# 8080, wait for GET /ping, POST the event to /invocations, print the
# response.
#
# The fixture agent echoes the request body, the received session-id
# header, and the injected GREETING env var, so we can assert the full
# request/response contract + env injection + session-id binding. When the
# event carries {"stream": true} it responds with a text/event-stream body, so
# we can assert the SSE response is streamed to stdout incrementally. A second
# MCP-protocol runtime (McpAgent, POST /mcp on 8000) exercises the MCP session
# handshake + tools/list / tools/call. A third runtime (CodeAgent) is a
# CodeConfiguration / managed-runtime artifact authored as plain Python source
# (fromCodeAsset) that cdkd local builds from source and runs. The final scenario
# exercises `--ws`: the EchoAgent's bidirectional /ws WebSocket endpoint (same
# 8080 container), sending the event as the first frame and streaming the
# received frames to stdout.
#
# Run via `/run-integ local-invoke-agentcore` (recommended) or directly:
#
#     bash tests/integration/local-invoke-agentcore/verify.sh
#
# Requires Docker. The build pulls a small node base image the first time.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
TARGET="CdkLocalInvokeAgentCoreFixture/EchoAgent"
PROTECTED="CdkLocalInvokeAgentCoreFixture/ProtectedAgent"
PROTECTED_CLAIMS="CdkLocalInvokeAgentCoreFixture/ProtectedAgentClaims"
MCP="CdkLocalInvokeAgentCoreFixture/McpAgent"
CODE="CdkLocalInvokeAgentCoreFixture/CodeAgent"
A2A="CdkLocalInvokeAgentCoreFixture/A2aAgent"
AGUI="CdkLocalInvokeAgentCoreFixture/AguiAgent"
BASE_IMAGE="public.ecr.aws/docker/library/node:20-slim"
CODE_BASE_IMAGE="public.ecr.aws/docker/library/python:3.12-slim"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling base images (one-time)"
docker pull --platform linux/arm64 "${BASE_IMAGE}" >/dev/null
docker pull --platform linux/arm64 "${CODE_BASE_IMAGE}" >/dev/null

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Test 1 — default empty event: env injection + auto session id.
echo "==> [1/20] Invoking EchoAgent with default empty event"
RESULT_1=$(${CDKD} local invoke-agentcore "${TARGET}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected greeting=hello-from-agent in response, got: ${RESULT_1}"
  exit 1
}
# Auto-generated session id reached the container (not null).
echo "${RESULT_1}" | grep -Eq '"sessionId":"[0-9a-fA-F-]{8,}' || {
  echo "FAIL: expected a non-null auto session id in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event echoes through /invocations.
echo "==> [2/20] Invoking EchoAgent with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}"' EXIT
echo '{"prompt":"hello agent","n":7}' > "${EVENT_FILE}"
RESULT_2=$(${CDKD} local invoke-agentcore "${TARGET}" --event "${EVENT_FILE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"prompt":"hello agent"' || {
  echo "FAIL: expected echoed prompt in response, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override wins over the template env.
echo "==> [3/20] Invoking EchoAgent with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}"' EXIT
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKD} local invoke-agentcore "${TARGET}" --env-vars "${ENV_FILE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — explicit --session-id reaches the container's session header.
echo "==> [4/20] Invoking EchoAgent with explicit --session-id"
SESSION="cdkd-integ-session-1234567890abcdef"
RESULT_4=$(${CDKD} local invoke-agentcore "${TARGET}" --session-id "${SESSION}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q "\"sessionId\":\"${SESSION}\"" || {
  echo "FAIL: expected sessionId=${SESSION} in response, got: ${RESULT_4}"
  exit 1
}

# Test 5 — a JWT-protected runtime invoked WITHOUT a token is rejected
# BEFORE any container starts (AgentCore returns 401 in the cloud).
echo "==> [5/20] ProtectedAgent without --bearer-token must be rejected pre-container"
set +e
OUT_5=$(${CDKD} local invoke-agentcore "${PROTECTED}" 2>&1)
RC_5=$?
set -e
echo "    exit=${RC_5}"
[[ ${RC_5} -ne 0 ]] || {
  echo "FAIL: expected a non-zero exit for the protected runtime with no token, got 0. Output: ${OUT_5}"
  exit 1
}
echo "${OUT_5}" | grep -q "requires an inbound JWT" || {
  echo "FAIL: expected an 'requires an inbound JWT' error, got: ${OUT_5}"
  exit 1
}
RUNNING=$(docker ps -a --filter name=cdkd-local-agentcore- -q | wc -l | tr -d ' ')
[[ "${RUNNING}" == "0" ]] || {
  echo "FAIL: a container was created despite the pre-container auth rejection (${RUNNING} found)"
  exit 1
}

# Test 6 — --no-verify-auth skips verification and proceeds.
echo "==> [6/20] ProtectedAgent with --no-verify-auth proceeds (auth skipped)"
RESULT_6=$(${CDKD} local invoke-agentcore "${PROTECTED}" --no-verify-auth 2>/dev/null | tail -1)
echo "    response: ${RESULT_6}"
echo "${RESULT_6}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected the agent to respond under --no-verify-auth, got: ${RESULT_6}"
  exit 1
}

# Test 7 — a --bearer-token (discovery URL unreachable -> pass-through accept)
# is verified and forwarded to /invocations as the Authorization header.
echo "==> [7/20] ProtectedAgent with --bearer-token forwards the Authorization header"
TOKEN="header.payload.sig"
RESULT_7=$(${CDKD} local invoke-agentcore "${PROTECTED}" --bearer-token "${TOKEN}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_7}"
echo "${RESULT_7}" | grep -q "\"authorization\":\"Bearer ${TOKEN}\"" || {
  echo "FAIL: expected the bearer token forwarded as Authorization: Bearer ${TOKEN}, got: ${RESULT_7}"
  exit 1
}

# Test 8 — a text/event-stream response is streamed to stdout incrementally.
# The agent emits SSE frames when the event carries {"stream": true}; we assert
# every streamed frame reached stdout (the full body, not a single buffered
# line — so we capture all output, not just tail -1).
echo "==> [8/20] EchoAgent streams a text/event-stream response to stdout"
STREAM_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}"' EXIT
echo '{"stream":true}' > "${STREAM_EVENT}"
RESULT_8=$(${CDKD} local invoke-agentcore "${TARGET}" --event "${STREAM_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_8}"
for tok in hello from sse; do
  echo "${RESULT_8}" | grep -q "\"token\":\"${tok}\"" || {
    echo "FAIL: expected streamed SSE frame token=${tok}, got: ${RESULT_8}"
    exit 1
  }
done
echo "${RESULT_8}" | grep -q '\[DONE\]' || {
  echo "FAIL: expected the streamed [DONE] sentinel, got: ${RESULT_8}"
  exit 1
}

# Test 9 — an MCP-protocol runtime, no --event: the session handshake runs and
# the default tools/list request returns the server's tools. The container
# serves POST /mcp on 8000 (no /ping); readiness is a successful initialize.
echo "==> [9/20] McpAgent (no --event) runs the handshake + tools/list"
RESULT_9=$(${CDKD} local invoke-agentcore "${MCP}" 2>/dev/null)
echo "    response: ${RESULT_9}"
echo "${RESULT_9}" | grep -q '"name": "add_numbers"' || {
  echo "FAIL: expected tools/list to return the add_numbers tool, got: ${RESULT_9}"
  exit 1
}

# Test 10 — an MCP tools/call via --event returns the tool result.
echo "==> [10/20] McpAgent with --event runs tools/call"
CALL_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}"' EXIT
echo '{"method":"tools/call","params":{"name":"add_numbers","arguments":{"a":2,"b":3}}}' > "${CALL_EVENT}"
RESULT_10=$(${CDKD} local invoke-agentcore "${MCP}" --event "${CALL_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_10}"
echo "${RESULT_10}" | grep -q '"text": "5"' || {
  echo "FAIL: expected tools/call add_numbers(2,3) to return text \"5\", got: ${RESULT_10}"
  exit 1
}

# Test 11 — a CodeConfiguration (managed-runtime) runtime authored as plain
# source (no Dockerfile): cdkd local builds it from source (pip install + run the
# entrypoint) and the entrypoint self-serves the 8080 HTTP contract.
echo "==> [11/20] CodeAgent (fromCodeAsset) builds from source + responds"
RESULT_11=$(${CDKD} local invoke-agentcore "${CODE}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_11}"
echo "${RESULT_11}" | grep -q '"runtime":"python-code"' || {
  echo "FAIL: expected the from-source python agent to respond, got: ${RESULT_11}"
  exit 1
}
echo "${RESULT_11}" | grep -q '"greeting":"hello-from-code"' || {
  echo "FAIL: expected greeting=hello-from-code (env injected), got: ${RESULT_11}"
  exit 1
}

# Test 12 — a --event payload echoes through the from-source agent.
echo "==> [12/20] CodeAgent with --event echoes the payload"
CODE_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}"' EXIT
echo '{"prompt":"hello code"}' > "${CODE_EVENT}"
RESULT_12=$(${CDKD} local invoke-agentcore "${CODE}" --event "${CODE_EVENT}" 2>/dev/null | tail -1)
echo "    response: ${RESULT_12}"
echo "${RESULT_12}" | grep -q '"prompt":"hello code"' || {
  echo "FAIL: expected echoed prompt from the from-source agent, got: ${RESULT_12}"
  exit 1
}

# Test 13 — the bidirectional /ws WebSocket transport: --ws sends the event as
# the first frame and streams every received frame to stdout until the agent
# closes. The fixture agent replies with one JSON frame (echo + session id +
# Authorization + GREETING) then a second text frame, then closes.
echo "==> [13/20] EchoAgent over the /ws WebSocket (--ws)"
WS_EVENT=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}"' EXIT
echo '{"prompt":"hello ws"}' > "${WS_EVENT}"
RESULT_13=$(${CDKD} local invoke-agentcore "${TARGET}" --ws --event "${WS_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_13}"
echo "${RESULT_13}" | grep -q '"ws":true' || {
  echo "FAIL: expected the /ws frame marker \"ws\":true, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q '"prompt":"hello ws"' || {
  echo "FAIL: expected the echoed event over /ws, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected GREETING injected over /ws, got: ${RESULT_13}"
  exit 1
}
echo "${RESULT_13}" | grep -q 'ws-frame-2' || {
  echo "FAIL: expected the second streamed /ws frame, got: ${RESULT_13}"
  exit 1
}

# Test 14 — --ws is HTTP-only: against an MCP runtime it warns and is ignored,
# falling through to the normal MCP path (tools/list still returns).
echo "==> [14/20] McpAgent with --ws warns + still runs the MCP path"
set +e
OUT_14=$(${CDKD} local invoke-agentcore "${MCP}" --ws 2>/tmp/cdkd-ws-mcp-stderr; cat /tmp/cdkd-ws-mcp-stderr >&2)
RC_14=$?
ERR_14=$(cat /tmp/cdkd-ws-mcp-stderr)
rm -f /tmp/cdkd-ws-mcp-stderr
set -e
echo "    response: ${OUT_14}"
[[ ${RC_14} -eq 0 ]] || {
  echo "FAIL: expected MCP --ws to still succeed (exit 0), got ${RC_14}. Output: ${OUT_14}"
  exit 1
}
echo "${OUT_14}" | grep -q '"name": "add_numbers"' || {
  echo "FAIL: expected MCP --ws to fall through to tools/list, got: ${OUT_14}"
  exit 1
}
echo "${ERR_14}" | grep -q -- '--ws applies only to the HTTP / AGUI protocols' || {
  echo "FAIL: expected an MCP --ws ignored warning on stderr, got: ${ERR_14}"
  exit 1
}

# Test 15 — ProtectedAgentClaims declares AllowedScopes + CustomClaims in the
# template. The resolver must extract them without crashing; with the
# unreachable discovery URL the verifier falls back to pass-through, so the
# invoke succeeds even with a placeholder bearer token. (The verifier's actual
# scope / claim checks are covered by the unit tests, which sign real RS256
# tokens against mock JWKS.)
echo "==> [15/20] ProtectedAgentClaims (allowedScopes + customClaims) invokes successfully"
RESULT_15=$(${CDKD} local invoke-agentcore "${PROTECTED_CLAIMS}" --bearer-token "h.p.s" 2>/dev/null | tail -1)
echo "    response: ${RESULT_15}"
echo "${RESULT_15}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected ProtectedAgentClaims to invoke under pass-through, got: ${RESULT_15}"
  exit 1
}
echo "${RESULT_15}" | grep -q '"authorization":"Bearer h.p.s"' || {
  echo "FAIL: expected the bearer token forwarded as Authorization: Bearer h.p.s, got: ${RESULT_15}"
  exit 1
}

# Test 16 — `--sigv4` opts into header parity with the cloud's IAM-auth
# behavior: cdkd local signs the /invocations POST with SigV4 (service
# bedrock-agentcore) and the agent receives the same `Authorization:
# AWS4-HMAC-SHA256 ...` shape it would in production. Static placeholder
# credentials are passed via env so this scenario is self-contained — the local
# agent never validates the signature against AWS, it just echoes the header.
# A second --sigv4 + --bearer-token sub-check confirms the mutually-exclusive
# gate rejects pre-container.
echo "==> [16/20] EchoAgent --sigv4 forwards an AWS4-HMAC-SHA256 Authorization header"
RESULT_16=$(AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE \
  AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  AWS_REGION=us-east-1 \
  ${CDKD} local invoke-agentcore "${TARGET}" --sigv4 2>/dev/null | tail -1)
echo "    response: ${RESULT_16}"
echo "${RESULT_16}" | grep -q '"authorization":"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/' || {
  echo "FAIL: expected an AWS4-HMAC-SHA256 Authorization header carrying the access key id, got: ${RESULT_16}"
  exit 1
}
echo "${RESULT_16}" | grep -q '/us-east-1/bedrock-agentcore/aws4_request' || {
  echo "FAIL: expected the signed credential scope to include bedrock-agentcore + us-east-1, got: ${RESULT_16}"
  exit 1
}

echo "==> [16/20] --sigv4 + --bearer-token together rejected (mutually exclusive)"
set +e
OUT_16B=$(${CDKD} local invoke-agentcore "${TARGET}" --sigv4 --bearer-token "h.p.s" 2>&1)
RC_16B=$?
set -e
[[ ${RC_16B} -ne 0 ]] || {
  echo "FAIL: expected a non-zero exit for --sigv4 + --bearer-token, got 0. Output: ${OUT_16B}"
  exit 1
}
echo "${OUT_16B}" | grep -q 'mutually exclusive' || {
  echo "FAIL: expected a 'mutually exclusive' error, got: ${OUT_16B}"
  exit 1
}

# Test 17 — `--timeout` overrides the per-request timeout. The default is 120s;
# raise it for long-running agents, or lower it to fail fast in a CI smoke test.
# The positive sub-check passes an explicit 60000 ms and asserts the agent still
# responds (the flag is parsed + threaded into the client call, not silently
# ignored). The negative sub-check confirms the parser rejects a non-positive
# value pre-container.
echo "==> [17/20] EchoAgent --timeout 60000 succeeds (flag is parsed + applied)"
RESULT_17=$(${CDKD} local invoke-agentcore "${TARGET}" --timeout 60000 2>/dev/null | tail -1)
echo "    response: ${RESULT_17}"
echo "${RESULT_17}" | grep -q '"greeting":"hello-from-agent"' || {
  echo "FAIL: expected EchoAgent to invoke under --timeout 60000, got: ${RESULT_17}"
  exit 1
}

echo "==> [17/20] --timeout 0 rejected by the parser (positive integer required)"
set +e
OUT_17B=$(${CDKD} local invoke-agentcore "${TARGET}" --timeout 0 2>&1)
RC_17B=$?
set -e
[[ ${RC_17B} -ne 0 ]] || {
  echo "FAIL: expected a non-zero exit for --timeout 0, got 0. Output: ${OUT_17B}"
  exit 1
}
echo "${OUT_17B}" | grep -q 'positive integer' || {
  echo "FAIL: expected a 'positive integer' error message, got: ${OUT_17B}"
  exit 1
}

# Test 19 — A2A protocol runtime: the container serves the Agent2Agent
# JSON-RPC 2.0 contract at POST / on 9000. With no --event, `cdkd local
# invoke-agentcore` defaults to `agent/getCard` (the agent discovery card).
echo "==> [19/20] A2aAgent (no --event) runs the JSON-RPC agent/getCard request"
RESULT_19=$(${CDKD} local invoke-agentcore "${A2A}" 2>/dev/null)
echo "    response: ${RESULT_19}"
echo "${RESULT_19}" | grep -q '"name": "fixture-a2a-agent"' || {
  echo "FAIL: expected the A2A agent card with name fixture-a2a-agent, got: ${RESULT_19}"
  exit 1
}

# Test 19 — A2A with --event runs the tasks/send method.
echo "==> [19/20] A2aAgent with --event runs tasks/send"
A2A_EVENT=$(mktemp -t cdkd-a2a-event-XXXX.json)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}" "${A2A_EVENT}"' EXIT
echo '{"method":"tasks/send","params":{"id":"task-1","message":{"text":"hello a2a"}}}' > "${A2A_EVENT}"
RESULT_19B=$(${CDKD} local invoke-agentcore "${A2A}" --event "${A2A_EVENT}" 2>/dev/null)
echo "    response: ${RESULT_19B}"
echo "${RESULT_19B}" | grep -q '"id": "task-1"' || {
  echo "FAIL: expected tasks/send result echoing id=task-1, got: ${RESULT_19B}"
  exit 1
}
echo "${RESULT_19B}" | grep -q '"state": "completed"' || {
  echo "FAIL: expected tasks/send to report completed state, got: ${RESULT_19B}"
  exit 1
}

# Test 20 — AGUI protocol runtime: the container serves the AG-UI
# HTTP-compatible contract (GET /ping + POST /invocations text/event-stream of
# AG-UI events). `cdkd local invoke-agentcore` routes through the existing HTTP path
# and streams each event line to stdout. The agent emits three events in order
# (RUN_STARTED, MESSAGE_CONTENT, RUN_FINISHED).
echo "==> [20/20] AguiAgent SSE event stream surfaces RUN_STARTED + MESSAGE_CONTENT + RUN_FINISHED"
RESULT_20=$(${CDKD} local invoke-agentcore "${AGUI}" 2>/dev/null)
echo "    response (head): $(echo "${RESULT_20}" | head -c 300)..."
echo "${RESULT_20}" | grep -q '"type":"RUN_STARTED"' || {
  echo "FAIL: expected RUN_STARTED event in AGUI SSE stream, got: ${RESULT_20}"
  exit 1
}
echo "${RESULT_20}" | grep -q '"content":"hello-from-agui"' || {
  echo "FAIL: expected MESSAGE_CONTENT event with hello-from-agui in AGUI SSE stream, got: ${RESULT_20}"
  exit 1
}
echo "${RESULT_20}" | grep -q '"type":"RUN_FINISHED"' || {
  echo "FAIL: expected RUN_FINISHED event in AGUI SSE stream, got: ${RESULT_20}"
  exit 1
}

# Test 18 — `--ws` with piped (non-TTY) stdin = one-shot, wire-faithful mode.
# `--ws` auto-detects TTY: a real terminal enters a REPL (stdin lines become
# follow-up frames), but here stdin is piped (`printf | ...`), so it is
# non-interactive — only the initial --event frame is sent and the agent's ack
# is the only frame received. The piped lines are NOT sent as follow-up frames
# (no REPL on a non-TTY), matching the old non-interactive behavior.
echo "==> [18/20] EchoAgent --ws with piped stdin stays one-shot (no REPL on non-TTY)"
LOOP_EVENT_FILE=$(mktemp -t cdkd-ws-loop-event-XXXX.json)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}" "${LOOP_EVENT_FILE}"' EXIT
echo '{"loop":true}' > "${LOOP_EVENT_FILE}"
# The EchoAgent in loop mode keeps the /ws socket open (it is designed for the
# interactive REPL, where the CLIENT closes on EOF). In one-shot (non-TTY) mode
# the client sends only the initial frame and then waits for the agent to close
# the stream -- which a loop-mode agent never does -- so it runs until --timeout.
# That is the correct one-shot semantic; we just bound the wait to a few seconds
# and tolerate the resulting non-zero exit (`|| true`) so `set -e` does not abort.
# The initial ack frame is still written to stdout before the timeout, which is
# what the assertions below check; the point of the test is that the piped stdin
# lines are NOT turned into follow-up frames on a non-TTY.
RESULT_18=$(printf 'line-A\nline-B\n' | \
  ${CDKD} local invoke-agentcore "${TARGET}" --ws --event "${LOOP_EVENT_FILE}" --timeout 8000 2>/dev/null || true)
echo "    response: ${RESULT_18}"
# Initial frame echo (first frame's loop:true is acknowledged by the agent):
echo "${RESULT_18}" | grep -q '"echoed":{"loop":true}' || {
  echo "FAIL: expected initial ack of the loop event in the WS response, got: ${RESULT_18}"
  exit 1
}
# The piped stdin lines must NOT be sent as follow-up frames on a non-TTY:
echo "${RESULT_18}" | grep -q 'loop-echo:line-A' && {
  echo "FAIL: piped (non-TTY) --ws must not send stdin lines as follow-up frames, got: ${RESULT_18}"
  exit 1
}
# Test 21 — `--watch` (follows cdk-local #270): re-synth + reload the agent
# container on a CDK source edit. We open a long-lived /ws session against the
# EchoAgent in loop mode (so the socket stays open), edit the agent source to
# inject a unique marker into the first-frame reply, and assert that (a) the
# watcher logs a reload verdict (soft-reload / rebuild) and (b) after the reload
# the re-opened /ws session surfaces the NEW marker — proving the rebuilt
# container is what the client reconnected to. The EchoAgent is a Dockerfile
# container asset, so the classifier picks the full-rebuild path; the soft-
# reload fast path is covered by the unit tests (an interpreted-language edit
# inside a CodeConfiguration source tree).
echo "==> [21/21] EchoAgent --ws --watch reloads on a source edit + reconnects"
AGENT_SRC="agent/server.js"
AGENT_SRC_BAK=$(mktemp -t cdkd-agent-src-XXXX.js)
WATCH_LOG=$(mktemp -t cdkd-watch-log-XXXX.txt)
WATCH_EVENT=$(mktemp -t cdkd-watch-event-XXXX.json)
MARKER="reloaded-$(date +%s)"
# Snapshot the source so we can restore it no matter how the test exits.
cp "${AGENT_SRC}" "${AGENT_SRC_BAK}"
cleanup_watch() {
  # Stop the background watch process (best-effort), restore the source, and
  # sweep any leftover agent container the kill may have raced past teardown.
  [[ -n "${WATCH_PID:-}" ]] && kill "${WATCH_PID}" 2>/dev/null || true
  [[ -n "${WATCH_PID:-}" ]] && wait "${WATCH_PID}" 2>/dev/null || true
  cp "${AGENT_SRC_BAK}" "${AGENT_SRC}" 2>/dev/null || true
  docker ps -a --filter name=cdkd-local-agentcore- -q | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -f "${AGENT_SRC_BAK}" "${WATCH_LOG}" "${WATCH_EVENT}"
}
trap 'cleanup_watch; rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}" "${LOOP_EVENT_FILE}" "${A2A_EVENT}"' EXIT
trap 'cleanup_watch; rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}" "${LOOP_EVENT_FILE}" "${A2A_EVENT}"; exit 130' INT
trap 'cleanup_watch; rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STREAM_EVENT}" "${CALL_EVENT}" "${CODE_EVENT}" "${WS_EVENT}" "${LOOP_EVENT_FILE}" "${A2A_EVENT}"; exit 143' TERM

echo '{"loop":true}' > "${WATCH_EVENT}"
# Background the watch session with stdin pinned to /dev/null (non-TTY one-shot
# WS frame behavior; loop mode keeps the socket open across the reload). All
# output (stdout + stderr) is captured to the log for the assertions below.
${CDKD} local invoke-agentcore "${TARGET}" --ws --watch --event "${WATCH_EVENT}" \
  </dev/null >"${WATCH_LOG}" 2>&1 &
WATCH_PID=$!

# Wait for the watcher to be armed (it logs the watch root once the file
# watcher is installed) so the edit below is observed.
for _ in $(seq 1 60); do
  grep -q 'Watching .* for source changes' "${WATCH_LOG}" && break
  sleep 1
done
grep -q 'Watching .* for source changes' "${WATCH_LOG}" || {
  echo "FAIL: --watch never armed the file watcher. Log:"
  cat "${WATCH_LOG}"
  exit 1
}

# Edit the agent source: inject the unique marker into the /ws first-frame
# reply object. This is an interpreted-source edit that changes the runtime
# response, so the reloaded container surfaces the new marker.
sed -i.sedbak "s/ws: true,/ws: true, reloaded: '${MARKER}',/" "${AGENT_SRC}"
rm -f "${AGENT_SRC}.sedbak"

# Wait for the watcher to fire + the reload to complete + the re-opened session
# to surface the new marker.
for _ in $(seq 1 90); do
  grep -q "${MARKER}" "${WATCH_LOG}" && break
  sleep 1
done

# (a) a reload verdict was logged.
grep -Eq 'verdict=(soft-reload|rebuild)' "${WATCH_LOG}" || {
  echo "FAIL: expected a 'verdict=soft-reload|rebuild' line after the source edit. Log:"
  cat "${WATCH_LOG}"
  exit 1
}
# (b) the re-opened /ws session reflects the NEW source (the injected marker).
grep -q "${MARKER}" "${WATCH_LOG}" || {
  echo "FAIL: expected the reloaded agent to surface the new marker '${MARKER}'. Log:"
  cat "${WATCH_LOG}"
  exit 1
}

# Stop the watch session + restore the source (also runs on EXIT as a backstop).
cleanup_watch
WATCH_PID=""

echo ""
echo "==> All 21 local-invoke-agentcore tests passed"
