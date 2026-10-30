// Minimal, dependency-free Lambda Web Function server for the
// `cdkd local start-web-function` integ test. It listens on the host:port the
// runtime hands it in AWS_LAMBDA_HTTP_ENDPOINT and echoes the request method,
// path, the entry file and two ServiceConfig env vars as JSON. `/slow` answers
// after 500 ms, so concurrent requests prove the server overlaps them.
const http = require('node:http');

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '').split(':');
if (!host || !port) {
  console.error('AWS_LAMBDA_HTTP_ENDPOINT is not set');
  process.exit(1);
}

const entry = process.env.WEB_ENTRY_LABEL || 'index';

http
  .createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          entry,
          revision: process.env.REVISION_LABEL,
          greeting: process.env.GREETING,
          functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        })
      );
    };
    if (req.url === '/slow') setTimeout(reply, 500);
    else if (req.url === '/crash') {
      reply();
      res.on('finish', () => process.exit(3));
    } else reply();
  })
  .listen(Number(port), host, () => {
    console.error(`web function (${entry}) listening on ${host}:${port}`);
  });
