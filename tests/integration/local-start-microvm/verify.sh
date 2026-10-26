#!/usr/bin/env bash
# verify.sh — cdkd local start-microvm integ test (no AWS deploy; Docker)
#
# Runs AWS Lambda MicroVMs from the fixture app's AWS::Lambda::MicrovmImage
# through cdkd's inherited `start-microvm` command (from cdk-local; modeled on
# cdk-local's own `local-start-microvm` fixture). The app declares two
# CfnMicrovmImages of the SAME s3assets.Asset directory (app/Dockerfile +
# app/app.js, a dependency-free server: hooks on 9001, echo endpoints on 8080
# and 9000). `Image` enables every hook and its /ready answers 503 twice before
# 200; `NeverReadyImage` answers 503 forever with a 3-second
# ReadyTimeoutInSeconds. Arms:
#
#   1. Hooks + payload: /ready retried until 200, then /validate and /run; the
#      run payload, the generated microvmId and EnvironmentVariables reach the
#      app, in hook order.
#   2. Port routing + stripping: 8080 by default, 9000 by X-aws-proxy-port;
#      X-aws-proxy-* headers never reach the app; invalid -> 400, unpublished
#      -> 403, published but not listening -> 502.
#   3. WebSocket routed by lambda-microvms.port.9000 echoes; the app sees no
#      MicroVM subprotocol and the 101 selects lambda-microvms.
#   4. Control endpoint: suspend (container docker-paused) -> 503 -> resume ->
#      served, with the /suspend and /resume hooks observed; a cross-origin
#      control request is refused 403.
#   5. SIGTERM -> /terminate observed, exit 0, no container left.
#   6. `--count 2`: two URLs with different microvmIds; SIGTERM terminates
#      both. `--auto-resume`: three concurrent requests to a suspended MicroVM
#      all get 200 through ONE /resume.
#   7. `NeverReadyImage`: boot fails non-zero with the /ready timeout message
#      and leaves no container.
#
#     bash tests/integration/local-start-microvm/verify.sh
#
# Requires Docker. Uses host ports 18490-18494. Every curl has --max-time, so a
# broken gate fails the arm instead of hanging it.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
STACK="CdkdLocalStartMicrovmFixture"
BASE_IMAGE="public.ecr.aws/docker/library/node:24-slim"
PORT=18490
PAYLOAD="tenant-a"

# The image declares ARM_64. On an amd64 host, build and run natively instead
# of under emulation (the app is plain JavaScript on a multi-arch base).
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64" ;;
  *) PLATFORM="linux/amd64" ;;
esac

CDKD_PID=""
# Every pid this script started a run under, so cleanup reaches each one's
# containers even after CDKD_PID has moved on.
RUN_PIDS=""
OUT_FILE="$(mktemp)"

# Containers are named `cdkd-local-microvm-<cdkd pid>-<index>-<rand>`, so a
# filter on this run's pid never matches a peer session's MicroVMs.
containers_of() { # usage: containers_of <pid>
  docker ps -a --filter "name=cdkd-local-microvm-$1-" --format '{{.Names}}'
}

