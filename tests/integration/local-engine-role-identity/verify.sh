#!/usr/bin/env bash
#
# verify.sh — the engine commands run the emulated WORKLOAD as the caller
# under --role-arn (go-to-k/cdkd#3240).
#
# `--role-arn` is a deploy identity. For `cdkd local start-alb`,
# `start-cloudfront`, `start-agentcore` and `start-service`, the container the
# emulator runs, and everything it resolves for that container, must use the
# CALLER's identity, never the role's. A zero-permission role makes the
# difference observable:
#
#   A. start-alb / start-cloudfront / start-agentcore under --role-arn: the
#      workload echoes its AWS_ACCESS_KEY_ID, which must be the caller's key.
#   B. start-service under --role-arn: the ECS secret (an SSM parameter the
#      role is denied) must reach the container, i.e. it was read as the caller.
#   C. start-alb with AWS_PROFILE exported, no static credential triple and no
#      --profile: the role's key must NOT reach the workload (it is stripped,
#      with a warning naming --profile).
#
# Two stacks in one app, synthesized one half at a time with `-c part=role|app`
# (cdk-local's Lambda Function URL origin boot cannot resolve its function when
# the app holds more than one stack). CdkdLocalEngineRoleIdentityRole is DEPLOYED (a role
# with no policy + a plain String SSM parameter) and destroyed at the end;
# CdkdLocalEngineRoleIdentityApp is only synthesized for the engines. The SSM
# value is a non-secret test string, so nothing secret reaches the state bucket
# and no object-version sweep is needed.
#
# Credentials live only in shell variables and in the environment of the
# subshells that run cdkd; nothing is written to a file or echoed.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash tests/integration/local-engine-role-identity/verify.sh
#
# Requires Docker and AWS credentials able to deploy IAM + SSM and to call
# sts:AssumeRole on the role. CDKD_CLI overrides the cdkd entry point (used to
# run the fixture against another build).

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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
ROLE_STACK="CdkdLocalEngineRoleIdentityRole"
APP_STACK="CdkdLocalEngineRoleIdentityApp"
# Must match ROLE_NAME / PARAM_NAME / PARAM_VALUE in lib/local-engine-role-identity-stack.ts.
ROLE_NAME="cdkd-integ-engine-role-identity-noperm"
PARAM_NAME="/cdkd-integ/local-engine-role-identity/secret"
PARAM_VALUE="caller-identity-3240-ok"
STATE_KEY="cdkd/${ROLE_STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${ROLE_STACK}/${REGION}/lock.json"
CDKD="${CDKD_CLI:-node ../../../dist/cli.js}"
SIDECAR_IMAGE="amazon/amazon-ecs-local-container-endpoints:latest-amd64"
BUSYBOX_IMAGE="public.ecr.aws/docker/library/busybox:1.36"
LAMBDA_IMAGE="public.ecr.aws/lambda/nodejs:20"
AGENT_IMAGE="public.ecr.aws/docker/library/node:20-slim"
case "$(uname -m)" in
  arm64 | aarch64) AGENT_PLATFORM="linux/arm64" ;;
  *) AGENT_PLATFORM="linux/amd64" ;;
esac

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET is not set" >&2
  exit 1
fi

# Set to 1 immediately BEFORE the role stack's deploy starts, so a deploy
# killed half-way is still destroyed.
ROLE_DEPLOYED=0
ENGINE_PID=""
OUT_FILE="$(mktemp)"
CALLER_AKID=""
CALLER_SECRET=""
CALLER_TOKEN=""

stop_engine() {
  if [ -n "${ENGINE_PID}" ] && kill -0 "${ENGINE_PID}" 2>/dev/null; then
    kill -TERM "${ENGINE_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do kill -0 "${ENGINE_PID}" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "${ENGINE_PID}" 2>/dev/null || true
  fi
  if [ -n "${ENGINE_PID}" ]; then wait "${ENGINE_PID}" 2>/dev/null || true; fi
  ENGINE_PID=""
}

