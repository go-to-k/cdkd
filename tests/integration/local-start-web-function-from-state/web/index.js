// Dependency-free Lambda Web Function server for the
// `cdkd local start-web-function --from-state` integ test. It listens on
// AWS_LAMBDA_HTTP_ENDPOINT. `GET /whoami` asks STS who the container's
// credentials belong to, through the AWS SDK the Lambda nodejs:24 base image
// ships under /var/runtime (no NODE_PATH points there when the runtime starts
// node directly, hence the absolute path), and echoes the ARN plus the
// ServiceConfig env var `ROLE_NAME`, which --from-state resolves from a Ref.
const http = require('node:http');

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '').split(':');
if (!host || !port) {
  console.error('AWS_LAMBDA_HTTP_ENDPOINT is not set');
  process.exit(1);
}

async function callerArn() {
  const { STSClient, GetCallerIdentityCommand } = require('/var/runtime/node_modules/@aws-sdk/client-sts');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const out = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  return out.Arn;
}

http
  .createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url !== '/whoami') return reply(200, { path: req.url, roleName: process.env.ROLE_NAME });
    callerArn().then(
      (arn) => reply(200, { arn, roleName: process.env.ROLE_NAME }),
      (err) => reply(500, { error: String(err && err.name), message: String(err && err.message) })
    );
  })
  .listen(Number(port), host, () => {
    console.error(`web function listening on ${host}:${port}`);
  });
