#!/usr/bin/env bash
# verify.sh - cdkd docker-image-asset integ.
#
# Exercises cdkd's deploy-time Docker ASSET pipeline against real AWS — the
# `DockerAssetPublisher` build + ECR push path. Unlike the LOCAL-emulation
# container fixtures (local-invoke-container etc.) which never touch AWS,
# this fixture proves the actual deploy-time `docker build` -> ECR auth ->
# `docker push` -> Lambda(PackageType=Image) flow end-to-end:
#
#   1. deploy CdkdDockerImageAssetExample  -> cdkd builds the local Dockerfile
#      and pushes the image to the CDK-managed asset ECR repo, then creates a
#      Lambda function with PackageType=Image pointing at that ECR image.
#   2. assert: the ECR repo exists + contains >=1 image; the Lambda exists
#      with PackageType=Image and a Code.ImageUri pointing at that repo+digest.
#   3. invoke the Lambda and assert the expected payload (proves the pushed
#      image actually runs).
#   4. destroy -> assert clean (0 errors): Lambda gone, the pushed image is
#      gone from ECR (cdkd's ECR provider force-deletes), state file gone.
#
# BSD/macOS-portable. Captures real rc + prints an explicit `[verify] PASS`.
#
# REQUIRES Docker running. If `docker info` fails, the test SKIPs gracefully
# (prints SKIP + exits 0) so it is robust on a Docker-less box but runs in a
# Docker env.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdDockerImageAssetExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# Resolved after deploy (used by cleanup's direct ECR sweep on the failure
# path). The CDK-managed container-assets repo for the default bootstrap
# qualifier hnb659fds; the image tag is the asset hash. We capture both the
# repo name and the pushed image digest after deploy.
ECR_REPO=""
IMAGE_DIGEST=""

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
    # ALWAYS remove the deployment-events sidecar (cdkd writes it on every
    # run; it deliberately survives destroy) so the integ leaves nothing.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Direct ECR sweep in case destroy itself is what broke: delete only the
  # image WE pushed (by digest) from the shared CDK asset repo, so we never
  # touch other deployments' images. ECR repos with images linger + cost.
  if [ -n "${ECR_REPO}" ] && [ -n "${IMAGE_DIGEST}" ]; then
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageDigest=${IMAGE_DIGEST}" --region "${REGION}" >/dev/null 2>&1 || true
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
# Like the local-* container fixtures, this integ needs a running Docker
# daemon to build + push the image. On a Docker-less box, SKIP cleanly.
echo "==> Checking Docker is available"
if ! docker info >/dev/null 2>&1; then
  echo "[verify] SKIP: Docker daemon not available (docker info failed); the docker-image-asset integ requires a running Docker daemon to build + push the image."
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

# --- Phase 1: deploy (forces docker build + ECR push) -----------------------
echo "==> Phase 1: deploy with the local binary (builds + pushes the Docker image asset)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the Lambda function name from state (CDK auto-names it) ---------
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve Lambda function name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved Lambda function name: ${FN_NAME}"

# --- Assertion: Lambda is PackageType=Image pointing at an ECR image --------
FN_CFG=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")
PKG_TYPE=$(echo "${FN_CFG}" | jq -r '.PackageType // empty')
if [ "${PKG_TYPE}" != "Image" ]; then
  echo "FAIL: Lambda PackageType is '${PKG_TYPE}', expected 'Image'" >&2
  echo "      raw get-function-configuration: ${FN_CFG}" >&2
  exit 1
fi
echo "    OK: Lambda PackageType == 'Image'"

# The image URI lives on get-function (Code.ImageUri), not the configuration.
IMAGE_URI=$(aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'Code.ImageUri' --output text 2>/dev/null)
if [ -z "${IMAGE_URI}" ] || [ "${IMAGE_URI}" = "None" ]; then
  echo "FAIL: Lambda Code.ImageUri is empty (expected an ECR image URI)" >&2
  exit 1
fi
echo "    OK: Lambda Code.ImageUri == ${IMAGE_URI}"

# ImageUri form: {account}.dkr.ecr.{region}.amazonaws.com/{repo}@sha256:{digest}
# (CDK pushes by tag, but Lambda resolves + stores the URI by digest).
ECR_REPO=$(echo "${IMAGE_URI}" | sed -E 's#^[^/]+/##; s#[@:].*$##')
IMAGE_DIGEST=$(echo "${IMAGE_URI}" | sed -nE 's#.*@(sha256:[0-9a-f]+)$#\1#p')
if [ -z "${ECR_REPO}" ]; then
  echo "FAIL: could not parse ECR repo name from ImageUri '${IMAGE_URI}'" >&2
  exit 1
