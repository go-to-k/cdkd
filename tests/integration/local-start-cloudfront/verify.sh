#!/usr/bin/env bash
# verify.sh — cdkd local start-cloudfront integ test (no AWS, no Docker)
#
# Serves a static-site CloudFront distribution locally via cdkd's inherited
# `start-cloudfront` command (from cdk-local): an S3 origin whose content is
# the BucketDeployment source asset resolved out of the cloud assembly + two
# CloudFront Functions (a viewer-request rewrite and a viewer-response header
# stamp). Asserts the full pipeline end to end:
#   - GET /        -> 200, default root object (index.html), and the
#                     viewer-response function's x-cdkd-fixture header.
#   - GET /foo     -> the viewer-request function rewrites it to
#                     /foo/index.html and the S3 origin serves that key.
#   - GET /missing -> the 403 -> /404.html (200) CustomErrorResponse fires
#                     (the SPA fallback for a missing key).
#   - --watch      -> editing the site source re-synths + swaps the routing
#                     model under the live socket; the new content is served.
#   - SIGTERM frees the listening port.
#
#     bash tests/integration/local-start-cloudfront/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
PORT=18363
BASE="http://127.0.0.1:${PORT}"
TARGET="CdkdLocalStartCloudFrontFixture/SiteDist"

CDKD_PID=""
OUT_FILE=$(mktemp)
ROOT_BODY=$(mktemp)
MISS_BODY=$(mktemp)

cleanup() {
  echo "==> Cleanup: stopping the server"
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 40); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  if [[ -f site/index.html.bak ]]; then
    mv -f site/index.html.bak site/index.html
  fi
  rm -f "${OUT_FILE}" "${ROOT_BODY}" "${MISS_BODY}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

fail() {
  echo "FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

echo "==> Pre-test port sweep (${PORT})"
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  lsof -ti "tcp:${PORT}" | xargs -r kill -9 || true
fi

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Booting: cdkd local start-cloudfront ${TARGET} --port ${PORT} --watch"
${CDKD} local start-cloudfront "${TARGET}" --port "${PORT}" --watch > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

echo "==> Waiting for the server banner"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "CloudFront distribution serving on" "${OUT_FILE}"; then BOOTED=1; break; fi
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then fail "server exited before it was ready"; fi
  sleep 0.5
done
[[ "${BOOTED}" -eq 1 ]] || fail "server did not print its ready banner in time"

# ---------------------------------------------------------------------------
# 1. Default root object + viewer-response header.
# ---------------------------------------------------------------------------
echo "==> GET / (default root object + viewer-response header)"
ROOT_HEADERS=$(curl -fsS -D - -o "${ROOT_BODY}" "${BASE}/") || fail "GET / failed"
grep -qi "root page" "${ROOT_BODY}" || fail "GET / did not serve the root index.html"
echo "${ROOT_HEADERS}" | grep -qi "x-cdkd-fixture: start-cloudfront" \
  || fail "viewer-response function header x-cdkd-fixture not present on GET /"

# ---------------------------------------------------------------------------
# 2. viewer-request rewrite: /foo -> /foo/index.html.
# ---------------------------------------------------------------------------
echo "==> GET /foo (viewer-request rewrite -> /foo/index.html)"
FOO_BODY=$(curl -fsS "${BASE}/foo") || fail "GET /foo failed"
echo "${FOO_BODY}" | grep -qi "foo page" \
  || fail "viewer-request rewrite did not resolve /foo to /foo/index.html"

# ---------------------------------------------------------------------------
# 3. CustomErrorResponses SPA fallback: missing key -> 403 -> /404.html (200).
# ---------------------------------------------------------------------------
echo "==> GET /does-not-exist (403 -> /404.html (200) SPA fallback)"
MISS_STATUS=$(curl -s -o "${MISS_BODY}" -w '%{http_code}' "${BASE}/does-not-exist") || true
[[ "${MISS_STATUS}" == "200" ]] || fail "missing key did not return the custom-error 200 (got ${MISS_STATUS})"
grep -qi "spa fallback" "${MISS_BODY}" || fail "missing key did not serve the /404.html custom-error page"

# ---------------------------------------------------------------------------
# 4. --watch: edit the site source, expect the new content served after reload.
# ---------------------------------------------------------------------------
echo "==> --watch: edit site/index.html and expect the reload to serve it"
cp site/index.html site/index.html.bak
printf '<!doctype html><html><body><h1>reloaded root</h1></body></html>\n' > site/index.html
RELOADED=0
for _ in $(seq 1 120); do
  if curl -fsS "${BASE}/" 2>/dev/null | grep -qi "reloaded root"; then RELOADED=1; break; fi
  sleep 0.5
done
mv -f site/index.html.bak site/index.html
[[ "${RELOADED}" -eq 1 ]] || fail "--watch did not serve the edited site content after a reload"

# ---------------------------------------------------------------------------
# 5. Teardown frees the port.
# ---------------------------------------------------------------------------
echo "==> SIGTERM and verify the port is freed"
kill -TERM "${CDKD_PID}" 2>/dev/null || true
for _ in $(seq 1 40); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -0 "${CDKD_PID}" 2>/dev/null && fail "server did not exit on SIGTERM"
CDKD_PID=""
sleep 0.5
if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then fail "port ${PORT} still bound after shutdown"; fi

echo "PASS: cdkd local start-cloudfront served the viewer-request -> S3 origin -> viewer-response pipeline, the SPA fallback, and a --watch reload."
