// Minimal HTTP server for the MicroVM image build. Lambda snapshots the
// running process once it is listening on port 8080. Mirrors the AWS
// "Create your first Lambda MicroVM" tutorial's app.js.
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: req.url }));
});

server.listen(8080, () => {
  console.log('Listening on port 8080');
});
