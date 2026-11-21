#!/usr/bin/env bash
# verify.sh — cdkd local start-api --from-state with HttpUserPoolAuthorizer
# real-AWS integ test (go-to-k/cdkd#6419, go-to-k/cdkd#6717)
#
# aws-cdk-lib's `HttpUserPoolAuthorizer` writes JwtConfiguration.Issuer as a
# `Fn::Join` over `Ref AWS::Region` + `Ref <UserPool>` and Audience as
# `[Ref <UserPoolClient>]`. cdkd local start-api used to refuse every stack
# with such a route ("JwtConfiguration.Issuer must be a string"). Both now
# resolve from cdkd state (--from-state); without state the server boots and
# warns, running the authorizer in JWKS pass-through.
#
# A REST v1 API rides along (go-to-k/cdkd#6717): GET /rest-secure behind a
# `CognitoUserPoolsAuthorizer` on the same pool, whose ProviderARNs is
# `[Fn::GetAtt <Pool>.Arn]`, on a method with `apiKeyRequired`.
#
# Flow:
#   1. Deploy the stack (user pool, client A (authorized), client B (not),
#      HTTP API route GET /secure behind the authorizer, Lambda).
#   2. Create a user and mint ID tokens for client A and client B.
#   3. No state: start-api boots and warns `JwtConfiguration.Issuer is an
#      intrinsic` (sentinel: the same line says `JWKS pass-through`). The REST
#      route warns per route that `ProviderARNs[0] is an intrinsic` and that
#      `ApiKeyRequired is not enforced`; a garbage token passes through (200).
#   4. --from-state: no such warning and no `JWKS unreachable`; client-A
#      token -> 200 with the user's sub; tampered token -> 401; no
#      Authorization -> 401; client-B token -> 401 (audience resolved).
#      REST: no ProviderARNs warning; client-A ID token -> 200 with the sub;
#      the statuses the deployed REST API answers: garbage / no header -> 401
#      Unauthorized, tampered signature -> 403 Access Denied.
#   5. Destroy; user pool, HTTP and REST APIs, Lambda, log groups and state
#      are gone.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-api-user-pool-authorizer/verify.sh
#
# Requires Docker. Uses host ports 18560-18563 (two servers per boot: the HTTP
# API and the REST API).

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

# Lambda creates `/aws/lambda/<stack>-<fn>` on first invoke; nothing in the
# stack owns it, so destroy leaves it behind.
. ../cr-log-groups.sh
. ../state-physical-id.sh

STACK="CdkdLocalStartApiUserPoolAuthorizer"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CDKD="node ${LOCAL_DIST}"
PORT_NOSTATE=18560
PORT_STATE=18562
USERNAME="cdkd-integ-user"
# Meets the default pool policy (upper, lower, digit, symbol, >= 8).
PASSWORD="Cdkd-Integ-6419-Pw!"
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
    for _ in $(seq 1 480); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
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
  if [ "${DEPLOYED}" = "1" ]; then
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 \
      || echo "WARN: destroy in trap failed; falling back to state destroy" >&2
  fi
  ${CDKD} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
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

# start_server <logfile> <port> [extra args...]: boots start-api in the background.
start_server() {
  local logfile="$1" port="$2"
  shift 2
  : > "${logfile}"
  ${CDKD} local start-api "${STACK}" --port "${port}" \
    --container-host 127.0.0.1 "$@" > "${logfile}" 2>&1 &
  CDKD_PID=$!
  local booted=0
  for _ in $(seq 1 480); do
    if grep -q 'Server listening' "${logfile}"; then booted=1; break; fi
    kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-api exited before it was ready (port ${port})"
    sleep 0.5
  done
  [ "${booted}" = 1 ] || fail "start-api did not print 'Server listening' in time (port ${port})"
}

# server_port <logfile> <label>: the port of the server whose ready banner
# names <label> (`HTTP API v2` / `REST API v1`); the order of the two servers
# is not part of the contract.
server_port() {
  local port
  port="$(grep -E "Server listening on http://[^[:space:]]+[[:space:]]+\(.*$2\)" "$1" \
    | sed -E 's|.*://[^:]+:([0-9]+).*|\1|' | head -1 || true)"
  [ -n "${port}" ] || fail "no '$2' server banner in $1"
  printf '%s' "${port}"
}

