// HTTP API v2 event shape — return statusCode + body so cdkd's response
// translator emits an actual HTTP response. `fromContainer: true` is the
// load-bearing marker verify.sh checks to confirm the request reached
// the container Lambda (not a 5xx surfaced by cdkd's own error path).
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromContainer: true,
      greeting: process.env.GREETING ?? 'unset',
      rawPath: event.rawPath,
      method: event.requestContext?.http?.method,
    }),
  };
};