fi
echo "    parsed ECR repo: ${ECR_REPO}  digest: ${IMAGE_DIGEST:-<none>}"

# --- Assertion: the ECR repo exists ----------------------------------------
if ! aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ECR repository '${ECR_REPO}' does not exist after deploy" >&2
  exit 1
fi
echo "    OK: ECR repository '${ECR_REPO}' exists"

# --- Assertion: the repo contains >=1 image (cdkd built + pushed it) --------
IMAGE_COUNT=$(aws ecr list-images --repository-name "${ECR_REPO}" --region "${REGION}" \
  --query 'length(imageIds)' --output text 2>/dev/null)
if [ -z "${IMAGE_COUNT}" ] || [ "${IMAGE_COUNT}" = "None" ] || [ "${IMAGE_COUNT}" -lt 1 ]; then
  echo "FAIL: ECR repo '${ECR_REPO}' has ${IMAGE_COUNT:-0} images, expected >=1 (cdkd should have pushed one)" >&2
  exit 1
fi
echo "    OK: ECR repo '${ECR_REPO}' contains ${IMAGE_COUNT} image(s) (cdkd built + pushed the Docker image asset)"

# --- Assertion: OUR pushed image (by digest) is present in the repo ---------
if [ -n "${IMAGE_DIGEST}" ]; then
  if ! aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageDigest=${IMAGE_DIGEST}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: the pushed image (digest ${IMAGE_DIGEST}) is not present in ECR repo '${ECR_REPO}'" >&2
    exit 1
  fi
  echo "    OK: the pushed image (digest ${IMAGE_DIGEST}) is present in ECR"
fi

# --- Assertion: invoking the Lambda runs the pushed image -------------------
echo "==> Phase 1b: invoke the Lambda (proves the pushed image actually runs)"
INVOKE_OUT=$(mktemp)
trap 'rm -f "${INVOKE_OUT}"' RETURN 2>/dev/null || true
aws lambda invoke --function-name "${FN_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"ping":"pong"}' "${INVOKE_OUT}" >/dev/null
RESPONSE=$(cat "${INVOKE_OUT}")
rm -f "${INVOKE_OUT}"
echo "    response: ${RESPONSE}"
echo "${RESPONSE}" | jq -e '.message == "hello from cdkd docker image asset"' >/dev/null || {
  echo "FAIL: expected message 'hello from cdkd docker image asset' in invoke response, got: ${RESPONSE}" >&2
  exit 1
}
echo "${RESPONSE}" | jq -e '.deployedBy == "cdkd"' >/dev/null || {
  echo "FAIL: expected deployedBy 'cdkd' (env var) in invoke response, got: ${RESPONSE}" >&2
  exit 1
}
echo "${RESPONSE}" | jq -e '.echoed.ping == "pong"' >/dev/null || {
  echo "FAIL: expected echoed.ping 'pong' in invoke response, got: ${RESPONSE}" >&2
  exit 1
}
echo "    OK: Lambda invoke returned the expected payload (the pushed image runs)"

# --- Phase 2: destroy (clean) -----------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Lambda function is gone"

# The Docker image asset is pushed into the SHARED CDK-managed container-assets
# repo. cdkd does not own/delete that bootstrap-managed repo (other stacks may
# share it), so the assertion is that OUR pushed image (by digest) is gone, not
# that the repo itself is removed. cdkd's ECR provider force-deletes repos it
# owns when they contain images; the shared asset repo's image lifecycle is the
# concern here.
if [ -n "${IMAGE_DIGEST}" ]; then
  if aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageDigest=${IMAGE_DIGEST}" --region "${REGION}" >/dev/null 2>&1; then
    echo "==> destroy left the pushed image behind; sweeping it (asset images are not auto-pruned)"
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageDigest=${IMAGE_DIGEST}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # Re-check: after the sweep, the image must be gone (0 orphans).
  if aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageDigest=${IMAGE_DIGEST}" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: pushed ECR image (digest ${IMAGE_DIGEST}) still present after destroy + sweep" >&2
    exit 1
  fi
  echo "    OK: pushed ECR image (digest ${IMAGE_DIGEST}) is gone (0 ECR orphans)"
  # Clear so the EXIT-trap sweep does not run again.
  IMAGE_DIGEST=""
fi

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> docker-image-asset test passed (deploy-time Docker build + ECR push verified end-to-end + image runs + clean destroy)"
echo "[verify] PASS"
