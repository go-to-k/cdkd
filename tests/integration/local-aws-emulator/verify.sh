#!/usr/bin/env bash
# verify.sh — the documented `--aws-emulator` loop (docs/aws-emulator.md),
# end to end against a local AWS Emulator container.
#
# Nothing here touches real AWS: every `aws` call below goes to the emulator
# (the AWS_* variables are pointed at its run directory and the real
# credentials are unset), and every cdkd command passes `--aws-emulator`.
#
# Phases:
#   0. Start the emulator in Docker on 127.0.0.1:${PORT} and wait for its health
#      check.
#   1. `cdkd deploy --aws-emulator` into the empty emulator: the state bucket
#      and asset storage are bootstrapped on the way, and the
#      autoDeleteObjects / BucketDeployment custom resources run in the Lambda
#      runtime image locally. Assert the BucketDeployment's file landed.
#   2. `cdkd local invoke --from-state --aws-emulator` on a top-level function
#      and on one inside a NestedStack: each writes an item to the table whose
#      name --from-state handed in and reads it back. Then the flag BEFORE the
#      target is refused with the placement remedy (go-to-k/cdkd#6382).
#   3. `cdkd local start-api --from-state --aws-emulator`: an HTTP API route
#      sends an SQS message to the deployed queue and receives it back.
#   4. UPDATE (CDKD_TEST_UPDATE=true): a GSI, more memory, a new env value.
#      Assert the table was updated in place (CreationDateTime unchanged), the
#      GSI and memory reached the emulator, and a local invoke sees the new
#      env value.
#   4b. `cdkd export --dry-run --aws-emulator` refuses the stack while the
#      emulator has no `cdk bootstrap` SSM parameter, naming it
#      (go-to-k/cdkd#6410), and passes once the parameter exists.
#   5. `cdkd destroy --aws-emulator`: the custom resources' Delete handlers run
#      locally again, and every resource plus the state record is gone.
#
# Requirements: Docker, and an AWS Emulator image built per
# docs/aws-emulator.md "Run the emulator" (default tag `aws-emulator`;
# override with CDKD_AWS_EMULATOR_IMAGE). STATE_BUCKET is not used: the state
# lives in the emulator.

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

STACK="CdkdLocalAwsEmulatorExample"
# Not the emulator's default 9297, so a developer's own emulator keeps running.
PORT="${CDKD_AWS_EMULATOR_PORT:-9311}"
API_PORT="${CDKD_LOCAL_API_PORT:-3911}"
IMAGE="${CDKD_AWS_EMULATOR_IMAGE:-aws-emulator}"
CONTAINER="cdkd-integ-local-aws-emulator"
EMU="https://127.0.0.1:${PORT}"
EMU_HOME="${HOME}/.aws/emulator"
RUN_DIR="${EMU_HOME}/${PORT}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

case "${PORT}" in
  '' | *[!0-9]*)
    echo "FAIL: CDKD_AWS_EMULATOR_PORT must be a port number (got '${PORT}')" >&2
    exit 1
    ;;
esac

# Every `aws` call in this script goes to the emulator, never to real AWS.
# The script's own `aws` calls do not pass through cdkd's --aws-emulator env
# scrub, so drop every identity source, every per-service endpoint override and
# the shell's region here. The region then comes from the emulator's config,
# the same one cdkd falls back to.
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN
unset AWS_REGION AWS_DEFAULT_REGION AWS_IGNORE_CONFIGURED_ENDPOINT_URLS
while IFS= read -r ENDPOINT_VAR; do
  unset "${ENDPOINT_VAR}"
done < <(env | sed -n 's/^\(AWS_ENDPOINT_URL[A-Z0-9_]*\)=.*/\1/p')
unset CDKD_AWS_EMULATOR CDKD_TEST_UPDATE CDKD_ROLE_ARN
export AWS_EC2_METADATA_DISABLED=true
export AWS_ENDPOINT_URL="${EMU}"
export AWS_CA_BUNDLE="${RUN_DIR}/ca.pem"
export AWS_CONFIG_FILE="${RUN_DIR}/config"
export AWS_SHARED_CREDENTIALS_FILE="${RUN_DIR}/emulator_credentials"
export AWS_PAGER=""

DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-deploy.$$.log"
UPDATE_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-update.$$.log"
DESTROY_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-destroy.$$.log"
INVOKE_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-invoke.$$.log"
API_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-api.$$.log"
EXPORT_LOG="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-export.$$.log"
EVENT_FILE="${TMPDIR:-/tmp}/cdkd-local-aws-emulator-event.$$.json"
API_PID=""
CLEANED_UP=0

