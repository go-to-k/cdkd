# Minimal Bedrock AgentCore Runtime CodeConfiguration (managed-runtime) agent
# for the cdkl invoke-agentcore integ test. Authored as plain source (no
# Dockerfile): cdkl builds it from source for the declared runtime, installs
# requirements.txt, and runs this entrypoint, which self-serves the AgentCore
# HTTP contract on 0.0.0.0:8080:
#   GET  /ping        -> 200 {"status":"Healthy"}
#   POST /invocations -> echoes the request body + the injected GREETING env var
# Uses only the Python stdlib. Startup logs go to stderr so the host's stdout
# carries only the cdkl result line.
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

GREETING = os.environ.get("GREETING", "unset")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence default stderr access logs
        pass

    def _json(self, status, payload):
        # Compact separators (no spaces) so the response matches verify.sh's
        # no-space grep assertions, like the Node fixtures' JSON.stringify output.
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/ping":
            self._json(200, {"status": "Healthy"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/invocations":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            echoed = json.loads(body or "{}")
        except json.JSONDecodeError:
            echoed = body
        self._json(200, {"echoed": echoed, "greeting": GREETING, "runtime": "python-code"})


if __name__ == "__main__":
    print("python code agent listening on 0.0.0.0:8080", file=sys.stderr, flush=True)
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