# Best-effort sweep, safe to run before anything exists. Sets SWEEP_RC non-zero
# when the role stack's destroy failed.
SWEEP_RC=0
sweep() {
  set +eu
  stop_engine
  docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker rm -f >/dev/null 2>&1
  docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | xargs -r docker network rm >/dev/null 2>&1
  rm -f "${OUT_FILE}"
  if [ "${ROLE_DEPLOYED}" -eq 1 ]; then
    ROLE_DEPLOYED=0
    echo "==> Cleanup: destroying ${ROLE_STACK}"
    ${CDKD} destroy "${ROLE_STACK}" --state-bucket "${STATE_BUCKET:-}" --force -c part=role
    if [ "$?" -ne 0 ]; then
      echo "FAIL: cdkd destroy ${ROLE_STACK} failed" >&2
      SWEEP_RC=1
    fi
  fi
  set -eu
}

cleanup() {
  rc=$?
  sweep
  if [ "${rc}" -eq 0 ] && [ "${SWEEP_RC}" -ne 0 ]; then rc="${SWEEP_RC}"; fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

fail() {
  echo "[verify] FAIL: $*" >&2
  echo "----- engine output -----" >&2
  cat "${OUT_FILE}" >&2 || true
  echo "-------------------------" >&2
  exit 1
}

# Run a command as the caller's STATIC identity (profile unset). `exec`, and a
# plain function body, so a backgrounded call replaces its own forked subshell
# with the command: ENGINE_PID is then cdkd's real PID and SIGTERM reaches it.
# Foreground callers wrap it in ( ) to keep the environment out of this shell.
as_caller() {
  unset AWS_PROFILE
  export AWS_ACCESS_KEY_ID="${CALLER_AKID}" AWS_SECRET_ACCESS_KEY="${CALLER_SECRET}"
  if [ -n "${CALLER_TOKEN}" ]; then export AWS_SESSION_TOKEN="${CALLER_TOKEN}"; else unset AWS_SESSION_TOKEN; fi
  exec "$@"
}

# Arm C: only an exported AWS_PROFILE; no static triple, no --profile flag.
as_profile_only() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  export AWS_PROFILE="${WORKLOAD_PROFILE}"
  exec "$@"
}

echo "[verify] region=${REGION} role-stack=${ROLE_STACK} app-stack=${APP_STACK}"

echo "[verify] step 0: pre-run sweep + orphan guard"
sweep
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "[verify] FAIL: ${STATE_KEY} already exists: a prior run's orphan or a concurrent run of this fixture" >&2
  exit 1
fi
if ! gone_probe aws iam get-role --role-name "${ROLE_NAME}"; then
  echo "[verify] FAIL: IAM role ${ROLE_NAME} already exists: a prior run's orphan" >&2
  exit 1
fi
OUT_FILE="$(mktemp)"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1: install fixture deps, pull images"
# --ignore-workspace: the repo root's pnpm-workspace.yaml would otherwise hoist
# aws-cdk-lib to the root's pinned version, which has no AgentCore L2.
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline
docker pull "${SIDECAR_IMAGE}" >/dev/null
docker pull "${BUSYBOX_IMAGE}" >/dev/null
docker pull "${LAMBDA_IMAGE}" >/dev/null
docker pull --platform "${AGENT_PLATFORM}" "${AGENT_IMAGE}" >/dev/null

