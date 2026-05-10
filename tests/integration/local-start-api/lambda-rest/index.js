// REST v1 greedy-proxy handler. Echoes the path + stageVariables so
// verify.sh can assert PR 8c's `event.stageVariables.STAGE === 'prod'`.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routedVia: 'rest-v1',
      path: event.path,
      stageVariables: event.stageVariables || null,
    }),
  };
};
