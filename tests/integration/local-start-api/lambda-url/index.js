// Function URL handler for the local-start-api integ test fixture.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ functionUrl: true, path: event.rawPath }),
  };
};
