#!/usr/bin/env bash
# verify.sh — BuildKit-Dockerfile regression integ test.
#
# Exercises every BuildKit feature this PR newly forwards via cdkd's
# docker build path, in ONE build:
#   1. `# syntax=docker/dockerfile:1`
#   2. Multi-stage with `--target final` (DockerImageCode.fromImageAsset.target)
#   3. `ARG` populated by `--build-arg` (DockerImageCode.fromImageAsset.buildArgs)
#   4. Heredocs (`RUN <<EOF`)
#   5. `RUN --mount=type=cache`
#   6. `RUN --mount=type=secret` populated by `--secret`
#      (DockerImageCode.fromImageAsset.buildSecrets — NEW capability)
#
# Pre-PR cdkd would either silently kill the build with maxBuffer 50 MB
# on BuildKit progress, OR reject `buildSecrets` at the type layer
# because cdkd's `DockerImageAssetSource` didn't surface the field.
# Both paths now work.
#
# Run via `/run-integ local-invoke-buildkit` (recommended) or directly:
#
#     bash tests/integration/local-invoke-buildkit/verify.sh
#
# Requires Docker with BuildKit (Docker Engine 23.0+ has it on by
# default; older daemons need DOCKER_BUILDKIT=1). Fully local — no AWS.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"

# Expected values baked into the image during build. The runtime function
# echoes these back so we can prove every BuildKit flag actually fired.
EXPECTED_BUILD_ARG="compiled-in-from-cdk"
# sha256 of `docker/secret.txt`. Recompute with:
#   sha256sum docker/secret.txt | cut -d' ' -f1
EXPECTED_SECRET_SHA=$(sha256sum docker/secret.txt | cut -d' ' -f1)

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Force a fresh build to guarantee the test actually exercises every
# BuildKit feature this run (otherwise a stale Docker layer cache could
# mask a broken --secret path).
echo "==> Force-rebuilding (clear stale cdkd local image so --secret / --target are re-exercised)"
docker image ls --filter 'reference=cdkd-local-invoke-*' --format '{{.Repository}}:{{.Tag}}' | while read -r tag; do
  docker image rm -f "${tag}" >/dev/null 2>&1 || true
done

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

echo "==> [1/3] Building + invoking BuildkitHandler (exercises every BuildKit feature)"
${CDKD} local invoke CdkdLocalInvokeBuildkitFixture/BuildkitHandler --no-pull >/tmp/cdkd-buildkit-1.log 2>&1
RESULT_1=$(grep -E '"(buildArg|secretSha|fromBuildkitImage)"' /tmp/cdkd-buildkit-1.log | tail -1)
echo "    response: ${RESULT_1}"

# Every BuildKit feature must show up in the response.
echo "${RESULT_1}" | grep -q "\"buildArg\":\"${EXPECTED_BUILD_ARG}\"" || {
  echo "FAIL: --build-arg did not flow through. Expected buildArg=${EXPECTED_BUILD_ARG}"
  echo "      response: ${RESULT_1}"
  cat /tmp/cdkd-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q "\"secretSha\":\"${EXPECTED_SECRET_SHA}\"" || {
  echo "FAIL: --secret did not flow through. Expected secretSha=${EXPECTED_SECRET_SHA}"
  echo "      response: ${RESULT_1}"
  cat /tmp/cdkd-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q '"multiStageTarget":"final"' || {
  echo "FAIL: multi-stage --target final did not run (app.js missing from image)"
  cat /tmp/cdkd-buildkit-1.log
  exit 1
}
echo "${RESULT_1}" | grep -q '"greeting":"hello-buildkit"' || {
  echo "FAIL: GREETING env var did not flow through"
  cat /tmp/cdkd-buildkit-1.log
  exit 1
}
echo "    ✓ build-arg=${EXPECTED_BUILD_ARG}"
echo "    ✓ secret-sha=${EXPECTED_SECRET_SHA}"
echo "    ✓ multi-stage --target=final"

# Verify the raw secret content NEVER landed in any image layer. This is
# the load-bearing security property of `RUN --mount=type=secret`: the
# secret content is mounted ONLY during the RUN step, never baked into a
# layer. Grep the local cdkd-built image's history for the secret
# content — must NOT match.
echo "==> [2/3] Verifying secret content NEVER baked into image layers (security property of --secret)"
SECRET_LITERAL=$(cat docker/secret.txt | head -1)
CDKD_TAG=$(docker image ls --filter 'reference=cdkd-local-invoke-*' --format '{{.Repository}}:{{.Tag}}' | head -1)
if [[ -z "${CDKD_TAG}" ]]; then
  echo "FAIL: no cdkd-local-invoke-* image found — build did not happen"
  exit 1
fi
# Walk every layer's filesystem and grep for the secret literal. If
# `--mount=type=secret` worked correctly, the secret was only on the
# build container's RUN-step tmpfs, never on a layer.
TMP_DUMP=$(mktemp)
trap 'rm -rf "${TMP_DUMP}"' EXIT
docker save "${CDKD_TAG}" | tar -t 2>/dev/null > "${TMP_DUMP}"
if docker save "${CDKD_TAG}" 2>/dev/null | grep -aq "${SECRET_LITERAL}"; then
  echo "FAIL: secret literal '${SECRET_LITERAL}' found in image layers — --mount=type=secret is leaking!"
  exit 1
fi
echo "    ✓ secret content absent from all image layers"

# Re-invoke under --no-build to confirm tag stability (the deterministic
# tag computed from the source must match across builds).
echo "==> [3/3] Re-invoking under --no-build to confirm tag stability"
${CDKD} local invoke CdkdLocalInvokeBuildkitFixture/BuildkitHandler --no-pull --no-build >/tmp/cdkd-buildkit-3.log 2>&1
RESULT_3=$(grep -E '"buildArg"' /tmp/cdkd-buildkit-3.log | tail -1)
echo "${RESULT_3}" | grep -q "\"buildArg\":\"${EXPECTED_BUILD_ARG}\"" || {
  echo "FAIL: --no-build re-invocation did not pick up the same baked image"
  cat /tmp/cdkd-buildkit-3.log
  exit 1
}
echo "    ✓ --no-build reused the cached tag"

rm -f /tmp/cdkd-buildkit-1.log /tmp/cdkd-buildkit-3.log

echo ""
echo "==> All 3 BuildKit-Dockerfile checks passed"
echo "    Every BuildKit feature this PR forwards is end-to-end verified:"
echo "    - # syntax=docker/dockerfile:1"
echo "    - multi-stage --target final"
echo "    - --build-arg GREETING_BUILD_ARG=${EXPECTED_BUILD_ARG}"
echo "    - heredocs (RUN <<EOF)"
echo "    - RUN --mount=type=cache"
echo "    - RUN --mount=type=secret id=mysecret (sha256=${EXPECTED_SECRET_SHA})"