stop_server() {
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

cleanup() {
  echo "==> Cleanup: stopping the run, removing its containers"
  stop_server
  for pid in ${RUN_PIDS}; do
    for name in $(containers_of "${pid}" 2>/dev/null); do
      docker rm -f "${name}" >/dev/null 2>&1 || true
    done
  done
  rm -f "${OUT_FILE}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "FAIL: $*" >&2
  echo "----- cdkd output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  exit 1
}

# Boot `cdkd local start-microvm` in the background and wait for its ready
# banner. Truncates OUT_FILE so each run's lines are read fresh.
boot_run() {
  : > "${OUT_FILE}"
  ${CDKD} local start-microvm "$@" --platform "${PLATFORM}" > "${OUT_FILE}" 2>&1 &
  CDKD_PID=$!
  RUN_PIDS="${RUN_PIDS} ${CDKD_PID}"
  for _ in $(seq 1 480); do
    if grep -q 'Press ^C to terminate the MicroVM(s).' "${OUT_FILE}"; then return 0; fi
    kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-microvm exited before it was ready"
    sleep 0.5
  done
  fail "start-microvm did not print its ready banner in time"
}

# SIGTERM the run, wait for THAT pid to exit 0, and require its containers gone.
terminate_run() {
  local pid="${CDKD_PID}" rc left
  kill -TERM "${pid}"
  set +e
  wait "${pid}"
  rc=$?
  set -e
  CDKD_PID=""
  [[ "${rc}" -eq 0 ]] || fail "start-microvm exited ${rc} on SIGTERM (want 0)"
  left="$(containers_of "${pid}")" || fail "docker ps failed while checking for leftover containers"
  [[ -z "${left}" ]] || fail "leftover MicroVM container(s) after SIGTERM: ${left}"
}

status_of() {
  curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$@"
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null

echo "==> Arm 1: hooks driven in order, payload + microvmId + env reach the app"
boot_run "${STACK}/Image" --port "${PORT}" --run-hook-payload "${PAYLOAD}" --proxy-port 9100
URL="http://127.0.0.1:${PORT}"
grep -q "listening on ${URL}" "${OUT_FILE}" || fail "ready banner does not name ${URL}"
grep -q 'HOOK ready -> 503 (attempt 2)' "${OUT_FILE}" || fail "/ready was not retried after 503"
grep -Eq '/ready hook answered 200 after [3-9][0-9]* attempt' "${OUT_FILE}" \
  || fail "/ready did not reach 200 after the 503 retries"
grep -q '/validate hook answered 200' "${OUT_FILE}" || fail "/validate was not called"
grep -q '/run hook answered 200' "${OUT_FILE}" || fail "/run was not called"
MVM_ID="$(grep -oE 'MicroVM mvm-[0-9a-f-]+ listening' "${OUT_FILE}" | awk 'NR == 1 {print $2}')"
[[ -n "${MVM_ID}" ]] || fail "no microvmId in the ready banner"
BODY="$(curl -s --max-time 10 "${URL}/hello")"
echo "${BODY}" | grep -q '"port":8080' || fail "default request not routed to 8080: ${BODY}"
echo "${BODY}" | grep -q "\"microvmId\":\"${MVM_ID}\"" || fail "/run microvmId not seen by the app: ${BODY}"
echo "${BODY}" | grep -q "\"runHookPayload\":\"${PAYLOAD}\"" || fail "run payload not seen by the app: ${BODY}"
echo "${BODY}" | grep -q '"greeting":"hello-from-microvm"' || fail "EnvironmentVariables not injected: ${BODY}"
echo "${BODY}" | grep -q '"hooks":\["ready","validate","run"\]' || fail "hook order wrong: ${BODY}"
echo "    ${MVM_ID}: ${BODY}"

echo "==> Arm 2: port routing and header stripping"
BODY="$(curl -s --max-time 10 "${URL}/alt" -H 'X-aws-proxy-port: 9000' -H 'X-aws-proxy-auth: token' -H 'X-aws-proxy-extra: 1')"
echo "${BODY}" | grep -q '"port":9000' || fail "X-aws-proxy-port: 9000 not routed to 9000: ${BODY}"
echo "${BODY}" | grep -q '"proxyHeaders":\[\]' || fail "X-aws-proxy-* headers reached the app: ${BODY}"
[[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: abc')" = "400" ]] || fail "invalid X-aws-proxy-port not 400"
[[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: 9200')" = "403" ]] || fail "unpublished port not 403"
[[ "$(status_of "${URL}/" -H 'X-aws-proxy-port: 9100')" = "502" ]] \
  || fail "published port with no listener (--proxy-port 9100) not 502"

echo "==> Arm 3: WebSocket routed by lambda-microvms.port.9000, MicroVM subprotocols stripped"
WS_OUT="$(node -e '
const ws = new WebSocket(process.argv[1], ["lambda-microvms", "lambda-microvms.port.9000"]);
const got = [];
const timer = setTimeout(() => { console.log(JSON.stringify({ error: "timeout", got })); process.exit(1); }, 10000);
ws.onopen = () => ws.send("ping");
ws.onerror = (e) => { console.log(JSON.stringify({ error: String(e.message || e.type), got })); process.exit(1); };
ws.onmessage = (m) => {
  got.push(String(m.data));
  if (got.length === 2) {
    clearTimeout(timer);
    console.log(JSON.stringify({ protocol: ws.protocol, got }));
    ws.close();
  }
};
' "ws://127.0.0.1:${PORT}/ws")" || fail "WebSocket client failed: ${WS_OUT}"
echo "${WS_OUT}" | grep -q '"protocol":"lambda-microvms"' || fail "101 did not select lambda-microvms: ${WS_OUT}"
echo "${WS_OUT}" | grep -q 'subprotocolHeader\\":null' || fail "the app saw a subprotocol header: ${WS_OUT}"
echo "${WS_OUT}" | grep -q '"echo:ping"' || fail "the echo did not round-trip through port 9000: ${WS_OUT}"
echo "    ${WS_OUT}"

echo "==> Arm 4: control endpoint: cross-origin refused, suspend -> 503 -> resume -> served"
[[ "$(status_of -X POST "${URL}/_cdkl/microvm/suspend" -H 'Origin: http://evil.example')" = "403" ]] \
  || fail "a cross-origin control request was not refused 403"
if grep -q 'HOOK suspend' "${OUT_FILE}"; then
  fail "the refused cross-origin request still ran /suspend"
fi
curl -s --max-time 10 -X POST "${URL}/_cdkl/microvm/suspend" | grep -q '"state":"suspended"' \
  || fail "suspend did not report suspended"
grep -q 'HOOK suspend -> 200' "${OUT_FILE}" || fail "/suspend hook not observed"
CONTAINER="$(grep -oE '\(container cdkd-local-microvm-[^)]+\)' "${OUT_FILE}" | awk 'NR == 1 {print $2}' | tr -d '()')"
[[ -n "${CONTAINER}" ]] || fail "no container name in the boot log"
[[ "$(docker inspect -f '{{.State.Paused}}' "${CONTAINER}")" = "true" ]] \
  || fail "container ${CONTAINER} is not paused while the MicroVM is suspended"
[[ "$(status_of "${URL}/while-suspended")" = "503" ]] || fail "a request to a suspended MicroVM was not 503"
curl -s --max-time 10 -X POST "${URL}/_cdkl/microvm/resume" | grep -q '"state":"running"' \
  || fail "resume did not report running"
BODY="$(curl -s --max-time 10 "${URL}/after-resume")"
echo "${BODY}" | grep -q '"hooks":\["ready","validate","run","suspend","resume"\]' \
  || fail "/resume hook not observed by the app: ${BODY}"

echo "==> Arm 5: SIGTERM calls /terminate and removes the container"
terminate_run
grep -q "MicroVM ${MVM_ID}: /terminate hook answered 200" "${OUT_FILE}" || fail "/terminate not called on SIGTERM"
grep -q 'HOOK terminate -> 200' "${OUT_FILE}" || fail "the app did not log its /terminate hook"

echo "==> Arm 6: --count 2 runs two independent MicroVMs"
boot_run "${STACK}/Image" --port "$((PORT + 2))" --count 2
A="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 2))/")"
B="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 3))/")"
ID_A="$(echo "${A}" | grep -oE 'mvm-[0-9a-f-]+' | awk 'NR == 1')"
ID_B="$(echo "${B}" | grep -oE 'mvm-[0-9a-f-]+' | awk 'NR == 1')"
[[ -n "${ID_A}" && -n "${ID_B}" ]] || fail "a --count 2 URL did not answer with a microvmId: ${A} / ${B}"
[[ "${ID_A}" != "${ID_B}" ]] || fail "the two MicroVMs share microvmId ${ID_A}"
terminate_run
[[ "$(grep -c '/terminate hook answered 200' "${OUT_FILE}")" -eq 2 ]] \
  || fail "SIGTERM did not terminate both MicroVMs"

echo "==> Arm 6b: --auto-resume: concurrent requests to a suspended MicroVM share ONE resume"
boot_run "${STACK}/Image" --port "$((PORT + 4))" --auto-resume
AR_URL="http://127.0.0.1:$((PORT + 4))"
curl -s --max-time 10 -X POST "${AR_URL}/_cdkl/microvm/suspend" | grep -q '"state":"suspended"' \
  || fail "suspend did not report suspended (auto-resume run)"
AR_DIR="$(mktemp -d)"
AR_PIDS=()
for i in 1 2 3; do
  curl -s --max-time 20 -o /dev/null -w '%{http_code}' "${AR_URL}/held-${i}" > "${AR_DIR}/${i}" &
  AR_PIDS+=("$!")
done
# Wait on the curls only: a bare `wait` also waits on the backgrounded run.
wait "${AR_PIDS[@]}"
AR_CODES="$(cat "${AR_DIR}/1" "${AR_DIR}/2" "${AR_DIR}/3")"
rm -rf "${AR_DIR}"
[[ "${AR_CODES}" = "200200200" ]] || fail "held requests did not all succeed after auto-resume: ${AR_CODES}"
[[ "$(grep -c 'HOOK resume -> 200' "${OUT_FILE}")" -eq 1 ]] \
  || fail "the three held requests did not share exactly one /resume"
terminate_run

echo "==> Arm 7: a /ready that never answers 200 fails with the timeout"
: > "${OUT_FILE}"
set +e
${CDKD} local start-microvm "${STACK}/NeverReadyImage" --platform "${PLATFORM}" > "${OUT_FILE}" 2>&1 &
NR_PID=$!
RUN_PIDS="${RUN_PIDS} ${NR_PID}"
wait "${NR_PID}"
NR_RC=$?
set -e
[[ "${NR_RC}" -ne 0 ]] || fail "start-microvm exited 0 for an image that is never ready"
grep -q 'The /ready hook did not answer 200 within 3000ms' "${OUT_FILE}" \
  || fail "the never-ready failure does not name the /ready timeout"
LEFT="$(containers_of "${NR_PID}")" || fail "docker ps failed while checking for leftover containers"
[[ -z "${LEFT}" ]] || fail "leftover container after the never-ready failure: ${LEFT}"

trap - EXIT INT TERM
cleanup
echo "PASS: cdkd local start-microvm"
