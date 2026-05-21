# syntax=docker/dockerfile:1
# This Dockerfile deliberately exercises BuildKit-only features so the
# integ test fails on the legacy builder. Before this PR cdkd silently
# killed the build on hosts where the BuildKit progress output exceeded
# the 50 MB execFile maxBuffer.
FROM public.ecr.aws/lambda/nodejs:20

# Heredoc (BuildKit syntax) — would fail on the legacy builder with
# "unknown instruction: RUN" / "syntax error" because the legacy parser
# rejects the `<<EOF` form.
RUN <<EOF
echo "Building with BuildKit heredoc" > /tmp/build-marker.txt
EOF

# `RUN --mount=type=cache` is also BuildKit-only. The cache mount is a
# no-op for this trivial build (no package manager) but it forces the
# frontend to use BuildKit features.
RUN --mount=type=cache,target=/var/cache/apt \
    cat /tmp/build-marker.txt

COPY app.js ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]
