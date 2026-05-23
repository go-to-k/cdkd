// $connect handler — admits every client by default. When the upgrade
// URL carries `?reject=true`, returns `{statusCode: 403}` so cdkd's
// $connect verdict path emits a `1008 Forbidden` close frame instead
// of admitting the connection (#528 M5 — exercise the deny path
// end-to-end against real Docker / RIE, complementing the mocked unit
// test in tests/unit/local/websocket-server.test.ts).
exports.handler = async (event) => {
  console.log('$connect:', event.requestContext.connectionId);
  const reject = event.queryStringParameters?.reject === 'true';
  if (reject) {
    console.log('$connect: rejecting per ?reject=true');
    return { statusCode: 403, body: 'Forbidden' };
  }
  return { statusCode: 200, body: 'OK' };
};
