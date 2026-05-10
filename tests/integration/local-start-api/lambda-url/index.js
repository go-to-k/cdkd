// Function URL handler for the local-start-api integ test fixture.
// Plain echo — the integ asserts a literal `"functionUrl":true` marker
// so the route table's `/{proxy+}` fallback is verifiable. Also surfaces
// stageVariables so PR 8c's assertion that Function URL routes get
// `stageVariables: null` (no Stage attached) is exercisable.
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
