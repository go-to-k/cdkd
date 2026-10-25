#!/usr/bin/env bash
# verify.sh — cdkd local start-web-function --from-state real-AWS integ test
# (go-to-k/cdkd#5295)
#
# Deploys a Lambda Web Function with cdkd so its S3 state records the
# execution role, then serves the deployed stack's endpoint locally with
# `--from-state --assume-role` (bare). The revision's
# `ServiceConfig.ExecutionRoleArn` is a `Fn::GetAtt` of a role in the stack,
# so only cdkd's state can resolve it: the container must then run AS that
# role, which the server itself proves by calling STS GetCallerIdentity.
# Shell credentials answer with another ARN and FAIL the arm.
#
# Flow:
#   1. A versioned code bucket this script owns, named with the run token.
#   2. Synth (to read the asset's `<hash>.zip` key), upload web/ zipped under
#      that key, deploy with the object's version id.
#   3. Wait until the role is assumable by the caller.
#   4. Boot `cdkd local start-web-function <Stack>/Endpoint --from-state
#      --assume-role`; assert cdkd auto-resolved the role from state and
#      printed no fallback warning; GET /whoami must answer
#      `assumed-role/<role>/...` and ROLE_NAME (a Ref) resolved to the role.
#   5. SIGTERM; no `cdkd-local-webfn-*` container left.
#   6. cdkd destroy; the function, endpoint, role, log groups, state file and
#      code bucket are gone.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-web-function-from-state/verify.sh
#
# Requires Docker. Uses host port 18480.

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

STACK="CdkdLocalStartWebFunctionFromState"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CDKD="node ${LOCAL_DIST}"
NAME_PREFIX="cdkd-integ-webfn-lsf"
RUN_TOKEN="r$$"
PREFIX="${NAME_PREFIX}-${RUN_TOKEN}"
FN_NAME="${PREFIX}-fn"
ROLE_NAME="${PREFIX}-${REGION}"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:24"
PORT=18480
# cdk-local names a container `cdkd-local-webfn-<pid of the cdkd process>-<rand>`.
# Every container check and removal is scoped to the pid of the serve THIS
# script started, so a peer run in a parallel wave is neither reported nor killed.
CONTAINER_PREFIX="cdkd-local-webfn-"
OUT_FILE="$(mktemp)"
WORK=""
CDKD_PID=""
# The pid of the serve, kept after stop_server clears CDKD_PID.
SERVE_PID=""
DEPLOYED=0
CLEANED_UP=0

# The cloud runtime is arm64-only and the command defaults to linux/arm64. On
# an amd64 host, run the container natively instead of under emulation.
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64"; PLATFORM_ARGS=() ;;
  *) PLATFORM="linux/amd64"; PLATFORM_ARGS=(--platform linux/amd64) ;;
esac

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not built (run vp run build)" >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
CODE_BUCKET="${NAME_PREFIX}-${RUN_TOKEN}-code-${ACCOUNT}-${REGION}"
export CDKD_WEBFN_RUN="${RUN_TOKEN}" CODE_BUCKET
# A placeholder until the upload returns the real version id (synth only).
export CODE_VERSION="pending"

stop_server() {
  if [ -n "${CDKD_PID}" ] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 80); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

# Identifiers of every resource of a type under the web function.
cc_ids() { # usage: cc_ids <type>
  aws cloudcontrol list-resources --type-name "$1" --resource-model "{\"FunctionName\":\"${FN_NAME}\"}" \
    --region "${REGION}" --query 'ResourceDescriptions[].Identifier' --output text
}

# Best-effort Cloud Control delete that waits for the request to settle.
cc_delete() { ( # usage: cc_delete <type> <identifier>
  set +eu
  token="$(aws cloudcontrol delete-resource --type-name "$1" --identifier "$2" --region "${REGION}" \
    --query 'ProgressEvent.RequestToken' --output text 2>/dev/null)"
  [ -n "${token}" ] || exit 0
  for _ in $(seq 1 60); do
    status="$(aws cloudcontrol get-resource-request-status --request-token "${token}" \
      --region "${REGION}" --query 'ProgressEvent.OperationStatus' --output text 2>/dev/null)"
    case "${status}" in SUCCESS | FAILED | CANCEL_COMPLETE) exit 0 ;; esac
    sleep 5
  done
) }

