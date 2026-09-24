#!/usr/bin/env bash
# verify.sh — cdkd local start-service Phase 2 integ test
#
# Boots a 2-replica ECS Service emulator backed by busybox heartbeat
# containers. Asserts both replicas reach docker, then SIGTERMs cdkd and
# asserts clean teardown (no leftover containers / networks / sidecars).
#
# Then (issue #3655) deploys a one-resource ECR repository stack, pushes
# busybox into it, and boots one service per NON-PLAIN registry host form
# (dual-stack, and FIPS where AWS serves it) WITHOUT `--no-pull`, so
# cdk-local's own ECR puller logs in and pulls. Destroys the repository
# stack on every exit path.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash tests/integration/local-start-service/verify.sh

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------
cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalStartServiceFixture"
REPO_STACK="CdkdLocalStartServicePullRepoFixture"
# Must match PULL_REPO_NAME in lib/local-start-service-stack.ts.
PULL_REPO="cdkd-local-start-service-pull-fixture"
# Set to 1 immediately BEFORE the repo stack's deploy starts, so a deploy
# killed half-way is still destroyed.
REPO_DEPLOYED=0
# The pull arm's private docker config. cdk-local's `docker login` writes the
# ECR token into it unencrypted, so cleanup removes it on every exit path.
PULL_DOCKER_CONFIG=""
# Set once STS answers; cleanup removes this run's local image tags with it.
ACCOUNT_ID=""
# Captured `cdkd local start-service` output of the arm in flight.
OUT_FILE=""