stop_api() { (
  set +eu
  if [ -n "${API_PID}" ] && kill -0 "${API_PID}" 2>/dev/null; then
    # SIGINT is start-api's own stop path: it removes the containers it started.
    kill -INT "${API_PID}" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "${API_PID}" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "${API_PID}" 2>/dev/null; then
      kill -TERM "${API_PID}" 2>/dev/null
    fi
  fi
  # A helper called under `set -e`: its status must not depend on the last
  # probe above.
  exit 0
) }

# The body runs in a subshell: a bare `set +eu` here would leak into the
# script itself after the pre-run call below and turn every later check off.
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  cleanup_body
}
cleanup_body() { (
  set +eu
  stop_api
  # The emulator keeps every resource in memory, so removing its container
  # discards the whole deployment, state bucket included.
  docker rm -f "${CONTAINER}" >/dev/null 2>&1
  # Its run directory (keys, certificate, config) for THIS port only.
  case "${PORT}" in
    [0-9]*)
      if [ -d "${RUN_DIR}" ]; then
        (cd "${EMU_HOME}" && rm -rf "./${PORT}")
      fi
      ;;
    *) echo "WARN: teardown sweep refused: PORT '${PORT}' is not a port number" >&2 ;;
  esac
  rm -f "${DEPLOY_LOG}" "${UPDATE_LOG}" "${DESTROY_LOG}" "${INVOKE_LOG}" "${API_LOG}" "${EXPORT_LOG}" "${EVENT_FILE}"
  exit 0
) }
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "FAIL: Docker is not running" >&2
  exit 1
fi
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "FAIL: no AWS Emulator image '${IMAGE}'. Build one per docs/aws-emulator.md \"Run the emulator\", or set CDKD_AWS_EMULATOR_IMAGE." >&2
  exit 1
fi

# Pre-run cleanup: a container or run directory left by an interrupted run.
cleanup
CLEANED_UP=0

# cdkd always colors its output (src/utils/colors.ts), redirected or not, so
# every log is stripped of ANSI codes before anything greps it.
strip_ansi() { # usage: strip_ansi <file>
  perl -pi -e 's/\e\[[0-9;]*m//g' "$1"
}

# cdkd prints "Name = value" for each stack output.
output_value() { # usage: output_value <log> <OutputKey>
  sed -n "s/^ *${STACK}\.$2 = //p" "$1" | tail -n 1
}

# --- Phase 0: start the emulator ---------------------------------------------
echo "==> Phase 0: start AWS Emulator (${IMAGE}) on ${EMU}"
mkdir -p "${EMU_HOME}"
PUBLISH=(-p "127.0.0.1:${PORT}:${PORT}")
USER_ARGS=()
if [ "$(uname -s)" = "Linux" ]; then
  # docs/aws-emulator.md "Linux": cdkd local containers reach the emulator on
  # the Docker bridge gateway.
  GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  PUBLISH+=(-p "${GATEWAY}:${PORT}:${PORT}")
  USER_ARGS=(--user "$(id -u):$(id -g)")
fi
docker run -d --rm --name "${CONTAINER}" --memory=2g --memory-swap=2g \
  "${USER_ARGS[@]+"${USER_ARGS[@]}"}" "${PUBLISH[@]}" \
  -e HOME="${HOME}" -v "${EMU_HOME}:${EMU_HOME}" \
  "${IMAGE}" -p "${PORT}" >/dev/null

HEALTHY=0
for _ in $(seq 1 60); do
  if [ -f "${RUN_DIR}/ca.pem" ] && curl -fsS --cacert "${RUN_DIR}/ca.pem" "${EMU}/__admin/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "${HEALTHY}" != 1 ]; then
  echo "FAIL: the emulator did not answer its health check within 60s" >&2
  docker logs "${CONTAINER}" 2>&1 | tail -20 >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGION="$(awk -F' *= *' '$1 == "region" { print $2; exit }' "${AWS_CONFIG_FILE}")"
REGION="${REGION:-us-east-1}"
STATE_BUCKET_EMU="cdkd-state-${ACCOUNT}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
echo "    OK: emulator healthy (account ${ACCOUNT}, region ${REGION})"

# --- Phase 1: deploy into the empty emulator ---------------------------------
echo "==> Phase 1: deploy --aws-emulator (bootstraps the empty emulator)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" --aws-emulator="${EMU}" >"${DEPLOY_LOG}" 2>&1; then
  echo "FAIL: deploy failed" >&2
  tail -40 "${DEPLOY_LOG}" >&2
  exit 1
