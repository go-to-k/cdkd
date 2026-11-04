# go-to-k/cdkd#5768: built by `cdkd local run-task --image-override` with the
# build context set by `--image-context` to override-app/, so the COPY below
# reaches a file outside this Dockerfile's own directory.
FROM public.ecr.aws/nginx/nginx:alpine
COPY shared/index.html /usr/share/nginx/html/index.html
