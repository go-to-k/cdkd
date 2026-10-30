# The application layers of the MicroVM image. Lambda's own container base
# (public.ecr.aws/lambda/microvms:al2023-minimal) is published for arm64 only
# and ships no language runtime, so this fixture builds on the multi-arch
# node:24-slim from ECR Public instead: the dependency-free app.js runs on
# either host architecture without emulation.
FROM public.ecr.aws/docker/library/node:24-slim

WORKDIR /app
COPY app.js .
# 8080 is the default ingress port and 9000 the X-aws-proxy-port arm; the
# hooks port (9001) is published from Hooks.Port, not from EXPOSE.
EXPOSE 8080 9000
CMD ["node", "app.js"]
