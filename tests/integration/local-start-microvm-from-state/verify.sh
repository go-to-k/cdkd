#!/usr/bin/env bash
# verify.sh — cdkd local start-microvm --from-state real-AWS integ test
# (go-to-k/cdkd#5330)
#
# Deploys a Lambda MicroVM image with cdkd whose EnvironmentVariables are
# intrinsics of other resources in the stack (`Ref` and `Fn::GetAtt ... Arn`
# of a bucket, `Ref` of an SSM parameter), then runs the image locally with
# `cdkd local start-microvm`. The app echoes its environment, so the arms see
# what reached the container.
#
# Flow:
#   1. Synth (to read the asset's `<hash>.zip` key), zip app/ and upload it
#      under that key to this run's prefix of the state bucket.
#   2. Deploy: cdkd's provider waits for the image build (CREATING ->
#      CREATED, several minutes). Assert CREATED on AWS.
#   3. Without a state flag: the three intrinsic variables are dropped with
#      cdkd's warning, and the app sees null.
#   4. With --from-state: each equals the deployed value read back through the
#      AWS CLI (the bucket answers head-bucket, its ARN is that bucket's, the
#      parameter answers get-parameter with its value); no drop warning.
#   5. SIGTERM after each run: exit 0, no `cdkd-local-microvm-<pid>-*`
#      container left.
#   6. cdkd destroy; the image, bucket, parameter, build role, the image's
#      build log group, the artifact and the state file are gone.
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-microvm-from-state/verify.sh
#
# Requires Docker. Uses host ports 18496-18497.

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
# The state bucket is versioned, so the code artifact's versions and delete
# markers are swept with the prefix-scoped helper (issue #2096).
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdLocalStartMicrovmFromState"
# The stack pins us-east-1, as lambda-microvm-image does.
REGION="${AWS_REGION:-us-east-1}"
if [ "${REGION}" != "us-east-1" ]; then
  echo "FAIL: this fixture deploys to us-east-1 only (AWS_REGION=${REGION})" >&2
  exit 1
fi
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CDKD="node ${LOCAL_DIST}"
RUN_TOKEN="r$$"
PREFIX="cdkd-integ-mvmfs-${RUN_TOKEN}"
IMAGE_NAME="${PREFIX}"
PARAM_NAME="/cdkd-integ/mvmfs/${RUN_TOKEN}"
PARAM_VALUE="value-${RUN_TOKEN}"
# Under the stack's state prefix (the stack builds the same path), so the
# prefix-scoped s3-versions helper can sweep every version of it.
ARTIFACT_PREFIX="cdkd/${STACK}/${REGION}/microvm-artifacts/${RUN_TOKEN}"
BUILD_LOG_GROUP="/aws/lambda/microvms/${IMAGE_NAME}"
BASE_IMAGE="public.ecr.aws/docker/library/node:24-slim"
PORT=18496
OUT_FILE="$(mktemp)"
WORK=""
CDKD_PID=""
# Every pid this script started a run under, so cleanup reaches each one's
# containers even after CDKD_PID has moved on.
RUN_PIDS=""
DEPLOYED=0
CLEANED_UP=0

# The image declares ARM_64. On an amd64 host, build and run natively instead
# of under emulation (the app is plain JavaScript on a multi-arch base).
case "$(uname -m)" in
  arm64 | aarch64) PLATFORM="linux/arm64" ;;
  *) PLATFORM="linux/amd64" ;;
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
BUCKET_NAME="${PREFIX}-${ACCOUNT}"
export CDKD_MVMFS_RUN="${RUN_TOKEN}" STATE_BUCKET

# Containers are named `cdkd-local-microvm-<cdkd pid>-<index>-<rand>`, so a
# filter on this run's pid never matches a peer session's MicroVMs.
containers_of() { # usage: containers_of <pid>
  docker ps -a --filter "name=cdkd-local-microvm-$1-" --format '{{.Names}}'
}

stop_server() {
  if [ -n "${CDKD_PID}" ] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 120); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

