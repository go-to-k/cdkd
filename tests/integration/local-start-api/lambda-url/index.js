// Function URL handler. Plain echo — the integ asserts a literal
// marker so the route table's `/{proxy+}` fallback is verifiable.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      functionUrl: true,
      path: event.rawPath || event.path,
      stageVariables: event.stageVariables || null,
    }),
  };
};
