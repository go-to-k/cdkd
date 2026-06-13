#!/usr/bin/env bash
# verify.sh - cdkd multi-asset integ.
#
# Stresses cdkd's asset-publishing layer when MANY assets of TWO kinds publish
# concurrently in ONE deploy. Where `docker-image-asset` exercises the ECR
# build+push path alone and `s3-asset-deploy` exercises the S3 zip path alone,
# this fixture forces both publishers + ECR + S3 to run together:
#
#   - 1 Docker image asset  -> DockerAssetPublisher (`docker build` -> ECR auth
#     -> `docker push`), backing a Lambda(PackageType=Image).
#   - 3 distinct multi-file directory assets (alpha/beta/gamma) -> three
#     DISTINCT FileAssetPublisher S3 uploads, one per zip Lambda.
#   - 1 generic s3_assets.Asset -> a 4th FileAssetPublisher S3 upload, read back
#     at runtime by the ALPHA Lambda via cdkd-resolved CONFIG_BUCKET/CONFIG_KEY.
#
# So one deploy publishes 1 ECR image + 4 S3 objects (FileAssetPublisher +
# DockerAssetPublisher concurrency, ECR + S3 in one run, asset-ref intrinsics).
#
# The load-bearing proof of CORRECT WIRING is that EACH Lambda returns its OWN
# distinct marker (docker / alpha / beta / gamma): a cross-wired asset (e.g. the
# beta ZIP uploaded but the alpha Lambda's Code S3 ref pointed at it) would
# return the WRONG marker and FAIL the test. So this asserts not just that all
# assets uploaded, but that each Lambda is wired to the RIGHT one.
#
# Asserts:
#   1. deploy: the Docker Lambda is PackageType=Image with OUR pushed image
#      present in ECR (by content-addressed asset-hash TAG parsed from
#      Code.ImageUri); each zip Lambda has CodeSize above the inline threshold
#      (proves it ran from an uploaded ZIP, not inline).
#   2. invoke EACH of the 4 Lambdas + assert its DISTINCT marker; the alpha
#      Lambda additionally returns configBytes>0 from the generic-asset S3
#      read-back (proving that 4th upload reached AWS + the bucket/key env
#      wiring resolved through cdkd's intrinsic resolver).
#   3. destroy: clean (0 errors) — all 4 Lambdas gone, OUR pushed ECR image
#      (by tag) gone, state file gone. The SHARED bootstrap container-assets ECR
#      repo + the bootstrap asset S3 bucket OBJECTS persist by design (cdkd does
#      not own them) and are NOT treated as orphans.
#
# BSD/macOS-portable (no `grep -P`, no `date -d`). Captures the real rc and
# prints an explicit `[verify] PASS` only on success.
#
# REQUIRES Docker running (for the image asset build+push). If `docker info`
# fails, the test SKIPs gracefully (prints SKIP + exits 0) so it is robust on a
# Docker-less box but runs in a Docker env.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdMultiAssetExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# Resolved after deploy (used by cleanup's direct ECR sweep on the failure
# path). The CDK-managed container-assets repo + the image tag (asset hash).
ECR_REPO=""
IMAGE_TAG=""

cleanup() {
  rc=$?
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # ALWAYS remove the deployment-events sidecar (cdkd writes it on every run;
    # it deliberately survives destroy) so the integ leaves nothing.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Direct ECR sweep in case destroy itself is what broke: delete only the
  # image WE pushed (by tag) from the shared CDK asset repo, so we never touch
  # other deployments' images. ECR repos with images linger + cost.
  if [ -n "${ECR_REPO}" ] && [ -n "${IMAGE_TAG}" ]; then
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  set -eu
  exit "${rc}"
}
trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Docker-availability guard (graceful SKIP) ------------------------------
# This integ needs a running Docker daemon to build + push the image asset. On
# a Docker-less box, SKIP cleanly (the zip/generic asset paths are also covered
# by s3-asset-deploy, so a SKIP here loses no UNIQUE coverage on such a box).
echo "==> Checking Docker is available"
if ! docker info >/dev/null 2>&1; then
  echo "[verify] SKIP: Docker daemon not available (docker info failed); the multi-asset integ requires a running Docker daemon to build + push the Docker image asset."
  trap - EXIT
  exit 0
