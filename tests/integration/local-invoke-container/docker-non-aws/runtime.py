# A Lambda function on a NON-AWS base image (go-to-k/cdkd#6018): the image
# ships no Runtime Interface Emulator, only this stdlib-only runtime client.
#
# Like the Go binary in the issue, it serves plain HTTP on :8080 (answering
# 404 to everything) when AWS_LAMBDA_RUNTIME_API is unset. So cdkd reaches the
# function only when it mounts an RIE that sets that variable; without one the
# invoke lands on this server's 404 instead.
import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

API = os.environ.get("AWS_LAMBDA_RUNTIME_API")

if not API:

    class NotLambda(BaseHTTPRequestHandler):
        def _not_found(self):
            body = b'{"error":{"code":"not_found"}}'
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = _not_found
        do_POST = _not_found

    HTTPServer(("0.0.0.0", 8080), NotLambda).serve_forever()

BASE = f"http://{API}/2018-06-01/runtime/invocation"
while True:
    with urllib.request.urlopen(f"{BASE}/next") as res:
        request_id = res.headers["Lambda-Runtime-Aws-Request-Id"]
        event = json.loads(res.read() or b"{}")
    result = {
        "fromNonAwsBase": True,
        "greeting": os.environ.get("GREETING", "unset"),
        # The image's own CMD, which reaches the process only when cdkd hands
        # the RIE the image's effective Entrypoint + Cmd.
        "args": sys.argv[1:],
        "echoed": event,
    }
    if isinstance(event, dict) and "rawPath" in event:
        # HTTP API v2 proxy shape for `cdkd local start-api`.
        result = {
            "statusCode": 200,
            "headers": {"content-type": "application/json"},
            "body": json.dumps({**result, "echoed": None, "rawPath": event["rawPath"]}),
        }
    data = json.dumps(result).encode()
    req = urllib.request.Request(f"{BASE}/{request_id}/response", data=data, method="POST")
    urllib.request.urlopen(req).read()