# Delete everything this run's token named. The guard keeps an empty or
# foreign token from widening the log-group listing to the account.
reap_run() { (
  set +eu
  case "${RUN_TOKEN:-}" in
    r[0-9]?*) ;;
    *)
      echo "WARN: teardown sweep refused — '${RUN_TOKEN:-}' is not this fixture's run token" >&2
      exit 0
      ;;
  esac
  arn="$(aws lambda-web get-web-function --function-name "${FN_NAME}" --region "${REGION}" \
    --query functionArn --output text 2>/dev/null)"
  if [ -n "${arn}" ]; then
    for id in $(cc_ids AWS::Lambda::WebFunctionEndpoint 2>/dev/null); do
      cc_delete AWS::Lambda::WebFunctionEndpoint "${id}"
    done
    for id in $(cc_ids AWS::Lambda::WebFunctionRevision 2>/dev/null); do
      cc_delete AWS::Lambda::WebFunctionRevision "${id}"
    done
    cc_delete AWS::Lambda::WebFunction "${arn}"
  fi
  for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${PREFIX}-" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    [ "${lg}" = "None" ] && continue
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
  done
  aws iam detach-role-policy --role-name "${ROLE_NAME}" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
) }

# Every version and delete marker of every object, then the bucket.
reap_code_bucket() { (
  set +eu
  aws s3api list-object-versions --bucket "${CODE_BUCKET}" \
    --query '[Versions[].[Key, VersionId], DeleteMarkers[].[Key, VersionId]][]' --output text 2>/dev/null \
    | while read -r key version; do
      [ -n "${key}" ] && [ "${key}" != "None" ] || continue
      aws s3api delete-object --bucket "${CODE_BUCKET}" --key "${key}" --version-id "${version}" >/dev/null 2>&1
    done
  aws s3api delete-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
) }

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: stopping the server, dropping leftover AWS resources"
  set +eu
  stop_server
  if [ -n "${SERVE_PID}" ]; then
    docker ps -a --filter "name=${CONTAINER_PREFIX}${SERVE_PID}-" --format '{{.ID}}' \
      | xargs -r docker rm -f >/dev/null 2>&1
  fi
  if [ "${DEPLOYED}" = "1" ]; then
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 \
      || echo "WARN: destroy in trap failed; sweeping the run's resources directly" >&2
  fi
  reap_run
  ${CDKD} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  reap_code_bucket
  rm -f "${OUT_FILE}"
  if [ -n "${WORK}" ] && [ -d "${WORK}" ]; then
    rm -rf "${WORK}"
  fi
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "==> Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null

WORK="$(mktemp -d)"

echo "==> Code bucket ${CODE_BUCKET}"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${CODE_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "${CODE_BUCKET}" --versioning-configuration Status=Enabled
aws s3api put-bucket-policy --bucket "${CODE_BUCKET}" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"lambda.amazonaws.com\"},
    \"Action\": [\"s3:GetObject\", \"s3:GetObjectVersion\"],
    \"Resource\": \"arn:aws:s3:::${CODE_BUCKET}/*\",
    \"Condition\": {\"ArnLike\": {\"aws:SourceArn\": \"arn:aws:lambda:${REGION}:${ACCOUNT}:web-function/${NAME_PREFIX}-*/revision/*\"}}
  }]
}"

echo "==> Synth: read the asset key the revision names"
${CDKD} synth "${STACK}" --region "${REGION}" >/dev/null
CODE_KEY="$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = t.Outputs && t.Outputs.CodeKey && t.Outputs.CodeKey.Value;
  if (typeof v !== "string" || !/^[0-9a-f]{64}\.zip$/.test(v)) process.exit(1);
  console.log(v);
' "cdk.out/${STACK}.template.json")" || { echo "FAIL: no literal <hash>.zip CodeKey output in the synthesized template" >&2; exit 1; }
echo "    key: ${CODE_KEY}"

echo "==> Uploading web/ as ${CODE_KEY}"
(cd web && zip -q "${WORK}/app.zip" index.js)
CODE_VERSION="$(aws s3api put-object --bucket "${CODE_BUCKET}" --key "${CODE_KEY}" --body "${WORK}/app.zip" \
  --region "${REGION}" --query VersionId --output text)"
case "${CODE_VERSION}" in
  "" | None | null | pending)
    echo "FAIL: the code upload returned no version id: '${CODE_VERSION}'" >&2
    exit 1
    ;;
