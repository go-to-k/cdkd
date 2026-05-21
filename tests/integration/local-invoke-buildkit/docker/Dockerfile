# syntax=docker/dockerfile:1
# Comprehensive BuildKit-only Dockerfile used by the local-invoke-buildkit
# integ test. Exercises every BuildKit feature that this PR newly forwards
# via cdkd's docker build path:
#   - `# syntax=docker/dockerfile:1` parser directive
#   - Multi-stage with named stages + `--target` to pick a non-final stage
#   - `ARG` populated by `--build-arg` from CDK's `dockerBuildArgs`
#   - Heredocs (`RUN <<EOF`)
#   - `RUN --mount=type=cache`
#   - `RUN --mount=type=secret` populated by `--secret` from CDK's
#     `dockerBuildSecrets`
#
# Pre-PR cdkd would fail this build silently (maxBuffer 50 MB) on the
# BuildKit progress stream OR reject `dockerBuildSecrets` at the type
# layer. Both paths now work.

ARG GREETING_BUILD_ARG=default-from-arg

# Stage 1 — builder. Captures the ARG value + secret digest into files
# that stage 2 copies. This stage NEVER becomes the final image; we use
# `--target final` to skip past it.
FROM public.ecr.aws/lambda/nodejs:20 AS builder
ARG GREETING_BUILD_ARG

# Heredoc + cache-mount (BuildKit-only): capture the build arg value.
RUN --mount=type=cache,target=/var/cache <<EOF
mkdir -p /tmp/cdkd-build
echo "${GREETING_BUILD_ARG}" > /tmp/cdkd-build/build-arg.txt
EOF

# Secret-mount (BuildKit-only): compute sha256 of the secret file and
# bake the digest into the image. The raw secret content NEVER lands in
# any image layer — only its digest, which the runtime echoes back to
# prove `--secret` actually flowed through.
RUN --mount=type=secret,id=mysecret <<EOF
if [ ! -f /run/secrets/mysecret ]; then
  echo "FAIL: /run/secrets/mysecret does not exist (--secret was not threaded through)" >&2
  exit 1
fi
sha256sum /run/secrets/mysecret | cut -d' ' -f1 > /tmp/cdkd-build/secret-sha.txt
EOF

# Stage 2 — final. The `--target final` flag selects THIS stage. Pulls
# baked artifacts from the builder + the handler source.
FROM public.ecr.aws/lambda/nodejs:20 AS final
COPY --from=builder /tmp/cdkd-build/build-arg.txt ${LAMBDA_TASK_ROOT}/build-arg.txt
COPY --from=builder /tmp/cdkd-build/secret-sha.txt ${LAMBDA_TASK_ROOT}/secret-sha.txt
COPY app.js ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]
