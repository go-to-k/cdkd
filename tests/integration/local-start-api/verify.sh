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
  vp install --prefer-offline
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

# Wait for ALL three "Server listening" lines — PR #341 / issue #260
# launches one HTTP server per API (HTTP API v2 + REST API v1 +
# Function URL), each on its own port (--port N → N, N+1, N+2). The
# pre-#341 single-server marker check would race past readiness if
# the first server bound before the others.
echo "==> Waiting for all servers (3 expected) to come up"
EXPECTED_SERVERS=3
READY=0
for i in $(seq 1 60); do
  # `grep -c` outputs "0" AND exits non-zero on zero matches, so a
  # naive `|| echo 0` concatenates both into "0\n0" and trips up
  # the `[[ ... -ge ... ]]` arithmetic. Capture stdout, then default
  # to 0 only when grep actually failed (file missing etc.).
  count=$(grep -c "Server listening" "${LOG_FILE}" 2>/dev/null) || count=0
  if [[ "${count}" -ge "${EXPECTED_SERVERS}" ]]; then
    READY=1
    break
  fi
  sleep 0.5
done
if [[ "${READY}" -eq 0 ]]; then
  echo "FAIL: only ${count}/${EXPECTED_SERVERS} servers came up within 30s. Log:"
  cat "${LOG_FILE}"
  exit 1
fi

echo "==> Server log preview:"
head -60 "${LOG_FILE}" | sed 's/^/    /'

