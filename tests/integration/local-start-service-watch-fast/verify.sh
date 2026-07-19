#!/usr/bin/env bash
# verify.sh - cdkd local start-service-watch-fast integ test
# (Phase 4 of cdk-local#214 - bind-mount source fast path; cdk-local 0.69.0)
#
# Exercises `cdkd local start-service --watch`'s classifier dispatch against
# real Docker. Deploys nothing.
#
# What it proves:
#   1. Editing the asset's interpreted-language SOURCE (webapp/server.cjs)
#      routes through the Phase 4 fast path: the classifier logs
#      `verdict=soft-reload`, the runner emits the
#      "Soft-reloaded replica r0 ... restart + TCP-ready probe complete;
#      Cloud Map + front-door re-published." line, and the served
#      response transitions from v1 to v2 WITHOUT a `docker build` or
#      shadow boot.
#   2. Editing the asset's Dockerfile routes through the rebuild fallback:
#      the classifier logs `verdict=rebuild (Dockerfile edit (Dockerfile))`,
#      the runner emits the Phase 1-3 "Rolling replica ... single-replica
#      reload complete" line, and the served response transitions from
#      v2 to v3 (proving the fallback still works).
#   3. Clean teardown on SIGTERM (no leftover cdkd-local-* containers /
#      networks).
#
# Run via `/run-integ local-start-service-watch-fast` (recommended) or
# directly:
#
#     bash tests/integration/local-start-service-watch-fast/verify.sh
#
# Requires Docker.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NODE_IMAGE="public.ecr.aws/docker/library/node:22-alpine"
HOST_PORT=8087

SERVER_CJS="webapp/server.cjs"
DOCKERFILE="webapp/Dockerfile"
SERVER_CJS_BACKUP=""
DOCKERFILE_BACKUP=""
LOG_FILE=""
CDKD_PID=""