fi
strip_ansi "${DEPLOY_LOG}"
grep -q 'Deployment completed successfully' "${DEPLOY_LOG}" || { echo "FAIL: no deploy success line" >&2; tail -40 "${DEPLOY_LOG}" >&2; exit 1; }
for CR in BucketAutoDeleteObjectsCustomResource SiteCustomResource; do
  if ! grep -qE "Running custom resource ${CR}[0-9A-F]*'s function .* in the Lambda runtime image locally" "${DEPLOY_LOG}"; then
    echo "FAIL: deploy did not run custom resource ${CR} locally" >&2
    tail -40 "${DEPLOY_LOG}" >&2
    exit 1
  fi
done
TABLE="$(output_value "${DEPLOY_LOG}" TableName)"
BUCKET="$(output_value "${DEPLOY_LOG}" BucketName)"
[ -n "${TABLE}" ] && [ -n "${BUCKET}" ] || { echo "FAIL: TableName / BucketName outputs missing from the deploy log" >&2; exit 1; }
aws s3api head-object --bucket "${BUCKET}" --key index.html >/dev/null
INNER_TABLE="$(aws dynamodb list-tables --query "TableNames[?starts_with(@, '${STACK}-Inner')] | [0]" --output text)"
QUEUE_NAME="$(aws sqs list-queues --queue-name-prefix "${STACK}-Queue" --query 'QueueUrls[0]' --output text)"
QUEUE_NAME="${QUEUE_NAME##*/}"
API_ID="$(aws apigatewayv2 get-apis --query "Items[?Name=='HttpApi'].ApiId | [0]" --output text)"
for V in "INNER_TABLE=${INNER_TABLE}" "QUEUE_NAME=${QUEUE_NAME}" "API_ID=${API_ID}"; do
  case "${V#*=}" in
    '' | None) echo "FAIL: ${V%%=*} not found in the emulator after deploy" >&2; exit 1 ;;
  esac
done
aws s3api head-object --bucket "${STATE_BUCKET_EMU}" --key "${STATE_KEY}" >/dev/null
echo "    OK: deployed; both custom resources ran locally; BucketDeployment file and state record present"

# --- Phase 2: local invoke --from-state ---------------------------------------
echo '{}' >"${EVENT_FILE}"
# cdkd local synthesizes the app itself, so the UPDATE phase's invoke needs
# CDKD_TEST_UPDATE=true too, or it runs the baseline template's env values.
invoke() { # usage: invoke <target> [update]; leaves the output in INVOKE_LOG
  local mode=false
  [ "${2:-}" = update ] && mode=true
  if ! CDKD_TEST_UPDATE="${mode}" node "${LOCAL_DIST}" local invoke "$1" --from-state --aws-emulator="${EMU}" --event "${EVENT_FILE}" >"${INVOKE_LOG}" 2>&1; then
    echo "FAIL: local invoke $1 failed" >&2
    tail -30 "${INVOKE_LOG}" >&2
    exit 1
  fi
  strip_ansi "${INVOKE_LOG}"
}
echo "==> Phase 2: local invoke --from-state --aws-emulator"
invoke "${STACK}/TableFn"
if ! grep -qF "{\"table\":\"${TABLE}\",\"stored\":\"v1\",\"version\":\"v1\"}" "${INVOKE_LOG}"; then
  echo "FAIL: TableFn did not write and read back v1 in ${TABLE}" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
STORED="$(aws dynamodb get-item --table-name "${TABLE}" --key '{"id":{"S":"k1"}}' --query 'Item.v.S' --output text)"
[ "${STORED}" = "v1" ] || { echo "FAIL: the emulator's table holds '${STORED}', expected v1" >&2; exit 1; }
invoke "${STACK}/Inner/TableFn"
if ! grep -qE '"stored":"nested","version":"nested"' "${INVOKE_LOG}"; then
  echo "FAIL: the nested stack's TableFn did not write and read back its item" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
echo "    OK: both functions reached the emulator's DynamoDB through --from-state names"

# The flag BEFORE the required target (go-to-k/cdkd#6382): the URL is optional,
# so the target is read as the URL. The run must refuse with the placement
# remedy, not commander's "missing required argument". "takes an http(s) URL"
# is the sentinel: present without the remedy means the wording drifted.
echo "==> Phase 2b: --aws-emulator before the target is refused with the placement remedy"
if node "${LOCAL_DIST}" local invoke --aws-emulator "${STACK}/TableFn" --event "${EVENT_FILE}" >"${INVOKE_LOG}" 2>&1; then
  echo "FAIL: local invoke --aws-emulator <target> succeeded; it must refuse the target as a URL" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
