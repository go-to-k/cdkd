// server.cjs - interpreted-language handler for the
// local-start-service-watch-fast integ fixture (Phase 4 of cdk-local#214).
// `.cjs` extension chosen so the file isn't swept by
// `tests/integration/.gitignore`'s `*.js` rule (committed handlers
// need a non-`.js` extension); the handler is plain CommonJS.
// verify.sh rewrites this whole file mid-run to bump VERSION (v1 -> v2)
// and asserts the served response changes after the bind-mount source
// fast path's `docker cp` + `docker restart` cycle. Keep the script
// minimal so the soft-reload's `docker cp` step has nothing to do but
// drop the new file in place.
const http = require('http');
const VERSION = 'v1';
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(VERSION);
  })
  .listen(8080, '0.0.0.0', () => {
    console.log(`server.cjs ${VERSION} listening on 8080`);
  });
