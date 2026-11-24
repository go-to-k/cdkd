# Minimal Bedrock AgentCore Runtime CodeConfiguration agent: serves the
# AgentCore HTTP contract on 0.0.0.0:8080 with the Python stdlib only.
#   GET  /ping        -> 200 {"status":"Healthy"}
#   POST /invocations -> 200 {"ok":true}
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json(200, {"status": "Healthy"})

    def do_POST(self):
        self._json(200, {"ok": True})


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