# Delete what this run's token named. The guard keeps an empty or foreign
# token from widening a prefix to the account.
reap_run() { (
  set +eu
  case "${RUN_TOKEN:-}" in
    r[0-9]?*) ;;
    *)
      echo "WARN: teardown sweep refused — '${RUN_TOKEN:-}' is not this fixture's run token" >&2
      exit 0
      ;;
  esac
  arn="$(aws lambda-microvms list-microvm-images --name-filter "${IMAGE_NAME}" \
    --region "${REGION}" --query "items[?name=='${IMAGE_NAME}'].imageArn | [0]" --output text 2>/dev/null)"
  if [ -n "${arn}" ] && [ "${arn}" != "None" ]; then
    aws lambda-microvms delete-microvm-image --image-identifier "${arn}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws s3api delete-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "${BUILD_LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1
  s3_purge_prefix_versions "${STATE_BUCKET}" "${ARTIFACT_PREFIX}/" all
) }

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: stopping the run, dropping leftover AWS resources"
  set +eu
  stop_server
  for pid in ${RUN_PIDS}; do
    for name in $(containers_of "${pid}" 2>/dev/null); do
      docker rm -f "${name}" >/dev/null 2>&1
    done
  done
  if [ "${DEPLOYED}" = "1" ]; then
    ${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1 \
      || echo "WARN: destroy in trap failed; sweeping the run's resources directly" >&2
  fi
  reap_run
  ${CDKD} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
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
  [ "${rc}" -eq 0 ] || fail "start-microvm exited ${rc} on SIGTERM (want 0)"
  left="$(containers_of "${pid}")" || fail "docker ps failed while checking for leftover containers"
  [ -z "${left}" ] || fail "leftover MicroVM container(s) after SIGTERM: ${left}"
}

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "==> Docker available + base image present (${PLATFORM})"
docker version --format '{{.Server.Version}}' >/dev/null
docker pull --platform "${PLATFORM}" "${BASE_IMAGE}" >/dev/null

WORK="$(mktemp -d)"

echo "==> Synth: read the asset key CodeArtifact.Uri ends with"
${CDKD} synth "${STACK}" --region "${REGION}" >/dev/null
CODE_KEY="$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = t.Outputs && t.Outputs.CodeKey && t.Outputs.CodeKey.Value;
  if (typeof v !== "string" || !/^[0-9a-f]{64}\.zip$/.test(v)) process.exit(1);
  console.log(v);
' "cdk.out/${STACK}.template.json")" || { echo "FAIL: no literal <hash>.zip CodeKey output in the synthesized template" >&2; exit 1; }
ARTIFACT_URI="s3://${STATE_BUCKET}/${ARTIFACT_PREFIX}/${CODE_KEY}"
echo "    artifact: ${ARTIFACT_URI}"

echo "==> Uploading app/ (Dockerfile + app.js) as the code artifact"
(cd app && zip -q -X "${WORK}/artifact.zip" Dockerfile app.js)
aws s3 cp "${WORK}/artifact.zip" "${ARTIFACT_URI}" --region "${REGION}" >/dev/null
export MICROVM_ARTIFACT_URI="${ARTIFACT_URI}"

echo "==> Deploying ${STACK} (the MicroVM image build can take several minutes)"
DEPLOYED=1
${CDKD} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

IMAGE_ARN="$(aws lambda-microvms list-microvm-images --name-filter "${IMAGE_NAME}" \
  --region "${REGION}" --query "items[?name=='${IMAGE_NAME}'].imageArn | [0]" --output text)"
case "${IMAGE_ARN}" in
  arn:aws:lambda:*:microvm-image:*) ;;
  *) echo "FAIL: no MicroVM image named ${IMAGE_NAME} after deploy: '${IMAGE_ARN}'" >&2; exit 1 ;;
esac
IMAGE_STATE="$(aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" \
  --region "${REGION}" --query 'state' --output text)"
[ "${IMAGE_STATE}" = "CREATED" ] || { echo "FAIL: expected image state CREATED, got '${IMAGE_STATE}'" >&2; exit 1; }
echo "    ${IMAGE_ARN} is CREATED"
BUILD_ROLE_NAME="$(${CDKD} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const r of JSON.parse(d)){if(r.resourceType==="AWS::IAM::Role"&&r.logicalId.startsWith("BuildRole")){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')" \
  || { echo "FAIL: could not read the BuildRole from cdkd state" >&2; exit 1; }

# The deployed values, read back through the AWS CLI.
aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null \
  || { echo "FAIL: deployed bucket ${BUCKET_NAME} does not answer head-bucket" >&2; exit 1; }
