# Application layers for the MicroVM image. The Lambda-managed base image
# (the MicroVM OS) is supplied separately via BaseImageArn; this Dockerfile
# only packages the application. Mirrors the AWS "Create your first Lambda
# MicroVM" tutorial.
FROM public.ecr.aws/docker/library/node:24-alpine

WORKDIR /app
COPY app.js .
EXPOSE 8080
CMD ["node", "app.js"]
