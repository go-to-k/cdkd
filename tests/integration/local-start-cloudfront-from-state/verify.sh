#!/usr/bin/env bash
# verify.sh — cdkd local start-cloudfront --from-state real-AWS integ test
# (go-to-k/cdkd#2600).
#
# Deploys an S3 bucket + a CloudFront distribution whose only origin is that
# bucket, with NO BucketDeployment, so the cloud assembly holds nothing to
# serve locally. One object is uploaded out of band. Then:
#
#   - NEGATIVE CONTROL: `cdkd local start-cloudfront` with no state source
#     must answer 502 for the object (the origin stays unresolved). This is
#     also what every cdkd before cdk-local 0.151.0 did under --from-state,
#     when the flag was not refused outright.
#   - THE ARM: with `--from-state`, the engine reads the bucket's physical
#     name from cdkd's S3 state and serves the object from real S3. The body
#     must be byte-identical to the uploaded file.
#
# No Docker: a distribution with only an S3 origin runs no Lambda container.
#
# Run via `/run-integ local-start-cloudfront-from-state` (recommended) or
# directly:
#
#     AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> \
#       bash tests/integration/local-start-cloudfront-from-state/verify.sh

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
STACK_NAME="CdkdLocalStartCloudFrontFromStateFixture"
TARGET="${STACK_NAME}/Distribution"
REGION="${AWS_REGION:-us-east-1}"
STATE_BUCKET="${STATE_BUCKET:?STATE_BUCKET env var required}"
OBJECT_KEY="from-state-probe.bin"

DEPLOYED=0
ORIGIN_BUCKET=""
CDKD_PID=""
WORK_DIR="$(mktemp -d)"

stop_server() {
  if [[ -n "${CDKD_PID}" ]] && kill -0 "${CDKD_PID}" 2>/dev/null; then
    kill -TERM "${CDKD_PID}" 2>/dev/null || true
    for _ in $(seq 1 60); do
      if ! kill -0 "${CDKD_PID}" 2>/dev/null; then break; fi
      sleep 0.5
    done
    kill -KILL "${CDKD_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CDKD_PID}" ]]; then
    wait "${CDKD_PID}" 2>/dev/null || true
  fi
  CDKD_PID=""
}

empty_origin_bucket() {
  # The object was uploaded out of band, so the bucket is not empty and its
  # DESTROY removal would be refused. Empty it first; a failure here is
  # reported, never swallowed, so the orchestrator's orphan sweep runs.
  if [[ -n "${ORIGIN_BUCKET}" ]]; then
    aws s3 rm "s3://${ORIGIN_BUCKET}" --recursive --region "${REGION}" >/dev/null
  fi
}

