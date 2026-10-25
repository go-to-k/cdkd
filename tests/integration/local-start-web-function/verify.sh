#!/usr/bin/env bash
# verify.sh — cdkd local start-web-function integ test (no AWS deploy; Docker)
#
# Serves an AWS Lambda Web Function from the fixture app through cdkd's
# inherited `start-web-function` command (from cdk-local). The app declares one
# CfnWebFunction, three CfnWebFunctionRevisions of the SAME s3assets.Asset
# bundle (web/index.js, a dependency-free HTTP server listening on
# AWS_LAMBDA_HTTP_ENDPOINT) that differ only in their ServiceConfig
# environment, and one CfnWebFunctionEndpoint weighting RevV1 20 / RevV2 80.
# Arms:
#   1. Endpoint target -> the higher-weight RevV2 is served: method / path /
#      ServiceConfig env / function name echoed, the weighted-split warning
#      printed once; SIGTERM leaves no container behind.
#   2. `--revision RevV1 --no-assume-role` overrides the weights (and the
#      cdkd-registered negation parses).
#   3. `--revision RevAlt` sets AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js, so the
#      runtime starts alt.js instead of index.js.
#
#     bash tests/integration/local-start-web-function/verify.sh
#
# Requires Docker. Uses host ports 18470-18472.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
STACK="CdkdLocalStartWebFunctionFixture"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:24"
PORT=18470
CONTAINER_PREFIX="cdkd-local-webfn-"

# The cloud runtime is arm64-only and the command defaults to linux/arm64. On
# an amd64 host, run the container natively instead of under emulation.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64"; PLATFORM_ARGS=() ;;
  *) PLATFORM="linux/amd64"; PLATFORM_ARGS=(--platform linux/amd64) ;;
esac

CDKD_PID=""
OUT_FILE=$(mktemp)

stop_server() {
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

cleanup() {
  echo "==> Cleanup: stopping the server"
  stop_server
  rm -f "${OUT_FILE}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "FAIL: $*" >&2
  echo "----- server output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkd local start-web-function` in the background and wait for its
# ready banner. Truncates OUT_FILE so each serve's lines are read fresh.
boot_serve() {
  stop_server
  : > "${OUT_FILE}"
  ${CDKD} local start-web-function "$@" ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} > "${OUT_FILE}" 2>&1 &
  CDKD_PID=$!
  for _ in $(seq 1 480); do
    if grep -q 'Server listening on http://' "${OUT_FILE}"; then return 0; fi
    kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-web-function exited before it was ready"
    sleep 0.5
  done
  fail "start-web-function did not print its ready banner in time"
}

assert_no_orphans() {
  sleep 1
  local orphans
  orphans="$(docker ps -a --filter "name=${CONTAINER_PREFIX}" --format '{{.Names}}')" \
    || fail "docker ps failed while checking for leftover containers after $1"
  [[ -z "${orphans}" ]] || fail "leftover web function container(s) after $1: ${orphans}"
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null
assert_no_orphans "pre-flight"

echo "==> Arm 1: endpoint target serves the higher-weight revision (RevV2)"
boot_serve "${STACK}/Endpoint" --port "${PORT}" --no-pull
URL="http://127.0.0.1:${PORT}"
grep -q "Server listening on ${URL}" "${OUT_FILE}" || fail "ready banner does not name ${URL}"
BODY="$(curl -s -X POST "${URL}/hello/world?q=1")"
echo "${BODY}" | grep -q '"method":"POST"' || fail "method not echoed: ${BODY}"
echo "${BODY}" | grep -q '"path":"/hello/world?q=1"' || fail "path not echoed: ${BODY}"
echo "${BODY}" | grep -q '"revision":"v2"' || fail "higher-weight revision RevV2 not served: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-v2"' || fail "ServiceConfig env not injected: ${BODY}"
echo "${BODY}" | grep -q '"entry":"index"' || fail "default entry index.js not started: ${BODY}"
echo "${BODY}" | grep -q '"functionName":"cdkd-integ-web-fn"' || fail "function name not set: ${BODY}"
[[ "$(grep -c 'weighted routing is not emulated' "${OUT_FILE}")" -eq 1 ]] \
  || fail "the weighted-split warning was not printed exactly once"
# Sentinel: the warning names the served revision, independent of the phrase above.
grep -q 'every request goes to revision RevV2' "${OUT_FILE}" \
  || fail "the weighted-split warning does not name the served revision"
echo "    RevV2 served: ${BODY}"

echo "==> Arm 1: SIGTERM removes the container"
stop_server
assert_no_orphans "the endpoint serve"

echo "==> Arm 2: --revision RevV1 overrides the endpoint weights"
boot_serve "${STACK}/Endpoint" --revision RevV1 --no-assume-role --port "$((PORT + 1))" --no-pull
BODY="$(curl -s "http://127.0.0.1:$((PORT + 1))/")"
echo "${BODY}" | grep -q '"revision":"v1"' || fail "--revision RevV1 not served: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-v1"' || fail "RevV1 env not injected: ${BODY}"
stop_server
assert_no_orphans "the --revision serve"

echo "==> Arm 3: AWS_LAMBDA_NODEJS_ENTRYPOINT=alt.js starts alt.js"
boot_serve "${STACK}/WebFn" --revision RevAlt --port "$((PORT + 2))" --no-pull
BODY="$(curl -s "http://127.0.0.1:$((PORT + 2))/")"
echo "${BODY}" | grep -q '"entry":"alt"' || fail "the entrypoint env did not start alt.js: ${BODY}"
echo "${BODY}" | grep -q '"revision":"alt"' || fail "RevAlt not served: ${BODY}"
stop_server
assert_no_orphans "the entrypoint serve"

trap - EXIT INT TERM
cleanup
echo "PASS: cdkd local start-web-function"