term_server() {
  if [[ -n "${CDKD_PID:-}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    echo "==> Sending SIGTERM to cdkd (pid ${CDKD_PID})"
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      kill -0 "${CDKD_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${CDKD_PID}" 2>/dev/null; then
      echo "==> cdkd did not exit within 120s; SIGKILL"
      kill -KILL "${CDKD_PID}" 2>/dev/null || true
    fi
  fi
}

restore_source() {
  # Put the committed v1 source back so the working tree is unchanged
  # whether the test passed, failed, or was interrupted mid-edit.
  if [[ -n "${SERVER_CJS_BACKUP:-}" && -f "${SERVER_CJS_BACKUP}" ]]; then
    cp "${SERVER_CJS_BACKUP}" "${SERVER_CJS}"
    rm -f "${SERVER_CJS_BACKUP}"
  fi
  if [[ -n "${DOCKERFILE_BACKUP:-}" && -f "${DOCKERFILE_BACKUP}" ]]; then
    cp "${DOCKERFILE_BACKUP}" "${DOCKERFILE}"
    rm -f "${DOCKERFILE_BACKUP}"
  fi
}

cleanup() {
  term_server
  restore_source
  # Project convention: integ tests do NOT run in parallel (one /run-integ
  # invocation at a time). The broad cdkd-local-* sweep is therefore safe
  # AND robust — if cdkd's own SIGTERM-driven cleanup missed anything
  # (e.g. process killed before teardown), the sweep catches it. If integ
  # parallelism is ever introduced, narrow these filters to a per-run
  # network suffix captured from the boot log.
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  if [[ -n "${LOG_FILE:-}" ]]; then
    rm -f "${LOG_FILE}"
  fi
}
# Install the trap BEFORE any mktemp/cp so a SIGINT in the pre-boot window
# still triggers restore_source + cleanup. The trap body is null-safe for
# the unset-backup case via the [[ -n ... ]] guards in restore_source / cleanup.
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

SERVER_CJS_BACKUP="$(mktemp)"
DOCKERFILE_BACKUP="$(mktemp)"
cp "${SERVER_CJS}" "${SERVER_CJS_BACKUP}"
cp "${DOCKERFILE}" "${DOCKERFILE_BACKUP}"

LOG_FILE="$(mktemp)"

# Pre-test orphan sweep - a failed previous run can leak cdkd-local-* state.
echo "==> Pre-test orphan sweep"
docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
  | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
  | xargs -r docker network rm >/dev/null 2>&1 || true

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NODE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

soft_reload_verdict_count() {
  local n
  n=$(grep -c "verdict=soft-reload" "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}
rebuild_verdict_count() {
  local n
  n=$(grep -c "verdict=rebuild" "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}
soft_reload_completion_count() {
  local n
  n=$(grep -cE "Soft-reloaded replica .*restart \+ TCP-ready probe complete" \
    "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}
rolling_completion_count() {
  local n
  n=$(grep -cE "Rolling replica .*(swap complete|single-replica reload complete)" \
    "${LOG_FILE}" 2>/dev/null) || n=0
  echo "${n}"
}

echo "==> Booting service (DesiredCount=1) with --watch on host port ${HOST_PORT}"
${CDKD} local start-service CdkdLocalStartServiceWatchFastFixture:WebService \
  --watch \
  --no-pull \
  --host-port "8080=${HOST_PORT}" \
  --container-host 127.0.0.1 \
  >"${LOG_FILE}" 2>&1 &
CDKD_PID=$!

echo "==> Waiting for boot banner (up to 240s; first boot builds the Node asset image)"
BOOTED=0
for _ in $(seq 1 240); do
  if grep -q "Service(s) running:" "${LOG_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    echo "FAIL: cdkd exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${LOG_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: service did not reach the boot banner within 240s"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  exit 1
fi

URL="http://127.0.0.1:${HOST_PORT}/"
curl_until() {
  local label="$1" url="$2" needle="$3" tries="$4"
  local response=""
  for _ in $(seq 1 "${tries}"); do
    if response=$(curl -sf --max-time 3 "${url}" 2>&1); then
      if echo "${response}" | grep -q "${needle}"; then
        echo "    [${label}] OK (response: ${response})"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${label} never matched '${needle}'. Last response: '${response}'"
  echo "----- service output -----"
  cat "${LOG_FILE}"
  echo "--------------------------"
  return 1
}

echo "==> Asserting the service serves v1 before any edit"
curl_until "GET / (v1)" "${URL}" '^v1$' 60

# -----------------------------------------------------------------------
# PHASE 4 FAST PATH - source-only edit
# -----------------------------------------------------------------------

echo "==> Editing webapp/server.cjs (v1 -> v2) to trigger the fast path"
cat >"${SERVER_CJS}" <<'EOF'
// server.cjs - mutated to v2 by verify.sh (Phase 4 soft-reload path)
const http = require('http');
const VERSION = 'v2';
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(VERSION);
  })
  .listen(8080, '0.0.0.0', () => {
    console.log(`server.cjs ${VERSION} listening on 8080`);
  });
EOF

echo "==> Waiting for the classifier to emit verdict=soft-reload"
SOFT_VERDICT=0
for _ in $(seq 1 90); do
  if [[ "$(soft_reload_verdict_count)" -ge 1 ]]; then
    SOFT_VERDICT=1
    break
  fi
  sleep 1
done
if [[ "${SOFT_VERDICT}" -eq 0 ]]; then
  echo "FAIL: the source-only edit did not produce 'verdict=soft-reload' within 90s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [verdict=soft-reload] OK"

echo "==> Waiting for the soft-reload completion log line"
SOFT_DONE=0
for _ in $(seq 1 90); do
  if [[ "$(soft_reload_completion_count)" -ge 1 ]]; then
    SOFT_DONE=1
    break
  fi
  sleep 1
done
if [[ "${SOFT_DONE}" -eq 0 ]]; then
  echo "FAIL: the soft-reload primitive did not log completion within 90s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [soft-reload complete] OK"

echo "==> Asserting the service now serves v2 (docker cp + docker restart; no rebuild)"
curl_until "GET / (v2)" "${URL}" '^v2$' 60

# The fast path MUST NOT have triggered the rebuild rolling primitive.
REBUILD_VERDICTS_AFTER_V2="$(rebuild_verdict_count)"
if [[ "${REBUILD_VERDICTS_AFTER_V2}" -ne 0 ]]; then
  echo "FAIL: expected 0 rebuild verdicts after the source-only edit, got ${REBUILD_VERDICTS_AFTER_V2}"
  cat "${LOG_FILE}"
  exit 1
fi
ROLLING_AFTER_V2="$(rolling_completion_count)"
if [[ "${ROLLING_AFTER_V2}" -ne 0 ]]; then
  echo "FAIL: expected 0 rolling-primitive completions after the source-only edit, got ${ROLLING_AFTER_V2}"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [fast path: no rebuild, no shadow boot] OK"

# -----------------------------------------------------------------------
# REBUILD FALLBACK - Dockerfile edit
# -----------------------------------------------------------------------

echo "==> Editing webapp/Dockerfile (bump base image revision) to force the rebuild path"
cat >"${DOCKERFILE}" <<'EOF'
FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
COPY server.cjs /app/server.cjs
# Dockerfile edit marker bumped by verify.sh to force the rebuild path.
ENV PHASE4_DOCKERFILE_EDIT=1
EXPOSE 8080
CMD ["node", "/app/server.cjs"]
EOF
# We also need to bump server.cjs to v3 so the user-visible response
# changes - otherwise we couldn't tell the rebuild apart from a noop.
cat >"${SERVER_CJS}" <<'EOF'
// server.cjs - mutated to v3 by verify.sh (Phase 4 rebuild fallback)
const http = require('http');
const VERSION = 'v3';
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(VERSION);
  })
  .listen(8080, '0.0.0.0', () => {
    console.log(`server.cjs ${VERSION} listening on 8080`);
  });
EOF

echo "==> Waiting for the classifier to emit verdict=rebuild (Dockerfile trigger)"
REBUILD_VERDICT=0
for _ in $(seq 1 90); do
  if [[ "$(rebuild_verdict_count)" -ge 1 ]]; then
    REBUILD_VERDICT=1
    break
  fi
  sleep 1
done
if [[ "${REBUILD_VERDICT}" -eq 0 ]]; then
  echo "FAIL: the Dockerfile edit did not produce 'verdict=rebuild' within 90s"
  cat "${LOG_FILE}"
  exit 1
fi
if ! grep -q "verdict=rebuild (Dockerfile edit" "${LOG_FILE}"; then
  echo "FAIL: the rebuild verdict did not name the Dockerfile as the trigger"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [verdict=rebuild (Dockerfile edit ...)] OK"

echo "==> Waiting for the rolling-primitive completion log line"
ROLLING_DONE=0
for _ in $(seq 1 240); do
  if [[ "$(rolling_completion_count)" -ge 1 ]]; then
    ROLLING_DONE=1
    break
  fi
  sleep 1
done
if [[ "${ROLLING_DONE}" -eq 0 ]]; then
  echo "FAIL: the rebuild rolling primitive did not log completion within 240s"
  cat "${LOG_FILE}"
  exit 1
fi
echo "    [rolling primitive completed] OK"

echo "==> Asserting the service now serves v3 (full rebuild + replica swap)"
curl_until "GET / (v3)" "${URL}" '^v3$' 60

# -----------------------------------------------------------------------
# TEARDOWN
# -----------------------------------------------------------------------

echo "==> SIGTERM the emulator and assert no leftover containers / networks"
term_server

LEAKED_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.Names}}' | wc -l | tr -d ' ')
LEAKED_NETS=$(docker network ls --filter "name=cdkd-local-" --format '{{.Name}}' | wc -l | tr -d ' ')
if [[ "${LEAKED_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEAKED_CONTAINERS} container(s) leaked post-teardown:"
  docker ps -a --filter "name=cdkd-local-" --format '{{.Names}}'
  exit 1
fi
if [[ "${LEAKED_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEAKED_NETS} network(s) leaked post-teardown:"
  docker network ls --filter "name=cdkd-local-" --format '{{.Name}}'
  exit 1
fi
echo "    [clean teardown] OK"

echo ""
echo "==> Phase 4 fast path integ PASSED"