# http_code <port> [header...]: GET /secure, prints the status code; body in BODY_FILE.
http_code() {
  http_path_code "$1" /secure "${@:2}"
}

# http_path_code <port> <path> [header...]: GET <path>, prints the status code; body in BODY_FILE.
http_path_code() {
  local port="$1" path="$2"
  shift 2
  local -a hdrs=()
  local h
  for h in "$@"; do hdrs+=(-H "${h}"); done
  curl -sS -o "${BODY_FILE}" -w '%{http_code}' --max-time 60 ${hdrs[@]+"${hdrs[@]}"} "http://127.0.0.1:${port}${path}"
}

# expect_rest <port> <auth header or ""> <code> <exact body> <label>
expect_rest() {
  local code
  if [ -n "$2" ]; then
    code="$(http_path_code "$1" /rest-secure "Authorization: $2")" || code="curl-failed"
  else
    code="$(http_path_code "$1" /rest-secure)" || code="curl-failed"
  fi
  [ "${code}" = "$3" ] || fail "$5: expected $3, got ${code} (body: $(cat "${BODY_FILE}"))"
  [ "$(cat "${BODY_FILE}")" = "$4" ] || fail "$5: expected body $4, got $(cat "${BODY_FILE}")"
  echo "    $5 -> $3"
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

POOL_ID="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Cognito::UserPool PoolD3F588B8)" || fail "no user pool id in state"
CLIENT_A="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Cognito::UserPoolClient PoolClientA54DA49E6)" || fail "no client A id in state"
CLIENT_B="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Cognito::UserPoolClient PoolClientB32581292)" || fail "no client B id in state"
API_ID="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::ApiGatewayV2::Api ApiF70053CD)" || fail "no HTTP API id in state"
REST_API_ID="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::ApiGateway::RestApi RestApi0C43BF4B)" || fail "no REST API id in state"
FN_NAME="$(state_physical_id "${STACK}" "${STATE_BUCKET}" AWS::Lambda::Function Handler886CB40B)" || fail "no function name in state"
# cdkd records a user pool client's physical id as `<poolId>|<clientId>`.
CLIENT_A="${CLIENT_A##*|}"
CLIENT_B="${CLIENT_B##*|}"
[ "${CLIENT_A}" != "${CLIENT_B}" ] || fail "client A and B share an id: ${CLIENT_A}"
echo "    pool=${POOL_ID} clientA=${CLIENT_A} clientB=${CLIENT_B} api=${API_ID} restApi=${REST_API_ID} fn=${FN_NAME}"

echo "==> Phase 2: create a user and mint ID tokens for client A and B"
aws cognito-idp admin-create-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --message-action SUPPRESS --region "${REGION}" >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --password "${PASSWORD}" --permanent --region "${REGION}" >/dev/null
USER_SUB="$(aws cognito-idp admin-get-user --user-pool-id "${POOL_ID}" --username "${USERNAME}" \
  --region "${REGION}" --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)"
case "${USER_SUB}" in "" | None) fail "no sub for ${USERNAME}" ;; esac

mint_token() { # usage: mint_token <client-id>
  aws cognito-idp admin-initiate-auth --user-pool-id "${POOL_ID}" --client-id "$1" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=${USERNAME},PASSWORD=${PASSWORD}" \
    --region "${REGION}" --query 'AuthenticationResult.IdToken' --output text
}
TOKEN_A="$(mint_token "${CLIENT_A}")" || fail "could not mint a client-A token"
TOKEN_B="$(mint_token "${CLIENT_B}")" || fail "could not mint a client-B token"
for t in "${TOKEN_A}" "${TOKEN_B}"; do
  case "${t}" in *.*.*) ;; *) fail "minted token is not a JWT" ;; esac
done
# Tamper: replace the first character of the signature segment (the last
# character only carries padding bits, so flipping it can leave the bytes intact).
SIG="${TOKEN_A##*.}"
SIG_FIRST="${SIG:0:1}"
if [ "${SIG_FIRST}" = "A" ]; then REPL="B"; else REPL="A"; fi
TOKEN_A_TAMPERED="${TOKEN_A%.*}.${REPL}${SIG:1}"
[ "${TOKEN_A_TAMPERED}" != "${TOKEN_A}" ] || fail "tampering did not change the token"

