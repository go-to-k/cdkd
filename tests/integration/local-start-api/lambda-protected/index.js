// Authorizer-protected handler for the local-start-api integ test fixture.
//
// Echoes the authorizer context surfaced by the local server so verify.sh
// can confirm the authorizer pass actually fired (vs simply allowing the
// request through unauthenticated).
exports.handler = async (event) => {
  const authCtx =
    (event.requestContext &&
      ((event.requestContext.authorizer && event.requestContext.authorizer.lambda) ||
        event.requestContext.authorizer)) ||
    null;
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protected: true, authorizer: authCtx }),
  };
};