cleanup() {
  stop_server
  if [[ "${DEPLOYED}" -eq 1 ]]; then
    echo "==> Cleanup: empty the origin bucket, then cdkd destroy (best-effort)"
    empty_origin_bucket || echo "WARN: emptying s3://${ORIGIN_BUCKET} failed"
    ${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force \
      || echo "WARN: destroy in trap failed; the orchestrator's orphan sweep will pick it up"
    DEPLOYED=0
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# boot <log-file> [extra flags...] — start the server in the background and
# set URL once the banner appears. Called directly, never in `$(...)`, so
# CDKD_PID stays in this shell for stop_server and the trap.
URL=""
boot() {
  local log="$1"
  shift
  ${CDKD} local start-cloudfront "${TARGET}" --port 0 "$@" >"${log}" 2>&1 &
  CDKD_PID=$!
  for _ in $(seq 1 120); do
    local url
    url=$(grep -oE 'serving on https?://[^[:space:]]+' "${log}" 2>/dev/null | head -1 | sed 's/^serving on //' || true)
    if [[ -n "${url}" ]]; then
      URL="${url}"
      return 0
    fi
    if ! kill -0 "${CDKD_PID}" 2>/dev/null; then
      echo "FAIL: cdkd local start-cloudfront exited before its banner. Output:"
      cat "${log}"
      exit 1
    fi
    sleep 1
  done
  echo "FAIL: no serving banner within 120s. Output:"
  cat "${log}"
  exit 1
}

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth --region "${REGION}" >/dev/null

echo "==> Deploying fixture to ${REGION} (real AWS: S3 bucket + CloudFront distribution)"
${CDKD} deploy "${STACK_NAME}" \
  --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose
DEPLOYED=1

ORIGIN_BUCKET="$(${CDKD} state resources "${STACK_NAME}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::S3::Bucket"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')" || true
[[ -n "${ORIGIN_BUCKET}" ]] || { echo "FAIL: could not read the deployed origin bucket from cdkd state"; exit 1; }
echo "    deployed origin bucket: ${ORIGIN_BUCKET}"

echo "==> Uploading the probe object out of band (random bytes, so only the real object matches)"
head -c 4096 /dev/urandom >"${WORK_DIR}/expected.bin"
aws s3 cp "${WORK_DIR}/expected.bin" "s3://${ORIGIN_BUCKET}/${OBJECT_KEY}" --region "${REGION}" >/dev/null

echo "==> [1/2] Negative control: no state source -> the unresolved origin answers 502"
boot "${WORK_DIR}/no-state.log"
CODE="$(curl --silent --show-error --max-time 10 -o "${WORK_DIR}/no-state.body" -w '%{http_code}' "${URL}/${OBJECT_KEY}")" || true
stop_server
# A transport failure leaves curl's `-w` at 000, so the branch below prints the log.
if [[ "${CODE}" != "502" ]]; then
  echo "FAIL: without a state source expected 502 for the unresolved S3 origin, got ${CODE}. Output:"
  cat "${WORK_DIR}/no-state.log"
  exit 1
fi
echo "    OK: 502 without a state source"

echo "==> [2/2] --from-state: the origin is served from the deployed bucket"
boot "${WORK_DIR}/from-state.log" --from-state --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
CODE="$(curl --silent --show-error --max-time 30 -o "${WORK_DIR}/got.bin" -w '%{http_code}' "${URL}/${OBJECT_KEY}")" || true
stop_server
if [[ "${CODE}" != "200" ]]; then
  echo "FAIL: --from-state expected 200 for ${OBJECT_KEY}, got ${CODE}. Output:"
  cat "${WORK_DIR}/from-state.log"
  exit 1
fi
if ! cmp -s "${WORK_DIR}/expected.bin" "${WORK_DIR}/got.bin"; then
  echo "FAIL: --from-state served ${OBJECT_KEY}, but its bytes differ from the uploaded object"
  exit 1
fi
if ! grep -qF "bucket=${ORIGIN_BUCKET}" "${WORK_DIR}/from-state.log" \
  || ! grep -qF 'on demand under --from-state.' "${WORK_DIR}/from-state.log"; then
  echo "FAIL: the boot log does not say the origin was promoted from cdkd state (bucket=${ORIGIN_BUCKET}, under --from-state). Output:"
  cat "${WORK_DIR}/from-state.log"
  exit 1
fi
echo "    OK: 200, byte-identical to the uploaded object, promoted under --from-state"

echo "==> Emptying the origin bucket, then cdkd destroy"
empty_origin_bucket
${CDKD} destroy "${STACK_NAME}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --force
DEPLOYED=0

echo "==> Verifying state is empty post-destroy"
# Match ONLY `state.json`: the deployment-events store survives destroy by
# design. `aws s3 ls` exits 1 both on no match (empty output) and on an
# error (non-empty output); only the first means "no keys".
STATE_LISTING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK_NAME}/" --recursive --region "${REGION}" 2>&1)" || {
  if [ -n "${STATE_LISTING}" ]; then
    echo "FAIL: could not list s3://${STATE_BUCKET}/cdkd/${STACK_NAME}/ to verify state deletion: ${STATE_LISTING}"
    exit 1
  fi
}
if [[ "$(printf '%s' "${STATE_LISTING}" | grep -c 'state\.json' || true)" -ne 0 ]]; then
  echo "FAIL: cdkd state.json for ${STACK_NAME} still present after destroy"
  exit 1
fi

echo ""
echo "==> local-start-cloudfront-from-state test passed"
echo "    - no state source: the BucketDeployment-less S3 origin answered 502"
echo "    - --from-state: served the deployed bucket's object byte-for-byte"
echo "    - cdkd destroy left no state behind"
