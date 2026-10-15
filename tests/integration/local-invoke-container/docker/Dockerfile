FROM public.ecr.aws/lambda/nodejs:20

# Declared so the fake build arg the stack passes is consumed, not warned about.
ARG CDKD_SENTINEL_ARG

COPY app.js ${LAMBDA_TASK_ROOT}/

CMD ["app.handler"]