# Orphan sweep — always runs even if the service was already killed.
cleanup() {
  local rc=$?
  echo "==> Cleanup: stopping any leftover containers + networks"
  if [[ -n "${CDKD_PID:-}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    # Give cdkd up to 30s to clean up gracefully.
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  if [[ -n "${OUT_FILE}" ]]; then
    rm -f "${OUT_FILE}"
  fi
  # Local tags the push / pull steps may leave behind on a mid-arm failure.
  if [[ -n "${ACCOUNT_ID}" ]]; then
    docker image rm -f \
      "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${PULL_REPO}:latest" \
      "${ACCOUNT_ID}.dkr-ecr.${REGION}.on.aws/${PULL_REPO}:latest" \
      "${ACCOUNT_ID}.dkr.ecr-fips.${REGION}.amazonaws.com/${PULL_REPO}:latest" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "${PULL_DOCKER_CONFIG}" ]]; then
    rm -rf "${PULL_DOCKER_CONFIG}"
    PULL_DOCKER_CONFIG=""
  fi
  if [[ "${REPO_DEPLOYED}" -eq 1 ]]; then
    REPO_DEPLOYED=0
    echo "==> Cleanup: destroying ${REPO_STACK}"
    local destroy_rc=0
    ${CDKD} destroy "${REPO_STACK}" --state-bucket "${STATE_BUCKET}" --force || destroy_rc=$?
    if [[ "${destroy_rc}" -ne 0 ]]; then
      echo "FAIL: cdkd destroy ${REPO_STACK} exited ${destroy_rc}"
      [[ "${rc}" -ne 0 ]] || rc=1
    fi
    if ! gone_probe aws ecr describe-repositories --region "${REGION}" \
      --repository-names "${PULL_REPO}"; then
      echo "FAIL: ECR repository ${PULL_REPO} still exists after destroy"
      [[ "${rc}" -ne 0 ]] || rc=1
    fi
    exit "${rc}"
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# Pre-test orphan sweep — a failed previous run can leak cdkd-local-*
# containers / networks, and the new per-replica subnet-isolation assertion
# below counts every cdkd-local-* network, so a stranded network from the
# previous run would either inflate NET_COUNT or surface a duplicate-subnet
# false positive. Run cleanup() once at boot to guarantee a clean baseline;
# the function is idempotent (xargs -r over empty input, kill -0 short-circuit
# on the unset CDKD_PID) so it's safe to invoke without any state populated.
echo "==> Pre-test orphan sweep"
cleanup

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling fixture images"
docker pull "${SIDECAR_IMAGE}"
docker pull "${BUSYBOX_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Capture the service output so we can grep for the boot banner. `cleanup`
# removes it, so the single EXIT trap above still sees the script's status.
OUT_FILE=$(mktemp)

echo "==> Booting service (DesiredCount=2)"
${CDKD} local start-service CdkdLocalStartServiceFixture:WebService \
  --no-pull --container-host 127.0.0.1 \
  > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!

# Wait for the service boot banner. The CLI prints
# "Service(s) running: <Name> (N replica(s)). Press ^C to shut down."
# once every target's controller has been started — that's the
# deterministic ready marker.
echo "==> Waiting for boot banner (up to 60s)"
BOOTED=0
for i in $(seq 1 60); do
  if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
    BOOTED=1
    break
  fi
  # If cdkd exited early, fail fast.
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
  echo "FAIL: service did not reach the boot banner within 60s"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi

echo "==> Asserting 2 replicas (4 containers: 2 web + 2 metadata sidecars)"
# Each replica gets its own docker network + sidecar, plus 1 web container.
# We assert at least 2 'web'-image containers running under the cdkd-local
# prefix; the sidecar count is incidental.
WEB_COUNT=$(docker ps --filter "ancestor=${BUSYBOX_IMAGE}" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${WEB_COUNT}" -lt 2 ]]; then
  echo "FAIL: expected at least 2 busybox 'web' containers running, found ${WEB_COUNT}"
  docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  exit 1
fi
echo "    OK: ${WEB_COUNT} busybox web containers running"

echo "==> Asserting one shared docker network (design § 5 Option A, PR #522)"
# Post-#522 every replica in a single CLI invocation joins ONE shared
# `cdkd-local-svc-<rand>` network so peers can reach each other by IP
# / network alias without `docker network connect` choreography. The
# pre-#522 per-replica-network shape (with the `170 + (index % 84)`
# subnet allocator + per-replica subnet isolation assertion) is gone.
NET_COUNT=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')
if [[ "${NET_COUNT}" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 shared cdkd-local-* docker network, found ${NET_COUNT}"
  docker network ls --filter "name=cdkd-local-"
  exit 1
fi
NET_ID=$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}')
SUBNET=$(docker network inspect "${NET_ID}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || echo "")
echo "    network ${NET_ID}: subnet=${SUBNET}"
# Subnet must be the shared-service `169.254.171.0/24` (SHARED_SVC_SUBNET_OCTET).
if [[ "${SUBNET}" != "169.254.171.0/24" ]]; then
  echo "FAIL: expected shared subnet 169.254.171.0/24 (SHARED_SVC_SUBNET_OCTET), got ${SUBNET}"
  exit 1
fi
echo "    OK: 1 shared network on 169.254.171.0/24"

echo "==> Sending SIGTERM to cdkd ($(echo $CDKD_PID))"
kill -TERM "${CDKD_PID}"

# Wait for cdkd to exit cleanly.
echo "==> Waiting for cdkd to exit (up to 60s)"
EXITED=0
for i in $(seq 1 60); do
  if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
    EXITED=1
    break
  fi
  sleep 1
done
if [[ "${EXITED}" -ne 1 ]]; then
  echo "FAIL: cdkd did not exit within 60s after SIGTERM"
  echo "----- service output -----"
  cat "${OUT_FILE}"
  echo "--------------------------"
  kill -KILL "${CDKD_PID}" 2>/dev/null || true
  exit 1
fi
# Reap the exit status so wait/kill -0 doesn't keep firing during the
# cleanup trap.
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

rm -f "${OUT_FILE}"
OUT_FILE=""

# ─── Issue #3655: pull through a NON-PLAIN ECR registry host ──────────
#
# The arm above passes `--no-pull`. These run WITHOUT it, so cdk-local's own
# ECR puller (not cdkd's `src/local/ecr-puller.ts`) classifies the image,
# runs `docker login` and `docker pull`. Before cdk-local 0.149.6 its host
# grammar knew only the plain `<acct>.dkr.ecr.<region>.<suffix>` form, so a
# dual-stack or FIPS image was treated as PUBLIC and pulled anonymously
# (`no basic auth credentials`).
#
# Each arm gets a FRESH `DOCKER_CONFIG` with no `credsStore`, no leftover auth
# and no host credential helper, so the only credentials docker holds are the
# ones cdk-local's login writes; a stale entry for the pull host in the
# operator's config would otherwise authenticate the pull regardless. The seed
# is NOT `{}`: docker falls back to a DETECTED platform store (`osxkeychain` on
# macOS) for a config holding no auth at all, which would put the token in the
# operator's keychain, outliving this run. One placeholder `auths` entry (an
# unresolvable `.invalid` name) keeps it in this file, which cleanup deletes.
new_scratch_docker_config() {
  if [[ -n "${PULL_DOCKER_CONFIG}" ]]; then
    rm -rf "${PULL_DOCKER_CONFIG}"
  fi
  PULL_DOCKER_CONFIG="$(mktemp -d)"
  printf '{"auths":{"cdkd-verify.invalid":{}}}\n' >"${PULL_DOCKER_CONFIG}/config.json"
}

# Usage: assert_token_in_scratch_config <host> [<host that must hold no entry>]
# Passes when the scratch config holds a non-empty `auth` for <host> (docker
# stores the key with or without `https://`) and no `credsStore` diverting the
# token elsewhere. Prints only key names, never a token.
assert_token_in_scratch_config() {
  node -e '
    const [file, host, forbidden] = process.argv.slice(1);
    const j = require(file);
    const auths = j.auths || {};
    const entry = (h) => auths[h] || auths["https://" + h];
    const problems = [];
    if ("credsStore" in j) problems.push("credsStore=" + j.credsStore);
    if (!(entry(host) && entry(host).auth)) problems.push("no stored token for " + host);
    if (forbidden && entry(forbidden)) problems.push("an entry for " + forbidden);
    if (problems.length) {
      console.log(problems.join("; ") + " -- keys: " + JSON.stringify(Object.keys(auths)));
      process.exit(1);
    }
  ' "${PULL_DOCKER_CONFIG}/config.json" "$@"
}

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
PLAIN_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
echo "==> region=${REGION} repo-stack=${REPO_STACK} state-bucket=${STATE_BUCKET}"

echo "==> Pre-flight: no ECR repository ${PULL_REPO} left by an earlier run"
if ! gone_probe aws ecr describe-repositories --region "${REGION}" \
  --repository-names "${PULL_REPO}"; then
  echo "FAIL: ECR repository ${PULL_REPO} already exists -- an orphan from an earlier run,"
  echo "      or a concurrent run of this fixture. Not deploying on top of it."
  exit 1
fi

echo "==> Deploying ${REPO_STACK}"
REPO_DEPLOYED=1
${CDKD} deploy "${REPO_STACK}" --state-bucket "${STATE_BUCKET}"

# A scratch DOCKER_CONFIG carries no `currentContext`, so every docker call
# made under it talks to the `default` context while the calls made without it
# (tag / ps / image rm) talk to the operator's current one. On a host with no
# default socket (colima-style) the two disagree and the arm reds falsely. Pin
# the daemon once, from the current context, unless the operator already did.
if [[ -z "${DOCKER_HOST:-}" ]]; then
  DOCKER_HOST="$(docker context inspect -f '{{.Endpoints.docker.Host}}')"
  export DOCKER_HOST
  echo "==> Pinned DOCKER_HOST=${DOCKER_HOST} from the current docker context"
fi

echo "==> Pushing busybox to ${PLAIN_HOST}/${PULL_REPO}:latest"
new_scratch_docker_config
aws ecr get-login-password --region "${REGION}" \
  | DOCKER_CONFIG="${PULL_DOCKER_CONFIG}" docker login --username AWS --password-stdin "${PLAIN_HOST}" >/dev/null
if ! assert_token_in_scratch_config "${PLAIN_HOST}"; then
  echo "FAIL: the push login did not store its token in the scratch config."
  echo "      If a credsStore is named above, the token went to that store:"
  echo "      remove its entry for ${PLAIN_HOST} (e.g. docker-credential-osxkeychain erase)."
  exit 1
fi
docker tag "${BUSYBOX_IMAGE}" "${PLAIN_HOST}/${PULL_REPO}:latest"
DOCKER_CONFIG="${PULL_DOCKER_CONFIG}" docker push "${PLAIN_HOST}/${PULL_REPO}:latest"
docker image rm -f "${PLAIN_HOST}/${PULL_REPO}:latest" >/dev/null 2>&1 || true

run_pull_service_arm() {
  local service="$1"
  local pull_host="$2"
  local label="$3"
  local image="${pull_host}/${PULL_REPO}:latest"

  new_scratch_docker_config
  # The pull must reach the registry, not a local tag left by an earlier arm.
  docker image rm -f "${image}" >/dev/null 2>&1 || true
  OUT_FILE=$(mktemp)

  echo "==> [${label}] booting ${STACK}:${service} (pulls ${pull_host})"
  DOCKER_CONFIG="${PULL_DOCKER_CONFIG}" ${CDKD} local start-service "${STACK}:${service}" \
    --container-host 127.0.0.1 --no-interactive-overrides \
    > "${OUT_FILE}" 2>&1 &
  CDKD_PID=$!

  local booted=0
  for _ in $(seq 1 300); do
    if grep -q "Service(s) running:" "${OUT_FILE}" 2>/dev/null; then
      booted=1
      break
    fi
    if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
      echo "FAIL (${label}): cdkd exited before reaching the boot banner"
      echo "----- service output -----"
      cat "${OUT_FILE}"
      echo "--------------------------"
      exit 1
    fi
    sleep 1
  done
  if [[ "${booted}" -ne 1 ]]; then
    echo "FAIL (${label}): service did not reach the boot banner within 300s"
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi

  local running
  running=$(docker ps --filter "ancestor=${image}" --format '{{.ID}}' | wc -l | tr -d ' ')
  if [[ "${running}" -lt 1 ]]; then
    echo "FAIL (${label}): no running container from ${image}"
    docker ps -a --filter "name=cdkd-local-" --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
    echo "----- service output -----"
    cat "${OUT_FILE}"
    echo "--------------------------"
    exit 1
  fi
  echo "    OK: ${running} container(s) running from ${image}"

  # The login must have gone to the PULL host, and its token must sit in THIS
  # file. The sentinel -- nothing stored for the PLAIN host -- would mean the
  # login went there and something else authenticated the pull.
  if ! assert_token_in_scratch_config "${pull_host}" "${PLAIN_HOST}"; then
    echo "FAIL (${label}): the docker login did not store its token for ${pull_host} in the arm's config"
    exit 1
  fi
  echo "    OK: token stored for ${pull_host}, no credsStore, no plain-host entry"

  kill -TERM "${CDKD_PID}"
  local exited=0
  for _ in $(seq 1 60); do
    if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
      exited=1
      break
    fi
    sleep 1
  done
  if [[ "${exited}" -ne 1 ]]; then
    echo "FAIL (${label}): cdkd did not exit within 60s after SIGTERM"
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
    exit 1
  fi
  wait "${CDKD_PID}" 2>/dev/null || true
  CDKD_PID=""

  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' \
    | xargs -r docker network rm >/dev/null 2>&1 || true
  docker image rm -f "${image}" >/dev/null 2>&1 || true
  rm -f "${OUT_FILE}"
  OUT_FILE=""
  rm -rf "${PULL_DOCKER_CONFIG}"
  PULL_DOCKER_CONFIG=""
}

run_pull_service_arm PullDualStackService "${ACCOUNT_ID}.dkr-ecr.${REGION}.on.aws" "dual-stack"

# AWS serves the FIPS registry endpoint in these six regions only.
case "${REGION}" in
  us-east-1 | us-east-2 | us-west-1 | us-west-2 | us-gov-east-1 | us-gov-west-1)
    run_pull_service_arm PullFipsService "${ACCOUNT_ID}.dkr.ecr-fips.${REGION}.amazonaws.com" "FIPS"
    ;;
  *)
    echo "==> [FIPS] SKIPPED -- ${REGION} has no FIPS ECR endpoint"
    ;;
esac

echo ""
echo "==> local-start-service arms passed (2 replicas booted and cleaned up on SIGTERM;"
echo "    dual-stack + FIPS ECR images pulled through cdk-local's puller)."
echo "    The EXIT trap now destroys ${REPO_STACK}; a destroy failure fails the run."
