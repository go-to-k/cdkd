#!/usr/bin/env bash
# verify.sh — cdkd local start-alb --from-state real-AWS integ test
#
# Deploys a real VPC + ALB + 2 ECS Fargate services to AWS so cdkd's
# S3 state file carries resolved Ref / Fn::GetAtt values, then boots
# the local ALB front-door with `--from-state` and asserts the
# engine substituted the deployed ALB DNS name into each container's
# `ALB_DNS_NAME` env var before the container started. This proves
# the engine's `--from-state` substitution path for ALB-fronted
# ECS services works end-to-end against real AWS — a gap that the
# pure-local `local-start-alb` sibling fixture cannot cover.
#
# Flow:
#   1. Pre-flight orphan sweep (Docker + AWS state).
#   2. Synth + cdkd deploy to us-east-1 (~5 min cold).
#   3. Read deployed ALB DNS name via aws cli (sanity).
#   4. Boot `cdkd local start-alb` in background with --from-state +
#      --lb-port 80=8080.
#   5. Probe http://127.0.0.1:8080/ — assert body contains
#      "service=web alb=<deployed-alb-dns>". Substitution proof.
#   6. Probe http://127.0.0.1:8080/orders/ — assert body contains
#      "service=orders alb=<deployed-alb-dns>". Proves both the
#      multi-target boot + the ListenerRule path routing.
#   6b. Probe http://127.0.0.1:8080/fn/x — a TargetType: lambda target group
#      whose function's ALB_DNS_NAME must resolve under --from-state too
#      (go-to-k/cdkd#2602). Before cdk-local 0.151.0 it was dropped, so the
#      body read "service=fn alb=" with nothing after it.
#   7. SIGTERM cdkd. Assert clean teardown.
#   7b. --image-override arms (go-to-k/cdkd#5156): --strict-overrides with
#      OrdersService uncovered is refused before any replica starts; then
#      both services are overridden by construct id / ServiceName and must
#      serve the locally built image's marker file.
#   8. cdkd destroy. Assert 0 errors, 0 orphans.
#
# Run via `/run-integ local-start-alb-from-state` (recommended) or
# directly:
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-alb-from-state/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
STACK_NAME="CdkdLocalStartAlbFromStateFixture"
# CDK L2 `ApplicationLoadBalancer` synthesizes the logical id with an
# auto-hash suffix (e.g. `Alb16C2F182`), so the colon form
# `Stack:Alb` would not match. Use the CDK display-path form
# (`Stack/Alb`) which the engine's `resolveAlbTarget` translates via
# the `aws:cdk:path` index — stable across CDK version bumps.
TARGET="${STACK_NAME}/Alb"
HOST_PORT=8080
REGION="${AWS_REGION:-us-east-1}"
STATE_BUCKET="${STATE_BUCKET:?STATE_BUCKET env var required}"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
LAMBDA_IMAGE="public.ecr.aws/lambda/nodejs:20"

# Track whether AWS resources were created so the trap can attempt a
# destroy even if a curl assertion failed before the explicit destroy
# step. We do NOT silently swallow destroy errors — if the destroy in
# the trap fails, the trap exits non-zero so the orchestrator's
# follow-up orphan sweep fires.
DEPLOYED=0
CDKD_PID=""
OUT_FILE=""