strip_ansi "${INVOKE_LOG}"
if grep -qF 'missing required argument' "${INVOKE_LOG}"; then
  echo "FAIL: the refusal is commander's missing-argument error, not the placement remedy" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
if ! grep -qF 'put --aws-emulator after the target, or write --aws-emulator=<url>' "${INVOKE_LOG}"; then
  if grep -qF 'takes an http(s) URL' "${INVOKE_LOG}"; then
    echo "FAIL: the refusal's wording drifted; update this check" >&2
  else
    echo "FAIL: local invoke --aws-emulator <target> did not print the placement remedy" >&2
  fi
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
if grep -qF 'Fatal error:' "${INVOKE_LOG}" || grep -qE '^[[:space:]]+at ' "${INVOKE_LOG}"; then
  echo "FAIL: the refusal surfaced as a Fatal error with a stack trace" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
echo "    OK: the misplaced flag is refused with the placement remedy"

# --- Phase 3: local start-api --from-state ------------------------------------
echo "==> Phase 3: local start-api --from-state --aws-emulator"
node "${LOCAL_DIST}" local start-api --stack "${STACK}" --from-state --aws-emulator="${EMU}" --port "${API_PORT}" >"${API_LOG}" 2>&1 &
API_PID=$!
READY=0
for _ in $(seq 1 120); do
  if grep -q "Server listening on http://127.0.0.1:${API_PORT}" "${API_LOG}"; then
    READY=1
    break
  fi
  kill -0 "${API_PID}" 2>/dev/null || break
  sleep 1
done
if [ "${READY}" != 1 ]; then
  echo "FAIL: start-api did not start listening" >&2
  tail -30 "${API_LOG}" >&2
  exit 1
fi
if ! RESP="$(curl -fsS -m 90 "http://127.0.0.1:${API_PORT}/send")"; then
  echo "FAIL: GET /send failed" >&2
  tail -30 "${API_LOG}" >&2
  exit 1
fi
if ! grep -qF '"via /send"' <<<"${RESP}"; then
  echo "FAIL: /send did not receive its own SQS message back (got: ${RESP})" >&2
  tail -30 "${API_LOG}" >&2
  exit 1
fi
stop_api
API_PID=""
echo "    OK: the route's SQS round trip stayed on the emulator"

# --- Phase 4: UPDATE in place -------------------------------------------------
echo "==> Phase 4: update deploy (GSI, memory, env value)"
CREATED_BEFORE="$(aws dynamodb describe-table --table-name "${TABLE}" --query 'Table.CreationDateTime' --output text)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --aws-emulator="${EMU}" >"${UPDATE_LOG}" 2>&1; then
  echo "FAIL: update deploy failed" >&2
  tail -40 "${UPDATE_LOG}" >&2
  exit 1
fi
strip_ansi "${UPDATE_LOG}"
grep -q 'Changes: 0 to create, [1-9][0-9]* to update, 0 to delete' "${UPDATE_LOG}" || { echo "FAIL: the update was not in place" >&2; grep 'Changes:' "${UPDATE_LOG}" >&2; exit 1; }
CREATED_AFTER="$(aws dynamodb describe-table --table-name "${TABLE}" --query 'Table.CreationDateTime' --output text)"
[ "${CREATED_BEFORE}" = "${CREATED_AFTER}" ] || { echo "FAIL: table was replaced (CreationDateTime ${CREATED_BEFORE} -> ${CREATED_AFTER})" >&2; exit 1; }
GSI="$(aws dynamodb describe-table --table-name "${TABLE}" --query 'Table.GlobalSecondaryIndexes[].IndexName' --output text)"
[ "${GSI}" = "byV" ] || { echo "FAIL: GSI byV missing after update (got '${GSI}')" >&2; exit 1; }
FN="$(aws lambda list-functions --query "Functions[?starts_with(FunctionName, '${STACK}-TableFn')].FunctionName" --output text)"
[ -n "${FN}" ] || { echo "FAIL: TableFn not found in the emulator" >&2; exit 1; }
MEM="$(aws lambda get-function-configuration --function-name "${FN}" --query MemorySize --output text)"
[ "${MEM}" = "256" ] || { echo "FAIL: TableFn MemorySize is ${MEM}, expected 256" >&2; exit 1; }
invoke "${STACK}/TableFn" update
if ! grep -qF "{\"table\":\"${TABLE}\",\"stored\":\"v2\",\"version\":\"v2\"}" "${INVOKE_LOG}"; then
  echo "FAIL: TableFn did not run with the updated VERSION v2" >&2
  tail -30 "${INVOKE_LOG}" >&2
  exit 1
