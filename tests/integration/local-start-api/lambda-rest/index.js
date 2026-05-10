// REST v1 handler for the local-start-api integ test fixture.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routedVia: 'rest-v1',
      path: event.path,
      method: event.httpMethod,
      pathParameters: event.pathParameters || {},
    }),
  };
};