echo "[verify] step 2: deploy ${ROLE_STACK}"
ROLE_DEPLOYED=1
${CDKD} deploy "${ROLE_STACK}" --state-bucket "${STATE_BUCKET}" -c part=role

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text)"
case "${ROLE_ARN}" in
  arn:aws*:iam::*:role/*) ;;
  *) echo "[verify] FAIL: could not read the role ARN (got '${ROLE_ARN}')" >&2; exit 1 ;;
esac
echo "[verify]   no-permission role: ${ROLE_ARN}"
GOT_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" --query 'Parameter.Value' --output text)"
[ "${GOT_VALUE}" = "${PARAM_VALUE}" ] \
  || { echo "[verify] FAIL: the deployed parameter holds '${GOT_VALUE}', expected '${PARAM_VALUE}'" >&2; exit 1; }

echo "[verify] step 3: capture the caller's static identity + premise guards"
CALLER_ENV="$(aws configure export-credentials --format env-no-export)" \
  || { echo "[verify] FAIL: aws configure export-credentials failed (AWS CLI v2.9+ and resolvable credentials are required)" >&2; exit 1; }
CALLER_AKID="$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_ACCESS_KEY_ID"{print substr($0,length($1)+2)}')"
CALLER_SECRET="$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_SECRET_ACCESS_KEY"{print substr($0,length($1)+2)}')"
CALLER_TOKEN="$(printf '%s\n' "${CALLER_ENV}" | awk -F= '$1=="AWS_SESSION_TOKEN"{print substr($0,length($1)+2)}')"
unset CALLER_ENV
if [ -z "${CALLER_AKID}" ] || [ -z "${CALLER_SECRET}" ]; then
  echo "[verify] FAIL: aws configure export-credentials returned no static credentials for the caller" >&2
  exit 1
fi

# The role must really be a different identity AND really be denied the
# parameter, or a green below proves nothing. IAM propagation can lag the
# deploy, so the assume is retried.
ROLE_CREDS=""
for _ in $(seq 1 12); do
  ROLE_CREDS="$( (as_caller aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkd-integ-3240 \
    --region "${REGION}" --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text) 2>/dev/null)" && break
  ROLE_CREDS=""
  sleep 5
done
[ -n "${ROLE_CREDS}" ] || { echo "[verify] FAIL: could not assume ${ROLE_ARN} within 60s" >&2; exit 1; }
# shellcheck disable=SC2086 # split the three tab-separated fields on purpose
set -- ${ROLE_CREDS}
ROLE_AKID="$1"
DENIED="$(
  unset AWS_PROFILE
  export AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3"
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" 2>&1 >/dev/null || true
)"
set --
unset ROLE_CREDS
[ "${ROLE_AKID}" != "${CALLER_AKID}" ] || { echo "[verify] FAIL: premise broken: the role session has the caller's access key" >&2; exit 1; }
echo "${DENIED}" | grep -q 'AccessDenied' \
  || { echo "[verify] FAIL: premise broken: the no-permission role was not denied ssm:GetParameter (got: ${DENIED})" >&2; exit 1; }
echo "[verify]   premise ok: the role session (${ROLE_AKID}) is denied the parameter; the caller is ${CALLER_AKID}"

echo "[verify] step 4: synthesize"
${CDKD} synth -c part=app >/dev/null

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'
}

# Boot an engine in the background. $1 = launcher (as_caller | as_profile_only),
# rest = the cdkd local ... arguments.
boot() {
  local launcher="$1"
  shift
  : > "${OUT_FILE}"
  # shellcheck disable=SC2086 # CDKD is "node <path>", split on purpose
  "${launcher}" ${CDKD} local "$@" -c part=app > "${OUT_FILE}" 2>&1 &
  ENGINE_PID=$!
}

wait_for_line() { # usage: wait_for_line <ERE> <tries x0.5s>
  local i
  for ((i = 0; i < $2; i++)); do
    if grep -Eq "$1" "${OUT_FILE}"; then return 0; fi
    kill -0 "${ENGINE_PID}" 2>/dev/null || fail "the engine exited before printing '$1'"
    sleep 0.5
  done
  fail "the engine did not print '$1' in time"
}

# Fetch a URL until the body carries an "akid" key; prints the body.
fetch_akid_body() { # usage: fetch_akid_body <curl args...>
  local body=""
  for _ in $(seq 1 90); do
    body="$(curl -sS --max-time 20 "$@" 2>/dev/null || true)"
    if printf '%s' "${body}" | grep -q '"akid"'; then printf '%s' "${body}"; return 0; fi
    kill -0 "${ENGINE_PID}" 2>/dev/null || fail "the engine exited while serving (last body: ${body})"
    sleep 1
  done
  fail "no response carrying an akid within 90s (last body: ${body})"
}

# The workload's AWS_ACCESS_KEY_ID must be the caller's, and cdkd must have
# reported its own AssumeRole (else a silently ignored --role-arn would make
# this pass on a tree that never assumed anything).
assert_workload_is_caller() { # usage: assert_workload_is_caller <what> <body>
  local what="$1" body="$2"
  echo "[verify]   ${what} workload said: ${body}"
  if ! printf '%s' "${body}" | grep -qF "\"akid\":\"${CALLER_AKID}\""; then
    fail "#3240: the ${what} workload did not run as the caller (expected \"akid\":\"${CALLER_AKID}\", got: ${body})"
  fi
  if ! awk -v arn="${ROLE_ARN}" 'index($0, "Assumed role ") && index($0, arn) { found = 1 } END { exit !found }' "${OUT_FILE}"; then
    fail "cdkd did not report assuming ${ROLE_ARN}; --role-arn may have been ignored"
  fi
}

echo "[verify] arm A1: start-alb under --role-arn runs the Lambda target as the caller"
PORT="$(free_port)"
boot as_caller start-alb "${APP_STACK}:Alb" --lb-port "80=${PORT}" --container-host 127.0.0.1 --no-pull --role-arn "${ROLE_ARN}"
wait_for_line 'Service\(s\) running:' 240
BODY="$(fetch_akid_body "http://127.0.0.1:${PORT}/")"
assert_workload_is_caller "start-alb" "${BODY}"
stop_engine

echo "[verify] arm A2: start-cloudfront under --role-arn runs the Function URL origin as the caller"
PORT="$(free_port)"
boot as_caller start-cloudfront "${APP_STACK}/Dist" --port "${PORT}" --no-pull --role-arn "${ROLE_ARN}"
wait_for_line 'CloudFront distribution serving on' 480
BODY="$(fetch_akid_body "http://127.0.0.1:${PORT}/")"
assert_workload_is_caller "start-cloudfront" "${BODY}"
stop_engine

echo "[verify] arm A3: start-agentcore under --role-arn runs the agent container as the caller"
boot as_caller start-agentcore "${APP_STACK}/Agent" --host 127.0.0.1 --port 0 --role-arn "${ROLE_ARN}"
wait_for_line 'HTTP contract served on http://[^ ]+' 960
HTTP_URL="$(grep -Eo 'HTTP contract served on http://[^ ]+' "${OUT_FILE}" | head -1)"
HTTP_URL="${HTTP_URL#HTTP contract served on }"
BODY="$(fetch_akid_body -X POST -H 'Content-Type: application/json' -d '{}' "${HTTP_URL}/invocations")"
assert_workload_is_caller "start-agentcore" "${BODY}"
stop_engine

echo "[verify] arm B: start-service under --role-arn reads the ECS secret as the caller"
boot as_caller start-service "${APP_STACK}:SecretService" --no-pull --role-arn "${ROLE_ARN}"
wait_for_line 'Service\(s\) running:' 240
SEEN=0
for _ in $(seq 1 60); do
  for c in $(docker ps -a --filter "name=cdkd-local-" --format '{{.Names}}'); do
    if docker logs "${c}" 2>&1 | grep -qF "ROLE_SECRET_SEEN=${PARAM_VALUE}"; then SEEN=1; break; fi
  done
  [ "${SEEN}" -eq 1 ] && break
  kill -0 "${ENGINE_PID}" 2>/dev/null || fail "start-service exited before the container printed the secret"
  sleep 1
done
[ "${SEEN}" -eq 1 ] \
  || fail "#3240: the container never received ROLE_TEST_SECRET=${PARAM_VALUE}: the ECS secret was read as the --role-arn role, which is denied ssm:GetParameter"
if ! awk -v arn="${ROLE_ARN}" 'index($0, "Assumed role ") && index($0, arn) { found = 1 } END { exit !found }' "${OUT_FILE}"; then
  fail "cdkd did not report assuming ${ROLE_ARN}; --role-arn may have been ignored"
fi
echo "[verify]   the container received the parameter value"
stop_engine

echo "[verify] arm C: start-alb with only an exported AWS_PROFILE strips the role's key"
if [ -n "${AWS_PROFILE:-}" ]; then
  WORKLOAD_PROFILE="${AWS_PROFILE}"
elif aws configure list-profiles | grep -x default >/dev/null; then
  WORKLOAD_PROFILE="default"
else
  WORKLOAD_PROFILE="$(aws configure list-profiles | sed -n 1p)"
fi
[ -n "${WORKLOAD_PROFILE}" ] \
  || fail "arm C premise: no AWS profile exists on this host; set WORKLOAD_PROFILE (or AWS_PROFILE) to a profile in the role's account"
WORKLOAD_ACCOUNT="$(aws sts get-caller-identity --profile "${WORKLOAD_PROFILE}" --query Account --output text)" \
  || fail "arm C premise: 'aws sts get-caller-identity --profile ${WORKLOAD_PROFILE}' failed; set WORKLOAD_PROFILE to a working profile"
ROLE_ACCOUNT="$(printf '%s' "${ROLE_ARN}" | cut -d: -f5)"
[ "${WORKLOAD_ACCOUNT}" = "${ROLE_ACCOUNT}" ] \
  || fail "arm C premise: profile '${WORKLOAD_PROFILE}' is in account ${WORKLOAD_ACCOUNT}, but ${ROLE_ARN} is in ${ROLE_ACCOUNT}; set WORKLOAD_PROFILE to a profile in the role's account"
echo "[verify]   using profile '${WORKLOAD_PROFILE}' (exported as AWS_PROFILE; no static triple, no --profile)"
PORT="$(free_port)"
boot as_profile_only start-alb "${APP_STACK}:Alb" --lb-port "80=${PORT}" --container-host 127.0.0.1 --no-pull --role-arn "${ROLE_ARN}"
wait_for_line 'Service\(s\) running:' 240
BODY="$(fetch_akid_body "http://127.0.0.1:${PORT}/")"
echo "[verify]   workload said: ${BODY}"
printf '%s' "${BODY}" | grep -qF '"akid":null' \
  || fail "#3240: the role's access key reached the workload with only AWS_PROFILE exported (expected \"akid\":null, got: ${BODY})"
grep -qF 'is not handed to the emulated workload' "${OUT_FILE}" \
  || fail "cdk-local's stripped-credentials warning ('is not handed to the emulated workload') was not printed"
if grep -qF 'with your own profile' "${OUT_FILE}"; then
  fail "the old cdkd startup warning ('with your own profile') was printed; it must be gone"
fi
awk -v arn="${ROLE_ARN}" 'index($0, "Assumed role ") && index($0, arn) { found = 1 } END { exit !found }' "${OUT_FILE}" \
  || fail "cdkd did not report assuming ${ROLE_ARN}; --role-arn may have been ignored"
stop_engine

echo "[verify] step 5: no leftover containers or networks"
sleep 1
LEFT="$(docker ps -a --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')"
[ "${LEFT}" -eq 0 ] || fail "${LEFT} container(s) left after the engines stopped"
LEFT="$(docker network ls --filter "name=cdkd-local-" --format '{{.ID}}' | wc -l | tr -d ' ')"
[ "${LEFT}" -eq 0 ] || fail "${LEFT} docker network(s) left after the engines stopped"

echo "[verify] step 6: destroy ${ROLE_STACK} and assert it is gone"
${CDKD} destroy "${ROLE_STACK}" --state-bucket "${STATE_BUCKET}" --force -c part=role
ROLE_DEPLOYED=0
assert_gone "IAM role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "lock file ${LOCK_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"

trap - EXIT INT TERM
rm -f "${OUT_FILE}"
unset CALLER_AKID CALLER_SECRET CALLER_TOKEN
echo "[verify] PASS — the engine commands run the workload as the caller under --role-arn (start-alb, start-cloudfront, start-agentcore, start-service); an exported AWS_PROFILE alone never hands the role's key to the workload"
