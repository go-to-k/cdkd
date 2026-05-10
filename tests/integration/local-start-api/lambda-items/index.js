// Items handler for the local-start-api integ test fixture.
//
// Returns a small JSON shape that verify.sh greps for. The body
// echoes the route's path parameter (when set) so /items/{id}
// requests surface the captured `{id}` value.
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  let body;
  if (event.requestContext && event.requestContext.http && event.requestContext.http.method === 'POST') {
    body = event.body ? JSON.parse(event.body) : { ok: true };
  } else if (id) {
    body = { id, name: `item-${id}` };
  } else {
    body = { items: [{ id: '1' }, { id: '2' }] };
  }
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
};