DEPLOYED_PARAM_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
[ "${DEPLOYED_PARAM_VALUE}" = "${PARAM_VALUE}" ] \
  || { echo "FAIL: parameter ${PARAM_NAME} reads '${DEPLOYED_PARAM_VALUE}', want '${PARAM_VALUE}'" >&2; exit 1; }
BUCKET_ARN="arn:aws:s3:::${BUCKET_NAME}"

echo "==> Arm 1: without a state flag the intrinsic variables are dropped"
boot_run "${STACK}/Image" --port "${PORT}"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/")"
echo "    ${BODY}"
echo "${BODY}" | grep -q '"env":{"BUCKET_NAME":null,"BUCKET_ARN":null,"PARAM_NAME":null}' \
  || fail "an intrinsic variable reached the container without a state flag: ${BODY}"
for key in BUCKET_NAME BUCKET_ARN PARAM_NAME; do
  if ! grep -q "Environment variable ${key} contains a CloudFormation intrinsic and was dropped" "${OUT_FILE}"; then
    # Sentinel: a line naming the key next to the warning's independent
    # remedy marker (`--env-vars`) means the warning fired but its wording
    # drifted from the phrase parsed above.
    if grep -E "\\b${key}\\b" "${OUT_FILE}" | grep -q -- '--env-vars'; then
      fail "the drop warning for ${key} changed wording; update this fixture's grep"
    fi
    fail "no drop warning for ${key} without a state flag"
  fi
done
terminate_run

echo "==> Arm 2: --from-state fills each from the deployed stack"
boot_run "${STACK}/Image" --from-state --state-bucket "${STATE_BUCKET}" --region "${REGION}" --port "$((PORT + 1))"
BODY="$(curl -s --max-time 10 "http://127.0.0.1:$((PORT + 1))/")"
echo "    ${BODY}"
echo "${BODY}" | grep -q "\"BUCKET_NAME\":\"${BUCKET_NAME}\"" \
  || fail "BUCKET_NAME (Ref) is not the deployed bucket ${BUCKET_NAME}: ${BODY}"
echo "${BODY}" | grep -q "\"BUCKET_ARN\":\"${BUCKET_ARN}\"" \
  || fail "BUCKET_ARN (Fn::GetAtt Arn) is not ${BUCKET_ARN}: ${BODY}"
echo "${BODY}" | grep -q "\"PARAM_NAME\":\"${PARAM_NAME}\"" \
  || fail "PARAM_NAME (Ref) is not the deployed parameter ${PARAM_NAME}: ${BODY}"
if grep -qE 'contains a CloudFormation intrinsic and was dropped|could not substitute env var' "${OUT_FILE}"; then
  fail "cdkd warned that a variable was not substituted under --from-state"
fi
terminate_run

echo "==> Destroying ${STACK}"
${CDKD} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
DEPLOYED=0

echo "==> Orphan verification"
assert_gone "MicroVM image ${IMAGE_ARN} still exists after destroy" \
  aws lambda-microvms get-microvm-image --image-identifier "${IMAGE_ARN}" --region "${REGION}"
assert_gone "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "build role ${BUILD_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${BUILD_ROLE_NAME}"
# The image build's log group is not a stack resource: removed here, so a
# passing run leaves none behind, then asserted gone.
if ! gone_probe aws logs describe-log-streams --log-group-name "${BUILD_LOG_GROUP}" --region "${REGION}" --max-items 1; then
  aws logs delete-log-group --log-group-name "${BUILD_LOG_GROUP}" --region "${REGION}" >/dev/null
fi
assert_gone "build log group ${BUILD_LOG_GROUP} still exists" \
  aws logs describe-log-streams --log-group-name "${BUILD_LOG_GROUP}" --region "${REGION}" --max-items 1
trap - EXIT INT TERM
# Every version and delete marker of the code artifact, then assert none is
# left: `aws s3 rm` alone would only write a delete marker.
s3_purge_prefix_versions "${STATE_BUCKET}" "${ARTIFACT_PREFIX}/" all \
  || { echo "FAIL: could not purge the code artifact versions under ${ARTIFACT_PREFIX}/" >&2; exit 1; }
s3_assert_versions_swept "${STATE_BUCKET}" "${ARTIFACT_PREFIX}/" "code artifact teardown"
rm -f "${OUT_FILE}"
rm -rf "${WORK}"
echo "[verify] PASS — local start-microvm --from-state resolved the image's Ref / Fn::GetAtt env vars"