echo "==> Phase 3: start-api WITHOUT state boots and warns about the intrinsic Issuer"
start_server "${OUT_FILE}" "${PORT_NOSTATE}"
grep -q 'JwtConfiguration.Issuer is an intrinsic' "${OUT_FILE}" \
  || fail "no-state boot did not warn 'JwtConfiguration.Issuer is an intrinsic'"
# Sentinel: an independent marker on the same line. Present while the parsed
# marker is absent would mean the warning was reworded.
grep -q 'JWKS pass-through' "${OUT_FILE}" || fail "warning lacks its 'JWKS pass-through' sentinel (reworded?)"
# go-to-k/cdkd#6717: the REST v1 Cognito authorizer's GetAtt pool ARN, and the
# method's ApiKeyRequired, are each warned per route (cdkd's own wording, with
# cdk-local 0.169.2).
grep -q 'RestAuth348E6400.ProviderARNs\[0\] is an intrinsic cdkd local start-api could not resolve' "${OUT_FILE}" \
  || fail "no-state boot did not warn 'ProviderARNs[0] is an intrinsic' for the REST authorizer"
# Sentinel: the route the same line names. Absent while the marker is present
# would mean the warning stopped naming the route.
grep -q 'ProviderARNs\[0\] is an intrinsic .*JWKS pass-through admits every Bearer token on route GET /rest-secure' "${OUT_FILE}" \
  || fail "the ProviderARNs warning does not name route GET /rest-secure (reworded?)"
grep -q 'ApiKeyRequired is not enforced by cdkd local start-api' "${OUT_FILE}" \
  || fail "no-state boot did not warn 'ApiKeyRequired is not enforced' for GET /rest-secure"
grep -q 'ApiKeyRequired is not enforced .*so route GET /rest-secure is served without an x-api-key check' "${OUT_FILE}" \
  || fail "the ApiKeyRequired warning does not name route GET /rest-secure (reworded?)"
REST_NOSTATE="$(server_port "${OUT_FILE}" 'REST API v1')"
echo "    REST, no state: garbage token -> 200 (JWKS pass-through, warned; cold boot: retry)"
CODE=""
for _ in $(seq 1 10); do
  CODE="$(http_path_code "${REST_NOSTATE}" /rest-secure "Authorization: Bearer garbage")" || CODE="curl-failed"
  [ "${CODE}" = "200" ] && break
  sleep 3
done
[ "${CODE}" = "200" ] || fail "REST, no state: garbage token expected 200 (pass-through), got ${CODE} (body: $(cat "${BODY_FILE}"))"
stop_server

echo "==> Phase 4: start-api --from-state resolves Issuer and Audience from state"
start_server "${OUT_FILE2}" "${PORT_STATE}" --from-state --state-bucket "${STATE_BUCKET}"
HTTP_STATE="$(server_port "${OUT_FILE2}" 'HTTP API v2')"
REST_STATE="$(server_port "${OUT_FILE2}" 'REST API v1')"
if grep -q 'JwtConfiguration.Issuer is an intrinsic' "${OUT_FILE2}"; then
  fail "--from-state still warned about an intrinsic Issuer"
fi
if grep -q 'JWKS unreachable' "${OUT_FILE2}"; then
  fail "--from-state hit an unreachable JWKS (Issuer resolved to a placeholder?)"
fi
# Sentinel: a pass-through warning of any wording must not appear either.
if grep -q 'JWKS pass-through' "${OUT_FILE2}"; then
  fail "--from-state log mentions JWKS pass-through"
fi
if grep -q 'ProviderARNs\[0\] is an intrinsic' "${OUT_FILE2}"; then
  fail "--from-state still warned that the REST authorizer's ProviderARNs is an intrinsic"
fi
# Not a state matter: ApiKeyRequired stays warned under --from-state too.
grep -q 'ApiKeyRequired is not enforced by cdkd local start-api' "${OUT_FILE2}" \
  || fail "--from-state boot did not warn 'ApiKeyRequired is not enforced'"

