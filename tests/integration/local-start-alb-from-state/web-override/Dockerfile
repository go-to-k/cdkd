# The --image-override arms of verify.sh (go-to-k/cdkd#5156) build both
# services' images from this file. The task definitions override the
# entrypoint and write index.html themselves, so the image adds a marker
# file next to it: serving it proves the local build, not the registry
# image, is the one running.
FROM public.ecr.aws/docker/library/busybox:1.36
RUN mkdir -p /tmp/www/orders \
  && echo cdkd-image-override > /tmp/www/override.txt \
  && echo cdkd-image-override > /tmp/www/orders/override.txt
