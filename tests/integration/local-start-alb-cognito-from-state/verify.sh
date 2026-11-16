#!/usr/bin/env bash
# verify.sh — cdkd local start-alb --from-state behind an authenticate-cognito
# action real-AWS integ test (go-to-k/cdkd#6458)
#
# The listener's AuthenticateCognitoConfig is the shape
# `ListenerAction.authenticateCognito` emits: `UserPoolArn: Fn::GetAtt
# <Pool>.Arn`, `UserPoolClientId: Ref <Client>`. start-alb used to drop the
# guard and serve the route to anyone. cdk-local 0.168.8 resolves the config
# from the state source; under --from-state that is cdkd's S3 state, where
# the client is recorded as `<poolId>|<clientId>`, so the guard's audience is
# right only when cdkd's provider hands over the bare client id.
#
# Flow:
#   1. Deploy the stack (user pool, client, domain; the ALB and listener are
#      condition-gated out of the deployment, see the stack file).
#   2. Create a user and mint an ID token for the client.
#   3. No state: start-alb boots, warns `UserPoolArn is an intrinsic`
#      (sentinel: the same line says `JWKS pass-through`), and an anonymous
#      request gets 401, not the fixed-response 200.
#   4. --from-state: no intrinsic warning, no unresolved client id, no JWKS
#      pass-through; valid token -> 200 "secret"; tampered token -> 401;
#      no Authorization -> 401.
#   5. Destroy; the user pool and state are gone.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-alb-cognito-from-state/verify.sh
#
# Requires Docker. Uses host port 18498.

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

. ../state-physical-id.sh

STACK="CdkdLocalStartAlbCognitoFromState"
TARGET="${STACK}/WebLB"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CDKD="node ${LOCAL_DIST}"
LB_HOST_PORT=18498
USERNAME="cdkd-integ-user"
# Meets the default pool policy (upper, lower, digit, symbol, >= 8).
PASSWORD="Cdkd-Integ-6458-Pw!"
OUT_FILE="$(mktemp)"
OUT_FILE2="$(mktemp)"
BODY_FILE="$(mktemp)"
CDKD_PID=""
DEPLOYED=0
CLEANED_UP=0

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not built (run vp run build)" >&2
  exit 1
fi

stop_server() {
  if [ -n "${CDKD_PID}" ] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 240); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
    wait "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: stopping the server, dropping leftover AWS resources"
  set +eu
  stop_server
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1
  if [ "${DEPLOYED}" = "1" ]; then
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 \
      || echo "WARN: destroy in trap failed; falling back to state destroy" >&2
  fi
  ${CDKD} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  rm -f "${OUT_FILE}" "${OUT_FILE2}" "${BODY_FILE}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "FAIL: $*" >&2
  echo "----- server log (no-state) -----" >&2
  cat "${OUT_FILE}" >&2 || true
  echo "----- server log (from-state) -----" >&2
  cat "${OUT_FILE2}" >&2 || true
  exit 1
}

# start_alb <logfile> [extra args...]: boots start-alb in the background and
# waits until the front-door answers. Called directly, never inside $( ):
# CDKD_PID must reach this shell so stop_server can reap the server.
start_alb() {
  local logfile="$1"
  shift
  : > "${logfile}"
  ${CDKD} local start-alb "${TARGET}" \
    --container-host 127.0.0.1 \
    --lb-port "80=${LB_HOST_PORT}" \
    "$@" > "${logfile}" 2>&1 &
  CDKD_PID=$!
  local booted=0
  for _ in $(seq 1 240); do
    if grep -q 'Service(s) running:' "${logfile}"; then booted=1; break; fi
    kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-alb exited before it was ready"
    sleep 0.5
  done
  [ "${booted}" = 1 ] || fail "start-alb did not print 'Service(s) running:' in time"
  local code
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:${LB_HOST_PORT}/" || true)"
    if [ -n "${code}" ] && [ "${code}" != "000" ]; then return 0; fi
    kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-alb exited before the front-door answered"
    sleep 1
  done
  fail "the front-door never answered on port ${LB_HOST_PORT}"
}

# http_code [header...]: GET /, prints the status code; body in BODY_FILE.
http_code() {
  local -a hdrs=()
  local h
  for h in "$@"; do hdrs+=(-H "${h}"); done
  curl -sS -o "${BODY_FILE}" -w '%{http_code}' --max-time 30 ${hdrs[@]+"${hdrs[@]}"} "http://127.0.0.1:${LB_HOST_PORT}/"
}

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pre-run cleanup of a prior killed run"
${CDKD} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1 || true

echo "==> Phase 1: deploy ${STACK}"
DEPLOYED=1
${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

POOL_ID="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Cognito::UserPool)" || fail "no user pool id in state"
CLIENT_RECORD="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Cognito::UserPoolClient)" || fail "no client id in state"
# cdkd records a user pool client's physical id as `<poolId>|<clientId>`. The
# fixture is only meaningful while it does: assert the premise.
case "${CLIENT_RECORD}" in
  *"|"*) ;;
  *) fail "client record ${CLIENT_RECORD} is not <poolId>|<clientId>; the fixture no longer exercises the Ref-value mapping" ;;