# Extract per-API ports from "Server listening on http://host:PORT (Kind)"
# lines. PR #341 launches one server per API, so each route family has
# its own port — using a single $PORT for every curl would only hit
# the HTTP API v2 server.
#
# Sed regex tightening: anchor the port on the `http://host:` segment
# (the `[^:]+` host class refuses to cross another `:`) so a future
# DisplayName containing `:NNN` (e.g. user-defined logical IDs or
# qualifiers like "v2:edge") can't shadow the real port.
PORT_HTTP=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*HTTP API v2\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
PORT_REST=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(.*REST API v1\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
# Two Function URL servers: the buffered one (UrlHandler) and the
# streaming one (StreamUrlHandler — added in #467). CDK appends an
# 8-hex-char hash to each logical id; the leading `(` anchor + the
# regex `UrlHandler[A-F0-9]{8}` boundary ensures `UrlHandler` does NOT
# match `StreamUrlHandler` (the latter has `Stream` before `UrlHandler`,
# so the `(` boundary excludes it).
PORT_FNURL=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(UrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
PORT_FNURL_STREAM=$(grep -E 'Server listening on http://[^[:space:]]+\s+\(StreamUrlHandler[A-F0-9]{8}\s+\(Function URL\)\)' "${LOG_FILE}" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1)
if [[ -z "${PORT_HTTP}" || -z "${PORT_REST}" || -z "${PORT_FNURL}" || -z "${PORT_FNURL_STREAM}" ]]; then
  echo "FAIL: could not extract per-API port mappings. Log:"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    HTTP API v2:           ${PORT_HTTP}"
echo "    REST API v1:           ${PORT_REST}"
echo "    Function URL:          ${PORT_FNURL}"
echo "    Function URL (stream): ${PORT_FNURL_STREAM}"

# Verify the route table contains every route. Method-column width
# varies per server (REST v1 with OPTIONS preflight rows has a wider
# method column than HTTP API v2), so match on `<METHOD>\s+<path>`
# regex instead of fixed-width prefixes. `{`, `}`, `+` in path
# patterns need regex escaping.
echo "==> Asserting discovered routes"
EXPECTED_ROUTES=(
  "GET     /items"
  "POST    /items"
  "GET     /items/\\{id\\}"
  "GET     /protected"
  "POST    /sqs"
  "POST    /events"
  "POST    /unknown-subtype"
  "POST    /protected-sqs"
  "ANY     /v1/\\{proxy\\+\\}"
  "GET     /v1/unsupported"
  "GET     /v1/cross-stack-auth"
  "OPTIONS /v1/\\{proxy\\+\\}"
  "ANY     /\\{proxy\\+\\}"
)
for line in "${EXPECTED_ROUTES[@]}"; do
  # Replace runs of spaces in the spec with `\s+` so the assertion
  # is tolerant of the per-server method-column width.
  pattern=$(echo "${line}" | sed -E 's/[[:space:]]+/[[:space:]]+/g')
  if ! grep -E "${pattern}" "${LOG_FILE}" >/dev/null; then
    echo "FAIL: missing route in route table: ${line} (pattern: ${pattern})"
    cat "${LOG_FILE}"
    exit 1
  fi
done

# The deferred-error route table label and the per-route startup warn.
# The defaultCorsPreflightOptions OPTIONS Method should appear with the
# [MOCK CORS preflight] label; the HTTP_PROXY GET on /v1/unsupported
# should appear with the [501 Not Implemented] label.
echo "==> Asserting deferred-route table labels"
if ! grep -F "[MOCK CORS preflight]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [MOCK CORS preflight] label."
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -F "[501 Not Implemented]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [501 Not Implemented] label."
  cat "${LOG_FILE}"
  exit 1
fi
# Startup warn summary: one [warn] line up front for every unsupported
# route. The HTTP_PROXY route's reason names the integration type.
if ! grep -i "HTTP 501 Not Implemented when hit" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: missing startup warn summary for unsupported routes."
  cat "${LOG_FILE}"
  exit 1
fi

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
curl_assert "GET /items/42" "http://127.0.0.1:${PORT_HTTP}/items/42" '"id":"42"'
curl_assert "POST /items" "http://127.0.0.1:${PORT_HTTP}/items" '"body"' \
  -X POST -H 'Content-Type: application/json' -d '{"x":1}'
# PR 8c: REST v1 stage variables — the prod Stage carries
# Variables: { STAGE: 'prod', LOG_LEVEL: 'info' }. Note this lives on
# the dedicated REST v1 server (own port, per PR #341).
curl_assert "ANY /v1/anything (stage variables)" \
  "http://127.0.0.1:${PORT_REST}/v1/anything" '"STAGE":"prod"'
# Function URL is a separate server on its own port. The Function URL
# greedy proxy answers any path on its server.
curl_assert "Function URL fallback" "http://127.0.0.1:${PORT_FNURL}/url-only/ping" '"functionUrl":true'

# #467: streaming Function URL (`invokeMode: RESPONSE_STREAM`). The
# handler emits 5 chunks of "hello-N\n" with 200ms delays between
# chunks. cdkd MUST:
#   1. Return HTTP 200 + `Transfer-Encoding: chunked` headers (not
#      buffered-then-flushed in one shot).
#   2. Deliver chunks incrementally — the wall-clock duration of
#      `curl --no-buffer` should reflect the handler's inter-chunk
#      sleeps (>= ~600ms across 5 chunks of 200ms).
#   3. Echo the prelude's X-Stream-Test header.
#
# Caveat: the AWS Lambda Runtime Interface Emulator (RIE) baked into
# `public.ecr.aws/lambda/nodejs:20` does NOT stream the response — it
# buffers every `responseStream.write(...)` call into one response that
# arrives at the HTTP client as a single block. This is a RIE limitation
# (verified empirically against the v1.0 RIE shipped in the base image
# on 2026-05-22); cdkd's `invokeRieStreaming` correctly parses the
# streaming protocol and pipes the body bytes with `Transfer-Encoding:
# chunked`, but real incremental delivery only manifests against the
# deployed Lambda runtime. The integ asserts the protocol shape, not
# inter-chunk timing.
echo "==> Asserting streaming Function URL (#467)"
STREAM_URL="http://127.0.0.1:${PORT_FNURL_STREAM}/anything"
# First-request retry loop (cold container ~3-5s on first invoke).
STREAM_RESPONSE=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if STREAM_RESPONSE=$(curl -sf -i --no-buffer "${STREAM_URL}" 2>&1); then
    if echo "${STREAM_RESPONSE}" | grep -q 'hello-0'; then break; fi
  fi
  sleep 1
done
if ! echo "${STREAM_RESPONSE}" | grep -qi '^HTTP/1.1 200'; then
  echo "FAIL: streaming Function URL did not return 200. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_RESPONSE}" | grep -qi '^transfer-encoding: chunked'; then
  echo "FAIL: streaming response missing Transfer-Encoding: chunked. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${STREAM_RESPONSE}" | grep -qi '^x-stream-test: on'; then
  echo "FAIL: streaming response missing X-Stream-Test header from the prelude. Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
# All 5 chunks present in the body (order-preserved). RIE buffers the
# writes, so we get all 5 in one shot — that's expected.
for i in 0 1 2 3 4; do
  if ! echo "${STREAM_RESPONSE}" | grep -q "hello-${i}"; then
    echo "FAIL: streaming response missing chunk 'hello-${i}'. Response:"
    echo "${STREAM_RESPONSE}"
    cat "${LOG_FILE}"
    exit 1
  fi
done
# Protocol-shape audit: the response body must NOT contain the literal
# bytes of the 8-NULL separator — that would mean cdkd's prelude parser
# leaked separator bytes into the body. We grep `chunk-` instead of a
# binary NULL match because curl's `-i` output is rendered for
# terminals and may mask NULs; the indirect signal is that the body
# starts with `hello-0` (the handler's first write after the
# `HttpResponseStream.from` wrapper installed the prelude).
if echo "${STREAM_RESPONSE}" | grep -q '"statusCode":200,"headers"'; then
  echo "FAIL: streaming response body leaked the JSON prelude (parser bug). Response:"
  echo "${STREAM_RESPONSE}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [streaming Function URL] OK"

# PR 8c: CORS preflight interception. The HTTP API has CorsConfiguration
# with `*` origins; verify.sh asserts the canonical preflight response.
echo "==> Asserting CORS preflight (OPTIONS /items)"
PREFLIGHT_HEADERS=$(curl -s -i -o - -X OPTIONS \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type' \
  "http://127.0.0.1:${PORT_HTTP}/items" 2>&1)
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^HTTP/1.1 204'; then
  echo "FAIL: CORS preflight did not return 204. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-origin: \*'; then
  echo "FAIL: CORS preflight missing access-control-allow-origin header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-methods: POST'; then
  echo "FAIL: CORS preflight missing access-control-allow-methods header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
# PR 8c review fix-back: every successful preflight now emits
# `Vary: Origin` so downstream caches don't share responses across
# origins. Pre-fix the header was missing on the wildcard / literal-
# origin / AllowCredentials echo paths.
if ! echo "${PREFLIGHT_HEADERS}" | grep -qi '^vary: Origin'; then
  echo "FAIL: CORS preflight missing 'Vary: Origin' header. Response:"
  echo "${PREFLIGHT_HEADERS}"
  exit 1
fi
echo "    [CORS preflight] OK"

# PR 8b: authorizer-protected route. Without the Bearer token the
# authorizer Deny's; with the Bearer token the route handler runs and
# echoes the authorizer's context map.
echo "==> Authorizer pass: GET /protected without token -> 401 (HTTP v2 deny)"
auth_status=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_HTTP}/protected")
if [[ "${auth_status}" != "401" ]]; then
  echo "FAIL: expected 401 from authorizer deny, got ${auth_status}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [GET /protected (deny)] OK (status=401)"

curl_assert "GET /protected (allow)" \
  "http://127.0.0.1:${PORT_HTTP}/protected" \
  '"protected":true' \
  -H 'Authorization: Bearer let-me-in'

# REST v1 MOCK CORS preflight: the `defaultCorsPreflightOptions` on
# MyRestApi synthesizes an OPTIONS Method with a MOCK integration on
# every resource. cdkd's discovery layer captures the literal
# `method.response.header.Access-Control-Allow-*` values from
# `IntegrationResponses[0].ResponseParameters`; the HTTP server returns
# them directly on OPTIONS (no Lambda invocation, no VTL evaluation).
echo "==> Asserting REST v1 MOCK CORS preflight (OPTIONS /v1/anything)"
REST_PREFLIGHT_HEADERS=$(curl -s -i -o - -X OPTIONS \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: GET' \
  "http://127.0.0.1:${PORT_REST}/v1/anything" 2>&1)
if ! echo "${REST_PREFLIGHT_HEADERS}" | grep -qiE '^HTTP/1.1 (200|204)'; then
  echo "FAIL: REST v1 MOCK CORS preflight did not return a 2xx. Response:"
  echo "${REST_PREFLIGHT_HEADERS}"
  exit 1
fi
if ! echo "${REST_PREFLIGHT_HEADERS}" | grep -qi '^access-control-allow-origin: \*'; then
  echo "FAIL: REST v1 MOCK CORS preflight missing access-control-allow-origin header. Response:"
  echo "${REST_PREFLIGHT_HEADERS}"
  exit 1
fi
echo "    [REST v1 MOCK CORS preflight] OK"

# Deferred-error class: GET /v1/unsupported has an HTTP_PROXY integration
# cdkd cannot emulate. The server returns 501 + `reason` in the body, no
# Lambda invocation. Pre-PR boot would have hard-errored on this route
# and prevented every other route from being reachable.
echo "==> Asserting GET /v1/unsupported -> 501 Not Implemented"
UNSUPPORTED_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' "http://127.0.0.1:${PORT_REST}/v1/unsupported")
UNSUPPORTED_STATUS=$(echo "${UNSUPPORTED_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
UNSUPPORTED_BODY=$(echo "${UNSUPPORTED_RESPONSE}" | sed '$ d')
if [[ "${UNSUPPORTED_STATUS}" != "501" ]]; then
  echo "FAIL: expected 501 from unsupported route, got ${UNSUPPORTED_STATUS}. Body: ${UNSUPPORTED_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${UNSUPPORTED_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: expected 501 body to include {\"message\":\"Not Implemented\"}. Body: ${UNSUPPORTED_BODY}"
  exit 1
fi
if ! echo "${UNSUPPORTED_BODY}" | grep -q '"reason"'; then
  echo "FAIL: expected 501 body to include a 'reason' field. Body: ${UNSUPPORTED_BODY}"
  exit 1
fi
echo "    [GET /v1/unsupported (501)] OK"

# Issue #431: authorizer Lambda Arn unresolvable. The route's
# AuthorizerUri was overridden in the fixture to a cross-stack-shape
# Fn::Sub the resolver cannot pin down. cdkd's authorizer-resolver
# flips the route to deferred-error unsupported at boot; the HTTP
# server returns 501 + reason at request time. The authorizer Lambda
# is never invoked.
echo "==> Asserting GET /v1/cross-stack-auth -> 501 Not Implemented (authorizer Arn unresolvable)"
AUTH_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' \
  -H 'Authorization: Bearer any-token' \
  "http://127.0.0.1:${PORT_REST}/v1/cross-stack-auth")
AUTH_STATUS=$(echo "${AUTH_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
AUTH_BODY=$(echo "${AUTH_RESPONSE}" | sed '$ d')
if [[ "${AUTH_STATUS}" != "501" ]]; then
  echo "FAIL: expected 501 from cross-stack authorizer route, got ${AUTH_STATUS}. Body: ${AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if ! echo "${AUTH_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: expected 501 body to include {\"message\":\"Not Implemented\"}. Body: ${AUTH_BODY}"
  exit 1
fi
if ! echo "${AUTH_BODY}" | grep -q 'authorizer Lambda Arn unresolvable'; then
  echo "FAIL: expected 501 reason to mention 'authorizer Lambda Arn unresolvable'. Body: ${AUTH_BODY}"
  exit 1
fi
echo "    [GET /v1/cross-stack-auth (501)] OK"

# #458: HTTP API v2 service integrations. The fixture wires POST /sqs to
# `SQS-SendMessage`, POST /events to `EventBridge-PutEvents`, and POST
# /unknown-subtype to a deliberately-typo'd subtype that must fall back
# to the deferred-501 path. We DO NOT deploy real SQS/EventBridge — the
# integ is local-only — so the SDK calls land against the dev's AWS
# creds and either reject with a 4xx (proves dispatch fired) or return
# AccessDenied / NoSuchQueue. Pre-#458 these routes 501'd at boot.
echo "==> Asserting service-integration route table labels (#458)"
if ! grep -F "[SQS-SendMessage]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [SQS-SendMessage] label."
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -F "[EventBridge-PutEvents]" "${LOG_FILE}" >/dev/null; then
  echo "FAIL: route table did not include [EventBridge-PutEvents] label."
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [route labels] OK"

echo "==> Asserting POST /sqs goes through the dispatcher (not 501)"
SQS_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/sqs?url=https://sqs.invalid.example/q")
SQS_STATUS=$(echo "${SQS_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
SQS_BODY=$(echo "${SQS_RESPONSE}" | sed '$ d')
# Acceptance: anything OTHER than 501 (= dispatched to AWS SDK). Most
# environments will surface a 4xx (NonExistentQueue / AccessDenied /
# InvalidParameter / SignatureDoesNotMatch). The body must NOT include
# the "Not Implemented" marker.
if [[ "${SQS_STATUS}" == "501" ]]; then
  echo "FAIL: POST /sqs returned 501 — service-integration dispatch did not fire. Body: ${SQS_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if echo "${SQS_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: POST /sqs body looks like the deferred-501 envelope. Body: ${SQS_BODY}"
  exit 1
fi
echo "    [POST /sqs dispatched] OK (status=${SQS_STATUS})"

echo "==> Asserting POST /events goes through the dispatcher (not 501)"
EVENTS_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"k":"v"}' \
  "http://127.0.0.1:${PORT_HTTP}/events?type=order.created")
EVENTS_STATUS=$(echo "${EVENTS_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
EVENTS_BODY=$(echo "${EVENTS_RESPONSE}" | sed '$ d')
if [[ "${EVENTS_STATUS}" == "501" ]]; then
  echo "FAIL: POST /events returned 501 — dispatch did not fire. Body: ${EVENTS_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if echo "${EVENTS_BODY}" | grep -q '"message":"Not Implemented"'; then
  echo "FAIL: POST /events body looks like the deferred-501 envelope. Body: ${EVENTS_BODY}"
  exit 1
fi
echo "    [POST /events dispatched] OK (status=${EVENTS_STATUS})"

echo "==> Asserting POST /unknown-subtype -> 501 (classifier rejected typo)"
UNK_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "http://127.0.0.1:${PORT_HTTP}/unknown-subtype")
UNK_STATUS=$(echo "${UNK_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
UNK_BODY=$(echo "${UNK_RESPONSE}" | sed '$ d')
if [[ "${UNK_STATUS}" != "501" ]]; then
  echo "FAIL: POST /unknown-subtype should 501 (unrecognized subtype). Got ${UNK_STATUS}. Body: ${UNK_BODY}"
  exit 1
fi
if ! echo "${UNK_BODY}" | grep -q 'BogusService-NotASubtype'; then
  echo "FAIL: 501 reason should name the offending subtype. Body: ${UNK_BODY}"
  exit 1
fi
echo "    [POST /unknown-subtype (501)] OK"

# Issue #502: Lambda-authorizer-protected service-integration route.
# Pre-PR the SDK dispatcher ran BEFORE the authorizer pass, letting
# unauthenticated requests reach the SDK call. Post-PR the authorizer
# pass runs FIRST — missing Bearer → 401, valid Bearer → SDK dispatches.
echo "==> Asserting POST /protected-sqs without token -> 401 (auth pass runs BEFORE SDK)"
PROTECTED_SQS_NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/protected-sqs?url=https://sqs.invalid.example/q")
if [[ "${PROTECTED_SQS_NOAUTH_STATUS}" != "401" ]]; then
  echo "FAIL: expected 401 from auth-deny on /protected-sqs, got ${PROTECTED_SQS_NOAUTH_STATUS}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [POST /protected-sqs (deny)] OK (status=401)"

echo "==> Asserting POST /protected-sqs with valid Bearer -> SDK dispatches (NOT 401)"
PROTECTED_SQS_AUTH_RESPONSE=$(curl -s -w '\nHTTP_STATUS=%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer let-me-in' \
  -d '{"message":"hello"}' \
  "http://127.0.0.1:${PORT_HTTP}/protected-sqs?url=https://sqs.invalid.example/q")
PROTECTED_SQS_AUTH_STATUS=$(echo "${PROTECTED_SQS_AUTH_RESPONSE}" | grep -oE 'HTTP_STATUS=[0-9]+' | cut -d= -f2)
PROTECTED_SQS_AUTH_BODY=$(echo "${PROTECTED_SQS_AUTH_RESPONSE}" | sed '$ d')
# Acceptance: anything other than 401 (= the auth pass let it through;
# the SDK call fired and AWS returned 4xx from the missing queue / bogus
# credentials / etc.). 501 would also be a failure (means dispatch
# didn't fire). Most environments will surface 4xx from the SDK adapter.
if [[ "${PROTECTED_SQS_AUTH_STATUS}" == "401" ]]; then
  echo "FAIL: POST /protected-sqs with valid Bearer returned 401 — authorizer rejected valid token. Body: ${PROTECTED_SQS_AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
if [[ "${PROTECTED_SQS_AUTH_STATUS}" == "501" ]]; then
  echo "FAIL: POST /protected-sqs returned 501 — SDK dispatch did not fire. Body: ${PROTECTED_SQS_AUTH_BODY}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [POST /protected-sqs (allow + SDK)] OK (status=${PROTECTED_SQS_AUTH_STATUS})"

echo ""
echo "==> All local-start-api smoke tests passed"
