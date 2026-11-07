# A non-AWS base image with no Lambda Runtime Interface Emulator
# (go-to-k/cdkd#6018). cdkd mounts one at /var/rapid/aws-lambda-rie and runs
# this image's ENTRYPOINT + CMD under it.
FROM python:3.12-alpine

COPY runtime.py /app/runtime.py

ENTRYPOINT ["/usr/local/bin/python3", "/app/runtime.py"]
CMD ["from-image-cmd"]