fi
echo "    OK: Docker daemon is reachable"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
# Pre-run cleanup must not exit the script (it runs before deploy). Inline a
# minimal state drop here; the EXIT trap handles the full teardown.
node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes >/dev/null 2>&1 || true

# --- Phase 1: deploy (publishes 1 ECR image + 4 S3 assets concurrently) -----
echo "==> Phase 1: deploy with the local binary (publishes 1 Docker/ECR + 4 S3 assets)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --yes; then
  echo "FAIL: deploy failed. The asset-publishing layer (1 Docker image + 3 zip Lambda assets + 1 generic asset) could not publish all assets and/or wire the resources. Inspect the deploy log above for the failing asset/resource + error." >&2
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve each Lambda's physical name from state (CDK auto-names them) ----
# Each logical id starts with its construct id (DockerHandler / AlphaHandler /
# BetaHandler / GammaHandler), so we match by that prefix.
resolve_fn() {
  local prefix="$1"
  echo "${STATE}" | jq -r --arg p "${prefix}" \
    '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith($p)) | .value.physicalId] | first'
}

DOCKER_FN=$(resolve_fn "DockerHandler")
ALPHA_FN=$(resolve_fn "AlphaHandler")
BETA_FN=$(resolve_fn "BetaHandler")
GAMMA_FN=$(resolve_fn "GammaHandler")

for pair in "DockerHandler:${DOCKER_FN}" "AlphaHandler:${ALPHA_FN}" "BetaHandler:${BETA_FN}" "GammaHandler:${GAMMA_FN}"; do
  name="${pair#*:}"
  label="${pair%%:*}"
  if [ -z "${name}" ] || [ "${name}" = "null" ]; then
    echo "FAIL: could not resolve ${label} Lambda function name from state" >&2
    echo "${STATE}" | jq .
    exit 1
  fi
done
echo "    resolved: docker=${DOCKER_FN} alpha=${ALPHA_FN} beta=${BETA_FN} gamma=${GAMMA_FN}"

# --- Assertion: the Docker Lambda is PackageType=Image + ECR image present ---
echo "==> Phase 1a: assert the Docker Lambda is PackageType=Image with OUR pushed image in ECR"
PKG_TYPE=$(aws lambda get-function-configuration --function-name "${DOCKER_FN}" --region "${REGION}" \
  --query 'PackageType' --output text 2>/dev/null)
if [ "${PKG_TYPE}" != "Image" ]; then
  echo "FAIL: Docker Lambda PackageType is '${PKG_TYPE}', expected 'Image'" >&2
  exit 1
fi
echo "    OK: Docker Lambda PackageType == 'Image'"

IMAGE_URI=$(aws lambda get-function --function-name "${DOCKER_FN}" --region "${REGION}" \
  --query 'Code.ImageUri' --output text 2>/dev/null)
if [ -z "${IMAGE_URI}" ] || [ "${IMAGE_URI}" = "None" ]; then
  echo "FAIL: Docker Lambda Code.ImageUri is empty (expected an ECR image URI)" >&2
  exit 1
fi
echo "    OK: Docker Lambda Code.ImageUri == ${IMAGE_URI}"

# ImageUri form: {account}.dkr.ecr.{region}.amazonaws.com/{repo}:{tag}. cdkd
# pushes by TAG (the content-addressed asset hash) and Lambda stores that exact
# URI, so the tag identifies OUR image. Handle the digest (`@sha256:...`) form
# defensively, but the tag form is what we observe.
ECR_REPO=$(echo "${IMAGE_URI}" | sed -E 's#^[^/]+/##; s#[@:].*$##')
if echo "${IMAGE_URI}" | grep -q '@'; then
  IMAGE_TAG=""
