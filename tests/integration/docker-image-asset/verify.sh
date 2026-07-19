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
#   2. assert: the ECR repo exists + OUR pushed image (identified by its
#      content-addressed asset-hash TAG, parsed from the Lambda Code.ImageUri)
#      is present. We do NOT count images in the shared bootstrap repo (it
#      already holds thousands from other deploys — not a meaningful signal).
#   3. invoke the Lambda and assert the expected payload (proves the pushed
#      image actually runs; arch is pinned ARM_64 to match the build platform).
#   4. destroy -> assert clean (0 errors): Lambda gone, OUR pushed image (by
#      tag) is gone from ECR, state file gone. The SHARED bootstrap repo itself
#      is expected to persist (cdkd does not own it) and is NOT a failure.
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

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after deploy (used by cleanup's direct ECR sweep on the failure
# path). The CDK-managed container-assets repo for the default bootstrap
# qualifier hnb659fds; the image tag is the asset hash. We capture both the
# repo name and the pushed image TAG after deploy. We assert OUR image by tag
# (the content-addressed asset hash) rather than digest: the Lambda's
# `Code.ImageUri` is the TAG form (`...:{assetHash}`), not the `@sha256:...`
# digest form, so the tag is what reliably identifies the image WE pushed.
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
    # ALWAYS remove the deployment-events sidecar (cdkd writes it on every
    # run; it deliberately survives destroy) so the integ leaves nothing.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Direct ECR sweep in case destroy itself is what broke: delete only the
  # image WE pushed (by tag) from the shared CDK asset repo, so we never
  # touch other deployments' images. ECR repos with images linger + cost.
  if [ -n "${ECR_REPO}" ] && [ -n "${IMAGE_TAG}" ]; then
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  set -eu
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

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
  trap - EXIT INT TERM
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

# ImageUri form: {account}.dkr.ecr.{region}.amazonaws.com/{repo}:{tag}
# CDK + cdkd push by TAG (the content-addressed asset hash). Lambda stores the
# URI in the SAME tag form it was given, so the tag (the part after the final
# `:`) is what identifies OUR pushed image. (It can in principle be a digest
# `@sha256:...` form too; handle both, but the tag form is what we observe.)
#   - repo: everything between the first `/` and the `:` / `@` separator.
#   - tag:  the `:tag` segment when present (and not a digest).
ECR_REPO=$(echo "${IMAGE_URI}" | sed -E 's#^[^/]+/##; s#[@:].*$##')
# Extract the `:tag` only (skip the `@sha256:...` digest form): take the part
# after the LAST `:` but only if the URI has no `@` digest separator.
if echo "${IMAGE_URI}" | grep -q '@'; then
  IMAGE_TAG=""
else
  IMAGE_TAG="${IMAGE_URI##*:}"
fi
if [ -z "${ECR_REPO}" ]; then
  echo "FAIL: could not parse ECR repo name from ImageUri '${IMAGE_URI}'" >&2
  exit 1
fi
if [ -z "${IMAGE_TAG}" ]; then
  echo "FAIL: could not parse an image TAG from ImageUri '${IMAGE_URI}' (expected the {repo}:{assetHash} form)" >&2
  exit 1
fi
echo "    parsed ECR repo: ${ECR_REPO}  tag: ${IMAGE_TAG}"

# --- Assertion: the ECR repo exists ----------------------------------------
if ! aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ECR repository '${ECR_REPO}' does not exist after deploy" >&2
  exit 1
fi
echo "    OK: ECR repository '${ECR_REPO}' exists"

# --- Assertion: OUR pushed image (by tag) is present in the repo ------------
# NOTE: we deliberately do NOT assert a ">=1 image" count against the SHARED
# bootstrap repo `cdk-hnb659fds-container-assets-*`. That repo already holds
# thousands of images from every other CDK deploy on this account, so a count
# check is meaningless as a signal (and the large/odd-shaped count tripped an
# `integer expected` bash error). The meaningful proof is that OUR exact image
# — identified by the content-addressed asset-hash tag parsed above — was
# pushed by cdkd's deploy-time build.
if ! aws ecr describe-images --repository-name "${ECR_REPO}" \
    --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: the pushed image (tag ${IMAGE_TAG}) is not present in ECR repo '${ECR_REPO}' (cdkd should have built + pushed it)" >&2
  exit 1
fi
echo "    OK: the pushed image (tag ${IMAGE_TAG}) is present in ECR (cdkd built + pushed the Docker image asset)"

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
# share it) — so we deliberately do NOT fail on the shared repo persisting.
# The assertion is that OUR pushed image (by tag) is gone. CDK's asset images
# are not auto-pruned on stack delete; if cdkd left it behind we sweep just our
# tag, then assert 0 orphans for our image.
if [ -n "${IMAGE_TAG}" ]; then
  if aws ecr describe-images --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1; then
    echo "==> destroy left the pushed image behind; sweeping it (shared-repo asset images are not auto-pruned)"
    aws ecr batch-delete-image --repository-name "${ECR_REPO}" \
      --image-ids "imageTag=${IMAGE_TAG}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # Re-check: after the sweep, OUR image must be gone (0 orphans for our tag).
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

echo ""
echo "==> docker-image-asset test passed (deploy-time Docker build + ECR push verified end-to-end + image runs + clean destroy)"
echo "[verify] PASS"
