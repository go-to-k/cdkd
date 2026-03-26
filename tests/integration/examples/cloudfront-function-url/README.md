# CloudFront + Lambda Function URL Example

A practical example that deploys a Lambda function with a Function URL behind a CloudFront distribution.

## Configuration

This stack includes the following resources:

- **Lambda Function**: Simple HTTP handler with inline Python 3.12 code
- **Lambda Function URL**: Public access (IAM auth type NONE)
- **CloudFront Distribution**: Uses Function URL as HTTP origin
- **IAM Role**: Lambda execution role
- **Lambda Permission**: Grants CloudFront invoke access

## Features Tested in cdkq

1. **Lambda Function URL**: AWS::Lambda::Url resource creation
2. **CloudFront Distribution**: Distribution with HTTP origin (not S3)
3. **Inline Code**: Lambda with inline Python code (no asset publishing needed)
4. **Cross-resource References**: Function URL referenced as CloudFront origin
5. **Lambda Permission**: Automatic permission for CloudFront to invoke Lambda
6. **Fn::GetAtt**: Retrieve distribution domain name and function URL in outputs

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkq
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] Lambda function is created with inline Python code
- [ ] Lambda Function URL is created with AUTH_NONE
- [ ] CloudFront Distribution is created with Function URL as origin
- [ ] Lambda Permission is created for CloudFront access
- [ ] Outputs are correctly resolved (distribution domain, function URL, function name)
- [ ] CloudFront serves requests via Lambda Function URL

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack CloudFrontFunctionUrlStack \
  --region us-east-1 \
  --force
```