esac
CLIENT_ID="${CLIENT_RECORD##*|}"
echo "    pool=${POOL_ID} client=${CLIENT_ID}"
# The condition-gated ALB and listener must not be deployed.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" \
  || fail "could not read the state record ${STATE_KEY}"
if grep -q 'AWS::ElasticLoadBalancingV2::' <<<"${STATE_JSON}"; then
  fail "the condition-gated ALB or listener was deployed"
fi

echo "==> Phase 2: create a user and mint an ID token"
aws cognito-idp admin-create-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --message-action SUPPRESS --region "${REGION}" >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --password "${PASSWORD}" --permanent --region "${REGION}" >/dev/null
TOKEN="$(aws cognito-idp admin-initiate-auth --user-pool-id "${POOL_ID}" --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=${USERNAME},PASSWORD=${PASSWORD}" \
  --region "${REGION}" --query 'AuthenticationResult.IdToken' --output text)" \
  || fail "could not mint a token"
case "${TOKEN}" in *.*.*) ;; *) fail "minted token is not a JWT" ;; esac
# Tamper: replace the first character of the signature segment (the last
# character only carries padding bits, so flipping it can leave the bytes intact).
SIG="${TOKEN##*.}"
if [ "${SIG:0:1}" = "A" ]; then REPL="B"; else REPL="A"; fi
TOKEN_TAMPERED="${TOKEN%.*}.${REPL}${SIG:1}"
[ "${TOKEN_TAMPERED}" != "${TOKEN}" ] || fail "tampering did not change the token"

echo "==> Phase 3: start-alb WITHOUT state keeps the guard"
start_alb "${OUT_FILE}"
grep -q 'UserPoolArn is an intrinsic' "${OUT_FILE}" \
  || fail "no-state boot did not warn 'UserPoolArn is an intrinsic'"
# Sentinel: an independent marker on the same line. Present while the parsed
# marker is absent would mean the warning was reworded.
grep -q 'JWKS pass-through' "${OUT_FILE}" || fail "warning lacks its 'JWKS pass-through' sentinel (reworded?)"
CODE="$(http_code)" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "no state, no Authorization: expected 401, got ${CODE} (body: $(cat "${BODY_FILE}"))"
if grep -q 'secret' "${BODY_FILE}"; then fail "no state, no Authorization: the fixed-response body was served"; fi
echo "    no state, no Authorization -> 401"
stop_server

echo "==> Phase 4: start-alb --from-state resolves the pool ARN and client id from state"
start_alb "${OUT_FILE2}" --from-state --state-bucket "${STATE_BUCKET}"
if grep -q 'is an intrinsic' "${OUT_FILE2}"; then
  fail "--from-state still reported a guard field as an unresolved intrinsic"
fi
if grep -q 'could not be resolved' "${OUT_FILE2}"; then
  fail "--from-state did not resolve the client id"
fi

echo "    valid token -> 200 secret (cold JWKS: retry)"
CODE=""
for _ in $(seq 1 10); do
  CODE="$(http_code "Authorization: Bearer ${TOKEN}")" || CODE="curl-failed"
  [ "${CODE}" = "200" ] && break
  sleep 3
done
[ "${CODE}" = "200" ] || fail "valid token: expected 200, got ${CODE} (body: $(cat "${BODY_FILE}"))"
grep -q '^secret$' "${BODY_FILE}" || fail "valid token: unexpected body $(cat "${BODY_FILE}")"
# Pass-through would also answer 200: the guard must have verified the token
# against the real pool, with the bare client id as its audience.
if grep -q 'JWKS pass-through' "${OUT_FILE2}"; then
  fail "--from-state log mentions JWKS pass-through (the guard did not resolve to the real pool)"
fi
if grep -q 'JWKS unreachable' "${OUT_FILE2}"; then
  fail "--from-state hit an unreachable JWKS"
fi

echo "    tampered token -> 401"
CODE="$(http_code "Authorization: Bearer ${TOKEN_TAMPERED}")" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "tampered token: expected 401, got ${CODE}"

echo "    no Authorization -> 401"
CODE="$(http_code)" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "no Authorization: expected 401, got ${CODE}"

stop_server
orphans="$(docker ps -a --filter 'name=cdkd-local-' --format '{{.Names}}')" \
  || fail "docker ps failed while checking for leftover containers"
[ -z "${orphans}" ] || fail "leftover local container(s): ${orphans}"

echo "==> Phase 5: destroy"
${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DEPLOYED=0

echo "==> Orphan verification"
assert_gone "user pool ${POOL_ID} still exists after destroy" \
  aws cognito-idp describe-user-pool --user-pool-id "${POOL_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${OUT_FILE}" "${OUT_FILE2}" "${BODY_FILE}"
echo "[verify] PASS — authenticate-cognito guard resolved from cdkd state by local start-alb (#6458)"