fi
echo "    OK: updated in place; GSI + memory reached the emulator; local invoke sees v2"

# --- Phase 4b: export --dry-run without CDK bootstrap (go-to-k/cdkd#6410) -----
# The emulator starts without `cdk bootstrap`, so the stack's BootstrapVersion
# parameter names an SSM parameter that does not exist. CloudFormation would
# fail the IMPORT changeset on it; the preview must refuse it by name first.
echo "==> Phase 4b: export --dry-run refuses the missing BootstrapVersion SSM parameter"
BOOTSTRAP_PARAM="/cdk-bootstrap/hnb659fds/version"
assert_gone "SSM parameter ${BOOTSTRAP_PARAM} exists before the export preview" aws ssm get-parameter --name "${BOOTSTRAP_PARAM}"
if CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" export "${STACK}" --aws-emulator="${EMU}" --dry-run >"${EXPORT_LOG}" 2>&1; then
  echo "FAIL: export --dry-run passed with ${BOOTSTRAP_PARAM} missing" >&2
  tail -30 "${EXPORT_LOG}" >&2
  exit 1
fi
strip_ansi "${EXPORT_LOG}"
if ! grep -qF "'BootstrapVersion': SSM parameter ${BOOTSTRAP_PARAM} is created by 'cdk bootstrap'" "${EXPORT_LOG}"; then
  echo "FAIL: export --dry-run failed without naming ${BOOTSTRAP_PARAM}" >&2
  tail -30 "${EXPORT_LOG}" >&2
  exit 1
fi
aws ssm put-parameter --name "${BOOTSTRAP_PARAM}" --type String --value 30 >/dev/null
# The preview still stops on the types the emulator's registry has no schema
# for (go-to-k/cdkd#6411), so this arm asserts only that the parameter is no
# longer named, on a run that printed the blocked list, which comes after the
# SSM check (the sentinel).
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" export "${STACK}" --aws-emulator="${EMU}" --dry-run >"${EXPORT_LOG}" 2>&1 || true
strip_ansi "${EXPORT_LOG}"
grep -qF 'The following resources block migration:' "${EXPORT_LOG}" || { echo "FAIL: export --dry-run did not reach the SSM check after ${BOOTSTRAP_PARAM} was created" >&2; tail -30 "${EXPORT_LOG}" >&2; exit 1; }
if grep -qF "SSM parameter ${BOOTSTRAP_PARAM}" "${EXPORT_LOG}"; then
  echo "FAIL: export --dry-run still names ${BOOTSTRAP_PARAM} after it was created" >&2
  tail -30 "${EXPORT_LOG}" >&2
  exit 1
fi
echo "    OK: the preview names the missing parameter, and stops naming it once it exists"

# --- Phase 5: destroy -----------------------------------------------------------
echo "==> Phase 5: destroy --aws-emulator"
if ! node "${LOCAL_DIST}" destroy "${STACK}" --aws-emulator="${EMU}" --force >"${DESTROY_LOG}" 2>&1; then
  echo "FAIL: destroy failed" >&2
  tail -40 "${DESTROY_LOG}" >&2
  exit 1
fi
strip_ansi "${DESTROY_LOG}"
for CR in BucketAutoDeleteObjectsCustomResource SiteCustomResource; do
  if ! grep -qE "Running custom resource ${CR}[0-9A-F]*'s function .* in the Lambda runtime image locally" "${DESTROY_LOG}"; then
    echo "FAIL: destroy did not run custom resource ${CR}'s Delete locally" >&2
    tail -40 "${DESTROY_LOG}" >&2
    exit 1
  fi
done
assert_gone "table ${TABLE} still exists after destroy" aws dynamodb describe-table --table-name "${TABLE}"
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}"
assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}"
assert_gone "nested table ${INNER_TABLE} still exists after destroy" aws dynamodb describe-table --table-name "${INNER_TABLE}"
assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}"
assert_gone "HTTP API ${API_ID} still exists after destroy" aws apigatewayv2 get-api --api-id "${API_ID}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET_EMU}" --key "${STATE_KEY}"
LEFT="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET_EMU}" --prefix "cdkd/${STACK}" --query 'Contents[].Key' --output text)"
if grep -qE '(^|[[:space:]])[^[:space:]]*/state\.json' <<<"${LEFT}"; then
  echo "FAIL: a state record survived destroy (nested stack?): ${LEFT}" >&2
  exit 1
fi
echo "    OK: destroyed; Delete handlers ran locally; resources and state records gone"

echo "[verify] PASS — --aws-emulator deploy, local invoke (incl. nested), start-api, in-place update and destroy all ran against AWS Emulator"