esac
export CODE_VERSION

echo "==> Deploying ${STACK} to ${REGION}"
DEPLOYED=1
${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
echo "==> Waiting for ${ROLE_ARN} to be assumable by the caller"
role_ready=0
assume_err=""
for _ in $(seq 1 30); do
  # Only the error text is kept; the issued credentials go to /dev/null.
  if assume_err="$(aws sts assume-role --role-arn "${ROLE_ARN}" --role-session-name cdkd-5295-probe \
       --query 'Credentials.Expiration' --output text 2>&1 >/dev/null)"; then
    role_ready=1
    break
  fi
  sleep 3
done
[ "${role_ready}" = 1 ] || { echo "FAIL: ${ROLE_ARN} never became assumable; last error: ${assume_err}" >&2; exit 1; }

# Control: the caller is not already the role, or the arm below proves nothing.
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
case "${CALLER_ARN}" in
  *":assumed-role/${ROLE_NAME}/"*) echo "FAIL: the caller already runs as ${ROLE_NAME}: ${CALLER_ARN}" >&2; exit 1 ;;
esac

echo "==> Boot: cdkd local start-web-function ${STACK}/Endpoint --from-state --assume-role"
: > "${OUT_FILE}"
${CDKD} local start-web-function "${STACK}/Endpoint" --from-state --assume-role \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --port "${PORT}" --no-pull \
  ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} > "${OUT_FILE}" 2>&1 &
CDKD_PID=$!
SERVE_PID="${CDKD_PID}"
booted=0
for _ in $(seq 1 480); do
  if grep -q 'Server listening on http://' "${OUT_FILE}"; then booted=1; break; fi
  kill -0 "${CDKD_PID}" 2>/dev/null || fail "start-web-function exited before it was ready"
  sleep 0.5
done
[ "${booted}" = 1 ] || fail "start-web-function did not print its ready banner in time"

grep -q "auto-resolved execution role from state: ${ROLE_ARN}" "${OUT_FILE}" \
  || fail "cdkd did not report resolving ${ROLE_ARN} from state"
if grep -qE 'could not resolve the execution role|no state was loaded|Falling back to the developer' "${OUT_FILE}"; then
  fail "cdkd printed a role-resolution fallback warning"
fi

BODY="$(curl -s "http://127.0.0.1:${PORT}/whoami")"
echo "    /whoami: ${BODY}"
echo "${BODY}" | grep -q "\"arn\":\"arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE_NAME}/" \
  || fail "the container did not run as ${ROLE_NAME}: ${BODY}"
echo "${BODY}" | grep -q "\"roleName\":\"${ROLE_NAME}\"" \
  || fail "ROLE_NAME (a Ref) was not resolved from state: ${BODY}"

echo "==> SIGTERM removes the container"
stop_server
sleep 1
orphans="$(docker ps -a --filter "name=${CONTAINER_PREFIX}${SERVE_PID}-" --format '{{.Names}}')" \
  || fail "docker ps failed while checking for leftover containers"
[ -z "${orphans}" ] || fail "leftover web function container(s): ${orphans}"

echo "==> Destroying ${STACK}"
${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DEPLOYED=0

echo "==> Orphan verification"
assert_gone "endpoint prod of ${FN_NAME} still exists after destroy" \
  aws lambda-web get-web-function-endpoint --function-name "${FN_NAME}" --endpoint-name prod --region "${REGION}"
# A revision cannot outlive its function, so the function probe covers it.
assert_gone "web function ${FN_NAME} still exists after destroy" \
  aws lambda-web get-web-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The log groups Lambda creates for the function are not stack resources:
# removed here, so a passing run leaves none behind, then asserted gone.
for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${PREFIX}-" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text); do
  [ "${lg}" = "None" ] && continue
  aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null
done
left="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/web/${PREFIX}-" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
[ -z "${left}" ] || [ "${left}" = "None" ] || fail "log groups of ${PREFIX} still exist after destroy: ${left}"

echo "==> Code bucket teardown"
reap_code_bucket
assert_gone "code bucket ${CODE_BUCKET} still exists" aws s3api head-bucket --bucket "${CODE_BUCKET}"

trap - EXIT INT TERM
rm -f "${OUT_FILE}"
rm -rf "${WORK}"
echo "[verify] PASS — local start-web-function --from-state --assume-role ran as ${ROLE_NAME}"
