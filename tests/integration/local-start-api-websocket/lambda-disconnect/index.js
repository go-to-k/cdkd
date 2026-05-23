// $disconnect handler — invoked when the socket closes. Response is
// ignored by AWS / cdkd; the side-effects (logging / cleanup) are
// what matters in real apps.
exports.handler = async (event) => {
  console.log('$disconnect:', event.requestContext.connectionId, 'code:', event.requestContext.disconnectStatusCode);
  return { statusCode: 200 };
};
