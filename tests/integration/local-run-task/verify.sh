#!/usr/bin/env bash
# verify.sh — local-run-task integ test
#
# Fully local: no AWS resources are deployed. Exercises `cdkd local
# run-task` end-to-end against Docker + the AWS-published
# `amazon-ecs-local-container-endpoints` sidecar + a single nginx
# container exposing port 80 → 18080 on the host.
#
# Run via `/run-integ local-run-task` (recommended) or directly:
#
#     bash tests/integration/local-run-task/verify.sh
#
# Requires Docker. The script pulls the sidecar + nginx images up front
# so the run is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
NGINX_IMAGE="public.ecr.aws/nginx/nginx:alpine"

SHIM_DIR=""
TASK_PID=""

cleanup() {
  echo "==> Cleanup: stopping any leftover containers"
  if [[ -n "${TASK_PID:-}" ]] && kill -0 "${TASK_PID}" 2>/dev/null; then
    kill -KILL "${TASK_PID}" 2>/dev/null || true
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-task-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1 || true
  [[ -n "${SHIM_DIR:-}" ]] && rm -rf "${SHIM_DIR}" || true
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${NGINX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

echo "==> [1/3] Starting task via --detach"
${CDKD} local run-task CdkdLocalRunTaskFixture/NginxTask --detach --no-pull --container-host 127.0.0.1

echo "==> [2/3] Curling http://127.0.0.1:18080/"
# Give nginx ~5s to listen.
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ || true)
echo "    HTTP code: ${HTTP_CODE}"
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: expected 200, got ${HTTP_CODE}"
  exit 1
fi

echo ""

# Tear down explicitly so the assertion below has something to assert ABOUT --
# this fixture runs `--detach`, so without this the containers are still Up and
# only the EXIT trap would remove them (mirrors local-run-task-awsvpc).
cleanup

# Assert the teardown actually swept. `-a` is load-bearing: a print-and-exit
# task container is already `Exited` here, so a running-only check passes while
# the orphan remains — the leak that survived every run of the sibling fixture.
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} container(s) still present after cleanup"
  docker ps -a --filter "name=cdkd-local-"
  exit 1
fi
echo "==> Teardown clean: 0 containers (incl. exited)"

# Test 3 — issue #4495: a ^C that lands while the task container's `docker run`
# is in flight must not leave the container that run starts. The container is
# recorded only once `docker run` returns, so cdkd's cleanup used to stop and
# remove what it knew, exit, and leave the in-flight run's container behind. A
# `CDK_DOCKER` shim holds the nginx container's `docker run` until the script
# releases it right after the ^C (capped at 60s), so the ^C lands inside it
# deterministically; only cdkd's node process is signalled, so the shim's run
# completes either way and the check reads what cdkd left.
echo "==> [3/3] ^C during the task container's docker run leaves no container"
SHIM_DIR=$(mktemp -d -t cdkd-docker-shim-XXXX)
TASK_LOG="${SHIM_DIR}/task.log"
cat > "${SHIM_DIR}/docker-shim" <<'SHIM'
#!/usr/bin/env bash
d="${CDKD_VERIFY_SHIM_DIR}"
if [[ "${1:-}" == "run" && "$*" == *nginx* && -f "${d}/armed" ]]; then
  rm -f "${d}/armed"
  touch "${d}/in-run"
  for _ in $(seq 1 120); do [[ -f "${d}/release" ]] && break; sleep 0.5; done
  rc=0
  docker "$@" > "${d}/run-id" 2>"${d}/run-err" || rc=$?
  cat "${d}/run-id"
  echo "${rc}" > "${d}/run-done"
  exit "${rc}"
fi
exec docker "$@"
SHIM
chmod +x "${SHIM_DIR}/docker-shim"
touch "${SHIM_DIR}/armed"

CDK_DOCKER="${SHIM_DIR}/docker-shim" CDKD_VERIFY_SHIM_DIR="${SHIM_DIR}" \
  ${CDKD} local run-task CdkdLocalRunTaskFixture/NginxTask --no-pull --container-host 127.0.0.1 \
  </dev/null >"${TASK_LOG}" 2>&1 &
TASK_PID=$!
for _ in $(seq 1 120); do
  [[ -f "${SHIM_DIR}/in-run" ]] && break
  kill -0 "${TASK_PID}" 2>/dev/null || break
  sleep 1
done
[[ -f "${SHIM_DIR}/in-run" ]] || {
  echo "FAIL: the task never reached its container's docker run. Log:"
  cat "${TASK_LOG}"
  exit 1
}

# Guards against vacuity: the run must still be in flight at the ^C.
[[ ! -f "${SHIM_DIR}/run-done" ]] || {
  echo "FAIL: the held docker run finished before the ^C. Log:"
  cat "${TASK_LOG}"
  exit 1
}
kill -INT "${TASK_PID}"
sleep 1
touch "${SHIM_DIR}/release"
# Bounded: a cleanup that never settles must fail here, not hang the run.
for _ in $(seq 1 60); do
  kill -0 "${TASK_PID}" 2>/dev/null || break
  sleep 1
done
kill -0 "${TASK_PID}" 2>/dev/null && {
  echo "FAIL: cdkd did not exit within 60s of the ^C. Log:"
  cat "${TASK_LOG}"
  exit 1
}
TASK_RC=0
wait "${TASK_PID}" || TASK_RC=$?
TASK_PID=""
for _ in $(seq 1 30); do
  [[ -f "${SHIM_DIR}/run-done" ]] && break
  sleep 1
done
[[ -f "${SHIM_DIR}/run-done" ]] || {
  echo "FAIL: the held docker run never finished. Log:"
  cat "${TASK_LOG}"
  exit 1
}
RUN_ID=$(cat "${SHIM_DIR}/run-id" 2>/dev/null || true)
LEFT=""
[[ -n "${RUN_ID}" ]] && LEFT=$(docker ps -a --filter "id=${RUN_ID}" --format ' {{.Names}}')
LEFT="${LEFT}$(docker ps -a --filter "name=cdkd-local-" --format ' {{.Names}} ({{.Status}})')"
LEFT="${LEFT}$(docker network ls --filter "name=cdkd-local-task-" --format ' {{.Name}}')"
[[ -z "${LEFT}" ]] || {
  echo "FAIL: ^C during the container's docker run left resources behind:${LEFT}. Log:"
  cat "${TASK_LOG}"
  exit 1
}
# Guards the check above against vacuity: the held run really started a
# container (on a network cdkd had not yet torn down), so the empty listing
# means cdkd removed it.
[[ "$(cat "${SHIM_DIR}/run-done")" == "0" && -n "${RUN_ID}" ]] || {
  echo "FAIL: the held docker run did not start a container (rc $(cat "${SHIM_DIR}/run-done"); stderr: $(cat "${SHIM_DIR}/run-err" 2>/dev/null)). Log:"
  cat "${TASK_LOG}"
  exit 1
}
[[ "${TASK_RC}" == "130" ]] || {
  echo "FAIL: expected cdkd to exit 130 on ^C, got ${TASK_RC}. Log:"
  cat "${TASK_LOG}"
  exit 1
}
echo "    [^C during docker run] OK (container removed, exit 130)"

echo "==> All local-run-task tests passed"