cleanup() {
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
    CDKD_PID=""
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  docker images --filter "reference=cdkd-local-override-*" --format '{{.ID}}' \
    | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true

  if [[ "${DEPLOYED}" -eq 1 ]]; then
    echo "==> Cleanup: cdkd destroy (best-effort)"
    # `--region` is required so the trap-path destroy reads the same
    # region-prefixed state key (`cdkd/<stack>/<region>/state.json`)
    # as the explicit destroy on the happy path. Without it the trap
    # could miss state and leave the stack orphan when AWS_REGION env
    # is unset.
    ${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force \
      || echo "WARN: destroy in trap failed; the orchestrator's orphan sweep will pick it up"
  fi

  if [[ -n "${OUT_FILE}" ]]; then
    rm -f "${OUT_FILE}"
    OUT_FILE=""
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Pre-test orphan sweep (Docker)"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"
docker pull "${LAMBDA_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth --region "${REGION}" >/dev/null

echo "==> Deploying fixture to ${REGION} (real AWS — VPC + ALB + 2 Fargate services)"
${CDKD} deploy "${STACK_NAME}" \
  --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose
DEPLOYED=1

echo "==> Verifying deploy via aws cli (sanity)"
ALB_DNS=$(aws elbv2 describe-load-balancers --region "${REGION}" \
  --names cdkd-local-alb-from-state \
  --query 'LoadBalancers[0].DNSName' --output text)
if [[ -z "${ALB_DNS}" || "${ALB_DNS}" == "None" ]]; then
  echo "FAIL: aws elbv2 describe-load-balancers returned no DNS name for cdkd-local-alb-from-state"
  exit 1
fi
echo "    Deployed ALB DNS: ${ALB_DNS}"

OUT_FILE=$(mktemp)
echo "==> Booting cdkd local start-alb --from-state (listener 80 -> host ${HOST_PORT})"
${CDKD} local start-alb "${TARGET}" \
  --from-state \
  --state-bucket "${STATE_BUCKET}" \
  --lb-port "80=${HOST_PORT}" \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

echo "==> Waiting for boot banner (up to 120s — 2 services + ALB front-door)"
BOOTED=0
for _ in $(seq 1 120); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    echo "FAIL: cdkd exited before reaching the boot banner"
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done

if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: cdkd local start-alb did not reach the boot banner within 120s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting --lb-port override took effect (front-door bound to ${HOST_PORT})"
if ! grep -qE "ALB front-door: https?://[^[:space:]]+:${HOST_PORT} " "${OUT_FILE}"; then
  echo "FAIL: expected an 'ALB front-door' banner on host port ${HOST_PORT}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

probe() {
  # probe <path> <expected-service-banner>
  local path="$1"
  local expected_svc="$2"
  local url="http://127.0.0.1:${HOST_PORT}${path}"
  local body=""
  for _ in $(seq 1 45); do
    if body=$(curl --silent --show-error --max-time 5 "${url}" 2>&1); then
      if echo "${body}" | grep -qF "service=${expected_svc} alb=${ALB_DNS}"; then
        echo "    OK: ${url} -> '${body%$'\n'}'"
        return 0
      fi
    fi
    sleep 1
  done
  echo "FAIL: ${url} did not return the expected substituted body within 45s"
  echo "      expected substring: 'service=${expected_svc} alb=${ALB_DNS}'"
  echo "      last response: ${body}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  return 1
}

echo "==> Probing default route (path / -> Web service)"
probe / web

echo "==> Probing ListenerRule path (path /orders/ -> Orders service)"
probe /orders/ orders

echo "==> Probing the Lambda target group (path /fn/x -> FnTarget, go-to-k/cdkd#2602)"
probe /fn/x fn

echo "==> Sending SIGTERM to cdkd (${CDKD_PID})"
kill -TERM "${CDKD_PID}"

echo "==> Waiting for cdkd to exit (up to 60s)"
EXITED=0
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdkd did not exit within 60s after SIGTERM"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKD_PID}" 2>/dev/null || true
CDKD_PID=""

echo "==> Asserting clean teardown — no leftover containers"
LEFTOVER_CONTAINERS=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_CONTAINERS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_CONTAINERS} containers still present after SIGTERM"
  docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi

echo "==> Asserting clean teardown — no leftover networks"
LEFTOVER_NETS=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${LEFTOVER_NETS}" -ne 0 ]]; then
  echo "FAIL: ${LEFTOVER_NETS} docker networks still present after SIGTERM"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi

# --- --image-override arms (go-to-k/cdkd#5156, via cdk-local 0.153.2) -------
# start-alb keys each service by `Stack:LogicalId`, so before cdk-local 0.153.2
# a documented short key (`WebService=...`) matched nothing: it was dropped
# with a warning and the registry image ran. Both services here run a registry
# image (`fromRegistry`), so both are override targets. The construct-id key
# `WebService` matches only because that service sets no `serviceName` (a
# service that sets one is known by it instead); OrdersService sets one, so it
# is keyed by its ServiceName.
OVERRIDE_DOCKERFILE="./web-override/Dockerfile"

echo "==> --strict-overrides with one service left uncovered: refused before any replica starts"
STRICT_OUT=$(mktemp)
set +e
${CDKD} local start-alb "${TARGET}" \
  --from-state \
  --state-bucket "${STATE_BUCKET}" \
  --lb-port "80=${HOST_PORT}" \
  --no-pull --container-host 127.0.0.1 \
  --no-interactive-overrides --strict-overrides \
  --image-override "WebService=${OVERRIDE_DOCKERFILE}" \
  > "${STRICT_OUT}" 2>&1
STRICT_RC=$?
set -e
STRICT_LOG=$(cat "${STRICT_OUT}")
rm -f "${STRICT_OUT}"
if [[ "${STRICT_RC}" -eq 0 ]]; then
  echo "FAIL: --strict-overrides with OrdersService uncovered exited 0"
  echo "${STRICT_LOG}"
  exit 1
fi
if ! grep -qF -- "--strict-overrides set, but 1 pinned target(s) remain uncovered" <<<"${STRICT_LOG}"; then
  echo "FAIL: expected the --strict-overrides refusal naming exactly 1 uncovered target"
  echo "${STRICT_LOG}"
  exit 1
fi
if grep -qF "Service(s) running:" <<<"${STRICT_LOG}"; then
  echo "FAIL: --strict-overrides refused only after the replicas booted"
  echo "${STRICT_LOG}"
  exit 1
fi
STRICT_LEFTOVER=$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${STRICT_LEFTOVER}" -ne 0 ]]; then
  echo "FAIL: ${STRICT_LEFTOVER} containers present after the --strict-overrides refusal"
  docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
  exit 1
fi
echo "    OK: refused (rc=${STRICT_RC}) with no replica started"

echo "==> --image-override by construct id (WebService) and ServiceName (orders): both matched"
rm -f "${OUT_FILE}"
OUT_FILE=$(mktemp)
${CDKD} local start-alb "${TARGET}" \
  --from-state \
  --state-bucket "${STATE_BUCKET}" \
  --lb-port "80=${HOST_PORT}" \
  --no-pull --container-host 127.0.0.1 \
  --no-interactive-overrides --strict-overrides \
  --image-override "WebService=${OVERRIDE_DOCKERFILE}" \
  --image-override "cdkd-local-alb-orders-svc=${OVERRIDE_DOCKERFILE}" \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

BOOTED=0
for _ in $(seq 1 180); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    echo "FAIL: cdkd exited before reaching the boot banner (override arm)"
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi
  sleep 1
done
if [[ "${BOOTED}" -ne 1 ]]; then
  echo "FAIL: override arm did not reach the boot banner within 180s"
  cat "${OUT_FILE}"
  exit 1
fi
if grep -qF "not in the pinned-target set" "${OUT_FILE}"; then
  echo "FAIL: a short --image-override key was dropped as unmatched"
  cat "${OUT_FILE}"
  exit 1
fi

probe_marker() {
  # probe_marker <path>: the file only the locally built image carries
  local url="http://127.0.0.1:${HOST_PORT}$1"
  local body=""
  for _ in $(seq 1 45); do
    if body=$(curl --silent --show-error --max-time 5 "${url}" 2>&1) \
      && [[ "${body}" == "cdkd-image-override" ]]; then
      echo "    OK: ${url} -> '${body}'"
      return 0
    fi
    sleep 1
  done
  echo "FAIL: ${url} did not serve the override image's marker within 45s"
  echo "      last response: ${body}"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  return 1
}
probe_marker /override.txt
probe_marker /orders/override.txt
# --from-state substitution still reaches the overridden containers.
probe / web
probe /orders/ orders

kill -TERM "${CDKD_PID}"
for _ in $(seq 1 60); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "${CDKD_PID}" 2>/dev/null; then
  echo "FAIL: cdkd did not exit within 60s after SIGTERM (override arm)"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
wait "${CDKD_PID}" 2>/dev/null || true
CDKD_PID=""
rm -f "${OUT_FILE}"
OUT_FILE=""

echo "==> cdkd destroy"
${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force
DEPLOYED=0

echo "==> Verifying state is empty post-destroy"
# Match ONLY the `state.json` object, not the whole prefix. Since #820/#885
# the deployment-events store (`cdkd/<stack>/<region>/deployments/...`)
# survives `destroy` by design, so a bare prefix listing is never empty
# after teardown and would false-FAIL here. The destroy contract is that
# `state.json` is gone; the informational events store is swept separately
# (see /cleanup step 3.5).
# `aws s3 ls --recursive` exits 1 BOTH when nothing matches (empty output)
# and on a real error like a throttle (non-empty error text); only the
# empty-output case means "no keys" (#1097 pattern 2 -- an API error must
# not silently pass this leak check).
STATE_LISTING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK_NAME}/" --recursive --region "${REGION}" 2>&1)" || {
  if [ -n "${STATE_LISTING}" ]; then
    echo "FAIL: could not list s3://${STATE_BUCKET}/cdkd/${STACK_NAME}/ to verify state deletion: ${STATE_LISTING}"
    exit 1
  fi
}
STATE_REMAINING=$(printf '%s' "${STATE_LISTING}" | grep -c 'state\.json' || true)
if [[ "${STATE_REMAINING}" -ne 0 ]]; then
  echo "FAIL: cdkd state.json for ${STACK_NAME} still present after destroy"
  exit 1
fi

echo ""
echo "==> local-start-alb-from-state test passed"
echo "    - Deployed VPC + ALB + 2 ECS Fargate services to ${REGION}"
echo "    - cdkd local start-alb --from-state substituted ALB DNS into both services' env vars"
echo "    - Default route (path /) reached Web service with resolved env var"
echo "    - ListenerRule path /orders/ reached Orders service with resolved env var"
echo "    - Lambda target group /fn/x reached FnTarget with resolved env var"
echo "    - --lb-port 80=8080 override took effect"
echo "    - --strict-overrides refused before any replica started"
echo "    - --image-override matched services by construct id and ServiceName"
echo "    - SIGTERM tore down every replica + network cleanly"
echo "    - cdkd destroy left no state behind"
