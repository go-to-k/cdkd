// Streaming Function URL handler that uses the documented
// `responseStream.setContentType(...)` + `responseStream.write(...)` shortcut
// WITHOUT explicitly calling `awslambda.HttpResponseStream.from(stream, metadata)`.
//
// This is the most common Function URL streaming idiom in AWS tutorials and
// in real-world handlers — production Lambda + Function URL accepts it. Local
// RIE does NOT emit the prelude+separator framing for this pattern, so cdkd
// must synthesize a default prelude and surface the body bytes verbatim
// (issue #664 fix).
//
// verify.sh asserts the response arrives with HTTP 200 + the expected body
// bytes, mirroring what the deployed Function URL would return.

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  responseStream.setContentType('text/event-stream');
  responseStream.write(`data: ${JSON.stringify({ hello: 'world' })}\n\n`);
  responseStream.write(`data: ${JSON.stringify({ count: 2 })}\n\n`);
  responseStream.end();
});