echo "    client-A token -> 200 (cold boot: retry)"
CODE=""
for _ in $(seq 1 10); do
  CODE="$(http_code "${HTTP_STATE}" "Authorization: Bearer ${TOKEN_A}")" || CODE="curl-failed"
  [ "${CODE}" = "200" ] && break
  sleep 3
done
[ "${CODE}" = "200" ] || fail "client-A token: expected 200, got ${CODE} (body: $(cat "${BODY_FILE}"))"
BODY="$(cat "${BODY_FILE}")"
echo "    body=${BODY}"
GOT_SUB="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sub))' "${BODY}")" \
  || fail "response body is not JSON: ${BODY}"
[ "${GOT_SUB}" = "${USER_SUB}" ] || fail "sub mismatch: body ${GOT_SUB} vs user ${USER_SUB}"
GOT_AUD="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).aud))' "${BODY}")" \
  || fail "response body is not JSON: ${BODY}"
[ "${GOT_AUD}" = "${CLIENT_A}" ] || fail "aud mismatch: body ${GOT_AUD} vs client A ${CLIENT_A}"
# The Lambda env CLIENT_ID is a Ref of the client: it must be the bare client id.
GOT_ENV="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).clientIdEnv))' "${BODY}")" \
  || fail "response body is not JSON: ${BODY}"
[ "${GOT_ENV}" = "${CLIENT_A}" ] || fail "CLIENT_ID env mismatch: body ${GOT_ENV} vs client A ${CLIENT_A}"

echo "    tampered client-A token -> 401"
CODE="$(http_code "${HTTP_STATE}" "Authorization: Bearer ${TOKEN_A_TAMPERED}")" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "tampered token: expected 401, got ${CODE}"

echo "    no Authorization -> 401"
CODE="$(http_code "${HTTP_STATE}")" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "no Authorization: expected 401, got ${CODE}"

echo "    client-B token (valid signature, audience not allowed) -> 401"
CODE="$(http_code "${HTTP_STATE}" "Authorization: Bearer ${TOKEN_B}")" || CODE="curl-failed"
[ "${CODE}" = "401" ] || fail "client-B token: expected 401 (Audience resolved), got ${CODE}"

echo "    REST client-A ID token -> 200 (pool resolved from state)"
CODE="$(http_path_code "${REST_STATE}" /rest-secure "Authorization: Bearer ${TOKEN_A}")" || CODE="curl-failed"
[ "${CODE}" = "200" ] || fail "REST client-A token: expected 200, got ${CODE} (body: $(cat "${BODY_FILE}"))"
BODY="$(cat "${BODY_FILE}")"
GOT_SUB="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sub))' "${BODY}")" \
  || fail "REST response body is not JSON: ${BODY}"
[ "${GOT_SUB}" = "${USER_SUB}" ] || fail "REST sub mismatch: body ${GOT_SUB} vs user ${USER_SUB}"
# The statuses the deployed REST API answers (measured by go-to-k/cdk-local#1016).
UNAUTH='{"message":"Unauthorized"}'
expect_rest "${REST_STATE}" "Bearer garbage" 401 "${UNAUTH}" "REST garbage token"
expect_rest "${REST_STATE}" "" 401 "${UNAUTH}" "REST no Authorization"
expect_rest "${REST_STATE}" "Bearer ${TOKEN_A_TAMPERED}" 403 '{"Message":"Access Denied"}' "REST tampered signature"

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
assert_gone "HTTP API ${API_ID} still exists after destroy" \
  aws apigatewayv2 get-api --api-id "${API_ID}" --region "${REGION}"
assert_gone "REST API ${REST_API_ID} still exists after destroy" \
  aws apigateway get-rest-api --rest-api-id "${REST_API_ID}" --region "${REGION}"
assert_gone "function ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The log group Lambda created on invoke is not a stack resource.
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
left="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}-" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
[ -z "${left}" ] || [ "${left}" = "None" ] || fail "log groups of ${STACK} still exist after destroy: ${left}"

trap - EXIT INT TERM
rm -f "${OUT_FILE}" "${OUT_FILE2}" "${BODY_FILE}"
echo "[verify] PASS — HttpUserPoolAuthorizer Issuer/Audience and CognitoUserPoolsAuthorizer pool resolved from state by local start-api, unenforced settings warned (#6419, #6717)"
