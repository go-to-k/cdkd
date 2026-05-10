// Items handler for the local-start-api integ test fixture.
//
// Returns a small JSON shape that verify.sh greps for:
//   - GET /items/{id} surfaces the captured `{id}` value as `"id"`.
//   - POST /items echoes the request body under `"body"` (PR 8b's
//     verify.sh greps for `"body"` literal substring).
//   - `stageVariables` is included in every response so PR 8c's stage
//     variable assertions can hit any path on this handler if needed.
exports.handler = async (event) => {
  const id = (event.pathParameters && event.pathParameters.id) || 'list';
  const method = event.requestContext && event.requestContext.http
    ? event.requestContext.http.method
    : event.httpMethod;
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: String(id),
      method,
      stageVariables: event.stageVariables || null,
      body: event.body || null,
    }),
  };
};
