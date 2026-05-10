// Items handler for the local-start-api integ test.
// Returns a small JSON body that includes the path id and the
// request's stage variables (PR 8c — verify.sh asserts the latter
// when it queries `/items/<id>`).
exports.handler = async (event) => {
  const id = (event.pathParameters && event.pathParameters.id) || 'list';
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: String(id),
      method: event.requestContext.http ? event.requestContext.http.method : event.httpMethod,
      stageVariables: event.stageVariables || null,
      body: event.body || null,
    }),
  };
};
