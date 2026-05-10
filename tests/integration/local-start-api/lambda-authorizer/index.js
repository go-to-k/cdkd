// Lambda REQUEST authorizer for the local-start-api integ test fixture.
//
// Allows when the request carries `Authorization: Bearer let-me-in`,
// denies otherwise. Returns an IAM-style policy document so the
// http-server's policy evaluator exercises the standard parse path.
exports.handler = async (event) => {
  const headers = event.headers || {};
  const auth =
    headers.authorization || headers.Authorization || headers.AUTHORIZATION || '';
  const expected = 'Bearer let-me-in';
  const allow = auth === expected;
  const methodArn = event.methodArn || event.routeArn || '*';
  return {
    principalId: allow ? 'integ-user' : 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: allow ? 'Allow' : 'Deny',
          Action: 'execute-api:Invoke',
          Resource: methodArn,
        },
      ],
    },
    context: { user: 'integ-user', tier: 'pro' },
  };
};
