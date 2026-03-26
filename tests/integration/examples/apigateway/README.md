# API Gateway + Lambda Example

A simple REST API Gateway with a Lambda integration endpoint.

## Configuration

This stack includes the following resources:

- **Lambda Function**: Inline Node.js 20.x handler returning a JSON greeting
- **REST API Gateway**: API with a single GET /hello endpoint
- **Lambda Integration**: Proxies requests from API Gateway to Lambda
- **IAM Role**: Lambda execution role (auto-created by CDK)
- **Lambda Permission**: Allows API Gateway to invoke the Lambda function

## Features Tested in cdkd

1. **API Gateway REST API**: Resource creation via Cloud Control API
2. **Lambda with Inline Code**: No asset publishing required
3. **Lambda Integration**: API Gateway method + integration resource wiring
4. **Multiple Resource Types**: API Gateway, Lambda, IAM in one stack
5. **CfnOutput Resolution**: API URL constructed with Fn::Join (region, API ID, stage)
6. **Resource Dependencies**: API Gateway resources depend on Lambda function and IAM role

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkd
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Verify

After deployment, test the endpoint:

```bash
curl $(node ../../../dist/cli.js output --stack ApiGatewayStack --key ApiUrl)hello
# Or use the API URL from the deploy output directly:
# curl https://<api-id>.execute-api.<region>.amazonaws.com/prod/hello
```

Expected response:

```json
{
  "message": "Hello from cdkd!",
  "timestamp": "2026-03-26T..."
}
```

## Test Points

- [ ] REST API Gateway is created
- [ ] Lambda function is created with inline code
- [ ] GET /hello method and Lambda integration are configured
- [ ] Lambda permission allows API Gateway invocation
- [ ] IAM execution role is created and attached to Lambda
- [ ] Outputs are correctly resolved (API URL, API ID, function name, ARN)
- [ ] The endpoint responds with the expected JSON payload

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack ApiGatewayStack \
  --region us-east-1 \
  --force
```
