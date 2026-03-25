# Basic Example

This is the simplest possible cdkq deployment example. It demonstrates:

- Creating a single S3 bucket
- Using Cloud Control API for resource provisioning
- Basic stack outputs

## Resources

- **AWS::S3::Bucket**: A simple S3 bucket with destroy removal policy

## Deploy

```bash
# Set environment variables
export STATE_BUCKET="your-cdkq-state-bucket"
export AWS_REGION="us-east-1"

# Bootstrap (first time only)
node ../../../dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Deploy
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --stack CdkqBasicExample \
  --region ${AWS_REGION} \
  --force
```