else
  IMAGE_TAG="${IMAGE_URI##*:}"
fi
if [ -z "${ECR_REPO}" ] || [ -z "${IMAGE_TAG}" ]; then
  echo "FAIL: could not parse ECR repo/tag from ImageUri '${IMAGE_URI}' (expected the {repo}:{assetHash} form)" >&2
  exit 1
fi
echo "    parsed ECR repo: ${ECR_REPO}  tag: ${IMAGE_TAG}"

if ! aws ecr describe-images --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: the pushed image (tag ${IMAGE_TAG}) is not present in ECR repo '${ECR_REPO}' (DockerAssetPublisher should have built + pushed it)" >&2
  exit 1
fi
echo "    OK: OUR pushed image (tag ${IMAGE_TAG}) is present in ECR (Docker asset built + pushed)"

# --- Assertion: each zip Lambda ran from an uploaded ZIP (CodeSize, not inline)
echo "==> Phase 1b: assert each zip Lambda's code came from an uploaded ZIP (not inline)"
assert_codesize() {
  local label="$1" name="$2"
  local size
  size=$(aws lambda get-function-configuration --function-name "${name}" --region "${REGION}" \
    --query 'CodeSize' --output text 2>/dev/null)
  if [ -z "${size}" ] || [ "${size}" = "None" ]; then
    echo "FAIL: could not read CodeSize for ${label} (${name})" >&2
    exit 1
  fi
  # 500 bytes is well above any inline one-liner but below our multi-file ZIP.
  if [ "${size}" -le 500 ]; then
    echo "FAIL: ${label} CodeSize is ${size} bytes (<=500) - expected an uploaded multi-file asset ZIP, not inline code" >&2
    exit 1
  fi
  echo "    OK: ${label} CodeSize == ${size} bytes (uploaded asset ZIP, not inline)"
}
assert_codesize "alpha" "${ALPHA_FN}"
assert_codesize "beta" "${BETA_FN}"
assert_codesize "gamma" "${GAMMA_FN}"

# --- Assertion: invoke EACH Lambda + assert its DISTINCT marker --------------
# This is the cross-wiring proof: each Lambda must return ITS OWN marker. If
# cdkd wired any Lambda's Code ref to the WRONG asset, the marker would differ.
echo "==> Phase 1c: invoke each Lambda + assert its DISTINCT marker (proves correct asset->Lambda wiring)"
INVOKE_OUT="$(mktemp)"
trap 'rm -f "${INVOKE_OUT}"; cleanup' EXIT

invoke_marker() {
  # $1=function name, returns the .marker field on stdout (empty on failure).
  aws lambda invoke --function-name "$1" --region "${REGION}" \
    --cli-binary-format raw-in-base64-out \
    --payload '{"ping":"multi-asset"}' "${INVOKE_OUT}" >/dev/null 2>&1 || return 1
  jq -r '.marker // empty' "${INVOKE_OUT}"
}

assert_marker() {
  local label="$1" name="$2" expected="$3"
  local got
  got=$(invoke_marker "${name}") || {
    echo "FAIL: invoking the ${label} Lambda (${name}) failed" >&2
    cat "${INVOKE_OUT}" >&2 || true
    exit 1
  }
  if [ "${got}" != "${expected}" ]; then
    echo "FAIL: ${label} Lambda returned marker '${got}', expected '${expected}'. A wrong marker means the WRONG asset was wired to this Lambda (cross-wiring), or the asset did not upload correctly." >&2
    cat "${INVOKE_OUT}" >&2 || true
    exit 1
  fi
  echo "    OK: ${label} Lambda returned its distinct marker '${expected}' (correct asset wired)"
}

