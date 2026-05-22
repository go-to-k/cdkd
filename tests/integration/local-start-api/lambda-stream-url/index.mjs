// Streaming Function URL handler — exercises the RESPONSE_STREAM
// invoke mode path added in #467.
//
// `awslambda.streamifyResponse` is the Lambda runtime's documented
// streaming entrypoint: the handler receives a writable Node Readable
// (`responseStream`) and writes the prelude (status + headers) via
// `awslambda.HttpResponseStream.from(...)` followed by chunked body
// bytes. The local server returns the same shape via
// `Transfer-Encoding: chunked` to the curl client.
//
// 5 chunks of "hello-N\n" with 200ms delays between them — verify.sh
// asserts the response arrives as chunks (timing observable) AND that
// `transfer-encoding: chunked` is in the response headers, not just
// the buffered concatenation. The handler also surfaces stageVariables
// (always `null` for Function URLs) so the response shape matches the
// buffered Function URL fixture.

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const metadata = {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/plain',
      'X-Stream-Test': 'on',
    },
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, metadata);

  for (let i = 0; i < 5; i++) {
    responseStream.write(`hello-${i}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  responseStream.end();
});
