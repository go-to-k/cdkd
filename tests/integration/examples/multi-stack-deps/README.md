# Multi-Stack Dependencies Example

This example demonstrates deploying multiple stacks with cross-stack references and dependency ordering using cdkq.

## Architecture

This example consists of three stacks deployed in dependency order:

1. **NetworkStack** (`CdkqNetworkStack`) - Foundation layer
   - Creates a VPC (1 AZ, no NAT gateway)
   - Creates a Security Group
   - Exports VPC ID and Security Group ID

2. **DataStack** (`CdkqDataStack`) - Data layer (depends on NetworkStack)
   - Creates a DynamoDB table (partition key + sort key)
   - Creates an S3 bucket
   - Exports table name, table ARN, and bucket name

3. **AppStack** (`CdkqAppStack`) - Application layer (imports from DataStack)
   - Creates an IAM role with DynamoDB access policy
   - Creates a Lambda function with environment variables referencing imported values
   - Uses `Fn::ImportValue` to resolve DataStack's table name, table ARN, and bucket name

## What This Tests

- **`--all` flag**: Deploying all three stacks in a single command
- **Cross-stack `Fn::ImportValue` resolution**: AppStack imports values exported by DataStack
- **Deployment order**: Stacks are deployed in dependency order (Network -> Data -> App)
- **Destruction order**: Stacks are destroyed in reverse dependency order (App -> Data -> Network)
- **Stack dependency via `addDependency`**: DataStack depends on NetworkStack

## Setup

Install dependencies:

```bash
npm install
```

## Deployment

### Deploy All Stacks

Deploy all stacks at once using the `--all` flag:

```bash
cd /path/to/cdkq
export STATE_BUCKET="your-state-bucket"
export AWS_REGION="us-east-1"

node dist/cli.js deploy \
  --app "npx ts-node tests/integration/examples/multi-stack-deps/bin/app.ts" \
  --all \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose
```

### Deploy Stacks Individually

Deploy stacks one at a time in dependency order:

```bash
# 1. Deploy NetworkStack
node dist/cli.js deploy \
  --app "npx ts-node tests/integration/examples/multi-stack-deps/bin/app.ts" \
  CdkqNetworkStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose

# 2. Deploy DataStack
node dist/cli.js deploy \
  --app "npx ts-node tests/integration/examples/multi-stack-deps/bin/app.ts" \
  CdkqDataStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose

# 3. Deploy AppStack
node dist/cli.js deploy \
  --app "npx ts-node tests/integration/examples/multi-stack-deps/bin/app.ts" \
  CdkqAppStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose
```

## Cleanup

Delete stacks in reverse dependency order:

```bash
# Using --all (cdkq handles reverse ordering)
node dist/cli.js destroy \
  --app "npx ts-node tests/integration/examples/multi-stack-deps/bin/app.ts" \
  --all \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --force

# Or manually in reverse order:
# 1. AppStack, 2. DataStack, 3. NetworkStack
```

## How It Works

1. **Export**: DataStack uses `CfnOutput` with `exportName` to export values. cdkq saves these in the state file:
   ```json
   {
     "exports": {
       "MultiStackDeps-TableName": "CdkqDataStack-AppTable-abc123",
       "MultiStackDeps-BucketName": "cdkqdatastack-databucket-xyz789"
     }
   }
   ```

2. **Import**: AppStack uses `Fn.importValue('MultiStackDeps-TableName')`. During deployment, cdkq:
   - Queries all stacks in the state bucket
   - Finds the export with the matching name from DataStack's state
   - Resolves the value in the AppStack's template

3. **Ordering**: `dataStack.addDependency(networkStack)` in the CDK app ensures deployment order. When using `--all`, cdkq respects these dependencies.