assert_marker "docker" "${DOCKER_FN}" "cdkd-multi-asset-marker-docker"
assert_marker "alpha" "${ALPHA_FN}" "cdkd-multi-asset-marker-alpha"
assert_marker "beta" "${BETA_FN}" "cdkd-multi-asset-marker-beta"
assert_marker "gamma" "${GAMMA_FN}" "cdkd-multi-asset-marker-gamma"

# --- Assertion: the generic s3_assets.Asset was read back by the alpha Lambda
echo "==> Phase 1d: assert the generic s3_assets.Asset read-back (4th S3 upload + intrinsic wiring)"
aws lambda invoke --function-name "${ALPHA_FN}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"ping":"multi-asset"}' "${INVOKE_OUT}" >/dev/null
ALPHA_BODY=$(cat "${INVOKE_OUT}")
CONFIG_ERROR=$(echo "${ALPHA_BODY}" | jq -r '.configError // empty')
if [ -n "${CONFIG_ERROR}" ] && [ "${CONFIG_ERROR}" != "null" ]; then
  echo "FAIL: alpha Lambda could not read the generic s3_assets.Asset: ${CONFIG_ERROR}" >&2
  exit 1
fi
CONFIG_BYTES=$(echo "${ALPHA_BODY}" | jq -r '.configBytes // 0')
if [ -z "${CONFIG_BYTES}" ] || [ "${CONFIG_BYTES}" -le 0 ]; then
  echo "FAIL: generic asset download returned configBytes=${CONFIG_BYTES} (expected > 0) - the 4th S3 upload may not have reached AWS or the CONFIG_BUCKET/CONFIG_KEY intrinsic did not resolve" >&2
  echo "${ALPHA_BODY}" | jq . >&2
  exit 1
fi
echo "    OK: generic s3_assets.Asset downloaded at runtime (configBytes=${CONFIG_BYTES}) - 4th upload reached AWS + bucket/key env wired"

rm -f "${INVOKE_OUT}"
trap cleanup EXIT

# --- Phase 2: destroy (clean) -----------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

for pair in "docker:${DOCKER_FN}" "alpha:${ALPHA_FN}" "beta:${BETA_FN}" "gamma:${GAMMA_FN}"; do
  label="${pair%%:*}"
  name="${pair#*:}"
  if aws lambda get-function --function-name "${name}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: ${label} Lambda function ${name} still exists after destroy" >&2
    exit 1
  fi
  echo "    OK: ${label} Lambda function is gone"
done

# The Docker image asset is pushed into the SHARED CDK-managed container-assets
# repo. cdkd does not own/delete that bootstrap-managed repo (other stacks may
# share it) — so we deliberately do NOT fail on the shared repo persisting. The
# assertion is that OUR pushed image (by tag) is gone. CDK asset images are not
# auto-pruned on stack delete; if cdkd left it behind we sweep just our tag.
if [ -n "${IMAGE_TAG}" ]; then
  if aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
    echo "==> destroy left the pushed image behind; sweeping it (shared-repo asset images are not auto-pruned)"
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: pushed ECR image (tag ${IMAGE_TAG}) still present after destroy + sweep" >&2
    exit 1
  fi
  echo "    OK: pushed ECR image (tag ${IMAGE_TAG}) is gone (0 ECR orphans)"
  # Clear so the EXIT-trap sweep does not run again.
  IMAGE_TAG=""
fi

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# NOTE: the bootstrap asset bucket OBJECTS (the uploaded ZIPs) + the shared
# container-assets ECR repo persist by design (CDK bootstrap infra cdkd does
# not own). We deliberately do NOT assert their absence.
echo "    NOTE: bootstrap-bucket asset objects + shared container-assets ECR repo persist by design (cdkd does not delete CDK bootstrap infra)"

echo ""
echo "==> multi-asset test passed (1 Docker/ECR image + 3 distinct S3 zip assets + 1 generic S3 asset published in one deploy; each Lambda wired to its correct asset by distinct marker; clean destroy)"
echo "[verify] PASS"
